# pi-dispatch 运行中转向（steering）综合方案 v2

> 2026-11-21。两轮共 10 个 harness 独立出方案：Claude、Codex、OpenCode、OpenCode2、Kimi、Pi、OMP、CodeBuddy、Kilo、MCode。本文是综合与裁决；每份原文在 `target/steering/<harness>.md`（MCode 为上一轮）。

## 0. 结论

**文件信箱 + 孩子扩展在 `turn_end` 调 `pi.sendUserMessage(text, { deliverAs: "steer" })`。**

- 父方 `dispatch_steer` 只往 `tasks/<id>/steer.jsonl` 追加一行；孩子下一次轮次边界读走，交给 pi 原生转向队列。
- 不改 argv、不改 stdin、不改退出码、不加新 `TaskStatus`、不碰 `#pump` 收尾主干。
- 送达证据只认孩子 stdout 的 `queue_update` 与 `message_end{role:"user"}`；写盘 ≠ 送达。
- 首版只做：单向纯文本、`running` 任务、下一轮 LLM 调用前、至多 16 条 × 4096 字符、尽力而为。
- 不做：打断在飞工具、RPC、撤回/优先级/广播、`queued` 任务、TUI 新面板、双向对话、图片。

一句话取舍：**转向的价值在「不丢已有上下文」；短任务直接 `dispatch_stop` + 重派，长任务才值得 steer。**

## 1. 需求与最小边界

| 需求样子         | 现有机制                                                            | 差在哪                         |
| ---------------- | ------------------------------------------------------------------- | ------------------------------ |
| 「别干了」       | `dispatch_stop`：SIGTERM→5s→SIGKILL（`src/core/engine.ts:923-940`） | 在飞工具与上下文全丢           |
| 「等我忙完再派」 | 队列 + 座位池                                                       | 只排还没起的任务，不改已起的   |
| 「给兄弟留个话」 | 黑板（`blackboard`）                                                | 父方只读；孩子不主动读就看不到 |
| 「上次接着跑」   | 父会话 resume；孩子一律 `--no-session`                              | 孩子没有会话可续               |
| 「跑太久收掉」   | `timeoutMs` + 停滞护栏                                              | 是杀不是转向                   |

**唯一空白**：孩子跑着时，父方要能补一句话，且不丢它已经做出来的工作。

**最小边界**：单向、纯文本、只针对本引擎 `running` 的孩子、下一个轮次边界送达、尽力而为、带 `sent/queued/delivered/seen/undelivered` 收据。排队中的任务要改向，`stop` 后重派更简单，且没有「改了却没起」的新竞态。

## 2. 事实

### 2.1 真机已证（上一轮探针）

- RPC `{"type":"steer"}` 在长工具（`sleep 6`）期间返回 `{success:true,disposition:"queued"}`；工具结束后 `turn_end → turn_start → queue_update` 清空 → user `message_end` 原文 → 下一 assistant 输出 `STEERED`。
- print 模式 + 孩子扩展在 `turn_end` 调 `sendUserMessage(...,{deliverAs:"steer"})`：`queue_update → turn_start → user message_end → assistant "STEERED" → agent_settled`，exit 0。
- 过晚 steer（`agent_settled` 后）只排队、不启动新 run；RPC 进程永远退 0，成败须从 `agent_settled.aborted` / `agent_end.stopReason` 推。

### 2.2 本轮源码级证据（pi 1.5.2）

- `turn_end` 的扩展 handler 被 **await**，在 `finishTurn` 之前跑；此刻 `isStreaming` 为真，`{deliverAs:"steer"}` 合法（CodeBuddy 读 `dist/core/agent-session.js`）。
- print 模式 `await session.prompt(initialMessage)` 等整个 settled run 才 dispose/exit；被 steer 是**延长 run**，不是提前退出（`dist/modes/print-mode.js:104-140`）。
- 低层 run 结束后 `agent.hasQueuedMessages()` 会触发 `continue()`；**在最后一个 `turn_end` 里入队的 steer 也会再跑一轮**，不会静默滞留（`agent-session.js:1595-1646`）。这把「最后一个 turn_end 之后写入必丢」的窗口缩到 settle 前的毫秒级。
- `pi.sendUserMessage` 自 **0.37.3** 起存在（`CHANGELOG.md:4956-4963`）；本包 peer `>=1.0.0`，支持范围内都有，**不需要版本门**，运行时 `typeof` 探测即可。
- user 消息回显的 `content` 可能是字符串，也可能是 `Array<{type,text}>`；证据扫描两者都要认（`docs/json.md:39,68`）。
- 送达时 pi 发 `message_start{role:"user"}`、从 steering 队列摘掉、再发一次 `queue_update`；`message_end{role:"user"}` 带最终正文（`agent-session.js:786-800`）。
- `agent_before_settle` 是 `agent_settled` 前最后一个可行动边界（`docs/extensions.md:663-695`）；本轮不作为首版依赖，列为真机后再定的加固项。

### 2.3 仓库事实

- 孩子 argv：`pi -p --no-session --mode json`，stdin `ignore`，stdout JSONL（`src/core/child.ts:35-45`、`:260-282`）；扩展用 `-e <本扩展>` 装入（`src/core/engine.ts:714`）。
- `parseChildStream` 只取 assistant/toolResult 的 `message_end` 与 `tool_execution_*`，user 消息被跳过（`src/core/child.ts:472-511`）。
- `#pump` 收 stdout、等 close、抽报告/用量/交付、resolve-exit（`src/core/engine.ts:726-834`）。
- 父方工具 `dispatch_task/list/read/stop/blackboard`（`src/index.ts:344-488`）；孩子 `depth>0` 分支只注册回执/黑板（`src/index.ts:215-220`）。
- `TaskRecord`（`src/core/types.ts:142-178`）；`attach-report` 终态静默丢弃、`attach-worktree` 全状态可写（`src/core/registry.ts:192-210`）；`childEnvFor` 已负责擦除继承黑板 env（`src/core/engine.ts:202-220`）；`storage.persistOutput` 建 `tasks/<id>/output.log`（`src/core/storage.ts:127-135`），`removeTrace` 删整个任务目录。

## 3. 方案对比

