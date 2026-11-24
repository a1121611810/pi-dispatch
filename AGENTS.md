# AGENTS.md — pi-dispatch

pi 的扩展：派子代理（队列 / 座位池 / 生命周期），收四样：正文、报告、用量、收据。核心在 `src/core/`，pi 适配在 `src/index.ts`。

## 一个原则：约束写进检查，不写成段落

每纠正一次智能体，先问「能不能变成确定性检查」（测试 / 破坏点 / lint / mutator），而不是往任何文档加一行。

投入优先级是倒金字塔：代码库 > 静态分析 > 验证 > 提示词 > 人审。本文件在最底层——只写环境查不到的东西。

## 摸代码：先 codegraph，后读文件

结构问题（X 怎么工作 / X 怎么调到 Y / 摸一片区域）先 `codegraph_explore`，返回的源码视为已读，别再开文件复核。改符号前用 `codegraph_callers` / `codegraph_impact` 拉影响面——正好喂「改动收尾」第 1 步的 scope 清单。索引不覆盖 `docs/spec/*.html`：规格对质照旧读文件。MCP 掉线时 `codegraph` CLI 等价；查不到先等几秒再怀疑（新文件约 4s 进图）。

## 改动收尾（按序做完才算完）

1. 代码 + 测试。新行为必须新测试。
2. `pnpm fmt`——**先格式化，再取破坏点锚点**（oxfmt 折行会折断锚点，仓里踩过）。
3. `pnpm test` / `check` / `lint` / `fmt:check` 全绿。
4. 新行为 → `scripts/breakpoints.ts` 加一条破坏点，然后 `pnpm check:breakpoints` 全 killed。一条功能点 = 一条测试 + 一条破坏点（术语见 GLOSSARY「测试纪律」）。
5. 新分支 / 解析器 / 钱或安全 → `pnpm mutate`：能杀则杀，杀不掉的写进对应测试文件头的「等价变异」段（写明为何在可达输入上等价）。
6. 行为变了 → `docs/spec/core-spec.html` 同步。

## 何时跑真机

`pnpm test:mode` 花真模型钱，只在改了这三处后手动跑：拼命令（`buildPiArgv`）、事件流解析（`parseChildStream`）、报告通道 / 用量。外加：TUI 人看面（`src/tui.ts` 的渲染/接线/清面）——完成线含 tui 腿「在飞上过屏、跑完面板即清」全 ✅。其余腿的完成线照旧：全部用例 ✅，含「没交报告账上也有数」（`reportChannel=none` 时用量仍非零）。

## 文档分工（各司其职）

| 文件                       | 角色                                           |
| -------------------------- | ---------------------------------------------- |
| `docs/spec/core-spec.html` | 设计说明，写给人看；代码跟它同步               |
| `GLOSSARY.md`              | 术语表：功能点 / 破坏点 / 假绿 / 验红……        |
| 测试文件头                 | 等价变异说明（mutator 杀不掉的，写清为何等价） |
| `scripts/breakpoints.ts`   | 假绿账本，可执行                               |
| 本文件                     | 只写环境查不到的：顺序、坑、约定               |

## 仓库约定

- JSONL 断言喂真机抓的样本（`test/child.test.ts` 的 `REAL_STREAM` / `REAL_TOOL_STREAM` / `REAL_USAGE_STREAM`）。
- 孩子 argv 每段都有理由；新增旗标要进 spec 的命令表，并补测试 + 破坏点。
- `pnpm mutate` 退出码 3 是基线（既有等价变异），新代码零幸存才是线。
- `pnpm mutate` 只覆盖导出的 defn/；`#` 私有方法不在扫描里（实测 `mutator --scan src/core/engine.ts` 只报 78 个位点、全是公有函数）。引擎接线由 `scripts/breakpoints.ts` 守。
- 门禁入口是 `scripts/test.ts`（`pnpm test`）：它先擦掉继承来的 `NODE_TEST_CONTEXT` / `PI_DISPATCH_DEPTH`，否则在测试进程或子代理里 `node --test` 一条用例都不跑却退出 0（假绿）。别直接 `node --test`。
- `pnpm check:breakpoints` 同时只能有一个在跑：它会临时改写源码再复原，并行两跑会读到对方改到一半的源码（实测：别人的中间态让锚点「出现 0 次」）。
- `pnpm check:breakpoints` 跑到一半被 `pkill` / SIGTERM 杀掉 ⇒ **源码里的变异不会被复原**（复原在 `finally` 里，SIGTERM 跳过它）⇒ 下一轮 `pnpm test` 会红一条不相干的用例，且三条 `engine.ts` 锚点「出现 0 次」。发现这种症状先查 `git diff src/` 有没有被改坏的行，别急着改测试。
