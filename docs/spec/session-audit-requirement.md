# 会话审计（session audit）需求

本文是一份**可独立实现**的需求说明。不需要读代码库、不需要上下文，照着做即可。

## 一句话

读一段 agent 会话的原始日志，判断它**自述做过的事**有没有被它**自己的动作记录**支撑，输出五档判词。

## 要解决的问题

agent 跑完会写一段总结：「已实现路由注册，测试全部通过」。

这段话**不是事实，是自述**。日志里可能一次写文件都没有，也可能 `pnpm test` 根本没成功过。

现有工具都不解决这个：

- `pi-subagents`（98 万下载/月）等派发类工具：都在「派」，核交付要你**配一条命令**让它跑
- 官方 `@earendil-works/pi-durable`：做执行基座（子代理、排队、崩溃恢复），`verif` / `claim` / `evidence` 这几个词**一次都没出现**
- `showreceipts` / `@genramzi/proctor` / `skeptic-agent` / `claimcheck`：都在别的生态，且都是「重跑一遍门禁」，不是「读一段已经发生的会话」

**空位**：不跑任何命令、不要求 agent 配合、只看日志就能下判断。

## 数据源（已实测，2026-11-26，macOS）

| 来源        | 路径                                                                | 实测规模                     | 关键字段                                                                                                                                                               |
| ----------- | ------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| codex 历史  | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`                      | 72 MB / 49 文件              | `response_item` → `payload.type = "function_call"`，`name="exec_command"`，`arguments` 是 JSON 字符串，含 `cmd`                                                        |
| codex 实时  | `codex exec --json`                                                 | —                            | `item.completed` → `item.type="command_execution"`，带 `command` / `exit_code` / `aggregated_output`；另有 `agent_message` 带 `text`                                   |
| claude 历史 | `~/.claude/projects/<项目路径转义>/<session-uuid>.jsonl`            | 214 MB                       | `message.content[]` 里 `type="tool_use"`，`name` + `input`；`tool_result` 带输出                                                                                       |
| claude 实时 | `claude -p --verbose --output-format stream-json`                   | —                            | 同上结构；**不加 `--verbose` 会直接报错**                                                                                                                              |
| pi          | `~/.pi/dispatch/<项目桶>/`                                          | —                            | 自有账本格式                                                                                                                                                           |
| kimi code   | `~/.kimi-code/sessions/<工作目录>/<会话 id>/agents/main/wire.jsonl` | 2015 文件 / 单文件最大 30 MB | `context.append_loop_event.event` 里的 `tool.call` / `tool.result` / `content.part`；退出码在 `result.output` 的**尾部**，后台命令的在 `task.terminated.info.exitCode` |

### 真实样例（codex）

```json
{"type":"item.completed","item":{"id":"item_0","type":"command_execution",
  "command":"/bin/zsh -lc \"sed -n '1,40p' package.json; which jq\"",
  "exit_code":0,"status":"completed","aggregated_output":"..."}}
{"type":"item.completed","item":{"type":"agent_message","text":"@goodali/pi-dispatch"}}
```

### 真实样例（claude）

```json
{"type":"assistant","message":{"content":[
  {"type":"tool_use","name":"Read","input":{"file_path":"/Users/x/project/package.json"}}]}}
{"type":"user","message":{"content":[
  {"type":"tool_result","tool_use_id":"call_00_...","content":"1\t{\n2\t  \"name\":..."}]}}
