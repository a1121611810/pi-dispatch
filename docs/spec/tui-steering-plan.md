# TUI 运行中转向：ponytail ultra 最小方案

日期：2026-11-22
来源：9 个 harness 派发（8 份已回：claude / codex / opencode / opencode2 / kimi / pi / omp / codebuddy；kilo 仍在跑，不改变共识）。提案在 `target/tui-steer/`。

## 结论

做**一个**斜杠命令：`/steer [消息]`。

- 本会话有多个 `running` 孩子：`ctx.ui.select` 选一个；
- 恰好一个：跳过选择；
- 没有消息参数：`ctx.ui.input` 收一句话；
- 底层只调现有 `engine.steer()`；
- 回执用 `ctx.ui.notify`，只承诺 `sent`（已写进信箱），送达/生效看任务结束通知。

不写自定义 overlay、不做鼠标/历史/广播/撤回/模板/快捷键配置；P0 不改面板、不加新状态、不加新存储。

## 为什么不是让模型调 `dispatch_steer`

两者最终都走 `TaskEngine.steer()` → `planSteer` → 同一个 `steer.jsonl`、同一套收据。人入口多出来的只有三件事：

1. **原话直达**：不经父模型转述/改写。
2. **不依赖父模型服从**：模型可能不调工具、调错 id。
3. **零额外模型回合**：不占父方上下文、不花 token。

它不提供“更即时”的投递：孩子仍然只在 `turn_end` 消费；只是人不用等父模型一个回合。

## 代码落点

### `src/tui.ts`（约 10–35 行，都是现有逻辑的提取/纯函数）

- `export function currentOwner(): TuiOwner`：把 `attachTuiSurface` 里的 `{ pid, startMs: processStartMs(pid) ?? 0 }` 提出来；命令与面板同口径，否则命令看不到面板里的在飞任务。
- `export function steerChoices(records, owner)`：只留 `status === "running"` 且 `isSessionRecord` 的记录，按 `startedAt` 升序；label 用 `#id8 + snippet(task)`，与面板同形。
- `export function renderSteerOptions(records, owner): string[]`：编号 `1) #abcd1234 读日志`；选择结果用 `options.indexOf(choice)` 回映，不解析字符串。
- `export async function promptSteer(deps)`：纯交互状态机，deps 只收 `{ hasUI, ui, records, steer }`；不 import engine，便于 fake 测试。
- 现有 `snippet` 可导出复用；`WIDGET_MAX_LINES`/面板渲染 P0 不动。

### `src/index.ts`（约 20–30 行）

- 在 `piDispatchEntry` 工厂层注册一次：
  ```ts
  if (Number(process.env.PI_DISPATCH_DEPTH ?? 0) === 0) registerSteerCommand(pi, current);
  ```
  不能放 `session_start`：`/new`/resume 会重复注册成 `/steer:1`；`factory` 层只注册一次，handler 通过 `current()` 读当前引擎。
- `registerSteerCommand(pi, current)`：
  1. `ctx.hasUI === false` → 静默返回（print/json 没有对话面）。
  2. `current()` 抛错（拆卸中/无会话）→ `notify("派单引擎未就绪", "error")`。
  3. `registry.list()` 过滤本会话 `running`。
  4. 0 个 → `warning("没有在飞任务；排队中的先 dispatch_stop 再重派")`。
  5. 1 个 → 直接 `input`；多个 → `select` 后再 `input`；`undefined`（Esc）静默返回。
  6. `args` 非空时跳过 `input`，把 `args` 当正文（`/steer 改成先跑测试`）。
  7. `engine.steer(id, text)`；`ok` → `info("已受理 #id · seq N · state=sent；只代表写进信箱，送达/生效看结束通知")`；失败 → `error(原文)`。
- 校验全部交给 `planSteer`：只 running、trim 非空、≤4096、≤16 条、seq 续号；UI 不重复实现，避免文案漂移。

## 交互细节

- 选择器只列 `running`：`stopping/queued/终态` 列出即骗人（core 会拒）。
- 选择后到输入之间任务退出：`engine.steer` 返回 `task is ..., not running`，用红字原文提示；不自动重派。
- 空输入 / 纯空白：`warning("空转向，没发")`，不调用引擎。
- 多任务时 `select` 取消：静默，不报错。
- 成功回执**不显示 `delivered/seen`**：运行中记录恒为 `sent`；终态通知已有 `送达 D / 生效 S`。
- 不显示 `SteerOutcome.path`（绝对路径泄漏）。

## 明确不做（ponytail ultra 砍掉）

| 不做                                       | 理由                                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| `ctx.ui.custom` 全屏/overlay               | `select/input` 已处理焦点、宽度、IME、主题、Esc；自绘 ≥100 行，只能像素断言 |
| 鼠标、历史选择器、模糊搜索                 | 目标上限是个位数；历史任务不能转向                                          |
| 广播/多选                                  | seq 按任务计，一次写多个会让对账变模糊；需要时重复调用                      |
| 撤回/编辑已发转向                          | 信箱 append-only，孩子可能已读；撤回是自欺                                  |
| 模板、快捷键配置、`getArgumentCompletions` | 一句话场景；快捷键抢用户键位，补全与“args 当正文”冲突                       |
| 面板转向计数/状态列                        | 在飞时全是 `sent`，显示会读成“生效”；且占 `MAX_WIDGET_LINES=10` 预算        |
| 父方 RPC 专用 UI                           | `/steer` 在 RPC 也可用（`ctx.hasUI=true`）；不另写                          |

