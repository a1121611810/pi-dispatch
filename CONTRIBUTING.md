# 贡献

## 环境

- Node.js >= 22.19.0（`engines` 下限）
- pnpm

```bash
pnpm install
```

## 常用命令

```bash
pnpm build             # rolldown 打包到 dist/
pnpm check             # tsrs 类型检查
pnpm lint              # oxlint
pnpm fmt               # oxfmt
pnpm test              # node:test（Node 22.19+ 原生跑 TS）
pnpm test:node22       # 用 Node 22.19.0（engines floor）跑一遍
pnpm check:breakpoints # 破坏点表：每个功能点改坏一处，指名的测试用例必须红
pnpm mutate            # 广谱变异（需本机 mutator 工具）
pnpm test:mode         # 真机验收（print/json/rpc/tui + 隔离/黑板/非 git 拒绝腿，真模型调用，慢且花钱）
```

`pnpm test:mode` 里的 tui 腿需要 python3 和 pyte。

## dist 入库

`dist/` 是提交进仓库的，因为 `pi install git:` 直接把克隆下来的目录当项目装。改完 `src/` 必须
跑 `pnpm build` 再提交，`pnpm build:check` 会在 CI 上比对产物和源码是否一致。

`dist/` 在 `.oxfmtignore` 里。oxfmt 会把 `0x811c9dc5` 改写成 `2166136261`，破坏 build:check。

## 两条测试纪律

**一、每个功能点都要有一条「改坏就必须红」的测试用例。**

写在 `scripts/breakpoints.ts`：`from` 改一处源码（必须唯一出现），`to` 是破坏版，`red` 是必须
变红的那条用例标题。

`pnpm check:breakpoints` 逐条验三种情况：假绿（改了还是绿的）、红错地方（红的是别的用例）、
标题写错（0 命中时 node 输出 `ok 1 - <文件名>`、退出码 0，看着像通过）。三种都判红。

写不出单行破坏点的功能点列在该文件顶部，逐条写明理由，不静默缺。

**二、真机验收的判断不落在模型散文上。**

`scripts/verdicts.ts` 里是纯函数，断言只看任务记录与子代理的 `output.log`。它们自己有夹具
用例（`test/verdicts.test.ts`），也各自进破坏点表。

## 本机跑门禁的注意事项

`TMPDIR` 必须显式设置，否则 worktree 相关用例会假红：

```bash
export TMPDIR=$(getconf DARWIN_USER_TEMP_DIR)
```

`pnpm check:breakpoints` 不能并发跑，两个进程会互相踩坏源码。跑之前也要先 `pnpm fmt`——
oxfmt 折行会折断破坏点锚点。

## 提交前

```bash
export TMPDIR=$(getconf DARWIN_USER_TEMP_DIR)
pnpm build && pnpm fmt:check && pnpm lint && pnpm check && pnpm test && pnpm check:privacy
```

`pnpm check:privacy` 扫所有入库文件里的本机路径和凭据。加文件时注意别把本地绝对路径带进去。

发版流程见 [`workflows/release.md`](./workflows/release.md)。
