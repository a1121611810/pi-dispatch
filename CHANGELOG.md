# 变更记录

本文件记录 pi-dispatch 的重要变更。

格式按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号按
[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.3.0] - 2026-11-28

### 新增

- `session-audit` 新增 `--format kimi`：读 Kimi Code 的 `wire.jsonl`（wire 1.3–1.5），入参可以是文件，也可以是
  会话目录（自动取 `agents/main/wire.jsonl`，不并子代理侧链）。
  - `isError` 缺省即成功（本机 708 份主线里 77.8% 的结果没有这个键）；失败退出码尾部优先、头部再用。
  - 后台命令的启动不算收据，退出码在 `task.terminated` 里按 `parentToolCallId` 补；**报告之后才跑完的终态不给报告作证**。
  - `Write` / `Edit` 的被拒调用不产路径收据（与 claude 有意分叉）。
  - wire 1.0 与只有 `context.append_message` 的会话不做支持，退 `2` 并在文案里点名。
- 真夹具 `test/fixtures/session-audit/kimi-{write,readonly}.jsonl`（来自真实会话，裁剪 + 脱敏）。
- 修复：`--json` 走管道时在 128 KiB 处被截断（`process.exit` 丢弃了异步 stdout 的尾巴）。
- 修复：用户敲斜杠触发的技能回合（`skill_activation` + `trigger: user-slash`）曾被当注入吞掉，
  报告之后的人话因此标不出「早于最后一次转向」。
- 破坏点 19 条（`scripts/breakpoints.ts`），`pnpm check:breakpoints` 395/395 全 killed。

## [0.2.1] - 2026-11-27

修 `--help` 里的退出码说明。0.2.0 的文案还写着「unclaimed 一律退 0」，实际实现是「unclaimed 且有路径收据退 1」。

- `session-audit --help` 的三行退出码说明改成与实现一致。
- 补一条 CLI 用例钉住这段文案。

## [0.2.0] - 2026-11-27

新增离线审计：读一份 codex / claude / pi 的会话日志，把智能体自述做过的事和它自己动作留下的收据对一遍。

### 新增

- `session-audit` 命令行（`bin`）：`--format codex|claude|pi`、`--cwd DIR`、`--max N`、`--json`、`--strict`。
  退出码 `0` = `verified`，或什么都没观测到的 `unclaimed`；`1` = 其余，含动过手却没给可核对自述的 `unclaimed`；`2` = 日志解析不了。
- `@goodali/pi-dispatch/audit` 导出：`audit(events, report, opts)`。纯函数，不读盘、不看时钟。
- 三家日志的归一化：codex（历史与实时两种信封、按 `call_id` 找回原始命令）、claude（写工具白名单、`tool_use` 配对、退出码四分区）、pi（复用 `parseChildStream`）。
- 判词附带的 note：`self-reported failure`、`no auditable claim`、`vague success claim`、`report predates last steer`。
- `pnpm mutate:audit`：把变异测试收缩到 `src/audit`。

### 变更

- 失败自述改按「失败可推位」判定。`a && b` 退 1 时不断言某一条失败；`a ; b` 和 `a || b` 的右侧可推；命令串里出现 `pipefail` 时整条不可推。
- 收据默认不截断（上限改为无穷），`--max N` 才是显式上限。此前模块内默认留 20 条。
- 零自述改判 `unclaimed`：有路径收据时附 note `no auditable claim`，CLI 退 1。此前判 `unverified`。
- shell 重定向（`>`、`>>`、`tee`）的目标记入路径收据；反引号里带扩展名的裸文件名也算路径。

### 修复

- 否定式自述被判成成功：`没有跑通：\`pnpm --version\` 报错`配退出码 0，此前给`verified`。
- Bash 调用缺命令文本时不再产出空收据。

### 已知限制

- 路径收据只来自写盘工具和 shell 重定向。用 `vim`、IDE 或子代理改的文件没有收据，报告再诚实也可能落在 `unverified`。
- `--strict` 只是把 `unclaimed` 当红，不扩大收据覆盖。

### 文档

- README 改成「派 / 查」两件事并列：`## Audit` 从第五节前移到 `## Dispatch` 之后，开头三句各说一件事。
- `docs/audit-mutation.md`：变异账，逐条列幸存者与等价推导。

## [0.1.2] - 2026-11-26

无功能变化。补齐 npm 搜索关键词，并给包目录加预览图。

- `keywords` 从 4 个补到 16 个，补上 `pi-extension`、`pi-coding-agent`、`subagent`、
  `multi-agent`、`parallel`、`verification` 等搜索词。
- `pi.image` 指向 `assets/social-preview.png`；Pi 包目录的卡片会显示这张图。
- README 重写为英文主文档加中文版，补了安装自检、竞品边界和限制说明。
- 新增 `CONTRIBUTING.md`、`workflows/release.md` 和社交预览图源文件。

## [0.1.1] - 2026-11-26

无功能变化。这次发布用来验证 CI 发版链路：打 tag 触发 workflow，用 npm trusted publishing
（OIDC）认证。0.1.0 是本地手动发布的，`publish` 这一步此前没有在 CI 里跑过。

## [0.1.0] - 2026-11-26

首个版本。

### 新增

- **交付判词与任务状态分成两条轴。** `status` 只由子代理的退出码决定，它不是质量结论；
  交付另有一列 `deliverable`，取 `verified` / `unclaimed` / `partial` / `unverified` /
  `absent` 五档，在终态时由 registry 算一次。空跑退出 0 记作 `succeeded` + `absent`，
  账上不再把「进程退 0」当成「干成了」。
- **派子代理** —— `dispatch_task` 递一段任务，立刻拿编号（长驻宿主 rpc/tui）或等它跑完拿交付物
  （一次性宿主 print/json）。
- **排队** —— 座位从内存池切份额，满了 FIFO 排队，永远不拒绝。
- **管住** —— 盯卡住（静默 5 分钟且无在飞工具）、超时收掉、能停（排队中的抽掉，在跑的
  SIGTERM→SIGKILL）。
- **转向** —— 孩子还在跑时用 `dispatch_steer` 插一句话，它在下一个回合边界看到后调整方向继续干；
  不打断在飞工具。收据分 `sent` / `queued` / `delivered` / `seen` / `undelivered`，终态通知汇总
  「转向 N 条：送达 D / 生效 S（未送达 U）」。
- **留痕** —— 每次派发一条记录，落 `~/.pi/dispatch/<项目桶>/`，原子写、压缩归档、重启恢复。
- **核对** —— 收据从子代理的动作里抽，不依赖它自述。报告三种通道（tool / prompt-json / none）。
  自述的文件和收据一个都对不上时标 `deliveryUnverified`（后缀匹配，相对与绝对路径都认），
  只对上一部分时带 `deliveryPartial`（`{claimed, matched}`）；谎报自检（`verified` 声称跑过的命令，
  收据 commands 里一条都没观测到）标 `verifyUnverified`，同一部分命中走 `verifyPartial`。
  意思是「没有实测支撑」，不是「一定在撒谎」。
