# 运行中转向：Ponytail-review × UB-mode 终审与最终方案

日期：2026-11-22
范围：未提交的 steering 实现（`src/core/steer.ts`、engine/child/registry/storage/types/index/notifications、verdicts/verify-modes/breakpoints、转向测试）。
审阅：9 个 harness 独立只读报告，见 `target/steering-final/<agent>.md`。全部按 `ponytail-review` 的 Must/Should/Nice 与 `ub-mode` 的 First Make it Work / Then Make it Right / Follow Practice 评审，并逐功能点核对“变异测试 + 假绿测试”。

## 结论

主路径成立：父方写信箱，孩子在 `turn_end` 用 `sendUserMessage(..., { deliverAs: "steer" })` 消费；真实引擎腿 `sleep 12` 中途插话得到 `state=seen`（3/3）。终态竞态（先 `#children.delete` 再对账）已在当前代码修掉，正常退出不会把收据永久留在 `sent`。

但按“每个功能点都必须有变异测试 + 假绿测试”的硬前提，当前**不能宣布全部达标**。9 份报告收敛出 4 组 P0，集中在“证据完整性、账本真实性、引擎守卫、边界输入”，不改主路径设计。

## 功能点矩阵（终审时）

图例：✅ 单测 + 变异/破坏点 + 假绿防线齐全；⚠️ 有缺口；— 不适用。

| #   | 功能点                   | 源码                                                                  | 现状 | 缺口                                                                                    |
| --- | ------------------------ | --------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------- |
| 1   | 标记整行精确             | `steer.ts` `STEER_MARKER_RE`                                          | ✅   | 无                                                                                      |
| 2   | wire 首行标记 + 框架语   | `steer.ts` `steerWire`                                                | ✅   | 无                                                                                      |
| 3   | 信箱 append / 续号       | `storage.ts`、`engine.ts`                                             | ⚠️   | append 失败分支、预存文件续号已有用例，但 `Storage.appendSteer` 无独立变异账本          |
| 4   | 孩子 `turn_end` 投递     | `index.ts` `registerSteerInbox`                                       | ⚠️   | handler 是私有闭包，mutator 零站点；真机样本缺失                                        |
| 5   | 游标失败重试             | `index.ts` `cursor.lastSeq`                                           | ⚠️   | 测试用同步 fake，真实 `sendUserMessage` 异步失败被吞（API 声明 `void`）                 |
| 6   | `queue_update` 证据      | `child.ts` `takeQueueUpdate`                                          | ⚠️   | 箭头回调去重无变异站点，3 条真实存活                                                    |
| 7   | user 回显证据            | `child.ts` `takeUserSteer`                                            | ⚠️   | 同上；初始 prompt 伪造已有负例                                                          |
| 8   | assistant `seen`         | `child.ts` `takeAssistantSeen`                                        | ⚠️   | 同上；多条回显共用一个 assistant 已有用例                                               |
| 9   | 收据对账                 | `steer.ts` `reconcileSteerReceipts`、`registry.ts` `applyAttachSteer` | ⚠️   | `tallySteers` 非空分支无用例（6 个账本幸存）；`applyAttachSteer` 可把 seen 降回 sent    |
| 10  | `reportStale` / 小窗资格 | `steer.ts` `isReportStale`、`index.ts` `hasReliableReport`            | ⚠️   | `hasReliableReport` 的 `!reportStale` 无正例；`reportStale: false` 会留键，三处口径不一 |
| 11  | 环境擦除/注入            | `engine.ts` `childEnvFor`                                             | ✅   | 已有擦除继承变量与注入用例                                                              |
| 12  | 列表投影                 | `index.ts` `dispatch_list`                                            | ⚠️   | 只测键存在，未测 true/false/缺席三态                                                    |
| 13  | 终态通知计数             | `notifications.ts`                                                    | ⚠️   | 只测空列表；`tallySteers` 非空分支无直接用例                                            |
| 14  | 拒绝矩阵                 | `steer.ts` `planSteer`、`engine.ts` `#steerNow`                       | ⚠️   | 预 spawn 窗口误拒；`readSteer` 抛错；非字符串 `text` 会崩；`seq` 无安全整数上限         |
| 15  | 真机 `judgeSteer`        | `verdicts.ts`、`verify-modes.ts`                                      | ⚠️   | 手写流，无 `REAL_STEER_STREAM`；pi 事件字段漂移会静默归零                               |