|          | A 文件信箱 + 孩子 `turn_end`                        | B 孩子切 RPC 长驻                                          | C stop 后 resume                   | D 黑板代信箱           | E fd3/管道                  |
| -------- | --------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------- | ---------------------- | --------------------------- |
| 机制     | 父追加 JSONL；孩子边界读 → `sendUserMessage(steer)` | `--mode rpc`，stdin 发 `prompt`/`steer`                    | 杀进程，`--session` 续跑并带新指令 | 复用黑板，孩子边界轮询 | 新增 fd 3 写通道            |
| 送达时机 | 当前工具批次结束、下一次 LLM 前                     | 同左                                                       | 下一次进程启动                     | 同 A，但看孩子读哪块板 | 同左，但要改 stdio          |
| 改动面   | child/engine/index/registry/storage + 测试          | buildPiArgv、spawnChild、pump、成功/失败判定、全套 fixture | 会话文件、清理、两段报告/用量      | 黑板寻址/排序/TTL      | spawn stdio、handle、跨平台 |
| 证据     | `queue_update` + user 回显                          | 协议 response + 回显 + `queue_update`                      | 新进程输出                         | 无强制证据             | 需另造 ack                  |
| 结论     | **推荐**                                            | 仅升级路径                                                 | 否决                               | 否决                   | 否决                        |

**为什么 A 不选 B**：两者送达语义完全相同，A 没有晚一轮——孩子内部仍走 pi 原生 steer 队列，A 只是把「父 → 子」那一段从 stdin 换成文件。B 的代价是把 argv、stdin、退出码、报告/用量、`resolve-exit` 全部重验；RPC 进程永远退 0，成败要从 `agent_settled` 推。这个仓最大的资产是生命周期与收据纪律，不值得为一条单向消息重写。B 唯一真正多出来的是「打断在飞工具」（`abort` 约 1 秒），而需求明确是「插话调整方向」，不是「立刻停手」；停手用 `dispatch_stop`。

## 4. 推荐方案

### 4.1 线格式与磁盘

父 → 子，文件：`<storage 桶>/tasks/<taskId>/steer.jsonl`（在 worktree 之外，不进 `git status`）。

一行一个 JSON：

```json
{ "seq": 1, "text": "把输出目录改到 out2/", "at": 1763700000000 }
```

- `seq`：同一任务严格递增，父方分配；上限 16 条。
- `text`：≤ 4096 字符；空/超长拒绝。
- 文件按行追加；半行/坏行由孩子跳过，下一回合重读；坏行不重试。

子 → 模型，注入文本（**标记只放第一行**）：

```text
[pi-dispatch-steer #1]
父方在你运行期间改了方向；这是对当前任务的补充/修正，不是新任务：
把输出目录改到 out2/
```

`[pi-dispatch-steer #N]` 是送达证据的锚。父方只在 `message_end` 且 `role === "user"` 的文本里认它（`content` 为 string 或 block 数组都要归一化）；assistant 复述不算。只解析首行，防止正文里伪造第二个标记。

环境变量：`PI_DISPATCH_STEER_FILE`（完整路径），由 `childEnvFor` 注入；继承来的同名变量一律擦掉（与黑板 G5 同规矩）。

### 4.2 状态机

```text
dispatch ──> queued ──> running ──(argv 初始 prompt)──> 回合 1 ──> turn_end
                                                          │
父方 dispatch_steer ──> 校验 running ──> seq=++ ──> append steer.jsonl
                                                          │  attach-steer(state=sent)
                                       孩子 turn_end 读 seq > lastSeq
                                       sendUserMessage(tag+text,{deliverAs:"steer"})
                                       成功才推进 lastSeq；抛错停在本条，下回合重试
                                                          │
                                       后续回合 … ──> agent_settled ──> 进程退出
                                                          │
#pump 退出后 parseChildStream：按 seq 对账 queue_update / user 回显 / 后续 assistant
                                                          │
                          attach-steer(最终态) ──> resolve-exit ──> 通知/收据
```

无新任务状态。`steers` 像 `worktree` 回执：只在用过时出现；终态后不再受理。

**运行中只报 `sent`。** `delivered/seen` 在退出时一次性对账；不做 stdout 增量解析（要拆行缓冲、改 `#pump` 主干，收益只是提前几十秒知道，且父方本来也看不到在飞正文）。这是本方案与旧稿最大的简化。

### 4.3 收据阶梯

| state         | 来源                                            | 证明                              |
| ------------- | ----------------------------------------------- | --------------------------------- |
| `sent`        | 父方 `appendFileSync` 成功                      | 字节进了信箱                      |
| `queued`      | 子进程 stdout 的 `queue_update.steering` 含 tag | 孩子扩展读到了，pi 收进了转向队列 |
| `delivered`   | `message_end{role:"user"}` 含 tag               | 消息进了 transcript               |
| `seen`        | 该 user 消息之后出现 assistant `message_end`    | 下一次 LLM 调用确实带着它发生     |
| `undelivered` | 退出时仍为 `sent`                               | 没有任何证据，明说没送到          |

`sent` 只是「已投递到信箱」，不是「孩子看到」。工具返回值与 `dispatch_list` 都必须这样说。

**终态语义**：退出时 `queued` 保留为 `queued`（已入队、未进 transcript），不要并进 `undelivered`；通知里「未送达」= `sent + queued`。`delivered` 但无后续 assistant 的，保持 `delivered`，不要谎报 `seen`。

### 4.4 文件/函数级改动

**`src/core/steer.ts`（新，核心层零 pi 依赖，约 60 行）**

- `STEER_TAG_PREFIX = "[pi-dispatch-steer #"`。
- `formatSteerMessage(seq, text)`：生成带标记与说明的注入文本。
- `parseSteerLines(raw)`：按行 JSON 解析；跳过空行/半行/坏行；按 seq 升序；返回 `{seq, text, at}`。
- `steerSeqFromText(text)`：从 user 消息文本首行抠标记的 seq；没有返回 undefined。
- `textOfContent(content)`：string 原样；数组拼 `type === "text"` 的 `text`；其它返回 `""`。
- `MAX_STEERS = 16`、`MAX_STEER_CHARS = 4096`。

**`src/core/types.ts`**

- 新增 `SteerState = "sent" | "queued" | "delivered" | "seen" | "undelivered"`。
- 新增 `SteerRecord { seq: number; text: string; at: number; state: SteerState; deliveredAt?: number; seenAt?: number }`。
- 新增 `SteerOutcome = { ok: true; taskId: string; seq: number; state: "sent" } | { ok: false; error: string }`。
- `TaskRecord` 加 `steers?: SteerRecord[]`、`reportStale?: true`（仅用过才出现）。
- `DispatchResult` 加 `steers?: SteerRecord[]`、`reportStale?: true`（一次性宿主并行的极端情况下也能带出）。

**`src/core/storage.ts`**