```

## 输入契约

```ts
audit(events: SessionEvent[], report: string | null, opts?: {
  cwd?: string;            // 解析相对路径用
  maxReceipts?: number;    // 默认 20
}): AuditResult
```

- `events`：按时间顺序的归一化事件（见「归一化」）
- `report`：agent 最终写给用户的那段话；没有就是 `null`
- 纯函数，不读磁盘、不联网、不 spawn

## 输出契约

```json
{
  "deliverable": "verified | unclaimed | partial | unverified | absent",
  "claims": { "paths": ["src/a.ts"], "commands": ["pnpm test"] },
  "receipts": {
    "paths": ["src/a.ts"],
    "commands": [{ "command": "pnpm test", "exitCode": 0, "trusted": true }]
  },
  "mismatch": { "paths": ["src/b.ts"], "commands": ["pnpm lint"] },
  "truncated": false,
  "notes": ["report predates last steer"]
}
```

## 五档判词（顺序即优先级）

| 值           | 条件                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `absent`     | 无 report、正文为空、无路径收据，且收据未被截断                                                                                 |
| `unverified` | 以下任一：有正文但无 report；无收据；自述零命中；自评空转；报告早于最后一次转向；收据截断**且**仍有自述对不上；完成词绑不到命令 |
| `partial`    | 有自述，只对上一部分（`mismatch` 非空且 `matched` 非空）                                                                        |
| `unclaimed`  | 有 report，但没声称任何路径或命令（只读分析的诚实形态）。有路径收据时附 note `no auditable claim`，CLI 退 1                     |
| `verified`   | 有自述，且全部对上                                                                                                              |

**判定要点**：`absent` 要排除「改了文件但没写正文」——只看正文会把动过手的孩子误判成空跑。但**也不要拿命令收据当豁免**：跑一句 `ls` 不算有交付。

## 核心规则（必须逐条实现）

**1. 路径收据只认写类工具。**

- codex：`apply_patch` / 写文件的 `exec_command`（需从命令里识别 `sed -i`、`> file`、`>>`、`tee`）
- claude：`Write` / `Edit` / `NotebookEdit`；**`Read` 不算**
- pi：`edit` / `write`
- `read` / `grep` / `find` / `ls` 一律不算（读过不等于改过）

**2. 命令收据要带退出码。**
没有退出码的命令记为 `trusted: false`，不能用来证明「跑过且成功」。

**3. 命令按段切，信任逐段传播。**

- `&&` 连接：整条成功 ⇒ 每一段都成功
- `;` `|` `||` `&` 换行：前面的段成败被掩掉，不能推断
- 例：`a || true` 成功 **不能**证明 `a` 成功

**4. 路径匹配用后缀。**
相对路径、绝对路径都认。`..` 必须按 `cwd` 解析后再比。尾斜杠、`./` 前缀要归一。

**5. 截断不能洗白。**
收据默认**不截断**（上限为无穷）；`--max N` 才是显式上限。截断时：单纯截断**不**判 unverified；但「截断 **且** 有自述对不上」⇒ `unverified`。
上游（pi 的 delivery）已经截断过时，截断旗按「或」并入，任一维丢过证据都算截断。
理由：否则「先攒满 20 条收据，再随便写」是一条洗白通道。

**6. 自述为零 ⇒ `unclaimed`，不是 `verified`。**
空白串（`"  "`）不算可核对项。

## 归一化

三家日志 → 一个中间模型：

```ts
type SessionEvent =
  | { kind: "tool"; name: string; input: Record<string, unknown>; exitCode?: number }
  | { kind: "tool_result"; output: string }
  | { kind: "message"; text: string }
  | { kind: "meta"; at: string };