## P0（现在补，完成前不合并）

### P0-1 证据完整性：16MB 砍头与真机样本

- **问题**：`engine.ts` 的 `#pump` 只保留 stdout 末尾 `STDOUT_KEEP_CHARS`（16MB），退出时才整段解析。题设负载是“孩子跑十几分钟、输出数十 MB”；早段的 `queue_update` / user 回显被砍后，`reconcileSteerReceipts` 会把已送达的转向记成 `undelivered`，`isReportStale` 也会把旧报告说成新鲜。
- **最小修法**：在 `onOutput` 里接一个增量证据扫描器（复用 `parseChildStream` 的 `parseLine`/四个 `take*`，只累计证据，不累计正文），退出时与末尾解析结果合并；若短期不做，先在 `TaskRecord` 加 `evidenceTruncated`，截断时拒绝把 `sent` 判成 `undelivered`，并在通知里明说“证据被截断”。
- **测试/假绿**：`test/engine.test.ts` 加“17MB 输出，证据在头部，任务仍判 `seen`”；`verify-modes` 的引擎腿打印 `outputPath`，失败时可回看；真机样本 `REAL_STEER_STREAM` 从一次真实 steer 会话抓取，`test/child.test.ts` 断言 `parseChildStream` 恰好产出 `steers=[{seq:1,state:"seen"}]`、`userMessages.length===1`、`queueSteering.length===1`。

### P0-2 账本真实性：tally、bad-title、变异重跑

- **问题**：`tallySteers` 只有空列表用例，`.metrics/mutate/core.steer.edn` 显示 12 个幸存（tally 6、parse 2、reconcile 1、steerSeq 1、textOfContent 1、lastDeliveredLine 1），而 `steering-plan.md` §10 写“76 killed / 7 survived”，数字与账本不符；`bad-title` 元测试（red 标题写错必须判 `bad-title`）仍是声明的前置，未落地。
- **最小修法**：`test/steer.test.ts` 加一条混合状态用例（sent/queued/delivered/seen/undelivered 各一条，断言 `{total:5, delivered:2, seen:1, undelivered:3}`），杀 tally 6 个位点；从 `scripts/breakpoints.ts` 导出 `runOne`/outcome 判定核，在 `test/test-runner.test.ts` 加“故意写错 red 标题 ⇒ `bad-title`，不是 killed”；用完整测试命令重跑 `steer.ts` 的 mutator，把幸存逐条写进文件头等价清单或补测试；修正 §10 为账本真实数字。
- **假绿防线**：不要只断言 `ok`；断言 `tallySteers` 的具体计数与 `bad-title` 的具体 outcome；不要把窄测试命令下的账本当全量结论。

### P0-3 引擎守卫：预 spawn、终态、append 失败

- **问题**：`#steerNow` 用 `#children.has(taskId)` 拒绝，但 `status` 在 child 真正 spawn 前就已置 `running`（worktree/座位准备最长约 30s），此时 `dispatch_steer` 会被误拒；反过来，删掉 `#children.has` 守卫、删掉 `#pump` 的 `await #steerTail`、或让 `appendSteer` 失败仍 `attach sent`，现有 589 个用例仍全绿（Codex 手工变异证实）。
- **最小修法**：用 `#steerClosed` 集合替代 `#children.has`：`#pump` 开始 drain 时加入，`#steerNow` 只拒绝已关闭的任务；预 spawn 期间允许写信箱（孩子启动后会在 `turn_end` 读到，最坏结果只是 `undelivered`）。`appendSteer` 抛错时不产生 sent 记录；补三条 engine 用例：派发后立即 steer（不等 running）、最后 `turn_end` 后 steer 拒绝、append 失败无记录。
- **测试/假绿**：`test/engine.test.ts` 用可控 `steeringSpawn` 按 `queue_update → user message_end → assistant message_end` 顺序吐事件；不要复用 `recordingSpawn`（它的 `onOutput` 是空函数，会让 `seen` 假绿）。

### P0-4 边界输入：读、类型、seq