- `steerPath(taskId)`：`<tasksDir>/<taskId>/steer.jsonl`，复用 `isSafeTaskId`。
- `appendSteer(taskId, line)`：`mkdirSync(...,{recursive:true})` + `appendFileSync(path, line+"\n")`。
- `readSteerLines(taskId)` / `countSteerLines(taskId)`：给 seq 初始化与最终计数。
- `removeTrace` / `archive` 不改：任务目录整棵删；记录里的 `steers` 已留正文。

**`src/core/registry.ts`**

- `TaskCommand` 加 `{ kind: "attach-steer"; id: string; steer: SteerRecord }`。
- `#apply` 加 case：按 `seq` upsert（保留已写入的 `text`/`at`，只补 `state` 与时间）；非终态写，终态静默丢弃；不发状态变迁（照 `attach-worktree` 的语义）。
- `attach-report` 加可选 `reportStale?: true`；`ALLOWED_TRANSITIONS` 不动。

**`src/core/child.ts`**

- `parseChildStream` 增加：
  - `userMessages: Array<{ text: string; at?: number }>`：只收 `message_end` 且 `role === "user"`，`textOfContent` 归一化。
  - `queueSteering: string[]`：收 `queue_update.steering` 的文本（string 或 `{ text }` 都归一化）。
  - `reportLine?: number`：最后一个 `child_report` toolResult 的行号。
  - 返回 `steers: Array<{ seq: number; state: "queued"|"delivered"|"seen"; deliveredAt?: number; seenAt?: number }>` 与 `reportStale?: true`（只返回有证据的 seq；无证据的由引擎标 `undelivered`）。
- 单遍顺序扫描：先按标记把 user 消息映射到 seq；每条 user 之后的第一条 assistant 把「已 delivered 未 seen」的 steers 标 seen；只有 `queueSteering` 证据、没有 user 回显的标 queued。
- 现有 `text`/`toolReport`/`usage`/`delivery` 逻辑不动；user 消息不污染正文。
- 不导出增量解析器——终态一次解析。

**`src/core/engine.ts`**

- `childEnvFor` 加第 4 个可选参 `steerFile?: string`；先 `delete env.PI_DISPATCH_STEER_FILE`，再按需注入。
- `#childEnv`：`storage && childExtensionPath` 时传 `storage.steerPath(taskId)`。
- 新增 `#steerSeq = new Map<string, number>()`；首次用 `countSteerLines` 初始化。
- 新增 `steer(taskId, message): Promise<SteerOutcome>`：
  - 未知 id / 非 `running` / 无 `#children` 句柄 / 无 storage / 无 childExtensionPath / 空 / 超长 / 第 17 条 → 明确拒绝，不落文件。
  - 同步分配 seq → `storage.appendSteer` → `registry.submit({kind:"attach-steer", id: taskId, steer:{seq,text,at,state:"sent"}})` → 返回 `{ok:true, taskId, seq, state:"sent"}`。
  - 分配与 await 之间不留空档，避免并发重号。不做 `hostMode` 硬门：状态是 `running` 就允许；一次性宿主正常调用不到，调用到了也应当生效。
- `#pump`：
  - 退出后、`resolve-exit` 前：`parseChildStream(text)` 得到 `steers` / `reportStale`；把每条最终态 `attach-steer`；`attach-report` 带 `reportStale`；仍为 `sent` 的标 `undelivered`。
  - 现有 attach-report/output/resolve-exit 顺序不变；steers 的最终 upsert 放在 resolve-exit 前，保证通知能看到。
- `#resultFromRecord`：按需带出 `steers`、`reportStale`。
- `stop` / `shutdown` / 超时 / 停滞 / 座位 / 池子 / activity 不改：转向不占座、不重置停滞计时。

**`src/index.ts`**

- 孩子分支（`session_start` 且 depth>0）：`const steerFile = process.env.PI_DISPATCH_STEER_FILE; if (steerFile) startSteerInbox(pi, steerFile);`。
- `startSteerInbox(pi, file)`：
  - `typeof pi.sendUserMessage !== "function"` → 不启动（旧 pi 降级；收据自然显示 undelivered）。
  - `let lastSeq = 0`；`pi.on("turn_end", handler)`。
  - handler：`readFileSync(file)`（文件不存在按空处理）→ `parseSteerLines` → 对 `seq > lastSeq` 逐条 `sendUserMessage(formatSteerMessage(seq,text), {deliverAs:"steer"})`；**发送成功才推进 lastSeq**；抛错就停在本条，下一回合重试。
  - 返回退订函数；`session_shutdown` 时退订。
- 父方 `registerTools` 加 `dispatch_steer {taskId, message}`；description 写明「不打断工具 / sent ≠ seen / 证据看 dispatch_list」。
- `dispatch_list` 投影加 `steers`（只回 `seq/at/state/deliveredAt/seenAt`，不回正文，避免列表膨胀）与 `reportStale`。
- `hasReliableReport` 加 `!result.reportStale`。
- `deliver` 的终态通知加 `｜转向 N 条：送达 D / 生效 S（未送达 U）`；`delivered === undefined` 时写「转向未观测到结果」。

**文档 / 脚本**

- `docs/spec/core-spec.html`：新增「运行中转向」一节；工具表加 `dispatch_steer`；收据小节加 `steers`；坑里写「最后一个 turn_end 之后写入仍可能丢」「一次性宿主正常不可转向」「信箱不进 worktree」「报告可能早于转向」。
- `README.md`：工具表加一行能力；已知边界写「不打断当前工具」。
- `GLOSSARY.md`：加「转向 / 信箱 / 送达证据 / 未送达」。
- `scripts/verify-modes.ts`：加一条 steer 真机腿（见 §5.4）。

### 4.5 边界与失败模式

| 场景                           | 行为                                                                                                            | 收据                            |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 孩子正在长工具调用             | 转向写入信箱，孩子在该工具批次结束后的 `turn_end` 读到；不打断工具                                              | 运行中 `sent`；退出后按实际证据 |
| 转向与最后一个 `turn_end` 竞争 | 写入恰在最后一次读取之后 → 孩子退出；OMP 源码证据表明「最后一个 turn_end 里入队」会继续，但「读取之后写入」仍丢 | `undelivered`；不重放、不复活   |
| 重复/乱序                      | 单写者 append，顺序即发送顺序；孩子按 seq 去重；标记只认首行                                                    | 每条只计一次                    |
| 孩子已结束/已 stopping         | `steer()` 按 `status !== "running"` 拒，不落盘                                                                  | 工具报错                        |
| 旧 pi 无 `sendUserMessage`     | 孩子侧 `typeof` 探测；不调、不崩                                                                                | `undelivered`，不装成功         |
| 一次性宿主                     | 父方通常卡在 `dispatch_task`；不做硬门，状态是 running 就允许                                                   | 正常调用不到                    |
| 父进程死亡                     | 孩子继续跑；已写的转向仍会在下一轮边界注入                                                                      | 重启恢复把在飞任务标 `lost`     |
| 孩子停滞                       | 转向不重置停滞计时——卡死的孩子读不到信箱，重置只会掩盖真卡死                                                    | 5 分钟后照常 `stalled`          |
| 报告早于转向                   | `reportStale=true`；`hasReliableReport` 为 false；通知明说                                                      | 报告不享受小窗                  |
| 孙任务                         | 继承来的 `PI_DISPATCH_STEER_FILE` 被擦掉，不读爷爷的信箱                                                        | 不串台                          |

