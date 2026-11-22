# 隔离 / 共享 / 运行中转向：异常难度测试与真机验收报告

日期：2026-11-22
目标：在已有 603 单测 / 199 破坏点基础上，补“异常难度”测试；覆盖隔离（worktree）、共享（blackboard / 同会话）、运行中转向及组合；每条尽量对应一个能杀死的变异；最后在真实 pi 上跑完整验收。

## 1. 派发与提案

9 个可用 harness 独立只读设计，报告在 `target/hard-tests/<agent>.md`，共 212 条候选（有重叠）：

| harness   | 候选 | 特点                                             |
| --------- | ---: | ------------------------------------------------ |
| claude    |   24 | 并发/竞态：两个隔离孩子同时 steer、stop/退出同刻 |
| codex     |   21 | 变异映射：私有守卫、跨目录组合、交付变异         |
| opencode  |   23 | 真机腿与资源上限；board 分页游标                 |
| opencode2 |   33 | 半写/崩溃恢复、FIFO、seq 溢出、非法状态          |
| kimi      |   25 | 文档承诺 vs 实际、半行 append、UTF-8 预算        |
| pi        |   25 | STEER_ORDER 降级、judgeSteer 假绿、信任边界      |
| omp       |   21 | 测试质量：空实现检查、最小断言集                 |
| codebuddy |   22 | 路径穿越、symlink、权限、超大输入                |
| kilo      |   18 | 精简/成本：哪些不要写、P0/P1/P2                  |

未派发：`claude-agent-teams`（Bypass Permissions 阻塞）、`zcode`（不能当 Orca worker）、`mcode`（非 Orca agent）。

## 2. 整合结果

不是把 212 条全写进来；按“确定性、便宜、杀关键路径、能长期维护”选了 12 组，落到现有测试文件。

### 2.1 发现并修掉的真实缺口

1. **信箱半行后追加会把新 JSON 粘进坏行**（`storage.appendSteer`）：父方崩溃留下半行时，下一条 `append` 直接拼接，`parseSteerLines` 会把两条一起丢掉。现在先看末字节，必要时补 `\n`；测试「信箱末尾半行时，新转向另起一行仍可解析」。
2. **seq 到 `Number.MAX_SAFE_INTEGER` 后 +1 写出不可解析值**（`planSteer`）：加安全整数守卫，返回 `steering sequence exhausted`；测试「受理计划……续号」覆盖。
3. **`readSteer` 对 FIFO / 目录会阻塞或抛错**：先 `stat`，只收 regular file；超过 256KB 拒绝。测试用 `mkfifo` 验证快速报错，不挂死测试进程。
4. **关板后仍能写入**（`BlackboardStore.append`）：`close()` 只补 `closedAt`，写侧不查。现在关板后写抛「黑板已关闭」，读仍可看证据；测试与破坏点各一。
5. **收据阶梯顺序错误**（`STEER_ORDER`）：原先 `undelivered` 排在 `seen` 后，迟到的 `undelivered` 能把 `seen` 降级。改为 `sent < undelivered < queued < delivered < seen`，并补「迟到的 undelivered 也不许降级」。
6. **半行 tracker 证据**：`createSteerEvidenceTracker` 按 chunk 切分也能在 `finish` 消费半行；测试按 7 字节切片，防止“只在整行输入下正确”。

### 2.2 新增/加强的测试

- `test/engine.test.ts`
  - 17MB 输出、证据在头部，仍对成 `seen`（防 16MB 砍头假 undelivered）。
  - 建盘等待期间（running 但未 spawn）可受理；append 失败不记 sent；进入退出对账后拒绝。
  - 信箱半行后追加、FIFO/目录、超限、坏文件。
  - 两个隔离孩子各有 worktree / seq，互不串线；steer 后父仓不被污染。
  - `reportStale` 正常/早于/晚于；通知只带 true。
- `test/child.test.ts`
  - 真机流 `test/fixtures/real-steer.jsonl` 恰好一条 queued/delivered/seen，正文 `STEERED`。
  - 增量 tracker 在 chunk 中间切断不丢证据；重复 queue/user/assistant 只记一次。
- `test/core-logic.test.ts`
  - `attach-steer` 迟到的 sent / undelivered 不许把 seen 降级。
- `test/blackboard.test.ts`
  - 关板后写入被拒、读取仍可看证据。
- `test/steer.test.ts`
  - 混合状态 tally；afterSeq 等号不重投；4096 放行 / 4097 跳过；非安全整数 seq；MAX_SAFE_INTEGER 耗尽。
- `test/test-runner.test.ts`
  - red 标题写错 ⇒ `bad-title`（元测试），不再把 0 命中当 killed。
- `test/adapter.test.ts`
  - stale 报告落回大窗；重复 `session_start` 不叠加收件箱/shutdown。

### 2.3 真机腿

新增 `caseSteerIsolated()` 与 `--steer-iso-only`：

- 真 git 仓 + 真 worktree + 真 pi；
- 孩子 `sleep 12` 中途 `engine.steer`；
- 断言 `state=seen`、worktree 存在、父仓 `git status --porcelain` 为空。

## 3. 最终门禁

- `pnpm test`：**607 pass / 0 fail**。
- `pnpm check`、`pnpm fmt:check`：通过；`oxlint` 仅既有 warning。
- `pnpm check:breakpoints`：**199/199** 红在该红的测试用例上。
- `pnpm test:mode`：**26/26 通过**（含 steer、steer-iso、rpc、tui、isolation、blackboard）。
- `node scripts/verify-modes.ts --steer-only`：3/3。
- `node scripts/verify-modes.ts --steer-iso-only`：3/3。
- 定向 `mutator`：
  - `blackboard.ts`：`append` 7/7 killed；新增「关板拒绝」无存活。
  - `storage.ts`：`endsWithNewline` 10/10 killed；`readSteer` 3/4，1 条为已有等价路径。
  - `registry.ts`：`applyAttachSteer` 4/7，3 条为 `??`/`>=`/常量等价，已登记。
  - `steer.ts`：84/90，6 条为已登记等价/探针假阴性；`parseSteerLines` 的 `<=` 一条仍待手工复核。

## 4. 没整合的候选（有意）

- **两个真兄弟同时 commit 后按顺序 merge**：模型是否愿意 commit 不可控，属 P2，允许 skip。
- **最后一个 `turn_end` 的精确竞态**：需要可控 gated fixture + 真 pi 事件，当前只做到“进入对账后拒绝”，不宣称覆盖所有时序。
- **父方 RPC 模型主动调用 `dispatch_steer`**：模型服从率不稳定，当前真机腿用引擎直调；工具接通已有 adapter 用例，不把模型行为当门禁。
- **异步 `sendUserMessage` 失败重试**：API 声明 `void`，运行时失败不可观测；只保留同步抛错回退游标的用例，不写假绿重试。
- **16MB/17MB 真机腿**：内存与时长不可接受；用合成 17MB 流 + 真机小流覆盖。

## 5. 结论

隔离、共享、转向三条主路径均在真实 pi 上跑通；新增的异常输入与并发用例能杀掉对应的破坏点/变异。当前仍是“候选测试套件”，不是 212 条全量落地；剩余 P1/P2 见 `target/hard-tests/*.md` 与 `docs/spec/steering-final-plan.md`。

**风险**：`steer.ts` 仍有 6 条变异幸存（其中 1 条待复核）；最后 `turn_end` / RPC 模型主动转向 / TUI 转向腿未做，长尾时序仍可能漏。