- **问题**：`Storage.readSteer` 直接 `readFileSync`，文件不可读/是目录会抛到 `dispatch_steer`；`planSteer` 对非字符串 `text` 调 `.trim()` 会崩；`parseSteerLines` 接受 `1e21` 这类非安全整数 seq，子代理可写坏信箱让后续 seq 失真；文件无大小上限。
- **最小修法**：`readSteer` 包 `try/catch`，失败返回空并让 `steer()` 返回 `ok:false`；`planSteer` 加 `typeof text !== "string"` 守卫；`parseSteerLines` 要求 `Number.isSafeInteger(seq) && seq > 0`，并给 `readSteer` 加 `MAX_STEERS * 8KB` 的读取上限；补 4 条负例（坏文件、非字符串、1e21、超长文件）。
- **假绿防线**：这些负例必须走公开入口（`engine.steer` / `parseSteerLines`），不要只测私有 helper。

## P1（下批）

1. `reportStale` 改成 `reportStale?: true`（只出现 true），`hasReliableReport` 加“stale 报告失去小窗”的正例与破坏点；`dispatch_list` 测 true/false/缺席三态。
2. `session_shutdown` 只注册一次：当前每次 `registerSteerInbox` 都新增一个 shutdown handler，旧 handler 会删掉新 WeakMap 项；用一个 per-pi 的 shutdown 注册表。
3. 异步发送契约：`sendUserMessage` 类型是 `void`，运行时失败不可靠捕获；注释与 README 改成“同步不抛才推进，异步尽力而为”，不要承诺重试。
4. 收据时间用事件时刻（若 pi 事件带 timestamp），否则合并成 `observedAt`，避免用对账时刻伪装送达时刻。
5. `verify-modes` 真机腿：超时从 90s 提到 180s；`scrubbedEnv` 擦除 `PI_DISPATCH_STEER_FILE`；TUI 腿缺 pyte 显式 skip，不计入通过率。
6. 父方 RPC `dispatch_steer` 腿、最后 `turn_end` gated fixture、TUI 腿：按计划 §5.4 补齐；补齐前文档只能写“引擎腿已验”。
7. `queued` 错误信息给替代路径（stop + 重派），不要让模型只看到“只受理 running”。

## P2（可删/后置）

- 删 `SteerOutcome.path`（绝对路径泄漏给模型，无读者）。
- 合并 `steerText` 与 `textOfContent` 的重复正文抽取；能复用就复用。
- `dispatch_steer` description 用常量插值 4096/16，避免文案与代码漂移。
- **RPC 升级路径明确后置**：只有出现“必须打断在飞工具 / 撤回已发转向 / 跨 harness 统一协议”任一需求才重开。

## 验收顺序

1. `pnpm fmt`。
2. `pnpm test`（新增 P0 用例后应为 589+）。
3. `pnpm check`、`pnpm fmt:check`、`pnpm exec oxlint`。
4. `pnpm check:breakpoints`（同一时间只跑一个；先清孤儿 mutator/breakpoints 进程）。
5. `pnpm exec mutator --no-coverage --mutate-all --test-command "node scripts/test.ts test/steer.test.ts test/child.test.ts test/engine.test.ts test/core-logic.test.ts test/adapter.test.ts test/verdicts.test.ts" src/core/steer.ts`，逐文件看 `:survived 0`，幸存只允许是文件头登记的等价变异。
6. `node scripts/verify-modes.ts --steer-only`（真 pi 孩子，3/3）。
7. 负载恢复（load < 30、可用内存 > 1GB）后跑一次干净 `pnpm test:mode`；高负载下的 print/json/isolation 红只能记为环境限制，不能当通过。

## 审阅来源

- `target/steering-final/claude.md`（竞态/账本）
- `target/steering-final/codex.md`（手工变异/私有路径）
- `target/steering-final/opencode.md`（真机腿/负载）
- `target/steering-final/opencode2.md`（数据形状/幂等）
- `target/steering-final/kimi.md`（文档/账本）
- `target/steering-final/pi.md`（适配层/工具面）
- `target/steering-final/omp.md`（测试设计）
- `target/steering-final/codebuddy.md`（边界/安全）
- `target/steering-final/kilo.md`（精简/升级路径）

未派发：`claude-agent-teams`（此前卡 Bypass Permissions 提示）、`zcode`（不能作为 Orca worker）、`mcode`（非 Orca agent）。

## 后续异常难度测试

隔离/共享/转向的异常难度测试与真机验收见 `docs/spec/hard-tests-report.md`（607 单测、199 破坏点、`test:mode` 26/26，含 `--steer-iso-only` 真机腿）。