**首版不做 `agent_before_settle`。** 它能在 settle 前再兜一次，但未证；OMP 的源码证据已把「最后 turn_end 入队」这条路走通，剩下的窗口是毫秒级。真机若发现该窗口常被命中，再加第二个钩子（同一个 handler，无新行直接返回 `undefined`，零成本）。

### 4.6 报告过期

孩子可能先在转向之前交了 `child_report`，之后继续干活但不再交。父方以最终正文 + delivery 为准；`reportStale=true` 时：

- `dispatch_list` / 终态结果带 `reportStale`；
- `hasReliableReport` 返回 false，不享受「可靠报告」的小窗；
- 通知写「报告早于最后一次转向，以最终正文为准」。

判定：最后一次 `delivered` 的 steer 的 user 回显行号 > 最后一个 `child_report` 的行号 ⇒ stale。报告在最后一次转向之后重交 ⇒ 不 stale。

## 5. 测试与验收

### 5.1 单元测试

- `test/steer.test.ts`（新）：格式/解析/半行/坏行/顺序/首行标记；`textOfContent` 的 string 与 block 数组；上限 16 / 4096。
- `test/child.test.ts`：
  - `REAL_STEER_STREAM`（真机抓的 `queue_update → user → assistant`）解析出 `queued/delivered/seen`；
  - user `content` 为字符串和数组都能识别；
  - 没有 user 回显不算 delivered；回显前的 assistant 不算 seen；只有 `queue_update` 没有 user 回显 ⇒ `queued`，绝不 `delivered`；空 `queue_update`（清空）不得把 `delivered` 降级；多个 user 回显共用一个后续 assistant 时，每条回显各自 `delivered`，只有紧接其后的第一条 assistant 记 `seen`；
  - 多个 seq 各自记账；assistant 文本里伪造的标记不算；user 回显乱序到达（seq 2 先于 1）仍各归各；两条 user 回显之间夹 assistant，seen 只认每条 user 后第一条 assistant；`queue_update` 缺 `steering` 字段或元素既非 string 也非 `{text}` 时不崩、不误记；user `message_start` 不算送达，只有 `message_end` 算；首行前缀不是精确 marker 时不算。
  - `reportStale`：报告在转向后重交 ⇒ 不标记（键缺席）；转向后没重交 ⇒ true；报告与最后一条 delivered 同行 ⇒ 按 `>` 判不标记；有双报告时只取最后一份，早报告不影响判定。
- `test/engine.test.ts`：`isolatedStorage()` + `freshEngine({storage, spawn: steeringSpawn(...)})`。**不要复用 `recordingSpawn`**：它只记 argv/env，`onOutput` 是空函数；拿它断言 `seen` 是假绿。`steeringSpawn` 要按真机顺序吐 `queue_update → user message_end → assistant message_end`，并逐事件 `deepEqual` 断言 `type/role/content`——不是只断言 `events.length > 0`。
  - dispatch 后 `engine.steer(id,"改方向")` ⇒ 文件一行、`sent` 进记录、env 指向它；再断言 `events` 真的发过。
  - 拒绝：queued/stopping/终态/未知 id/无 storage/无 childExtensionPath/空/纯空白/4096 放行与 4097 拒绝/第 17 条/已有 `steer.jsonl` 时续号；并发两次调用得到 seq 1/2，文件两行。第 17 条拒绝时前 16 条的记录与文件字节不变；终态拒绝后 seq 不增、文件字节不变。
  - 退出时把 queue_update / user 回显 / assistant 证据并进记录；仍 sent 的标 undelivered；delivered 但无后续 assistant 的保留 delivered。
  - 默认关的记录既无 `steers` 键、也无 `reportStale` 键；转向过的记录 `steers.length === 1`；孙任务不继承 env；`reportStale` 四态：无报告（键缺席）、报告早于最后 delivered（true）、报告晚于（缺席）、只有 queued 未 delivered（缺席）、报告与最后 delivered 同一行（按 `>` 判，不 stale）。
  - 追加失败不得先 `attach sent`：用只读/不可写目录或注入失败的 append，断言 `ok:false`、记录里没有该 seq。
- `test/core-logic.test.ts`：`attach-steer` 按 seq upsert；终态静默丢弃（断言记录/状态/时间戳全不变）；不改 status；同 seq 补状态时保留 `text/at`（仓里没有 `test/registry.test.ts`，状态机用例集中在 core-logic）。
- `test/adapter.test.ts`：`dispatch_steer` schema/描述；`dispatch_list` 条件展开；depth>0 且给信箱时只注册一个 `turn_end`；无 `sendUserMessage` 时不崩；发送第一条抛错时调用序必须是 `1,1,2`，不能跳到 2；`session_shutdown` 后不再读/发。
- `scripts/verdicts.ts` 新增 `judgeSteer(record, outputLog)`：纯函数，检查 `state==="seen"`、user 回显在 `turn_end` 之后、assistant 在回显之后、seq 精确；`test/verdicts.test.ts` 用正反夹具覆盖缺事件/错序/未 seen/失败记录，并加一条「`ok` 恒 true 的假 verdict 必须被负例打红」。真机腿只调它，不重复写断言。

每条新用例必须同时有正例和负例：正例断言 `state/seq/文件行/事件顺序` 的具体值，负例断言拒绝且不落盘。只断言 `ok === true` 的用例视为假绿，评审直接打回。

### 5.2 变异测试与破坏点

**命令**：`pnpm mutate`（mutator，无覆盖率）。基线退出码是 **3**（既有等价变异）；新代码零幸存才是线。不能只看总退出码：按 `.metrics/mutate/{core.steer,core.child,core.engine,core.registry,index}.edn` 逐个新函数看 `:survived 0`。杀不掉的变异写进对应测试文件头的「等价变异」段，说明为何在可达输入上等价。