## 测试与变异

### 单元（`test/tui.test.ts`）

- `steerChoices`：只留本会话 running；排除 restore/别家 owner/stopping/queued；按 startedAt 升序；label 去重。
- `promptSteer`：0 个 warning；1 个跳过 select；多个 select；取消静默；空输入 warning；`steer` ok/err 文案；`hasUI=false` 静默。
- 每条配一个破坏点：例如 `status === "running"` → `!==`、`isSessionRecord` 删掉、`options.length === 1` → `false`、`args.trim() ||` → `args`。

### adapter（`test/adapter.test.ts`）

- 工厂层只注册一次 `/steer`；`depth>0` 不注册。
- fake `ctx.ui` 断言 select/input/notify 的调用顺序与参数；fake engine 断言 `steer(id, text)`。
- 不把 `ui.select` 的返回值当 taskId；用 index 映射。

### 真机 TUI（`scripts/verify-modes.ts`，P1）

- pyte pty 起 TUI → 派一个 `sleep 12` 孩子 → 输入 `/steer` → `input` 输入“改成 STEERED” → 断言孩子正文改口、`dispatch_list` 收据 `seen`。
- 额外探针：父模型正在流式输出时执行 `/steer`，验证命令立即执行（当前依据 pi 源码/文档，未在本仓实测）。
- 失败要 `process.exit(3)`；缺 pyte 显式 skip，不算通过。

## 风险

1. **流式中命令可用性**：pi 文档/源码称扩展命令在 streaming 时立即执行，但本仓未真机验证；先用 10–20 分钟 pty 探针，不通则退回 `/steer <id8> <正文>` 参数形态。
2. **选择→输入期间任务退出**：engine 确定性拒收，用户看到红字；不会写错任务。
3. **owner 口径**：`processStartMs` 读不到时 fallback 0，命令与面板同口径；残宿主下可能看不到任务（与面板同一已知限制）。
4. **跨会话过滤**：`isSessionRecord` 是信任边界；漏掉会把人的话写进同项目另一活会话的信箱。
5. **孩子可写信箱**：现有信任边界问题，TUI 不新增暴露面，但 `/steer` 会让人更常用这条通道。

## 实施顺序

1. P0：`currentOwner`/`runningSteerTargets`/`renderSteerOptions`/`runSteerCommand` + `registerSteerCommand`；单测 + adapter + 4–6 条破坏点。
2. P0：`/steer` 无参/单任务/多任务/取消/空/失败手测。
3. P1：pyte 真机腿（普通 + 流式中探针）。
4. P2：面板 `·转N`（可选，需重算 10 行预算）；RPC 无额外工作。

> 以上 1–3 已实施；见文末「实施状态」。

## 实施状态（2026-11-22，收口后）

已落地：

- `src/tui.ts`：`currentOwner`、`runningSteerTargets`、`steerChoiceLabel`、`renderSteerOptions`、`steerReceipt`、`runSteerCommand`（唯一交互状态机，不 import engine）。
- `src/index.ts`：`registerSteerCommand` 在工厂层按 `PI_DISPATCH_DEPTH === 0` 注册一次；handler 先 `ctx.hasUI` 再 `current()`，失败原文回显，`steer` 异常不冒泡。
- 单测：`test/tui.test.ts` 34 条，覆盖矩阵 17 条（排序用乱序夹具断言整组 options；owner 过滤含别 pid/缺戳/restore 三类；单任务 args 非空跳过 input；input Esc 零副作用；select→steer 间任务退出只发一次、透传原文不重试；重复 label 按序号回映第二项；回执整串等值且无 delivered/seen/http/path）。
- 假绿元测试：`test/test-runner.test.ts` 用 `PI_DISPATCH_SABOTAGE=no-steer|wrong-id|label-id` 起子进程跑 `test/tui.test.ts` 指名字段，坏 fake 必须红；同 pattern 无 sabotage 的对照必须绿且真跑到 1 条（防零命中假绿）。
- adapter：工厂层注册调用计数 = 1（两次 `session_start` 后仍 1）；`depth>0` 连命令都不注册；`hasUI=false` 静默、无活动会话报「引擎未就绪」。
- 真机：`node scripts/verify-modes.ts --tui-steer-only` 2/2 —— pyte pty 里 `/steer` 回执上屏，孩子 `sleep 12` 后正文改口、收据 `seq=1 state=seen`。全量 `pnpm test:mode` 28/28（主线程）。

门禁：`pnpm test` 633 pass / 0 fail；`pnpm check`、`pnpm fmt:check` 绿；`pnpm check:breakpoints` 216/216（其中 TUI 转向 17 条，含 owner 过滤、排序、空 args 才弹输入、失败级别、回执 seq、depth 守卫）；`tui.ts` 定向 mutator 74 个变异点 60 killed / 14 survived，存活点全是 `?? / ?. / 兜底字面量` 等价变异（逐条写在 `test/tui.test.ts` 文件头），`runSteerCommand` 13/13。

不采纳：`index<0`（select 返回未知值）保持「红字报错」而不是静默——静默会让它与 `choice === undefined` 守卫在输入上等价、不可杀；Esc 仍静默。

边界：流式中命令可用性已由 pty 腿覆盖；RPC 的 `select/input` 未单独真机跑（同一 `hasUI`，adapter 已覆盖）；跨会话过滤仍靠 owner 戳（与面板同口径）。
