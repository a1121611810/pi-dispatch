# pi-dispatch

Programmable subagent dispatch for [pi](https://github.com/earendil-works/pi).

派子代理出去干活，并且管住他们：排队、限流、盯住别卡死、能停、留痕、核对。

## 状态

核心已落地。`src/core/` 是 pi 无关的核心层（可独立测试），`src/index.ts` 是 pi 适配层。

## 它能干什么

- **派子代理** —— `dispatch_task` 递一段任务，立刻拿编号（长驻宿主 rpc）或等它跑完拿交付物（一次性宿主 print/json）
- **排队** —— 座位是从内存池切出来的份额，满了 FIFO 排队等，**永远不拒绝**
- **管住** —— 盯卡住（静默 5 分钟 + 无在飞工具）、超时收掉、能停（排队中的抽掉，在跑的 SIGTERM→SIGKILL）
- **留痕** —— 每次派发一条记录，落 `~/.pi/dispatch/<项目桶>/`，原子写、压缩归档、重启恢复
- **核对** —— 收据从子代理的动作抽（不依赖它自述）；报告三种通道（tool / prompt-json / none）；自述的文件和收据一个都对不上时标 `deliveryUnverified`（后缀匹配，相对/绝对路径都认）

## 父方工具

| 工具            | 作用                                                 |
| --------------- | ---------------------------------------------------- |
| `dispatch_task` | 派任务（8 个参数：`taskDescription` 必填，其余可选） |
| `dispatch_list` | 查记录（状态 / 时长 / 用量 / 报告 / 收据）           |
| `dispatch_stop` | 停任务                                               |

## 设计要点

- **核心层不 import pi** —— 全部业务规则在 `src/core/`，四个依赖（spawn / 读机器 / 时钟 / 存储目录）可注入
- **等待语义由宿主模式定** —— rpc 异步（立刻编号 + 终态通知），print/json 同步等终态（一次性宿主进程会先退出，异步会丢交付物）
- **座位 = 内存池份额** —— 池子量 = 可用 − 预留（总内存 10%），每座份额 = max(512 MiB, 总内存 2%)（实测校准：子代理峰值 RSS 约 148 MiB）
- **`allowScripts`** —— 一个布尔透传到拼命令：宽档只加 `-e builtin:codemode`（不动工具表），只读档在 `--tools` 名单里补上 `codemode`——两处都要，漏一处能力就看不见

## 已知边界

- **通知在 turn 边界投递** —— rpc 长驻宿主的终态通知 `deliverAs: "nextTurn"`，要等**下一个** turn 才到模型眼前。子代理在 turn N 结束时完成的通知，turn N 的 turn_end 已过了，最早 turn N+1 才投递。交互式使用没问题（用户会持续发消息）；纯脚本驱动要预期这一点。
- **print/json 同步等待可能很长** —— 子代理跑几分钟，父方工具调用就一直挂着。有 `timeoutMs` 与卡住判定兜底。
- **座位 0 时一次性宿主直接退回** —— 机器太挤（可用低于预留）时 `seatCap` 是 0，这个进程里没有任何子代理能结束并腾出座位，因此不等、直接回「machine is too tight」，避免挂死父方。
- **只读档位不是沙箱** —— strict 挡「改」不挡「读」，pi 的读工具没有目录囚禁。
- **交付核对只认能在收据里对上的路径** —— 收据只记文件类工具的 `args.path`；`bash`/`sed` 改的文件、或 `..` 这类要按工作目录解析的写法进不了收据，自述这些文件会被标 `deliveryUnverified`。提示的意思是「没有实测支撑」，不是「一定在撒谎」。

## 开发

```bash
pnpm build             # rolldown 打包到 dist/
pnpm check             # tsrs 类型检查
pnpm lint              # oxlint
pnpm fmt               # oxfmt
pnpm test              # node:test（Node 22.19+ 原生跑 TS）
pnpm test:node22       # 用 Node 22.19.0（engines floor）跑一遍
pnpm check:breakpoints # 破坏点表：每个功能点改坏一处，指名的测试用例必须红
pnpm mutate            # 广谱变异（需本机 mutator 工具）
pnpm test:mode         # 三模式真机验收（print/json/rpc，真模型调用，慢且花钱）
```

### 两条测试纪律

- **每个功能点都要有一条「改坏就必须红」的测试用例。** 写在 `scripts/breakpoints.ts`：
  `from` 改一处源码（必须唯一出现），`to` 是破坏版，`red` 是必须变红的那条用例标题。
  `pnpm check:breakpoints` 逐条验：假绿（改了还是绿的）、红错地方（红的是别的用例）、
  标题写错（0 命中时 node 输出 `ok 1 - <文件名>`、退出码 0，看着像通过）都判红。
  写不出单行破坏点的功能点列在该文件顶部，逐条写明理由，不静默缺。
- **真机验收的判断不落在模型散文上。** `scripts/verdicts.ts` 里是纯函数，断言只看任务记录与
  子代理的 `output.log`；它们自己有夹具用例（`test/verdicts.test.ts`），也各自进破坏点表。

## 安装

```bash
pi install npm:pi-dispatch
```

## 许可证

MIT，见 [LICENSE](./LICENSE)。