**私有 `#` 方法不进 mutator 账本**：可测逻辑放 `src/core/steer.ts` 的导出函数；`engine.ts` 的 `#steer`/`#pump` 只做编排。若某段逻辑只能在私有方法里，又写不出单行破坏点，就必须补一条公开行为测试（`dispatch_steer`/退出结果），不能拿「变异没报」当已覆盖。

**变异体 → 预期杀它的用例**：

| #   | 变异                                       | 预期杀它的用例                           |
| --- | ------------------------------------------ | ---------------------------------------- |
| 1   | `MAX_STEERS` 16→17；或 `>=`→`>`            | 引擎：第 16 条接受、第 17 条拒绝（同例） |
| 2   | `MAX_STEER_CHARS` 4096→4097；或 `>`→`>=`   | 引擎：4096 接受、4097 拒绝（同例）       |
| 3   | `parseSteerLines` 不跳过坏行/半行          | 信箱：坏行/半行不毒化整批                |
| 4   | `parseSteerLines` 不按 seq 排序            | 信箱：按 seq 升序                        |
| 5   | `steerSeqFromText` 扫全文而非首行          | child：正文里的伪造标记不算              |
| 6   | `steerSeqFromText` 不校验标记前缀          | child：无标记的 user 消息不算            |
| 7   | `textOfContent` 只处理 string / 只处理数组 | child：string 与数组两种 content         |
| 8   | user role 判断反转                         | child：assistant 文本不算                |
| 9   | 删掉 `queue_update` 证据分支               | child：queued 证据                       |
| 10  | 删掉 assistant-after-delivered 分支        | child：seen 证据                         |
| 11  | `status !== "running"`→`false`             | 引擎：queued/stopping/终态拒绝           |
| 12  | 删掉 `#children` 句柄检查                  | 引擎：无句柄拒绝                         |
| 13  | 删掉 `delete env.PI_DISPATCH_STEER_FILE`   | 引擎：孙任务不继承                       |
| 14  | 删掉 `deliverAs:"steer"`                   | 适配：turn_end 用 steer 投递             |
| 15  | 删掉 `#pump` 最终 `attach-steer`           | 引擎：退出时最终态入记录                 |
| 16  | registry 的 seq upsert 改成 append         | registry：同 seq 不重复                  |
| 17  | `reportStale` 比较方向翻转                 | child：报告早于转向                      |
| 18  | `dispatch_list` 的 `steers` 条件展开常开   | 适配：默认关无 steers 键                 |
| 19  | 删掉 `typeof pi.sendUserMessage` 探测      | 适配：旧 pi 不崩                         |
| 20  | 发送失败也推进 `lastSeq`                   | 适配：发送失败下轮重试                   |
| 21  | 删掉“无扩展路径/纯空白/4096 边界”检查      | 引擎：所有拒绝分支都 `ok:false`          |
| 22  | 已有 `steer.jsonl` 时 seq 从 1 重开        | 引擎：预置文件后续号                     |
| 23  | `undelivered` 写成 `sent`                  | 引擎：退出对账终态                       |
| 24  | `judgeSteer` 的 `ok` 恒 true               | verdicts：正反夹具                       |
| 25  | 删掉 `hasReliableReport` 的 `!reportStale` | 适配：stale 报告失去小窗                 |
| 26  | `lastSeq` 比较 `>` 改 `>=`                 | 适配：同一条不重投                       |

**破坏点**（`scripts/breakpoints.ts`，先 `pnpm fmt` 再取锚点；`pnpm check:breakpoints` 必须串行，它会临时改写源码）：

1. `child.ts` 的 user 回显分支改成 `if (false)` ⇒ 证据链用例必红。
2. `queue_update` 的标记扫描删掉 ⇒ `queued` 用例必红。
3. `index.ts` 的 `{ deliverAs: "steer" }` 改成无选项 ⇒ 投递用例必红。
4. `engine.ts` 的 `record.status !== "running"` 守卫改成恒放行 ⇒ 拒绝用例必红。
5. `#pump` 的最终 `attach-steer` 删掉 ⇒ 终态对账用例必红。**若格式化后跨语句、写不出单行 `from`，改为变异测试**，并在 `scripts/breakpoints.ts` 顶部“写不出单行破坏点”清单登记原因；不要硬造脆弱锚点。
6. `childEnvFor` 的 `delete env.PI_DISPATCH_STEER_FILE` 删掉 ⇒ 孙任务串台用例必红。
7. `dispatch_list` 的 `steers` 条件展开改成永久展开 ⇒ 默认关逐字节基线必红。
8. `reportStale` 的比较方向翻转 ⇒ 报告过期用例必红。
9. 第 17 条上限的 `>=` 改 `>` ⇒ 上限用例必红。

每条破坏点的 `red` 必须是测试文件里**精确存在**的标题；0 命中会被跑器判 `bad-title`，不是绿。

**已知等价变异**（写进测试文件头，不强行杀）：`?? []` vs `|| []`（值已确定为数组）；守卫后的可选链重复兜底；`text.trim()` 后与 `!text.trim()`；`\d+` vs `[0-9]+`；缺文件时 `return 0` 与 catch 后 `return 0`。

### 5.3 假绿测试

假绿 = 功能坏了，测试仍然绿。每条都要有防线，且防线本身要被验证。