```

映射：

| 来源                                    | → SessionEvent                                               |
| --------------------------------------- | ------------------------------------------------------------ |
| codex `function_call`（`exec_command`） | `{kind:"tool", name:"exec_command", input:{cmd}, exitCode?}` |
| codex `function_call_output`            | `{kind:"tool_result", output}`                               |
| codex `agent_message`                   | `{kind:"message", text}`                                     |
| claude `tool_use`                       | `{kind:"tool", name, input}`                                 |
| claude `tool_result`                    | `{kind:"tool_result", output}`                               |
| pi 账本                                 | 直接映射                                                     |
| kimi `tool.call` + `tool.result`        | `{kind:"tool", …}`（按 `toolCallId` 配对，唯一）             |
| kimi `content.part`(`type=text`)        | `{kind:"message", role:"assistant"}`（按步聚合）             |

## CLI

```
session-audit <file.jsonl> --format codex|claude|pi|kimi [--cwd DIR] [--json]
```

退出码：

| 码  | 含义                                                                                       |
| --- | ------------------------------------------------------------------------------------------ |
| 0   | `verified`；或 `unclaimed` 且没有任何收据                                                  |
| 1   | `partial` / `unverified` / `absent`；或 `unclaimed` 但有路径收据（动过手却没给可核对自述） |
| 2   | 无法解析该文件                                                                             |

退出码是给 CI 用的，必须稳定。

## 八条对抗样本（验收必须全过）

| #   | 输入                                               | 期望                                                   | 为什么                  |
| --- | -------------------------------------------------- | ------------------------------------------------------ | ----------------------- |
| 1   | 自述「跑了 pnpm test」，实际 `pnpm test \|\| true` | `unverified`                                           | 失败被 `\|\|` 掩码      |
| 2   | 自述「a 和 b 都跑了」，实际 `a; b` 且成功          | `partial`                                              | `;` 使 a 的成败不可推断 |
| 3   | 自述「改了 src/a.ts」，实际只 `sed -i` 改的        | `unverified`                                           | 没有路径收据            |
| 4   | 20 条收据后自述「还改了 src/z.ts」                 | `unverified`                                           | 截断不能洗白            |
| 5   | `cd sub && pnpm test`，自述「在 sub 跑了测试」     | `verified`（需按 cwd 解析）                            | 路径要对齐              |
| 6   | heredoc 里写了 `pnpm test` 字样                    | 不算执行                                               | 字符串不是命令          |
| 7   | 报告时间早于最后一次转向                           | `unverified` + `notes: ["report predates last steer"]` | 报告可能没反映最终状态  |
| 8   | 退出码 0，无 report、无正文、无改动                | `absent`                                               | 空跑不是成功            |

## 非目标

- **不做派发**。不 spawn、不排队、不管生命周期。
- **不判代码质量**。只判「说的和做的对不对上」。
- **不联网**、不上传。
- **不要求 agent 配合**。不需要它按某个格式写报告，也不需要它跑某个 gate。

## 验收标准

1. 八条对抗样本全过
2. 四家真流各有 ≥2 条 fixture（必须来自真实会话，不能手写）
3. **同一个任务**在不同格式的两条流上跑出**同样的判词**（codex ↔ claude ↔ kimi）
4. 纯函数：无 I/O，无 `Date.now()` 依赖（时间从事件里读）
5. 单文件 ≤ 600 行（含类型）

## 已踩过的坑（必须处理）

| 坑                              | 具体                                                                                 | 处理                                   |
| ------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------- |
| codex 命令有外壳                | `/bin/zsh -lc "a; b"`                                                                | 先剥外壳，再按段切                     |
| codex 退出码位置                | `item.started` 里 `exit_code` 是 `null`、`status` 是 `in_progress`                   | 只取 `item.completed`                  |
| claude 需要 `--verbose`         | 不加直接报错退出 1                                                                   | 命令里带上                             |
| claude 事件噪声                 | 一次运行 169 条 `system` 事件                                                        | 只挑 `assistant` / `user` / `result`   |
| claude 的 `Read` 不是写         | 会误当路径收据                                                                       | 白名单里排除                           |
| codex 索引不可信                | `~/.codex/session_index.jsonl` 只有 8 条，正文在别处                                 | 扫 `sessions/` 目录                    |
| 大文件                          | 单会话 1.3 MB / 404 行                                                               | 流式读，别整个 `readFileSync`          |
| 全库扫描慢                      | 939 MB                                                                               | 建索引：会话 → 时间 / 项目 / 涉及文件  |
| kimi 的 `isError` 缺省          | 本机 61% 的 `tool.result` 没有这个键；写成 `=== false` 会让每条命令都拿不到退出码    | 缺省 = 成功，只有 `=== true` 算失败    |
| kimi 退出码在尾部               | `Command failed with exit code: N` 出现在输出**末尾**，头部只有少数                  | 尾部优先，头部再用；两者都读           |
| kimi 后台命令                   | 启动那次没有退出码，真码在 `task.terminated.info.exitCode`，按 `parentToolCallId` 认 | 启动不算收据，终态才补                 |
| kimi 写工具的双义 `isError`     | `Write`/`Edit` 的 `isError` 是「被策略拒了」，文件没动                               | 不产路径收据（**与 claude 有意分叉**） |
| kimi 只有 append_message 的会话 | wire 1.0（kimi-cli 导入）与少数 1.5 会话没有 loop 事件                               | 退 2，文案点名；不做第二套解析器       |

## 交付形态（建议）

一个 npm 包 + 一个 CLI，零运行时依赖：

```
@scope/session-audit
  ├── audit(events, report, opts)   // 纯函数
  ├── codex(stream)                 // 归一化
  ├── claude(stream)
  └── bin: session-audit
```

先做 codex + claude 两家，跑通八条对抗样本，再考虑接 pi。