| #   | 假绿场景                       | 为什么会绿                                                                 | 防线                                                                                                                                                                                                              |
| --- | ------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 测试门禁环境泄漏               | 继承 `NODE_TEST_CONTEXT`/`PI_DISPATCH_DEPTH` 时 `node --test` 0 用例仍退 0 | 只走 `pnpm test`（`scripts/test.ts` 擦环境）；`test/test-runner.test.ts` 的标记文件用例守住                                                                                                                       |
| 2   | 破坏点 `red` 标题写错/0 命中   | node 输出 `ok 1 - <文件>` 且退 0                                           | 跑器判 `bad-title`；标题精确、唯一；先 `pnpm fmt` 再取锚点                                                                                                                                                        |
| 3   | 只断言 `ok` / 不断言状态       | `steer()` 返回 ok 但文件没写、状态没进记录                                 | 每条用例正例断言 `state/seq/文件行/事件顺序`，负例断言拒绝且不落盘                                                                                                                                                |
| 4   | 假 spawn 不吐事件              | `#pump` 测试只看到 sent，却断言通过                                        | 新增 `steeringSpawn`（不要复用 `recordingSpawn`）按真机顺序吐 `queue_update → user message_end → assistant message_end`；逐事件 `deepEqual` 断言 `type/role/content`，不是只数 `events.length`，更不是只看 `sent` |
| 5   | 合成流与真实 pi 不一致         | 手写 stream 只有 string content，真机是数组（或反之）                      | `REAL_STEER_STREAM` 真机样本 + string/array 两态；样本完整性用例断言 `parseChildStream` 恰好产出 `steers===[{seq:1,state:"seen"}]`、`userMessages.length===1`、`queueSteering.length===1`——字段漂移时这条先红     |
| 6   | `reportStale` 只剩缺席/true    | 没有报告，或报告总在转向后                                                 | 四例：无报告（键缺席）；报告早于最后 delivered（true）；报告晚于（缺席）；只有 queued 未 delivered（缺席）                                                                                                        |
| 7   | `dispatch_list` 只测键存在     | 条件展开常开也能过                                                         | 默认关记录 `!("steers" in record)` 逐字节 golden；开启时断言 `steers.length === 1` 且字段值具体，不只看键在不在；变异必须是 `steers: record.steers ?? []`（真的加键），不能只把条件改常开却仍给 `undefined`       |
| 8   | `sendUserMessage` 只测被调用   | 没带 `deliverAs:"steer"` 也会进队列（或新开 run）                          | fake pi 记录 options，断言 `deliverAs === "steer"` 与完整 wire 文本                                                                                                                                               |
| 9   | 测试间共享 `#steerSeq`/storage | 上一个用例的 seq 让下一个用例碰巧过                                        | 每个用例 isolated storage + fresh engine；不跨文件共享状态                                                                                                                                                        |
| 10  | 真机腿 skip 当通过             | TUI 缺 pyte 时 skip；steer 腿也跟着 skip                                   | steer 腿在 pi 可用时必须 fail 不 skip；skip 要显式报告                                                                                                                                                            |
| 11  | `check:breakpoints` 并行跑     | 两跑互相读到改到一半的源码                                                 | 串行；CI 不加并行矩阵                                                                                                                                                                                             |
| 12  | 在子代理里直接 `node --test`   | `PI_DISPATCH_DEPTH` 让适配层按孩子装配，0 用例退 0                         | 只用 `pnpm test`；子代理任务里也走门禁                                                                                                                                                                            |

**假绿的元测试**（测试「测试能不能抓住假绿」）：

- 在 `test/test-runner.test.ts` 加一例：构造一条 `red` 标题故意写错的破坏点，`check:breakpoints` 必须报 `bad-title`，不能报 killed。**不要在测试里对仓库源码跑完整 `check:breakpoints`**（它会临时改写源码）；把 `runOne` 的判定核抽成可注入函数，或在临时 overlay/临时目录里跑。
- 在 `test/engine.test.ts` 加一例「负控制」：把 `status` 设成终态后 `steer()` 必须拒绝且文件不存在；如果守卫被删，这条先红。
- **bad-title 元测试是前置项，不是 follow-up**：先抽 `scripts/breakpoints.ts` 的 `runOne`/outcome 判定核为可注入函数（或导出 `check`），再在 `test/test-runner.test.ts` 断言「red 标题写错 ⇒ `bad-title`，不是 killed」。核没抽出前不合并 steering 功能代码；这条不能靠人审代替。
- 假 spawn 的 `events` 要带「真的发过」标记；测试末尾断言 `events.length > 0`，防止 spawn 根本没被调用也绿。

### 5.4 真实测试

真实测试不进 `node --test` 快腿；`pnpm test:mode` 手动跑，真模型、真 pi、真钱。

1. **引擎腿（已落地，`--steer-only` 3/3 通过）**：`scripts/verify-modes.ts` 的 `caseEngineSteer()` 直接构造 `TaskEngine` 派真 pi 孩子，任务为 `Run the bash command sleep 12, then reply with exactly the word DONE`；轮询到 running 后由 Node 侧调 `engine.steer(taskId, "After the sleep finishes, reply exactly STEERED instead of DONE.")`，终态用 `judgeSteer(record, childLog)` 判。这条腿不依赖父方模型是否调用工具，是可重复的确定性入口。`judgeSteer` 只看 `parseChildStream(childLog).text`（最后一条 assistant），不看 user 回显里的 `STEERED`。
2. **RPC 长驻父 + 多回合孩子 steer（未落地）**：计划在父第一次 `dispatch_task` tool result 返回 taskId 后立刻 `dispatch_steer`；断言工具结果 `sent`、`output.log` 的回显在 `turn_end` 之后/下一条 assistant 之前、最终正文改向、`steers[0].state === "seen"`。实测父方模型在长任务里不一定调用 `dispatch_steer`，这条腿不能作为唯一验收入口；先保留引擎腿。
3. **最后 turn_end 窗口（未落地）**：用独立夹具在最后 `turn_end` 写 ready/等 release，验证「handler 先读」与「handler 后才写」两个方向；负控制允许 `queued/undelivered`，不得停 `sent`。当前只用引擎腿与合成流覆盖。
4. **TUI 腿（未落地）**：真 pty 里让父 agent 调 `dispatch_steer`，断言常驻面板不新增行、终态通知出现「转向 N 条」。缺 pyte 时显式 `skipped`，按 `passed/(len-skipped)` 汇总，不算 ✅。
5. **真实流回灌（未落地）**：把引擎腿孩子的 `output.log` 脱敏成 `REAL_STEER_STREAM`，至少含 `queue_update`、user `message_end`、assistant `message_end`，以及转向前后各一次 `child_report` toolResult；`test/child.test.ts` 直接吃样本并断言三态与 seq 精确，不用手写事件替代。

**成本与稳定性**：steer 腿约 1–2 分钟、一次真模型会话；超时 180s；provider 5xx 只重试一次；失败保留 `output.log` 与 taskId。TUI 腿只在本地有 pyte 时跑，CI 不跑。真机腿失败时不能把记录改成 succeeded；失败路径必须 `process.exit(3)`，不能让 skip/退 0 冒充通过。机器高负载（load > 100、可用内存 < 200MB）时 print/json/isolation 会因 no seats/120s 超时假红，真机腿应串行并在负载恢复后重跑。

### 5.5 验收顺序

1. `pnpm fmt`（先格式化，再取破坏点锚点）。
2. `pnpm test`（唯一门禁入口，擦继承环境）。
3. `pnpm check` / `pnpm lint` / `pnpm fmt:check` 全绿。
4. `pnpm check:breakpoints` 串行跑，全 killed；`bad-title`/`survived` 都算失败。
5. `pnpm mutate`：退出码 3 是既有基线；新代码零幸存；等价变异写进测试文件头。
6. `pnpm test:mode` steer 腿；保存 `REAL_STEER_STREAM`；TUI 腿按 pyte 可用性 skip/跑。
7. `docs/spec/core-spec.html` 同步；`README`/`GLOSSARY` 补工具与术语。

## 6. RPC 升级路径（不作为首版）

如果后续需要**真正抢占**（中断长工具）、**撤回/查看队列**、或只想要一套协议，再切 RPC。已证事实与代价：

- 孩子改 `pi --mode rpc --no-session`，初始 prompt 走 stdin `{"type":"prompt"}`；转向走 `{"type":"steer"}`；settle 后 `closeInput()`。
- 完成判定改为 `agent_settled`（不是进程退出）；退出码永远 0，必须用 `agent_settled.aborted` / `agent_end.stopReason` / `auto_retry_end` 推导 `runFailed`，否则会把 provider 错误记成 succeeded。
- 初始 prompt 的 response `disposition` 必须是 `started`；否则 kill + failed，不能挂住。
- `stop` 先发 `abort` 再关 stdin，SIGTERM/SIGKILL 仍作兜底。
- 好处：`clear_queue` 可做收尾补救，`set_steering_mode` 可控多条转向，`get_state` 可查队列。
- 代价：所有 child argv/stdio/退出/golden 测试重写；长驻路径整体换传输，是最大回归面。

**触发升级的条件**（任一）：需要中断长工具后立刻转向；需要撤回已排队转向；需要把「转向」做成跨 harness 的统一协议；或者维护者愿意承担一次完整的生命周期重验。

## 7. 多 harness 对照与裁决

| Harness         | 投递                                                                 | 证据                                            | 磁盘/收据                                             | 受理               | 独有贡献                                                                    | 裁决                                                          |
| --------------- | -------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------- | ------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Claude          | 文件信箱，`000001-uuid.json`，tmp→rename，`.done`                    | user `message_end` + 后续 assistant（`acted`）  | 聚合 `{sent,delivered?,acted?}`；终态才报 delivered   | queued 放行        | 运行中只报 sent 的诚实口径；通知措辞                                        | 采纳终态对账/通知；queued 不采纳                              |
| Codex           | 文件信箱 `steering/queue/<seq>-<uuid>.json`，tmp→rename，seen/failed | `queue_update` → user `message_end` → assistant | 逐条 `{id,seq,at,chars,queued?,delivered?,answered?}` | 只 running         | 逐条收据、7 条破坏点、`judgeSteering`                                       | 采纳逐条收据/破坏点；per-file 与版本门不采纳                  |
| OpenCode        | 文件信箱 `pending/injected/dropped`，原子 rename                     | user `message_end`                              | 四级；8 KiB                                           | 只 running         | `content` string/array；`sendUserMessage` 自 0.37.3                         | 采纳 string/array 与版本事实                                  |
| OpenCode2       | JSONL `steer/notes.jsonl`                                            | `custom_message` 回声 `details.seq`             | `{sent,delivered}`                                    | 只 running         | `reportStale` / `hasReliableReport`；`agent_before_settle`                  | 采纳 JSONL、reportStale；custom_message 不采纳                |
| Kimi            | 每任务目录，一条一文件 `<seq>.json`                                  | `turn_end`/`tool_execution_end` 自取；XML 转义  | 聚合 `{sent,queued?,absorbed?}`                       | 只 running         | `queued>absorbed` 诊断；砍 ack/增量/兜底的理由；5 行在飞正文建议            | 采纳诊断与砍法；per-file/XML 不采纳                           |
| Pi              | JSONL `steer.jsonl`                                                  | `turn_end`；raw text + `queue_update` 文本匹配  | 聚合 `{sent,seen,absorbed}`                           | 只 running         | 父方空闲时 `sendUserMessage` 会新开 run；证据契约风险                       | 采纳 JSONL、turn_end 单钩子、风险；逐条 id 保留               |
| OMP             | JSONL `steer.jsonl`                                                  | `message_start{role:"user"}`                    | `{sent,delivered}`                                    | queued 可写        | 源码证明 post-run `hasQueuedMessages()` 会 continue；fd3 否决               | 采纳 post-run 证据；queued 不采纳；message_start 作为备选证据 |
| CodeBuddy       | 每任务 `steer/inbox/*.json`，tmp→rename，`taken/` 认领               | `message_start{role:"user"}`                    | `{id,at,chars,deliveredAt?}`                          | queued+running     | `turn_end` handler 被 await、isStreaming 真；print 整轮 await；至多一次认领 | 采纳源码事实、4 KiB 上限、无 hostMode 硬门；per-file 不采纳   |
| Kilo            | **RPC 长驻 + 原生 `steer`**                                          | 协议 response + user 回显                       | `steers?: string[]`                                   | 只 running（长驻） | 唯一 RPC 派；指出信箱是在重造队列                                           | 首版不采纳；RPC 升级路径保留                                  |
| MCode（上一轮） | 文件信箱 + `turn_end`                                                | user 回显                                       | 聚合                                                  | 只 running         | env 擦除、上限、在飞正文不可见的提醒                                        | 采纳 env/上限/可见性提醒                                      |

**共识（8/9 选信箱）**：`turn_end` 边界、`sendUserMessage({deliverAs:"steer"})`、不改 argv/stdio/退出码、不打断在飞工具、不加 TaskStatus、不做广播/优先级/TUI、送达证据来自 stdout 而非孩子自述。

**分歧与裁决**：

- **Kilo 的 RPC vs 信箱** → 首版信箱；RPC 只在需要 abort/撤回/统一协议时升级。理由见 §3：送达时机相同，RPC 的改动面大一个数量级。
- **queued 是否受理**（Claude/OMP/CodeBuddy 放行）→ 只 running。`queued` 改向等于改初始任务，`stop` 后重派更简单；避免「改了却没起」的新竞态。
- **per-file vs JSONL** → JSONL。≤16 条，单写者 append，孩子 `lastSeq` 去重；per-file 的 rename/claim/目录树只增加文件操作。
- **裸文本 vs 标记信封** → 标记信封。模型知道这是父方在运行中插话；首行标记让证据确定，不靠全文本匹配。
- **终态对账 vs 增量解析** → 终态。运行中只报 `sent`；不做 `parseStreamLine`，不改 `#pump` 主干。
- **`agent_before_settle`** → 首版不做。OMP 的 post-run drain 已覆盖「最后 turn_end 入队」；剩下的是毫秒级窗口，先真机测，再决定是否加第二个钩子。
- **版本门** → 不加。`sendUserMessage` 自 0.37.3 起有，peer `>=1.0.0`；孩子侧 `typeof` 探测兜底。
- **报告过期** → 加 `reportStale`。OpenCode2 的 `hasReliableReport` 规则直接复用。
- **custom_message vs sendUserMessage** → `sendUserMessage`。真机已证；`custom_message` + `continue` 未证，且要自己拼事件。
- **上限 4 KiB vs 8 KiB** → 4 KiB。转向文本会留在后续每个请求里，宁紧勿松；常量可调。
- **记录是否存正文** → 存。`dispatch_list` 投影不回正文；记录留审计，`removeTrace` 后仍能解释当时说了什么。

## 8. 实施顺序（确认后）

1. `src/core/steer.ts` + `types.ts` + `storage.ts` + `registry.ts`（数据与账）。
2. `child.ts` 的证据扫描（user/queue_update/reportStale）；`engine.ts` 的 `childEnvFor` / `steer()` / `#pump` 终态对账。
3. `index.ts` 孩子钩子 + 父工具 + `dispatch_list` + 通知。
4. 单测 + 破坏点 + 变异。
5. `pnpm fmt` → `pnpm test/check/lint/fmt:check` → `pnpm check:breakpoints` → `pnpm mutate`。
6. `pnpm test:mode` steer 腿 → `docs/spec/core-spec.html` 同步。

每段只动本段文件，不顺手扩范围；段边界停下等确认。

**同批可后置的加固**（不阻塞 v1）：`agent_before_settle` 第二钩子；`#pump` 在飞正文 append（让 `dispatch_read` 看到「现在」）；TUI 转向按钮。

## 9. 风险与未证

- **已实测**：RPC steer 的送达语义/边界/abort；print 模式 `turn_end` + `sendUserMessage({deliverAs:"steer"})` 的完整事件链；扩展 `child_report` 在 RPC 下可用。
- **代码级已证、真机未跑**：`turn_end` handler 被 await 且 `isStreaming` 为真；print 模式等整个 settled run；post-run `hasQueuedMessages()` 会 continue；`sendUserMessage` 自 0.37.3 起有。
- **未实测**：真实仓库扩展（而非探针扩展）加 `turn_end` 钩子后的完整真机腿；`pnpm test:mode` 的 steer 腿；`reportStale` 的真实行为；`agent_before_settle`（首版不用）。
- 最大风险：**最后一个 `turn_end` 之后写入的转向仍可能丢**（毫秒级窗口）。这是刻意的「不复活已结束 run」；收据会显示 `undelivered`，父方可选择重派。
- 第二风险：**证据契约**。`queue_update` / user `message_end` 的字段是 pi 的事件契约；pi 改字段会让 `queued/delivered/seen` 静默归零。必须用真机流样本钉住（`REAL_STEER_STREAM`），并用破坏点守住。
- 第二点五风险：**16MB stdout 砍头会丢早段转向证据**。`#pump` 只留末尾 `STDOUT_KEEP_CHARS`，超过后早段的 `queue_update`/user 回显会被砍掉，已送达甚至已生效的转向会被收成 `undelivered`。方向是保守的（不会假报送达），但父方会误以为没送到；长跑大输出的孩子要留意，补增量证据解析前记为已知边界。
- 第三风险：**报告可能早于转向**。已用 `reportStale` 标记；父方应以最终正文 + delivery 为准。
- 第四风险：**父方看不到在飞正文**。`output.log` 在退出时才落盘，`dispatch_read` 读不到「现在」。这不是转向的 blocker，但决定了父方凭什么知道要转向。最省的补法是在 `#pump` 的 `onOutput` 里顺手 append 输出并截断记账（约 10 行，独立一件事），建议下一批再做。
- 第五风险：**模型不一定照办**。收据只证明「进了 transcript / 下一轮跑了」，不证明语义服从；不要造「服从率」字段。
- **信任边界**：转向文本是父方（模型）写的，但会作为 user 消息进入孩子上下文；限长 4096、条数 16、只认首行标记；`content` 的 string/array 两种形态都要处理。孩子模型改不了自己的 user 回显，证据不依赖孩子自述。
- **明确跳过**：TUI 人工转向面、follow-up、图片、撤回/优先级、跨会话恢复、嵌套转向（孩子没有 `dispatch_task` 工具）、广播。

## 10. 实施状态（2026-11-22）

**已落地**：`src/core/steer.ts`（marker/上限/解析/对账/`planSteer`/`isReportStale`）、`storage` 的 `steerPath`/`appendSteer`/`readSteer`、`registry` 的 `attach-steer`、`child` 的 queue/user/assistant 证据链、`engine` 的 `steer()`/env 注入/退出对账、`index` 的 `dispatch_steer`/孩子收件箱/列表投影/通知、`scripts/verdicts.ts` 的 `judgeSteer`。新增测试 `test/steer.test.ts` 与 child/engine/core-logic/adapter/verdicts 增补。

**门禁结果**：

- `pnpm test`：607 pass / 0 fail。
- `pnpm check`、`pnpm fmt:check`：通过；`pnpm exec oxlint` 仅既有 warning。
- `pnpm check:breakpoints`：199/199 红在该红的测试用例上（新增：marker 整行精确、wire 框架语、回显需同 seq 队列证据、seen 补 deliveredAt、judgeSteer 只看 assistant、reportStale 通知、17MB 尾部截断证据、非字符串/seq/信箱限长、tally 混合计数、收据单调）。
- `mutator`：`steer.ts` 90 位点，`test/steer.test.ts` 下账本为 84 killed / 6 survived；6 条为已登记等价/探针假阴性（`parseSteerLines` 的 `<=` 一条待复核），详见 `docs/spec/steering-final-plan.md` 与 `test/steer.test.ts` 文件头。`tallySteers` 已从 6 个幸存降为 0。`judgeSteer` 10/10。
- `node scripts/verify-modes.ts --steer-only`：3/3 通过（running → seq=1 → state=seen），用的是真 pi 孩子与 `sleep 12` 中途插话。
- `pnpm test:mode`：26/26 全绿（含 steer、steer-iso、rpc、tui、isolation、blackboard）。

**已知边界（16MB 证据截断已用增量追踪修复）**：

- `#pump` 仍只留 stdout 末尾 16MB 作文本，但转向证据已由 `createSteerEvidenceTracker()` 在流式阶段单独累计；17MB 用例与真机样本覆盖。
- `sendUserMessage` 声明为 `void`，运行时的异步失败无法在这一层可靠捕获；同步抛错才回退游标。按「尽力而为」理解，不承诺异步失败重试。
- 父方 RPC `dispatch_steer` 腿、最后 `turn_end` 夹具、TUI 腿、`REAL_STEER_STREAM` 回灌尚未落地；真机验收当前以引擎腿为准。
- 机器高负载（load > 100、可用内存 < 200MB）时 `test:mode` 的 print/json/isolation 会因 no seats/120s 超时假红；真机腿应串行并在负载恢复后重跑。
