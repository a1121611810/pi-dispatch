# pi-dispatch 成本控制改造方案

> 事实基线：`docs/spec/cost-control.md`（233 条真实派发实测 + 四档真机 A/B）。
> 本文是**施工单**：只写要改哪个文件的哪个函数、改成什么、怎么验。
> 本轮不写实现代码；下一轮照本文施工。

---

## 0. 先纠基线里的四条事实（读代码读出来的，会改设计）

基线文档 `cost-control.md` 的「六、要落地的代码改动」四条都成立，但**四条的前提各有一处与 pi 1.5.2 的实际行为不符**。不改方案就会照着基线写出错的东西，所以先列在最前面。

| #   | 基线原文                                                                                                            | 实测事实（pi 1.5.2，源码位置）                                                                                                                                                                                                                                                                                                                                                        | 对方案的影响                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | 改动 4：给子代理工作目录放 `.pi/settings.json` 写 `{"cacheWarming":"off"}`，「项目级 settings 优先于 agent 目录级」 | **不成立**。`SettingsManager.getCacheWarmingMode()` 只读 `this.globalSettings`，而 `globalSettings` = `<agent-dir>/settings.json`（`dist/core/settings-manager.js:123,725-728`，注释原文 "Read from global settings only because warming costs money"）。`docs/settings.md` 的 cacheWarming 行也标着 "Global setting only"。项目级 `.pi/settings.json` 里的 `cacheWarming` **不生效** | 改动 4 换机制：走扩展钩子 `cache_warming_decision`（见 §2.4）。附带好处：不用往父方工作区写文件 ⇒ 没有 `.gitignore` 问题、没有隔离档的落点问题 |
| C2  | 派 `medium` 不降预算，白以为省了                                                                                    | pi 自己会**往上抬**：`clampThinkingLevel()` 先往更高档位找（`pi-ai/dist/models.js:714-731`），vendor-local 的 `medium` 是显式 `null` ⇒ 落到 `high`（16384 token 预算）。启动路径确认：`main.js:746` → `session.setThinkingLevel()` → `_clampThinkingLevel()` → `clampThinkingLevel()`                                                                                                 | 校验不是「锦上添花」，是**防涨价**：不校验就等于替父方选了最贵的档。方案必须先校验再发，且只发模型支持的档位（这样 pi 的 clamp 不再插手）      |
| C3  | 改动 3 的理由：「子代理跑多轮时，上一轮的完整 request 不再是下一轮的前缀，缓存全废」                                | **今天不是这样**。真机样本 `test/fixtures/real-steer.jsonl` 里 3 条 system 消息的 addendum 逐字节相同（均 2019 字符）⇒ 子代理**一轮之内**前缀已经稳定，`--append-system-prompt` 是启动参数、运行期不变                                                                                                                                                                                | 改动 3 的收益不是「轮内稳定」，是**跨子代理共享同一段前缀**：今天 `why` 在系统提示词里 ⇒ 每个子代理的系统提示词都不同 ⇒ 彼此之间缓存不共享     |
| C4  | 「每次派发都拼一个含 taskId/why 的块」                                                                              | 附加块里**没有 taskId**（`src/core/child.ts:198-207` 只有 why 与隔离契约）。taskId 走环境变量 `PI_DISPATCH_TASK_ID` 进孩子，不进提示词                                                                                                                                                                                                                                                | 变动面比基线设想的小：系统提示词里唯一每派必变的是 `why`（+ 条件出现的隔离契约）                                                               |

另外两条写方案时要记住的机制事实（不是纠错，是约束）：

- **C5** pi 的 thinking 档位校验与 clamp 口径（`pi-ai/dist/models.js:701-731`）：`thinkingLevelMap[档位] === null` ⇒ 该档**不支持**；`xhigh` / `max` **缺键**也当不支持；其它档位缺键 ⇒ 走 provider 默认值（到 high 为止）。`--model x:<档>` 后缀优先于 settings 的 `modelThinkingLevels`（`model-resolver.js:397`：`scopedModel.thinkingLevel ?? perModel ?? defaultThinkingLevel`）。
- **C6** cache 预热的经济学（`pi-ai/dist/cache-warming.js:52-69`）：**运行中**续接概率是 **1**（不是 0.15）；0.15 是闲置期的常量。⇒ 孩子在跑的时候，pi 判定「预热划算」的概率极高，预热是**真花钱**的。

本机实测目录（`~/.pi/agent/models.json`，2026-11-24）里 vendor-local 全系列的档位图：

```
regex:test-vendor/group/main  reasoning=true
  {"high":"high","low":"low","max":"max","medium":null,"minimal":null,"off":"none","xhigh":null}
minimax-cn/MiniMax-M3.1-Flash
  {"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"}
```

---

## 1. 总体设计

### 1.1 四项改造各管一段，互不重叠

```
派发一次（dispatch_task）
   │
   ├─【2】thinking 校验 ──► 决定「这一单用什么模型、想多久」
   │                          影响：output token（thinking token 计入 output）
   │                          落点：拼 argv 之前（core，不依赖 pi 运行时）
   │
   ├─【3】前缀稳定化 ──► 决定「这一单的系统提示词长什么样」
   │                          影响：input token + 跨子代理的缓存命中
   │                          落点：拼 argv（core）
   │
   ├─【1】usageBudget ──► 决定「这一单最多能花多少」
   │                          影响：整单的钱（软门收尾 / 硬门收尸）
   │                          落点：运行中（引擎盯 stdout 的用量事件）
   │
   └─【4】cache 预热关掉 ──► 决定「这一单会不会额外花钱买没人用的缓存」
                              影响：整单的钱（每个预热请求 = 一次 prompt 全量重放）
                              落点：孩子进程里的扩展钩子（适配层）
```

四项的**共同前提**：钱是引擎从**孩子的事件流**里观测出来的（`message_end` 的 `usage`），不是孩子自报的。所以：

- 【1】要在运行中约束孩子 ⇒ 必须有一条**运行中**的用量观测通道（现在 `parseChildStream` 只在退出时跑一遍）。
- 【2】【3】【4】都是**派发前/启动时**的一次性决定 ⇒ 都落 core 的纯函数，可以脱离 pi 运行时单测。

### 1.2 三层落点（core 不 import pi 的纪律不变）

| 层             | 放什么                                                                                                                             | 新文件 / 改动文件                                                                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/`    | 全部业务规则：预算口径与闸、thinking 校验、前缀拼装、预热决策、增量用量累加                                                        | 新增 `src/core/budget.ts`、`src/core/thinking.ts`、`src/core/cache-warming.ts`；改 `src/core/types.ts`、`gates.ts`、`child.ts`、`engine.ts`、`registry.ts` |
| `src/index.ts` | 只做翻译：把 pi 的模型目录（`ctx.modelRegistry`）摊成 core 认识的形状；注册 `cache_warming_decision` 钩子；把新参数写进工具 schema | 改 `src/index.ts`                                                                                                                                          |
| 文档           | 行为变了要同步规格                                                                                                                 | 改 `docs/spec/core-spec.html`（§命令怎么拼 / §安检有哪几道 / 新增一节）                                                                                    |

四个可注入依赖不变（spawn / 读机器 / 时钟 / 存储目录）。本轮**新增第五个可注入依赖**：模型目录快照（`EngineDeps.thinkingCatalog`），它是**数据**不是机器读，缺省 = 空目录（= 不校验、原样透传）。

### 1.3 协作关系（三条，值得写进规格）

1. **【2】先于【1】**：预算按「实际花的钱」判，而花多少取决于 thinking 档位（thinking token 计入 output，output 单价是 input 的 4 倍）。档位不校验 ⇒ 预算的分母算不准（派 `medium` 实际按 `high` 跑，预算会提前到点，用户觉得「预算不准」）。**先校验再谈预算**。
2. **【3】放大【1】的收益**：预算的 token 口径含 cacheRead（见 §2.1），所以「前缀稳定 ⇒ cacheRead 降」直接换算成「同样的预算能多跑几轮」。
3. **【1】的软门靠【3】保命**：软门是「到点让孩子收尾」——这条指令要进孩子的上下文。如果系统提示词每轮都在变，指令的位置与前缀稳定性都会受影响；把【3】做在【1】前面，软门的收尾指令才能稳定地落在 user message 里（见 §2.1.4）。

### 1.4 交付物口径（统一）

一次派发结束后，父方从三个地方看到同一份成本事实：

- **回执**（`DispatchResult` / `TaskRecord`）：`usage`（观测到的累计用量）+ `budget`（预算与已花）+ `thinking`（请求档位与实际档位）+ `budgetExhausted`（布尔旗标）。
- **列表**（`dispatch_list`）：多带 `budget`、`thinking`、`budgetExhausted` 三列。
- **通知**（终态 push）：预算到点时带一句「预算到点（降级交付）」；thinking 被降级时带一句「思考档位 high→low」。

---

## 2. 逐项设计

### 2.1 【1】`dispatch_task` 加 `usageBudget`

#### 2.1.1 预算口径

**结论：两个上限都支持，默认推荐美元；token 口径必须含 cacheRead。**

```ts
// src/core/types.ts
export interface UsageBudget {
  /** 累计成本上限（美元）。用孩子上报的 usage.cost.total 判。 */
  maxUsd?: number;
  /** 累计「处理过的 token」上限：input + output + cacheRead + cacheWrite。 */
  maxTokens?: number;
  /** 硬门相对软门的倍数（默认 2）。 */
  hardFactor?: number;
  /** 软门之后多久还没交付就硬收（毫秒，默认 120000）。 */
  hardGraceMs?: number;
}
```

为什么两个都要：

- **美元**是用户真正在意的单位，且孩子上报的 `usage.cost.total` 就是真金白银（含 cacheRead 的实际单价）。本机 vendor-local 定价下 cacheRead 只占成本的 13%，美元口径天然不会被缓存型子代理「刷爆」。
- **token** 口径 = `input + output + cacheRead + cacheWrite`，是**处理过的 token 上界**。它必须含 cacheRead（本机 27505 回合实测 cacheRead 占 prompt token 的 97.7%）：不含的话，一个每轮重放 4000 token 前缀的子代理在账上看起来「几乎不花钱」，预算形同虚设（社区 `nicobailon/pi-subagents` 的 `inputTokens + outputTokens` 口径正是这个毛病）。
- 但**必须说清代价**：含 cacheRead 的 token 上界对缓存型子代理「偏严」——它数的是上下文 churn，不是钱。所以默认推荐写 `maxUsd`；`maxTokens` 给「我想限制它读多少」的场景（例如 `maxTokens: 100000` ≈ 十轮 4k 前缀的子代理）。
- 两者都给时，**任一越线即到点**（OR 语义）。

#### 2.1.2 软门还是硬门：**两个都要，软门先行**

纯硬门（到点 SIGTERM）会打断正在跑的工具：子代理可能正在 `pnpm test` 或写文件被杀，交付物半截，家长还拿不到报告。纯软门（只提醒）则可能被无视——模型完全有理由继续干完 20 轮。

方案：**两段式（借鉴 `QuintinShaw/pi-dynamic-workflows` 的 phased-budgets 软门，但加一道兜底）**

| 阶段 | 触发条件                                      | 动作                                                                                                                      | 孩子状态                                 |
| ---- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 软门 | 观测到的累计用量 **≥** 上限                   | ① 给孩子写一条**转向**（复用现成的 steer 通道，见下）说「预算到点，收尾交付」；② 记录 `budget.exhausted = true`、`softAt` | 不打断在飞工具，孩子在下一个回合边界看到 |
| 硬门 | ① 累计用量 ≥ 上限 × `hardFactor`（默认 2）    | `stop(taskId, "budget exhausted: …")` → 现有路径 SIGTERM → 宽限后 SIGKILL                                                 | 收掉                                     |
| 硬门 | ② 软门后过了 `hardGraceMs`（默认 120s）还没交 | 同上                                                                                                                      | 收掉                                     |

要点：

- **软门走现成的转向通道**：`engine.steer(taskId, text)` → 写 `steer.jsonl` → 孩子在 `turn_end` 读到并作为 user steer 注入（`src/index.ts:642-677`）。**不打断在飞工具**——这正是转向的既有语义（GLOSSARY「运行中转向」）。转向还会留下一条收据（`steers[]`），父方能看到「到点时插过一句话」。
- **软门不是「通知」而是「交付指令」**：文案要写清楚「停止扩展工作，用现有结果收尾，按报告契约交付」，否则孩子可能只是「知道了」然后继续干。
- **硬门是兜底，不是主路径**：正常情况下软门就够了（孩子收尾 → 退出码 0 → `succeeded` + `budgetExhausted: true`，这就是「降级交付」）。硬门触发时孩子是被收掉的 ⇒ **status 仍是 `canceled`（不许装成 succeeded）**，但**部分正文照交**（`#pump` 照常收 stdout、落盘、回报），回执标 `budgetExhausted: true`。
- **超支上界要说清**：预算是软上限——用量是在请求**完成后**才观测到的，所以「越线的那一轮」已经付过钱了。实际最多超到 `上限 × hardFactor`（默认 2 倍）或到软门后 `hardGraceMs` 内自然停下。
- **没有转向通道时**：没有 storage 或没装孩子扩展 ⇒ 软门写不进去 ⇒ 只记 `exhausted`，靠硬门兜底（并在回执里说清「软门未送达」）。

#### 2.1.3 父方怎么拿到运行中的累计用量

现在只有 `parseChildStream(text)` 在**退出时**跑一遍，得到 `observedUsageTotal`。运行中没有通道。

**做法**：在 `src/core/child.ts` 里加第三个事件流累积器（和 `createSteerEvidenceTracker` 同级，共用 `parseLine` 与 `StreamEvent` 形状，不重复写解析）：

```ts
// src/core/child.ts（新增导出）
export interface UsageTracker {
  /** 喂一段 stdout；跨 chunk 的半行自己留着。 */
  push(chunk: string): void;
  /** 累计用量 + assistant 回合数。 */
  snapshot(): { usage: ChildUsage; turns: number };
}
export function createUsageTracker(): UsageTracker;
```

它只认 `message_end` 且 `role === "assistant"` 的 `usage` 字段，口径与 `parseChildStream` **完全一致**（复用 `takeUsage` / `addUsage`）。

**关键不变量（要写成测试）**：`tracker.snapshot().usage` 必须等于 `parseChildStream(同一段流).observedUsageTotal`。两条路独立实现却必须同数——这是「运行中判预算」与「退出后记账」不打架的唯一保证。

引擎侧（`src/core/engine.ts` 的 `#pump`）：

```ts
const usage = createUsageTracker();
let lastTurns = -1;
child.onOutput((chunk) => {
  activity.push(chunk);
  evidence.push(chunk);
  usage.push(chunk);
  text += chunk;
  // …（截尾逻辑照旧）
  const snap = usage.snapshot();
  if (snap.turns !== lastTurns) {
    // 只在真的有新用量时判预算
    lastTurns = snap.turns;
    void this.#checkBudget(taskId, input, snap);
  }
});
```

`#checkBudget` 的骨架：

```ts
async #checkBudget(taskId, input, snap) {
  const budget = input.usageBudget;
  if (!budget) return;
  const spentUsd = usdOf(snap.usage);
  const spentTokens = totalTokens(snap.usage);
  const state = this.#budgetStates.get(taskId) ?? { softAt: undefined, hard: false };
  const decision = evaluateBudget({
    budget, spentUsd, spentTokens,
    softAt: state.softAt, hard: state.hard, now: this.#now(),
  });
  if (decision.phase === "ok") return;
  if (decision.phase === "soft" && state.softAt === undefined) {
    state.softAt = this.#now();
    this.#budgetStates.set(taskId, state);
    const outcome = await this.steer(taskId, BUDGET_STEER_TEXT);   // 串行走 engine.steer，收据也留下来
    await this.#registry.submit({ kind: "attach-budget", id: taskId, budget: { ... } });
    if (!outcome.ok) { /* 记「软门未送达」，靠硬门兜底 */ }
    this.#armBudgetTimer(taskId, input);   // 软门后宽限期到了还没交 ⇒ 硬门
    return;
  }
  if (decision.phase === "hard") {
    state.hard = true;
    this.#budgetStates.set(taskId, state);
    await this.#registry.submit({ kind: "attach-budget", id: taskId, budget: { ... } });
    await this.stop(taskId, `budget exhausted: ${decision.reason}`);
  }
}
```

硬门的**时间兜底**要一个定时器（孩子卡在长工具里时不会有新用量事件）：软门触发时 arm 一个 `hardGraceMs` 的 `setTimeout`（`.unref()`），到期若孩子还在跑 ⇒ `stop(...)`。孩子退出时清掉定时器。

#### 2.1.4 要改哪些文件 / 函数

| 文件                       | 改什么                                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/core/types.ts`        | 新增 `UsageBudget`、`BudgetReceipt`；`DispatchInput` 加 `usageBudget?: UsageBudget`；`TaskRecord` 加 `budget?: BudgetReceipt`、`budgetExhausted?: true`；`DispatchResult` 加同名字段 |
| `src/core/budget.ts`（新） | `totalTokens(usage)`、`usdOf(usage)`、`evaluateBudget(input): {phase, reason}`、`DEFAULT_HARD_FACTOR = 2`、`DEFAULT_HARD_GRACE_MS = 120_000`、`BUDGET_STEER_TEXT`                    |
| `src/core/gates.ts`        | 新增 `usageBudgetGate`（纯函数，形状闸）；`defaultGates` 末尾追加它（**追加在末尾，既有 11 道的索引一个字不动**）                                                                    |
| `src/core/child.ts`        | 新增 `createUsageTracker()`（复用 `takeUsage`/`addUsage`/`parseLine`）                                                                                                               |
| `src/core/registry.ts`     | 新增命令 `attach-budget`（仿 `attach-worktree`：任何状态可写、永不改 status）                                                                                                        |
| `src/core/engine.ts`       | `#pump` 里接 usage tracker 与 `#checkBudget`；`#budgetStates` / `#armBudgetTimer`；`#resultFromRecord` 带出 `budget` / `budgetExhausted`                                             |
| `src/index.ts`             | `DISPATCH_TASK_SCHEMA` 加 `usageBudget`；`dispatch_task` 的 args 映射；`dispatch_list` 的行加三列；终态通知加预算/档位提示                                                           |
| `docs/spec/core-spec.html` | §安检有哪几道 加第 12 道（预算闸）与第 13 道（user message 体积闸）；新增「预算：软门 + 硬门」一节；§父方看到的 补 `budget` / `thinking` 两个回执字段                                |

#### 2.1.5 边界情况清单

| 情况                                      | 处理                                                                                                      |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `maxUsd` / `maxTokens` 都没给             | 闸拒（`rejection`）：「至少要给一个上限」——不给上限的预算对象等于没设预算，不如不设                       |
| 上限是 0 / 负数 / NaN / Infinity          | 闸拒，不 coerce（照抄 `allowScriptsGate` 的口径：错值方向是「多花钱」，必须拒）                           |
| `hardFactor < 1`                          | 闸拒（<1 会让硬门早于软门）                                                                               |
| 孩子自报 usage 与观测不符                 | **以观测为准**（现有行为：`attach-report` 里 `usage: parsed.observedUsageTotal`）——预算只认观测，不认自报 |
| `reportChannel=none`（孩子没交报告）      | 预算照判、账照记（现有行为已经保证「没交报告账上也有数」）                                                |
| 孩子没起（spawn 失败 / 排队时被取消）     | 没有用量 ⇒ 不触发预算；结果里不带 budget 字段（`#resultFromRecord` 的 `startedAt > 0` 判定）              |
| 排队期间预算参数被改                      | 不支持：预算在受理时钉死（跟 `timeoutMs` 一样，`#inputs` 里存的是受理时的入参）                           |
| 硬门杀掉的孩子的最终 status               | `canceled`（退出码 143）+ `budgetExhausted: true` + 部分正文照交                                          |
| 软门后孩子自己交差了（无报告 / 报告空转） | 照常记 `reportChannel` / `assessmentVacuous` 等既有旗标；预算旗标独立，不互相掩盖                         |

---

### 2.2 【2】派发前按目标模型校验 thinking 档位

#### 2.2.1 规则（最终口径）

用 pi 的 `getSupportedThinkingLevels` 口径算出该模型**支持**的档位：

```
supported(model) =
  model.reasoning === false        → ["off"]
  否则：档位 ∈ [off, minimal, low, medium, high, xhigh, max]
        且 thinkingLevelMap[档位] !== null
        且 档位 ∉ {xhigh, max} 或 thinkingLevelMap[档位] !== undefined
```

然后：

| 请求档位                   | 判定               | 实际生效（发给孩子的）                          | 回执里的 `reason`                                           |
| -------------------------- | ------------------ | ----------------------------------------------- | ----------------------------------------------------------- |
| 不给                       | —                  | 不拼后缀 ⇒ 沿用会话默认                         | 「没给档位 ⇒ 沿用会话默认」                                 |
| 在 `supported` 里          | 支持               | 原样（`provider/id:<档位>`）                    | 「模型支持该档」                                            |
| `map[档位] === null`       | **显式不支持**     | **降到 `low`**                                  | 「该模型没有 <档位> 档（thinkingLevelMap=null）⇒ 降到 low」 |
| 缺键（只可能是 xhigh/max） | 模型压根没提这一档 | `supported` 里**最接近**的一档（通常是 `high`） | 「该模型没有 <档位> 档 ⇒ 按 pi 口径落到 <档位>」            |
| 模型不在目录里             | 查不到             | **原样透传**（不猜）                            | 「模型不在目录里 ⇒ 未校验，原样发」                         |
| 模型 `reasoning=false`     | 不支持思考         | 不拼后缀（= off）                               | 「该模型不支持思考 ⇒ off」                                  |

三条硬规矩：

1. **只降不升**：任何情况下生效档位的**成本序**不得高于请求档位（`off < minimal < low < medium < high < xhigh ≈ max`）。绝不重演 C2 里 pi 把 `medium` 抬成 `high` 的事。
2. **降级目标是 `low`**（不是「最近的一档」）：`low`（2048 预算）是「能干活又不肉疼」的档。`low` 不可用则退 `off`，再不行取目录里最便宜的一档。例外：请求档位本身比 `low` 还便宜（`off` / `minimal`）时，取「比请求更便宜或同价」的最便宜可用档（不能因为「降级」反而更贵）。
3. **只发 `supported` 里的档位**：这样 pi 自己的 `clampThinkingLevel` 拿到的是一个它支持的档位 ⇒ **不会改动** ⇒ 回执里的「实际生效档位」就是孩子真跑的档位（不是预测，是事实）。这条同时消灭了 C2 的涨价路径。

#### 2.2.2 数据流

```
pi 运行时（适配层）
  ctx.modelRegistry.getAll()  ──►  [{provider, id, reasoning, thinkingLevelMap}]
        │  （只取这几个字段，摊成 core 认识的纯数据）
        ▼
  EngineDeps.thinkingCatalog: () => readonly ThinkingModelInfo[]
        │
        ▼
  引擎 #buildArgv：
    model  = effectiveModel({model: 调用参数, sessionModel: 会话当前模型})   ← child.ts 导出，解析序只有这一处
    found  = findThinkingModel(catalog, model)     ← "provider/id" 精确命中；裸 id 唯一命中也算；命中不了 = undefined
    result = resolveThinkingLevel({requested: input.thinkingLevel, model: found})
        │
        ├─► buildPiArgv({..., model, thinkingLevel: result.effective})   ← 只拼后缀，不做判断
        └─► 受理时把 result 写进记录（thinking 字段）
```

`resolveThinkingLevel` 是**纯函数**（输入 = 请求档位 + 模型快照，输出 = 回执），完全不需要 pi 运行时 ⇒ core 层可独立单测。模型目录从哪来（`ctx.modelRegistry`）是适配层的事，core 只认一个纯数据形状。

#### 2.2.3 回执

```ts
// src/core/types.ts
export interface ThinkingReceipt {
  /** 父方要的档位 */
  requested?: string;
  /** 实际发给孩子的档位（不发后缀 = undefined ⇒ 沿用会话默认） */
  effective?: string;
  /** 生效档位与请求档位不同（降级或 pi 口径的收档） */
  adjusted: boolean;
  /** 模型认出来了没有（false = 未校验） */
  modelKnown: boolean;
  /** 一句话说明：为什么是这个档 */
  reason?: string;
}
```

写在 `TaskRecord.thinking` 与 `DispatchResult.thinking`；`dispatch_list` 与终态通知带出来（通知里只在 `adjusted` 时说一句「思考档位 high→low」）。

#### 2.2.4 要改哪些文件 / 函数

| 文件                         | 改什么                                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/core/thinking.ts`（新） | `ThinkingModelInfo`、`supportedThinkingLevels(model)`、`findThinkingModel(catalog, reference)`、`resolveThinkingLevel(args)`                           |
| `src/core/types.ts`          | `ThinkingReceipt`；`TaskRecord.thinking?`；`DispatchResult.thinking?`                                                                                  |
| `src/core/child.ts`          | 导出 `effectiveModel({model, sessionModel})`（把现有解析序抽成一处，`buildPiArgv` 与引擎共用）；`buildPiArgv` 只拼后缀，不判断                         |
| `src/core/engine.ts`         | `EngineDeps` 加 `thinkingCatalog?`；`#buildArgv` 里做解析；受理时（`#dispatchReady`）把 `thinking` 写进初始记录                                        |
| `src/index.ts`               | `startSession` 里用 `ctx.modelRegistry.getAll()` 造目录快照传进引擎；`dispatch_task` 的 `thinkingLevel` 描述改成「无效档位会降级，回执里说明实际档位」 |

#### 2.2.5 边界情况清单

| 情况                                   | 处理                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------ |
| `model` 写成模式（`vendor-local/*`）   | 目录里查不到 ⇒ 不校验、原样透传、回执说「未校验」                                    |
| 裸 id（`regex:group/main`）            | 目录里 id 唯一 ⇒ 能校验；id 撞多个 ⇒ 不校验                                          |
| 模型是虚拟模型（virtual model）        | 目录里查的是虚拟模型本身 ⇒ `thinkingLevelMap` 可能是路由后的值。**【需真机验证】**   |
| 调用方没给 `model`（继承会话模型）     | 用 `sessionModel` 查目录；查不到就不校验                                             |
| 调用方没给 `thinkingLevel`             | 不拼后缀（行为与今天完全一致）——**不擅自替父方降档**                                 |
| 请求 `max`（vendor-local 支持）        | 原样发。⚠️ `max` 与 `high` 预算相同（都 16384）——别为 `max` 多付钱，也不值得为它多跑 |
| 请求 `xhigh`（vendor-local 显式 null） | 降到 `low`。⚠️ pi 自己会把 `xhigh` 收到 `max`（=16384），所以这里**省钱 8 倍**       |

---

### 2.3 【3】`--append-system-prompt` 前缀稳定化

#### 2.3.1 现状与目标

现状（`src/core/child.ts:198-207, 263`）：

```
--append-system-prompt  =  上下文块 + <pi-dispatch-why>…</pi-dispatch-why> + （隔离契约）+ 报告契约
-- <task>                                   ← 位置参数 = 孩子的第一条 user message
```

目标：

```
--append-system-prompt  =  上下文块 + 报告契约              ← 恒定：每次派发逐字节相同
-- <task> + （why 块）+ （隔离契约块）        ← 变的部分全在 user message
```

**为什么这样能省钱**：provider 的 prompt 缓存按「请求前缀」命中。今天 `why` 在系统提示词里 ⇒ 每个子代理的系统提示词都不同 ⇒ 彼此之间**前缀不共享** ⇒ 每个子代理的首轮 input 都是全价。搬走之后，所有子代理共享同一段前缀（上下文块 + 报告契约 + pi 自己的 preamble/tools/rules + 项目上下文），第二、第三个子代理的首轮也能命中缓存。

⚠️ **口径要说清**（C3）：子代理**轮内**的前缀今天已经稳定（argv 是启动参数，运行期不变），所以这项改造的收益是**跨子代理共享**，不是「轮内不再破缓存」。跨子代理能否真命中，取决于 provider 的缓存键与 TTL（vendor-local 走 openai-completions 兼容层，pi 的 `promptCacheKeyMode` 默认 `auto`）——**【需真机验证】**。

#### 2.3.2 隔离契约块怎么放

`WORKTREE_CONTRACT_BLOCK` 只在 `isolation === "worktree"` 时出现。放系统提示词 ⇒ 隔离子代理与普通子代理的前缀不同 ⇒ 两组之间不共享（组内仍共享）。放 user message ⇒ **所有**子代理共享同一段系统前缀。

**决定：放 user message**。理由：

- 隔离契约是「环境事实 + 交付约定」，不是「身份定义」；放 user message 语义上不亏。
- 组内共享（隔离组 / 非隔离组）已经拿到大部分收益；再细分不值得为它牺牲跨组共享。
- 边界更干净：**系统提示词恒定**这一条可以用一个字节级断言钉死（见 §3）。

代价：隔离契约在孩子上下文里的位置从「系统提示词」降到「第一条 user message」，权威性略降（模型对 system 的服从度通常高于 user）。**【需真机验证】**：跑一个 `isolation=worktree` 的真机子代理，确认它仍然自己 commit、不 push。

#### 2.3.3 最小改法（不动 argv 结构）

`argv` 的**形状不变**：`[pi, -p, --no-session, --mode, json, --append-system-prompt, <块>, --no-extensions, --no-skills, …, --, <user message>]`。变的只有两段**内容**：

- `--append-system-prompt` 的值：恒定契约块。
- `--` 之后的位置参数：从「任务原文」变成「user message」。

**没有 why、没有隔离时，user message == 任务原文** ⇒ argv 与今天**逐字节相同** ⇒ 现有 golden（`FROZEN_ARGV`）不必动（只需新增带 why / 带隔离的两种组合）。

新代码形状：

```ts
// src/core/child.ts
/** 恒定契约块：上下文块 + 报告契约。每次派发逐字节相同。 */
export const CONTRACT_BLOCK = [SUBAGENT_CONTEXT_BLOCK, REPORT_CONTRACT_BLOCK].join("\n");

/** 给孩子的 user message：任务正文 +（可选）理由块 +（可选）隔离契约块。 */
export function buildUserMessage(options: {
  task: string;
  why?: string;
  isolation?: Isolation;
}): string {
  return [
    options.task,
    options.why ? `<pi-dispatch-why>${escapeXmlText(options.why)}</pi-dispatch-why>` : "",
    options.isolation === "worktree" ? WORKTREE_CONTRACT_BLOCK : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
```

`buildPiArgv` 里：

```ts
argv.push("--append-system-prompt", CONTRACT_BLOCK);
// …
argv.push("--", buildUserMessage(options));
```

`buildAppendBlock` **删掉**（唯一调用方是 `buildPiArgv` 与 `test/child.test.ts`）。

#### 2.3.4 边界情况（这块最容易翻车）

| 情况                             | 处理                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **argv 单参数长度**              | 任务与理由现在**合并进同一个 argv 参数**。两个各 ≤64 KiB（现有闸）⇒ 合并后可能超 Linux 的 `MAX_ARG_STRLEN`（128 KiB）⇒ spawn 抛 E2BIG ⇒ 记 failed 而不是 rejected。**必须加闸**：user message 整体 ≤ 64 KiB（`MAX_TEXT_BYTES`）才放行，超了 `rejection`                                                         |
| **user message 不能以 `@` 开头** | pi 的 `--` 分支把以 `@` 开头的位置参数当**文件路径**读（`dist/cli/args.js:24-33`）⇒ 任务正文被丢弃。现有 `taskTextGate` 拒「task 以 @ 开头」，组合后还要看**整条 message 的首字符**：message 的首字符恒等于 task 的首字符 ⇒ 现有闸已覆盖；**再补一条断言**（message 不得以 `@` 开头）防将来有人在 task 前加前缀 |
| **user message 不能以 `-` 开头** | `--` 之后的参数 pi 一律当 message（不解析成旗标），所以 `-` 开头是安全的；但现有 `taskTextGate` 已拒（纵深防御），保持                                                                                                                                                                                          |
| **理由里的 XML 实体**            | `escapeXmlText` 照旧作用于 why（块内不许伪造标签）——why 现在在 user message 里，逃逸规则不变（标签边界仍要防伪造）                                                                                                                                                                                              |
| **隔离契约的顺序**               | 顺序固定：任务 → why → 隔离契约（why 解释动机，隔离契约讲环境与交付，靠近交付）                                                                                                                                                                                                                                 |
| **孩子对 why 的引用**            | 报告契约里写着「if your instructions contained a `<pi-dispatch-why>` block」——块还在（只是换了位置）⇒ 契约文本一字不改                                                                                                                                                                                          |
| **黑板**                         | 黑板消息**从不**进提示词（既有纪律），本次不动                                                                                                                                                                                                                                                                  |

#### 2.3.5 要改哪些文件 / 函数

| 文件                       | 改什么                                                                                                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/child.ts`        | 删 `buildAppendBlock`；加 `CONTRACT_BLOCK` 与 `buildUserMessage`；`buildPiArgv` 改用这两者                                                                                             |
| `src/core/gates.ts`        | 加「user message 体积闸」：`messageBytesGate`（≤ `MAX_TEXT_BYTES`）；它在 `textFieldsGate` 之后跑（文本字段先过）                                                                      |
| `src/index.ts`             | 无需改（why 的取值路径不变）                                                                                                                                                           |
| `src/core/engine.ts`       | 无需改（`buildPiArgv` 的入参形状不变）                                                                                                                                                 |
| `docs/spec/core-spec.html` | §命令怎么拼 的表格改两行：`--append-system-prompt` 改成「挂恒定契约块（上下文 + 报告契约）」；「任务放最后」改成「user message 放最后（任务 + why + 隔离契约）」；新增一小节讲前缀共享 |

---

### 2.4 【4】子代理侧关掉 cache 预热

#### 2.4.1 机制（基线 C1 的修正）

基线说「项目级 `.pi/settings.json` 优先于 agent 目录级」——对 `cacheWarming` **不成立**（pi 1.5.2 只读 agent 目录级，且 docs 标注 "Global setting only"）。所以**不能**靠往子代理工作区写文件来关。

可行的机制是 **pi 的扩展钩子**（docs/extensions.md §cache_warming_decision）：

```ts
pi.on("cache_warming_decision", (event, ctx) => {
  // event.action = pi 的决定；返回 {action:"stop"} 即覆盖（最后一个返回 action 的 handler 说了算）
  return { action: "stop" };
});
```

孩子进程本来就装了本扩展（`-e <本扩展>`，`src/index.ts:284`），所以**在 depth > 0 的进程里注册这个钩子**即可。父会话（depth 0）不注册 ⇒ 父会话的预热照旧（父会话长命，预热对它有价值）。

为什么值得做（机制事实 C6）：预热的经济学判定里，**运行中**的续接概率是 **1**（闲置期才是 0.15）⇒ 孩子在跑的时候 pi 几乎总是判定「预热划算」⇒ 会真的发一次 prompt 全量重放（cacheRead 计价 + 1 个 output token）。而短命子代理跑完就没了，**这份热缓存谁也用不上**——纯浪费。

规模要说实话（别夸大）：预热请求的费用 ≈ 前缀 token × cacheRead 单价（本机 vendor-local ≈ 4000 token × $0.015/M ≈ $0.00006/次），且只在「孩子活得比 provider 缓存 TTL 的 90% 还久」时才发生（pi 的预热延迟 = TTL × 0.9，`pi-ai/dist/cache-warming.js:35-39`）。**收益小但严格非负**，实现成本约 10 行 ⇒ 值得做，但不要把它算进主要节省里。

#### 2.4.2 数据流与落点

```
core（纯函数，可单测）
  src/core/cache-warming.ts
    export function cacheWarmingDecision(depth: number): { action: "stop" } | undefined
      → depth > 0 ⇒ {action:"stop"}；depth === 0 ⇒ undefined（不表态，父会话的预热不动）

适配层（注册）
  src/index.ts 工厂层（与 registerSteerCommand 同级，不进 session_start）
    if (parseDepth(process.env.PI_DISPATCH_DEPTH) > 0)
      pi.on("cache_warming_decision", () => cacheWarmingDecision(depth));
```

注册在**工厂层**（不是 `session_start`）：工厂层跑一次、进程内长期有效；`session_start` 可能因 new/resume/fork 重复触发 ⇒ 注册在那儿要防重复（`registerSteerCommand` 已经示范了「工厂层注册一次」的做法）。

#### 2.4.3 边界情况

| 情况                                               | 处理                                                                                                                                                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 父会话（depth 0）                                  | **不注册**钩子 ⇒ 父会话预热照旧（父会话长命，预热对它有用）                                                                                                                                                                    |
| 子代理套子代理（depth 2）                          | 同样注册 ⇒ 整棵子树都关                                                                                                                                                                                                        |
| 孩子进程里 pi 版本 < 支持该钩子的版本              | `pi.on("cache_warming_decision", …)` 在老版本上注册未知事件 ⇒ **要查老版本的行为**：若注册未知事件会抛，就在注册处 try/catch 兜底（不影响派发）。**【需真机验证】**（本机 pi 1.5.2 支持；`peerDependencies` 写的是 `>=1.0.0`） |
| 隔离档（独立 worktree）                            | 钩子在孩子进程里，与 cwd 无关 ⇒ 一视同仁（这也是不用写 settings 文件的最大好处）                                                                                                                                               |
| 孩子的全局 settings 里 `cacheWarming` 已经是 `off` | 钩子照样返回 stop（幂等）                                                                                                                                                                                                      |
| 预热已经被别的扩展停掉                             | 最后一个返回 action 的 handler 说了算 ⇒ 我们的 stop 不恢复预热（保守方向正确）                                                                                                                                                 |

#### 2.4.4 要改哪些文件 / 函数

| 文件                              | 改什么                                                       |
| --------------------------------- | ------------------------------------------------------------ |
| `src/core/cache-warming.ts`（新） | `cacheWarmingDecision(depth)`（纯函数，返回常量形状）        |
| `src/index.ts`                    | 工厂层注册 `cache_warming_decision` 钩子（depth > 0 时）     |
| `docs/spec/core-spec.html`        | 新增一小节：「预热：孩子侧关掉（钩子，不是 settings 文件）」 |

---

## 3. 测试与验收

> 纪律：**一条功能点 = 一条测试 + 一条破坏点**（`scripts/breakpoints.ts`）。
> 门禁入口是 `pnpm test`（`scripts/test.ts`），**不要**直接 `node --test`。
> 施工顺序：先写代码 + 测试 → `pnpm fmt` → 再取破坏点锚点（oxfmt 会折行折断锚点，仓里踩过）→ `pnpm check:breakpoints` 全 killed。

**本节怎么读**：

| 小节          | 回答什么问题                                                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| §3.1          | 改哪几个测试文件                                                                                                                                |
| §3.2 / §3.2.1 | **有哪些用例**（施工单列的 62 条，实际写了 61 条——第 62 条是假绿已删；标题可直接抄）                                                            |
| §3.3          | **有哪些破坏点**（施工单列的 55 条，实际 316 条在 `scripts/breakpoints.ts`）+ **覆盖矩阵**（功能点 → 用例 → 破坏点 → 缺口）+ 写不出破坏点的清单 |
| §3.4          | 哪些变异是**等价变异**（mutator 杀不掉，也不该杀）                                                                                              |
| §3.5          | **验收线**（每条带「怎么判定」）                                                                                                                |
| §3.6          | **验红规程**（怎么确认一条破坏点真的杀到了它该杀的东西）                                                                                        |
| §3.7          | **变异测试规程**（`pnpm mutate` 怎么跑、退出码、基线、幸存怎么判、幸存怎么写进文件头）                                                          |
| §3.8          | **计数口径**（施工后的实际值：用例 61 / 破坏点 316 / 功能点 71 / 闸 13 道，别各处数字打架）                                                     |

### 3.1 新增 / 改动的测试文件

| 文件                      | 状态   | 装什么                                    |
| ------------------------- | ------ | ----------------------------------------- |
| `test/budget.test.ts`     | **新** | 预算口径、闸、阶段判定、预热决策          |
| `test/thinking.test.ts`   | **新** | 档位校验与降级                            |
| `test/child.test.ts`      | 改     | argv 内容、user message、增量用量累加     |
| `test/core-logic.test.ts` | 改     | 新增两道闸的用例；改「安检 10」的闸数断言 |
| `test/engine.test.ts`     | 改     | 预算软门 / 硬门的行为、thinking 回执      |
| `test/adapter.test.ts`    | 改     | 钩子注册、工具 schema 带 `usageBudget`    |
| `test/tui.test.ts`        | 改     | 面板行内的预算到点 / 档位降级提示         |

### 3.2 逐项用例标题（可直接抄进 `test/*.test.ts`）

#### 【1】usageBudget

`test/budget.test.ts`：

1. `预算：token 口径含 cacheRead（缓存型子代理的账不失真）`
2. `预算：token 口径含 cacheWrite`
3. `预算：美元口径取累计 cost（没有 cost 时按 0 算）`
4. `预算：恰好等于上限 ⇒ 进软门（>= 不是 >）`
5. `预算：低于上限 ⇒ 不动`
6. `预算：两个上限都给了 ⇒ 任一越线即到点`
7. `预算：超过硬门倍数 ⇒ 进硬门`
8. `预算：没到硬门倍数 ⇒ 仍是软门`
9. `预算：软门后超过宽限期 ⇒ 进硬门（不靠新用量）`
10. `预算：已经硬收过就一直是硬门（不回到软门）`
11. `预算：没给预算 ⇒ phase ok`
12. `预算：硬门先于软门成立时直接进硬门（不先软门）`

`test/core-logic.test.ts`：

13. `安检 17：usageBudget 至少要给一个上限（maxUsd / maxTokens）`
14. `安检 17b：usageBudget 的上限必须是正的有限数（0 / 负数 / NaN 都拒）`
15. `安检 17c：usageBudget 的 hardFactor / hardGraceMs 要合法`
16. `安检 18：user message 超过 64 KiB 要拒（拼进一个 argv 装不下）`
17. `安检 18b：user message 不能以 @ 开头（pi 会把它当文件读）`
18. `安检 10：默认闸序含隔离/黑板两道值闸`（**既有用例要改**：`gates.length` 由 11 改成 13，并加 `assert.equal(gates[11], usageBudgetGate)`、`assert.equal(gates[12], messageBytesGate)`）

`test/child.test.ts`：

19. `收件：增量用量累加 = 终局 parseChildStream 的口径（同一段流，两条路同数）`
20. `收件：增量用量跨 chunk 的半行不丢（usage 事件被切成两半也要算进去）`
21. `收件：增量用量只认 assistant 的 message_end（user / system 的 usage 不计）`

`test/engine.test.ts`：

22. `引擎：预算到点 ⇒ 降级交付（不 failed，回执标 budgetExhausted）`
23. `引擎：预算到点 ⇒ 给孩子写一条收尾转向（软门，收据里看得见）`
24. `引擎：硬门 ⇒ 收掉孩子（SIGTERM），部分正文照交`
25. `引擎：没给预算 ⇒ 不写转向也不收尸`
26. `引擎：预算回执带上限、已花的钱与 token`

#### 【2】thinking 校验

`test/thinking.test.ts`：

27. `思考档位：模型支持该档 ⇒ 原样发（不降级）`
28. `思考档位：thinkingLevelMap 显式 null ⇒ 降到 low（vendor-local 的 medium）`
29. `思考档位：降级只往下不往上（生效档位的成本序不得高于请求档位）`
30. `思考档位：模型不在目录里 ⇒ 原样透传并说明未校验`
31. `思考档位：非思考模型 ⇒ 不发后缀（= off）`
32. `思考档位：xhigh/max 缺键 ⇒ 按 pi 口径落到最接近的一档（不静默降成 low）`
33. `思考档位：裸 id 唯一命中也能找到模型`
34. `思考档位：裸 id 撞多个 ⇒ 不校验（原样透传）`
35. `思考档位：回执说明实际生效档位与降级原因`
36. `思考档位：只发 supported 里的档位 ⇒ pi 的 clamp 不会再改它（档位必在支持集里）`

`test/child.test.ts`：

37. `拼命令：降级后的档位进 --model 后缀（a/b:low）`
38. `拼命令：没给档位时不拼后缀（a/b 不带冒号）`

`test/engine.test.ts`：

39. `引擎：thinking 降级写进回执（requested/effective/reason）`

#### 【3】前缀稳定化

`test/child.test.ts`：

40. `拼命令：附加块恒定（why 不进系统提示词）`
41. `拼命令：why 进 user message`
42. `拼命令：隔离契约进 user message，不进系统提示词`
43. `拼命令：没有 why 也没有隔离时，user message 就是任务原文（argv 与今天逐字节相同）`
44. `golden：附加块逐字节等于冻结字面量（上下文 + 报告契约）`
45. `golden：user message 逐字节等于冻结字面量（任务 + why + 隔离契约）`

#### 【4】关掉预热

`test/budget.test.ts`：

46. `成本：depth>0 的孩子关掉 cache 预热（action=stop）`
47. `成本：父会话（depth=0）不表态（不返回 action，预热照旧）`

`test/adapter.test.ts`：

48. `适配层：子代理进程（depth>0）注册 cache_warming_decision 并返回 stop`
49. `适配层：父进程不注册 cache_warming_decision`

### 3.2.1 覆盖矩阵查出来的用例缺口（13 条，与上面 49 条并列）

> 这 13 条是 §3.3.3 的覆盖矩阵查出来的：**§2 写了行为、§3.2 没有对应用例**。编号接在 49 后面。

| #   | 用例标题（可直接抄进 `test/*.test.ts`）                                 | 放哪个文件              | 它守的是 §2 的哪条边界                                                                                                                           |
| --- | ----------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 50  | `引擎：没交报告时预算照样判（账上也有数）`                              | `test/engine.test.ts`   | §2.1.5「`reportChannel=none` ⇒ 预算照判、账照记」                                                                                                |
| 51  | `引擎：孩子没起来 ⇒ 不带 budget 字段`                                   | `test/engine.test.ts`   | §2.1.5「孩子没起（spawn 失败 / 排队时被取消）⇒ 不带 budget 字段」                                                                                |
| 52  | `引擎：受理时钉死预算（排队期间改参数不生效）`                          | `test/engine.test.ts`   | §2.1.5「排队期间预算参数被改 ⇒ 不支持」                                                                                                          |
| 53  | `引擎：软门后孩子交了差 ⇒ 报告旗标与预算旗标不互相掩盖`                 | `test/engine.test.ts`   | §2.1.5「软门后孩子自己交差了 ⇒ 既有旗标照常记，预算旗标独立」                                                                                    |
| 54  | `思考档位：没给 model 时用会话模型查目录`                               | `test/thinking.test.ts` | §2.2.5「调用方没给 `model`（继承会话模型）⇒ 用 `sessionModel` 查目录」                                                                           |
| 55  | `成本：depth=2 的孩子也关掉 cache 预热`                                 | `test/budget.test.ts`   | §2.4.3「子代理套子代理（depth 2）⇒ 整棵子树都关」                                                                                                |
| 56  | `拼命令：理由里的 XML 实体被转义（不会伪造标签）`                       | `test/child.test.ts`    | §2.3.4「理由里的 XML 实体 ⇒ 块内不许伪造标签」                                                                                                   |
| 57  | `拼命令：user message 的顺序是 任务 → why → 隔离契约`                   | `test/child.test.ts`    | §2.3.4「隔离契约的顺序 ⇒ 任务 → why → 隔离契约」                                                                                                 |
| 58  | `适配层：pi 不认识 cache_warming_decision 时不炸`                       | `test/adapter.test.ts`  | §2.4.3「老版本 pi 注册未知事件 ⇒ try/catch 兜底（不影响派发）」                                                                                  |
| 59  | `适配层：dispatch_task 的 schema 带 usageBudget`                        | `test/adapter.test.ts`  | §2.1.4「`DISPATCH_TASK_SCHEMA` 加 `usageBudget`」                                                                                                |
| 60  | `适配层：dispatch_list 的行带 budget / thinking / budgetExhausted 三列` | `test/adapter.test.ts`  | §2.1.4 / §2.2.4「列表多带三列」                                                                                                                  |
| 61  | `适配层：终态通知在预算到点时带「降级交付」、降档时带「high→low」`      | `test/adapter.test.ts`  | §2.1.4 / §2.2.3「通知带预算/档位提示」                                                                                                           |
| 62  | ~~`适配层：不给子代理写 .pi/settings.json（走钩子不写文件）`~~ **已删** | —                       | 假绿：只调 `session_start`、没派子代理 ⇒ 断言的是没人碰过的路径（改任何源码都绿）。机制已换成钩子，写文件这条路径压根不存在 ⇒ 见 §3.3.4 第 11 条 |

新用例总数 = 49 + 13 = 62，**其中第 62 条已删**（假绿，见上表）⇒ **61 条**（计数口径见 §3.8）。

### 3.3 破坏点与覆盖矩阵

> 三块：§3.3.1 已有 14 条（沿用 codex 写的，red 归属有两处改正，见表下的说明）、§3.3.2 新增 41 条、§3.3.3 覆盖矩阵、§3.3.4 写不出单行破坏点的功能点。
> **锚点纪律**：`from` 必须在目标文件里**恰好出现一次**（0 次或多次都判红）。下面所有锚点按 §2 的代码形状写；**施工时以实际写出的代码为准，先 `pnpm fmt` 再取锚点**（oxfmt 折行会折断锚点，仓里踩过）。
> **函数名列**：现有 `scripts/breakpoints.ts` 的条目没有函数名（只有 file/from/to），新增条目把函数名带在「功能点」列里，方便施工时定位。
> ⚠️ **§3.3.1 与 §3.3.2 的 BP 编号是「施工单」阶段的临时编号，已与实际表漂移**（例：BP-39 的 `mapped === undefined` 在现码里不存在）。施工完成后的实际破坏点见 **`scripts/breakpoints.ts`**，其 feature 字符串已抄进 §3.3.3 矩阵的「破坏点」列 ⇒ **以那一列为准**。

#### 3.3.1 已有 14 条（沿用）

| #     | 功能点                     | file                        | from                                                                                                                           | to                                                                                                                             | test                      | red（精确标题）                                                                  |
| ----- | -------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------- | -------------------------------------------------------------------------------- |
| BP-1  | 预算到点进软门             | `src/core/budget.ts`        | `  if (overUsd \|\| overTokens) {`                                                                                             | `  if (overUsd && overTokens) {`                                                                                               | `test/budget.test.ts`     | `预算：恰好等于上限 ⇒ 进软门（>= 不是 >）`                                       |
| BP-2  | 硬门倍数生效               | `src/core/budget.ts`        | `  const factor = budget.hardFactor ?? DEFAULT_HARD_FACTOR;`                                                                   | `  const factor = budget.hardFactor ?? DEFAULT_HARD_FACTOR * 2;`                                                               | `test/budget.test.ts`     | `预算：超过硬门倍数 ⇒ 进硬门`                                                    |
| BP-3  | 软门后宽限期到点进硬门     | `src/core/budget.ts`        | `  const hardByTime = input.softAt !== undefined && input.now - input.softAt >= grace;`                                        | `  const hardByTime = input.softAt !== undefined && input.now - input.softAt > grace;`                                         | `test/budget.test.ts`     | `预算：软门后超过宽限期 ⇒ 进硬门（不靠新用量）`                                  |
| BP-4  | token 口径含 cacheRead     | `src/core/budget.ts`        | `    (usage.cacheRead ?? 0) +`                                                                                                 | `    0 +`                                                                                                                      | `test/budget.test.ts`     | `预算：token 口径含 cacheRead（缓存型子代理的账不失真）`                         |
| BP-5  | 预算闸：至少一个上限       | `src/core/gates.ts`         | `  if (budget.maxUsd === undefined && budget.maxTokens === undefined)`                                                         | `  if (false)`                                                                                                                 | `test/core-logic.test.ts` | `安检 17：usageBudget 至少要给一个上限（maxUsd / maxTokens）`                    |
| BP-6  | 降级到 low                 | `src/core/thinking.ts`      | `  if (supported.includes("low")) return "low";`                                                                               | `  if (supported.includes("low")) return "off";`                                                                               | `test/thinking.test.ts`   | `思考档位：thinkingLevelMap 显式 null ⇒ 降到 low（vendor-local 的 medium）`      |
| BP-7  | 降级只往下不往上           | `src/core/thinking.ts`      | `  const cheaper = supported.filter((level) => COST_ORDER.indexOf(level as never) <= COST_ORDER.indexOf(requested as never));` | `  const cheaper = supported.filter((level) => COST_ORDER.indexOf(level as never) >= COST_ORDER.indexOf(requested as never));` | `test/thinking.test.ts`   | `思考档位：降级只往下不往上（生效档位的成本序不得高于请求档位）`                 |
| BP-8  | 只发 supported 里的档位    | `src/core/thinking.ts`      | `  if (supported.includes(requested))`                                                                                         | `  if (true)`                                                                                                                  | `test/thinking.test.ts`   | `思考档位：只发 supported 里的档位 ⇒ pi 的 clamp 不会再改它（档位必在支持集里）` |
| BP-9  | 附加块恒定（why 不进前缀） | `src/core/child.ts`         | `  argv.push("--append-system-prompt", CONTRACT_BLOCK);`                                                                       | `  argv.push("--append-system-prompt", CONTRACT_BLOCK + (options.why ?? ""));`                                                 | `test/child.test.ts`      | `拼命令：附加块恒定（why 不进系统提示词）`                                       |
| BP-10 | why 进 user message        | `src/core/child.ts`         | `    options.why ? \`<pi-dispatch-why>${escapeXmlText(options.why)}</pi-dispatch-why>\` : "",`                                 | `    "",`                                                                                                                      | `test/child.test.ts`      | `拼命令：why 进 user message`                                                    |
| BP-11 | 隔离契约进 user message    | `src/core/child.ts`         | `    options.isolation === "worktree" ? WORKTREE_CONTRACT_BLOCK : "",`                                                         | `    "",`                                                                                                                      | `test/child.test.ts`      | `拼命令：隔离契约进 user message，不进系统提示词`                                |
| BP-12 | 增量用量与终局口径一致     | `src/core/child.ts`         | `    acc.usage = addUsage(acc.usage, takeUsage(message.usage));`                                                               | `    acc.usage = takeUsage(message.usage);`                                                                                    | `test/child.test.ts`      | `收件：增量用量累加 = 终局 parseChildStream 的口径（同一段流，两条路同数）`      |
| BP-13 | 孩子侧关预热               | `src/core/cache-warming.ts` | `  return depth > 0 ? { action: "stop" } : undefined;`                                                                         | `  return depth > 0 ? undefined : undefined;`                                                                                  | `test/budget.test.ts`     | `成本：depth>0 的孩子关掉 cache 预热（action=stop）`                             |
| BP-14 | 预算到点 ⇒ 降级交付        | `src/core/engine.ts`        | `  if (decision.phase === "soft" && state.softAt === undefined) {`                                                             | `  if (decision.phase === "ok" && state.softAt === undefined) {`                                                               | `test/engine.test.ts`     | `引擎：预算到点 ⇒ 降级交付（不 failed，回执标 budgetExhausted）`                 |

> **两处 red 归属改正**（不新增功能点，只把「该红的那条」指准）：
>
> - **BP-1** 的 `||` → `&&` 打的是「两个上限任一越线即到点」的 OR 语义 ⇒ red 应指 `预算：两个上限都给了 ⇒ 任一越线即到点`；「恰好等于上限 ⇒ 进软门（>= 不是 >）」交给新的 **BP-17**（把 `>=` 改成 `>`）。两条都不动。
> - **BP-8** 的 `if (true)` 打的是「生效档位必须在 supported 里」⇒ red 仍指 `思考档位：只发 supported 里的档位 …`；「模型支持该档 ⇒ 原样发」交给新的 **BP-36**。

#### 3.3.2 新增破坏点（BP-15 ~ BP-55，41 条）

> 每条一行给全：`from`（原样必须在目标文件里恰好出现一次）/ `to`（破坏版，必须仍是合法 TS）/ 该红的用例标题（逐字抄 §3.2）。
> 表里「函数」列是施工时的定位提示；`src/core/budget.ts`、`src/core/thinking.ts`、`src/core/cache-warming.ts` 是新文件，函数名按 §2 给的形状写。

| #     | 功能点（函数）                                                         | file                        | from                                                                                              | to                                                                                            | test                      | red（精确标题）                                                                     |
| ----- | ---------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------- |
| BP-15 | token 口径含 cacheWrite（`totalTokens`）                               | `src/core/budget.ts`        | `    (usage.cacheWrite ?? 0) +`                                                                   | `    0 +`                                                                                     | `test/budget.test.ts`     | `预算：token 口径含 cacheWrite`                                                     |
| BP-16 | 没有 cost 时按 0 算（`usdOf`）                                         | `src/core/budget.ts`        | `  return usage.cost?.total ?? 0;`                                                                | `  return usage.cost?.total ?? 1;`                                                            | `test/budget.test.ts`     | `预算：美元口径取累计 cost（没有 cost 时按 0 算）`                                  |
| BP-17 | 到点判定用 `>=` 不是 `>`（`evaluateBudget`）                           | `src/core/budget.ts`        | `spentUsd >= budget.maxUsd`                                                                       | `spentUsd > budget.maxUsd`                                                                    | `test/budget.test.ts`     | `预算：恰好等于上限 ⇒ 进软门（>= 不是 >）`                                          |
| BP-18 | 低于上限不动（`evaluateBudget`）                                       | `src/core/budget.ts`        | `spentTokens >= budget.maxTokens`                                                                 | `spentTokens >= 0`                                                                            | `test/budget.test.ts`     | `预算：低于上限 ⇒ 不动`                                                             |
| BP-19 | 没到硬门倍数仍是软门（`evaluateBudget`）                               | `src/core/budget.ts`        | `spentUsd >= budget.maxUsd * factor`                                                              | `spentUsd >= budget.maxUsd`                                                                   | `test/budget.test.ts`     | `预算：没到硬门倍数 ⇒ 仍是软门`                                                     |
| BP-20 | 硬收过就一直硬门（`#checkBudget` → `evaluateBudget` 的 `hard` 入参）   | `src/core/engine.ts`        | `      hard: state.hard,`                                                                         | `      hard: false,`                                                                          | `test/engine.test.ts`     | `预算：已经硬收过就一直是硬门（不回到软门）`                                        |
| BP-21 | 没给预算 ⇒ phase ok（`evaluateBudget`）                                | `src/core/budget.ts`        | `  if (!input.budget) return { phase: "ok"`                                                       | `  if (!input.budget) return { phase: "soft"`                                                 | `test/budget.test.ts`     | `预算：没给预算 ⇒ phase ok`                                                         |
| BP-22 | 硬门先于软门成立（`evaluateBudget`）                                   | `src/core/budget.ts`        | `  if (hardByUsage \|\| hardByTime)`                                                              | `  if (hardByTime)`                                                                           | `test/budget.test.ts`     | `预算：硬门先于软门成立时直接进硬门（不先软门）`                                    |
| BP-23 | 上限必须是正的有限数（`usageBudgetGate`）                              | `src/core/gates.ts`         | `  if (budget.maxUsd !== undefined && (!Number.isFinite(budget.maxUsd) \|\| budget.maxUsd <= 0))` | `  if (false)`                                                                                | `test/core-logic.test.ts` | `安检 17b：usageBudget 的上限必须是正的有限数（0 / 负数 / NaN 都拒）`               |
| BP-24 | hardFactor / hardGraceMs 要合法（`usageBudgetGate`）                   | `src/core/gates.ts`         | `  if (budget.hardFactor !== undefined && budget.hardFactor < 1)`                                 | `  if (false)`                                                                                | `test/core-logic.test.ts` | `安检 17c：usageBudget 的 hardFactor / hardGraceMs 要合法`                          |
| BP-25 | user message 体积闸 ≤ 64 KiB（`messageBytesGate`）                     | `src/core/gates.ts`         | `  if (bytes > MAX_TEXT_BYTES)`                                                                   | `  if (false)`                                                                                | `test/core-logic.test.ts` | `安检 18：user message 超过 64 KiB 要拒（拼进一个 argv 装不下）`                    |
| BP-26 | user message 不能以 `@` 开头（`messageBytesGate`）                     | `src/core/gates.ts`         | `  if (message.startsWith("@"))`                                                                  | `  if (false)`                                                                                | `test/core-logic.test.ts` | `安检 18b：user message 不能以 @ 开头（pi 会把它当文件读）`                         |
| BP-27 | 新闸接在默认闸序末尾（`defaultGates`）                                 | `src/core/gates.ts`         | `  usageBudgetGate,`                                                                              | `  messageBytesGate,`                                                                         | `test/core-logic.test.ts` | `安检 10：默认闸序含隔离/黑板两道值闸`                                              |
| BP-28 | 增量用量跨 chunk 的半行不丢（`createUsageTracker` 的 `push`）          | `src/core/child.ts`         | `    this.buffer = lines.pop() ?? "";`                                                            | `    this.buffer = "";`                                                                       | `test/child.test.ts`      | `收件：增量用量跨 chunk 的半行不丢（usage 事件被切成两半也要算进去）`               |
| BP-29 | 只认 assistant 的 message_end（`createUsageTracker`）                  | `src/core/child.ts`         | `    if (message.role !== "assistant") return;`                                                   | `    if (false) return;`                                                                      | `test/child.test.ts`      | `收件：增量用量只认 assistant 的 message_end（user / system 的 usage 不计）`        |
| BP-30 | 软门写收尾转向（`#checkBudget`）                                       | `src/core/engine.ts`        | `    await this.steer(taskId, BUDGET_STEER_TEXT);`                                                | `    await this.steer(taskId, "");`                                                           | `test/engine.test.ts`     | `引擎：预算到点 ⇒ 给孩子写一条收尾转向（软门，收据里看得见）`                       |
| BP-31 | 没给预算就不动作（`#checkBudget`）                                     | `src/core/engine.ts`        | `  const budget = input.usageBudget;`                                                             | `  const budget = input.usageBudget ?? { maxUsd: 0 };`                                        | `test/engine.test.ts`     | `引擎：没给预算 ⇒ 不写转向也不收尸`                                                 |
| BP-32 | 回执带上限与已花的钱和 token（`attach-budget` 的回执体）               | `src/core/registry.ts`      | `    spentTokens: input.spentTokens,`                                                             | `    spentTokens: 0,`                                                                         | `test/engine.test.ts`     | `引擎：预算回执带上限、已花的钱与 token`                                            |
| BP-33 | 工具 schema 带 `usageBudget`（`DISPATCH_TASK_SCHEMA`）                 | `src/index.ts`              | `    usageBudget: usageBudgetSchema,`                                                             | `    usageBudget: {},`                                                                        | `test/adapter.test.ts`    | `适配层：dispatch_task 的 schema 带 usageBudget`                                    |
| BP-34 | 列表三列（`dispatch_list` 的行）                                       | `src/index.ts`              | `    budget: record.budget,`                                                                      | `    budget: undefined,`                                                                      | `test/adapter.test.ts`    | `适配层：dispatch_list 的行带 budget / thinking / budgetExhausted 三列`             |
| BP-35 | 终态通知带预算/档位提示（终态 push 的文案）                            | `src/index.ts`              | `    budgetExhausted ? "预算到点（降级交付）" : ""`                                               | `    ""`                                                                                      | `test/adapter.test.ts`    | `适配层：终态通知在预算到点时带「降级交付」、降档时带「high→low」`                  |
| BP-36 | 支持的档位原样发（`resolveThinkingLevel`）                             | `src/core/thinking.ts`      | `      effective: requested,`                                                                     | `      effective: "low",`                                                                     | `test/thinking.test.ts`   | `思考档位：模型支持该档 ⇒ 原样发（不降级）`                                         |
| BP-37 | 模型不在目录里 ⇒ 未校验（`resolveThinkingLevel`）                      | `src/core/thinking.ts`      | `    modelKnown: false,`                                                                          | `    modelKnown: true,`                                                                       | `test/thinking.test.ts`   | `思考档位：模型不在目录里 ⇒ 原样透传并说明未校验`                                   |
| BP-38 | 非思考模型 ⇒ off（`supportedThinkingLevels` / `resolveThinkingLevel`） | `src/core/thinking.ts`      | `    if (!model.reasoning) return { effective: "off"`                                             | `    if (false) return { effective: "off"`                                                    | `test/thinking.test.ts`   | `思考档位：非思考模型 ⇒ 不发后缀（= off）`                                          |
| BP-39 | 缺键 ⇒ 最接近的一档（`supportedThinkingLevels`）                       | `src/core/thinking.ts`      | `    if (mapped === undefined) return nearest(supported);`                                        | `    if (mapped === undefined) return "low";`                                                 | `test/thinking.test.ts`   | `思考档位：xhigh/max 缺键 ⇒ 按 pi 口径落到最接近的一档（不静默降成 low）`           |
| BP-40 | 裸 id 唯一命中（`findThinkingModel`）                                  | `src/core/thinking.ts`      | `  if (hits.length === 1) return hits[0];`                                                        | `  if (hits.length === 0) return hits[0];`                                                    | `test/thinking.test.ts`   | `思考档位：裸 id 唯一命中也能找到模型`                                              |
| BP-41 | 裸 id 撞多个 ⇒ 不校验（`findThinkingModel`）                           | `src/core/thinking.ts`      | `  if (hits.length > 1) return undefined;`                                                        | `  if (hits.length > 1) return hits[0];`                                                      | `test/thinking.test.ts`   | `思考档位：裸 id 撞多个 ⇒ 不校验（原样透传）`                                       |
| BP-42 | 回执说明降级原因（`resolveThinkingLevel` 的 `reason`）                 | `src/core/thinking.ts`      | `      reason: \`该模型没有 ${requested} 档（thinkingLevelMap=null）⇒ 降到 low\`,`                | `      reason: "",`                                                                           | `test/thinking.test.ts`   | `思考档位：回执说明实际生效档位与降级原因`                                          |
| BP-43 | 降级后的档位进 `--model` 后缀（`buildPiArgv`）                         | `src/core/child.ts`         | `  const modelArg = thinkingLevel ? \`${model}:${thinkingLevel}\` : model;`                       | `  const modelArg = model;`                                                                   | `test/child.test.ts`      | `拼命令：降级后的档位进 --model 后缀（a/b:low）`                                    |
| BP-44 | 没给档位时不拼后缀（`buildPiArgv`）                                    | `src/core/child.ts`         | `  const modelArg = thinkingLevel ? \`${model}:${thinkingLevel}\` : model;`                       | `  const modelArg = \`${model}:${thinkingLevel ?? "high"}\`;`                                 | `test/child.test.ts`      | `拼命令：没给档位时不拼后缀（a/b 不带冒号）`                                        |
| BP-45 | 引擎回执带 thinking（受理时写进初始记录）                              | `src/core/engine.ts`        | `      thinking: result,`                                                                         | `      thinking: undefined,`                                                                  | `test/engine.test.ts`     | `引擎：thinking 降级写进回执（requested/effective/reason）`                         |
| BP-46 | 没给 model 时用会话模型查目录（`effectiveModel`）                      | `src/core/child.ts`         | `  const model = input.model ?? sessionModel;`                                                    | `  const model = input.model;`                                                                | `test/thinking.test.ts`   | `思考档位：没给 model 时用会话模型查目录`                                           |
| BP-47 | 没有 why 也没有隔离时 user message == 任务原文（`buildUserMessage`）   | `src/core/child.ts`         | `    options.task,`                                                                               | `    \`${options.task}\n\`,`                                                                  | `test/child.test.ts`      | `拼命令：没有 why 也没有隔离时，user message 就是任务原文（argv 与今天逐字节相同）` |
| BP-48 | 附加块逐字节冻结（`CONTRACT_BLOCK`）                                   | `src/core/child.ts`         | `export const CONTRACT_BLOCK = [SUBAGENT_CONTEXT_BLOCK, REPORT_CONTRACT_BLOCK].join("\n");`       | `export const CONTRACT_BLOCK = [SUBAGENT_CONTEXT_BLOCK, REPORT_CONTRACT_BLOCK].join("\n\n");` | `test/child.test.ts`      | `golden：附加块逐字节等于冻结字面量（上下文 + 报告契约）`                           |
| BP-49 | user message 逐字节冻结（`buildUserMessage` 的分隔符）                 | `src/core/child.ts`         | `    .filter(Boolean)\n    .join("\n\n");`                                                        | `    .filter(Boolean)\n    .join("\n");`                                                      | `test/child.test.ts`      | `golden：user message 逐字节等于冻结字面量（任务 + why + 隔离契约）`                |
| BP-50 | 理由里的 XML 实体被转义（`buildUserMessage`）                          | `src/core/child.ts`         | `escapeXmlText(options.why)`                                                                      | `options.why`                                                                                 | `test/child.test.ts`      | `拼命令：理由里的 XML 实体被转义（不会伪造标签）`                                   |
| BP-51 | 父会话不表态（`cacheWarmingDecision`）                                 | `src/core/cache-warming.ts` | `  return depth > 0 ? { action: "stop" } : undefined;`                                            | `  return depth > 0 ? { action: "stop" } : { action: "stop" };`                               | `test/budget.test.ts`     | `成本：父会话（depth=0）不表态（不返回 action，预热照旧）`                          |
| BP-52 | depth=2 也关预热（`cacheWarmingDecision`）                             | `src/core/cache-warming.ts` | `  return depth > 0 ? { action: "stop" } : undefined;`                                            | `  return depth === 1 ? { action: "stop" } : undefined;`                                      | `test/budget.test.ts`     | `成本：depth=2 的孩子也关掉 cache 预热`                                             |
| BP-53 | 适配层注册钩子（工厂层，`src/index.ts`）                               | `src/index.ts`              | `    pi.on("cache_warming_decision", () => cacheWarmingDecision(depth));`                         | `    pi.on("cache_warming_decision", () => undefined);`                                       | `test/adapter.test.ts`    | `适配层：子代理进程（depth>0）注册 cache_warming_decision 并返回 stop`              |
| BP-54 | 父进程不注册钩子（工厂层的 depth 判断）                                | `src/index.ts`              | `  if (parseDepth(process.env.PI_DISPATCH_DEPTH) > 0)`                                            | `  if (true)`                                                                                 | `test/adapter.test.ts`    | `适配层：父进程不注册 cache_warming_decision`                                       |
| BP-55 | 老版本 pi 注册未知事件不炸（工厂层的 try/catch）                       | `src/index.ts`              | `    pi.on("cache_warming_decision", () => cacheWarmingDecision(depth));\n  } catch {`            | `    pi.on("cache_warming_decision", () => cacheWarmingDecision(depth));\n  }`                | `test/adapter.test.ts`    | `适配层：pi 不认识 cache_warming_decision 时不炸`                                   |

**同一锚点多条破坏点**（各自独立替换，互不冲突，施工时留意别把两条的 `from` 抄成同一条）：BP-43 / BP-44 共用 `buildPiArgv` 的 `modelArg` 那一行（`to` 不同）；BP-13 / BP-51 / BP-52 共用 `cacheWarmingDecision` 的 `return` 那一行（`to` 不同）。

#### 3.3.3 覆盖矩阵（功能点 → 用例 → 破坏点 → 缺口）

> 口径：**一个功能点 = 一条测试 + 一条破坏点**（`scripts/breakpoints.ts`）。
> 本表逐行对齐 §2 的四条改造；「用例」列的标题逐字抄 §3.2 / §3.2.1。
> **「破坏点」列写的是 `scripts/breakpoints.ts` 里的实际 feature 字符串**（不是 BP 编号——BP 编号是施工单阶段的临时编号，与实际表已漂移；以本列为准）。
> 一行可能对应**多条**破坏点（同一用例守多个位点，如美元线与 token 线各一条），列里用 `/` 分隔。
> 「缺口怎么补」列是施工单的旧措辞：带「已补（见破坏点列）」的表示**已实现并已进 `scripts/breakpoints.ts`**。

**【1】usageBudget**

| #    | 功能点                                          | 用例（§3.2 标题）                                                                                                                                                           | 破坏点                                                                                                                                            | 缺口怎么补                                                      |
| ---- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| B-01 | token 口径含 cacheRead                          | `预算：token 口径含 cacheRead（缓存型子代理的账不失真）`                                                                                                                    | `token 口径含 cacheRead（totalTokens）`                                                                                                           | —                                                               |
| B-02 | token 口径含 cacheWrite                         | `预算：token 口径含 cacheWrite`                                                                                                                                             | `token 口径含 cacheWrite（totalTokens）`                                                                                                          | 已补（见破坏点列）                                              |
| B-03 | 美元口径取累计 cost（缺 cost 按 0）             | `预算：美元口径取累计 cost（没有 cost 时按 0 算）`                                                                                                                          | `没有 cost 时按 0 算（usdOf）`                                                                                                                    | 已补（见破坏点列）（用例要同时断言累计值与「缺 cost ⇒ 0」两半） |
| B-04 | 到点判定用 `>=` 不是 `>`                        | `预算：恰好等于上限 ⇒ 进软门（>= 不是 >）`                                                                                                                                  | `到点判定用 >= 不是 >（evaluateBudget）`                                                                                                          | 已补（见破坏点列）；red 已让给 B-06                             |
| B-05 | 低于上限 ⇒ 不动                                 | `预算：低于上限 ⇒ 不动`                                                                                                                                                     | `低于上限不动（evaluateBudget）`                                                                                                                  | 已补（见破坏点列）                                              |
| B-06 | 两个上限任一越线即到点（OR 语义）               | `预算：两个上限都给了 ⇒ 任一越线即到点`                                                                                                                                     | `预算到点进软门（两个上限任一越线，OR 语义）`                                                                                                     | red 归属已改（§3.3.1 表下说明）                                 |
| B-07 | 超过硬门倍数 ⇒ 硬门                             | `预算：超过硬门倍数 ⇒ 进硬门`                                                                                                                                               | `硬门倍数生效（evaluateBudget）`                                                                                                                  | —                                                               |
| B-08 | 没到硬门倍数 ⇒ 仍是软门                         | `预算：没到硬门倍数 ⇒ 仍是软门`                                                                                                                                             | `没到硬门倍数仍是软门（evaluateBudget）`                                                                                                          | 已补（见破坏点列）                                              |
| B-09 | 软门后超宽限期 ⇒ 硬门（不靠新用量）             | `预算：软门后超过宽限期 ⇒ 进硬门（不靠新用量）`                                                                                                                             | `软门后宽限期到点进硬门（evaluateBudget）`                                                                                                        | —                                                               |
| B-10 | 硬收过就一直硬门（不回落软门）                  | `预算：已经硬收过就一直是硬门（不回到软门）`                                                                                                                                | `硬收过就一直硬门（evaluateBudget 的 hard 入参）`                                                                                                 | 已补（见破坏点列）                                              |
| B-11 | 没给预算 ⇒ phase ok                             | `预算：没给预算 ⇒ phase ok`                                                                                                                                                 | `没给预算 ⇒ phase ok（evaluateBudget）`                                                                                                           | 已补（见破坏点列）                                              |
| B-12 | 硬门先于软门成立 ⇒ 直接硬门                     | `预算：硬门先于软门成立时直接进硬门（不先软门）`                                                                                                                            | `硬门先于软门成立（evaluateBudget）`                                                                                                              | 已补（见破坏点列）；纯「顺序」缺陷另见 §3.3.4 第 8 条           |
| B-13 | 预算闸：至少要给一个上限                        | `安检 17：usageBudget 至少要给一个上限（maxUsd / maxTokens）`                                                                                                               | `预算闸：至少一个上限（usageBudgetGate）`                                                                                                         | —                                                               |
| B-14 | 预算闸：上限是正的有限数                        | `安检 17b：usageBudget 的上限必须是正的有限数（0 / 负数 / NaN 都拒）`                                                                                                       | `上限必须是正的有限数（usageBudgetGate）` / `maxTokens 也必须是正的有限数（usageBudgetGate）`                                                     | 已补（见破坏点列）                                              |
| B-15 | 预算闸：hardFactor / hardGraceMs 合法           | `安检 17c：usageBudget 的 hardFactor 必须是 ≥1 的有限数（NaN / Infinity / 字符串都拒）` + `安检 17d：usageBudget 的 hardGraceMs 必须是正的有限数，且不超过 setTimeout 上限` | `hardFactor < 1 要拒（usageBudgetGate）` / `hardFactor 非有限数要拒（usageBudgetGate）` / `hardGraceMs 不超过 setTimeout 上限（usageBudgetGate）` | —（B-32 行的 `hardFactor = 1` 语义另有破坏点）                  |
| B-16 | 闸序：新闸接末尾，既有 11 道索引不动            | `安检 10：默认闸序含隔离/黑板两道值闸`                                                                                                                                      | `新闸接进默认闸序` / `缺省 git 探测按「不是 git 仓」算` / `新闸接在默认闸序末尾（defaultGates）`                                                  | 已补（见破坏点列）（既有用例已改：`gates.length` = 13）         |
| B-17 | 增量用量口径 = 终局 `parseChildStream`          | `收件：增量用量累加 = 终局 parseChildStream 的口径（同一段流，两条路同数）`                                                                                                 | `增量用量与终局口径一致（createUsageTracker）`                                                                                                    | —                                                               |
| B-18 | 增量用量跨 chunk 半行不丢                       | `收件：增量用量跨 chunk 的半行不丢（usage 事件被切成两半也要算进去）`                                                                                                       | `增量用量跨 chunk 的半行不丢（createUsageTracker）`                                                                                               | 已补（见破坏点列）                                              |
| B-19 | 增量用量只认 assistant 的 `message_end`         | `收件：增量用量只认 assistant 的 message_end（user / system 的 usage 不计）`                                                                                                | `只认 assistant 的 message_end（createUsageTracker）`                                                                                             | 已补（见破坏点列）                                              |
| B-20 | 预算到点 ⇒ 降级交付（不 failed）                | `引擎：预算到点 ⇒ 降级交付（不 failed，回执标 budgetExhausted）`                                                                                                            | `预算到点 ⇒ 降级交付（#checkBudget 的软门分支）`                                                                                                  | —                                                               |
| B-21 | 软门写收尾转向（收据可见）                      | `引擎：预算到点 ⇒ 给孩子写一条收尾转向（软门，收据里看得见）`                                                                                                               | `软门写收尾转向（#checkBudget）`                                                                                                                  | 已补（见破坏点列）                                              |
| B-22 | 硬门 ⇒ 收掉孩子（SIGTERM），部分正文照交        | `引擎：硬门 ⇒ 收掉孩子（SIGTERM），部分正文照交`                                                                                                                            | `硬门走 stop（#checkBudget）`                                                                                                                     | 缺席类，见 §3.3.4 第 1 条                                       |
| B-23 | 没给预算 ⇒ 不写转向也不收尸                     | `引擎：没给预算 ⇒ 不写转向也不收尸`                                                                                                                                         | `没给预算就不动作（#checkBudget）`                                                                                                                | 已补（见破坏点列）                                              |
| B-24 | 预算回执带上限、已花的钱与 token                | `引擎：预算回执带上限、已花的钱与 token`                                                                                                                                    | `回执带上限与已花的钱和 token（#attachBudget）` / `回执带上已花的美元（#attachBudget）`                                                           | 已补（见破坏点列）                                              |
| B-25 | 没交报告时预算照样判（账上也有数）              | `引擎：没交报告时预算照样判（账上也有数）`                                                                                                                                  | `运行中用量检查不依赖报告通道（#pump）`                                                                                                           | 缺席类，见 §3.3.4 第 2 条；用例补在 §3.2.1 第 50 条             |
| B-26 | 孩子没起来 ⇒ 不带 budget 字段                   | `引擎：孩子没起来 ⇒ 不带 budget 字段`                                                                                                                                       | `孩子没起来不带 budget 回执（#resultFromRecord）`                                                                                                 | 缺席类，见 §3.3.4 第 3 条；用例补在 §3.2.1 第 51 条             |
| B-27 | 受理时钉死预算（排队期间改参数不生效）          | `引擎：受理时钉死预算（排队期间改参数不生效）`                                                                                                                              | `受理时钉死预算（#dispatchReady 克隆入参）`                                                                                                       | 缺席类，见 §3.3.4 第 4 条；用例补在 §3.2.1 第 52 条             |
| B-28 | 报告旗标与预算旗标不互相掩盖                    | `引擎：软门后孩子交了差 ⇒ 报告旗标与预算旗标不互相掩盖`                                                                                                                     | `报告旗标与预算旗标不互相掩盖（#resultFromRecord）`                                                                                               | 缺席类，见 §3.3.4 第 5 条；用例补在 §3.2.1 第 53 条             |
| B-29 | 工具 schema 带 `usageBudget`                    | `适配层：dispatch_task 的 schema 带 usageBudget`                                                                                                                            | `工具 schema 带 usageBudget（DISPATCH_TASK_SCHEMA）`                                                                                              | 已补（见破坏点列）；用例已写（见 §3.2.1）                       |
| B-30 | 列表三列（budget / thinking / budgetExhausted） | `适配层：dispatch_list 的行带 budget / thinking / budgetExhausted 三列`                                                                                                     | `列表三列（dispatch_list 的行）`                                                                                                                  | 已补（见破坏点列）；用例已写（见 §3.2.1）                       |
| B-31 | 终态通知带预算/档位提示                         | `适配层：终态通知在预算到点时带「降级交付」、降档时带「high→low」`                                                                                                          | `终态通知带预算/档位提示（deliver 的文案）`                                                                                                       | 已补（见破坏点列）；用例已写（见 §3.2.1）                       |
| B-32 | `hardFactor = 1` ⇒ 到点直接硬门（跳过降级交付） | `预算：hardFactor=1 ⇒ 跳过软门直接进硬门`                                                                                                                                   | `hardFactor=1 ⇒ 跳过软门直接进硬门（evaluateBudget）`                                                                                             | 已补（见破坏点列）                                              |
| B-33 | TUI 面板行内带预算/档位提示                     | `tui：行内带预算到点与档位降级提示`                                                                                                                                         | `TUI 行内带预算到点与档位降级提示`                                                                                                                | 已补（见破坏点列）                                              |

**【2】thinking 校验**

| #    | 功能点                                            | 用例（§3.2 标题）                                                                | 破坏点                                               | 缺口怎么补                                                 |
| ---- | ------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------- |
| T-01 | 模型支持该档 ⇒ 原样发                             | `思考档位：模型支持该档 ⇒ 原样发（不降级）`                                      | `支持的档位原样发（resolveThinkingLevel）`           | 已补（见破坏点列）                                         |
| T-02 | `thinkingLevelMap` 显式 null ⇒ 降到 low           | `思考档位：thinkingLevelMap 显式 null ⇒ 降到 low（vendor-local 的 medium）`      | `降级到 low（downgradeTarget）`                      | —                                                          |
| T-03 | 降级只往下不往上                                  | `思考档位：降级只往下不往上（生效档位的成本序不得高于请求档位）`                 | `降级只往下不往上（downgradeTarget）`                | —                                                          |
| T-04 | 模型不在目录里 ⇒ 原样透传 + 说明未校验            | `思考档位：模型不在目录里 ⇒ 原样透传并说明未校验`                                | `模型不在目录里 ⇒ 未校验（resolveThinkingLevel）`    | 已补（见破坏点列）                                         |
| T-05 | 非思考模型 ⇒ 不发后缀（= off）                    | `思考档位：非思考模型 ⇒ 不发后缀（= off）`                                       | `非思考模型 ⇒ off（resolveThinkingLevel）`           | 已补（见破坏点列）                                         |
| T-06 | xhigh/max 缺键 ⇒ 最接近的一档                     | `思考档位：xhigh/max 缺键 ⇒ 按 pi 口径落到最接近的一档（不静默降成 low）`        | `缺键 ⇒ 最接近的一档（resolveThinkingLevel）`        | 已补（见破坏点列）                                         |
| T-07 | 裸 id 唯一命中                                    | `思考档位：裸 id 唯一命中也能找到模型`                                           | `裸 id 唯一命中（findThinkingModel）`                | 已补（见破坏点列）                                         |
| T-08 | 裸 id 撞多个 ⇒ 不校验                             | `思考档位：裸 id 撞多个 ⇒ 不校验（原样透传）`                                    | `裸 id 撞多个 ⇒ 不校验（findThinkingModel）`         | 已补（见破坏点列）                                         |
| T-09 | 回执说明生效档位与降级原因                        | `思考档位：回执说明实际生效档位与降级原因`                                       | `回执说明降级原因（resolveThinkingLevel 的 reason）` | 已补（见破坏点列）                                         |
| T-10 | 只发 supported 里的档位                           | `思考档位：只发 supported 里的档位 ⇒ pi 的 clamp 不会再改它（档位必在支持集里）` | `只发 supported 里的档位（resolveThinkingLevel）`    | —                                                          |
| T-11 | 降级后的档位进 `--model` 后缀                     | `拼命令：降级后的档位进 --model 后缀（a/b:low）`                                 | `降级后的档位进 --model 后缀（buildPiArgv）`         | 已补（见破坏点列）                                         |
| T-12 | 没给档位时不拼后缀                                | `拼命令：没给档位时不拼后缀（a/b 不带冒号）`                                     | `没给档位时不拼后缀（buildPiArgv）`                  | 已补（见破坏点列）                                         |
| T-13 | 引擎回执带 thinking                               | `引擎：thinking 降级写进回执（requested/effective/reason）`                      | `引擎回执带 thinking（受理时写进初始记录）`          | 已补（见破坏点列）                                         |
| T-14 | 没给 model 时用会话模型查目录                     | `思考档位：没给 model 时用会话模型查目录`                                        | `没给 model 时用会话模型查目录（effectiveModel）`    | 已补（见破坏点列）；用例已写（见 §3.2.1）                  |
| T-15 | 模型写成模式（`vendor-local/*`）⇒ 查不到 ⇒ 不校验 | `思考档位：模型不在目录里 ⇒ 原样透传并说明未校验`（同一条功能点的另一个输入）    | `模型不在目录里 ⇒ 未校验（resolveThinkingLevel）`    | 同一功能点，不另开破坏点                                   |
| T-16 | 没给 `thinkingLevel` ⇒ 不拼后缀（不擅自降档）     | `拼命令：没给档位时不拼后缀（a/b 不带冒号）`                                     | `没给档位时不拼后缀（buildPiArgv）`                  | 同一功能点                                                 |
| T-17 | 虚拟模型的档位（路由后）                          | ✗ 无可测用例                                                                     | —                                                    | 外部类（provider 行为），见 §3.3.4 第 7 条 → §3.5 真机验证 |

**【3】前缀稳定化**

| #    | 功能点                                         | 用例（§3.2 标题）                                                                   | 破坏点                                                               | 缺口怎么补                                          |
| ---- | ---------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------- |
| P-01 | 附加块恒定（why 不进系统提示词）               | `拼命令：附加块恒定（why 不进系统提示词）`                                          | `附加块恒定（buildPiArgv）`                                          | —                                                   |
| P-02 | why 进 user message                            | `拼命令：why 进 user message`                                                       | `why 进 user message（buildUserMessage）`                            | —                                                   |
| P-03 | 隔离契约进 user message，不进系统提示词        | `拼命令：隔离契约进 user message，不进系统提示词`                                   | `隔离契约进 user message（buildUserMessage）`                        | —                                                   |
| P-04 | 没有 why 也没有隔离 ⇒ user message == 任务原文 | `拼命令：没有 why 也没有隔离时，user message 就是任务原文（argv 与今天逐字节相同）` | `没有 why 也没有隔离时 user message == 任务原文（buildUserMessage）` | 已补（见破坏点列）                                  |
| P-05 | 附加块逐字节冻结                               | `golden：附加块逐字节等于冻结字面量（上下文 + 报告契约）`                           | `附加块逐字节冻结（CONTRACT_BLOCK）`                                 | 已补（见破坏点列）                                  |
| P-06 | user message 逐字节冻结                        | `golden：user message 逐字节等于冻结字面量（任务 + why + 隔离契约）`                | `user message 逐字节冻结（buildUserMessage 的分隔符）`               | 已补（见破坏点列）                                  |
| P-07 | user message 体积闸 ≤ 64 KiB                   | `安检 18：user message 超过 64 KiB 要拒（拼进一个 argv 装不下）`                    | `user message 体积闸 ≤ 64 KiB（messageBytesGate）`                   | 与 B-14 同一条功能点（闸序）                        |
| P-08 | user message 不能以 `@` 开头                   | `安检 18b：user message 不能以 @ 开头（pi 会把它当文件读）`                         | `user message 不能以 @ 开头（messageBytesGate）`                     | 与 B-14 同一条功能点（闸序）                        |
| P-09 | 理由里的 XML 实体被转义                        | `拼命令：理由里的 XML 实体被转义（不会伪造标签）`                                   | `理由里的 XML 实体被转义（buildUserMessage）`                        | 已补（见破坏点列）；用例已写（见 §3.2.1）           |
| P-10 | user message 顺序：任务 → why → 隔离契约       | `拼命令：user message 的顺序是 任务 → why → 隔离契约`                               | `user message 顺序是 任务 → why → 隔离契约`                          | 顺序类，见 §3.3.4 第 8 条；用例补在 §3.2.1 第 57 条 |
| P-11 | 孩子对 why 的引用（报告契约文本一字不改）      | `报告契约：三段分工 + 反话钉 + why 条件句`（既有用例，不改）                        | `契约反话钉不能松` / `why 条件句不能丢`                              | 结构类，见 §3.3.4 第 9 条                           |
| P-12 | 黑板消息从不进提示词（本次不动）               | `golden：开黑板时附加块逐字节不变（黑板契约全在工具描述里）`（既有用例，不改）      | —                                                                    | 结构类，见 §3.3.4 第 9 条（既有用例守）             |

**【4】关掉预热**

| #    | 功能点                              | 用例（§3.2 标题）                                                              | 破坏点                                             | 缺口怎么补                                                                  |
| ---- | ----------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------- | --------------------------------------------------------------------------- |
| W-01 | depth>0 ⇒ action=stop               | `成本：depth>0 的孩子关掉 cache 预热（action=stop）`                           | `孩子侧关预热（cacheWarmingDecision）`             | —                                                                           |
| W-02 | depth=0 ⇒ 不表态（预热照旧）        | `成本：父会话（depth=0）不表态（不返回 action，预热照旧）`                     | `父会话不表态（cacheWarmingDecision）`             | 已补（见破坏点列）                                                          |
| W-03 | depth=2（套子代理）也关             | `成本：depth=2 的孩子也关掉 cache 预热`                                        | `depth=2 也关预热（cacheWarmingDecision）`         | 已补（见破坏点列）；用例已写（见 §3.2.1）                                   |
| W-04 | 适配层：depth>0 注册钩子并返回 stop | `适配层：子代理进程（depth>0）注册 cache_warming_decision 并返回 stop`         | `适配层注册预热钩子（工厂层）`                     | 已补（见破坏点列）                                                          |
| W-05 | 适配层：父进程不注册                | `适配层：父进程不注册 cache_warming_decision`                                  | `父进程不注册钩子（工厂层的 depth 判断）`          | 已补（见破坏点列）                                                          |
| W-06 | 老版本 pi 注册未知事件不炸          | `适配层：pi 不认识 cache_warming_decision 时不炸`                              | `老版本 pi 注册未知事件不炸（工厂层的 try/catch）` | 已补（见破坏点列）；用例已写（见 §3.2.1）                                   |
| W-07 | 不给子代理写 `.pi/settings.json`    | ✗ 无可测用例                                                                   | —                                                  | 结构类：没有「写文件」这条代码路径可改 ⇒ **无破坏点**（见 §3.3.4 第 11 条） |
| W-08 | 隔离档一视同仁 / 幂等 / 不恢复预热  | `成本：depth>0 的孩子关掉 cache 预热（action=stop）`（同一功能点的另两个输入） | `孩子侧关预热（cacheWarmingDecision）`             | 同一功能点，不另开破坏点                                                    |

**类型层**（不是运行时行为点，`pnpm check` 守，不占用例也不占破坏点）：`src/core/types.ts` 新增 `UsageBudget` / `BudgetReceipt` / `ThinkingReceipt` 与三个挂点字段、`EngineDeps.thinkingCatalog?`、`DispatchInput.usageBudget?`。判据：`pnpm check`（tsrs）不过 ⇒ 红。

#### 3.3.4 写不出单行破坏点的功能点（不许静默缺）

> 照 `scripts/breakpoints.ts` 顶部的既有格式写进注释块：每条写清「缺陷是什么 + 为什么单行替换表达不了 + 由哪条用例守」。
> 三类：**缺席类**（没有对应代码路径可改）/ **顺序类**（缺陷是语句顺序）/ **结构类**（缺陷是「某段代码不存在」）。另有 **外部类**（provider / 环境行为，本仓不可测）走 §3.5 真机验证。
>
> ⚠️ **施工后的实况**：第 1–5 条（缺席类）**已各自找到破坏点**（矩阵 B-22 / B-25 / B-26 / B-27 / B-28 的「破坏点」列），第 8 条的顺序变体由 `user message 顺序是 任务 → why → 隔离契约` 守 ⇒ **仍无破坏点的是 6 条**：第 6、7、10 条（外部类）+ 第 8 条的纯顺序变体 + 第 9、11 条（结构类）。
>
> > 下面第 1–5 条的「单行替换表达不了」是**当初的判断**，现已被更精确的锚点推翻——它们各自都有破坏点了。

1. **硬门走 `stop`（SIGTERM → SIGKILL）** — 缺席类。缺陷是「没调 `stop`」，正确实现的硬门分支里那行 `await this.stop(taskId, …)` **就是不能删**（删了是删代码，不是改代码），单行替换只能把参数换掉、换出来的行为照样是「收掉孩子」，打不出「没收掉」的差异 ⇒ 由 `引擎：硬门 ⇒ 收掉孩子（SIGTERM），部分正文照交`（断言假 spawn 收到 SIGTERM）守。 ⇒ **现已有破坏点：`硬门走 stop（#checkBudget）`**（当初「单行替换表达不了」的判断已被更精确的锚点推翻）。
2. **预算判定与报告通道解耦（`reportChannel=none` 时预算照判）** — 缺席类。缺陷是「预算判定挂在报告通道上」，而正确实现里**根本不存在**「先看报告再判预算」这条路径 ⇒ 改哪一行都改不出「没交报告就不判预算」⇒ 由 `引擎：没交报告时预算照样判（账上也有数）` 守。 ⇒ **现已有破坏点：`运行中用量检查不依赖报告通道（#pump）`**（当初「单行替换表达不了」的判断已被更精确的锚点推翻）。
3. **孩子没起来 ⇒ 不带 budget 字段** — 缺席类。缺陷是「多带了 budget 键」，正确实现的 `#resultFromRecord` 里**没有**这个键（按「默认关时键不出现」的纪律）⇒ 单行改不出「键存在且为 undefined」与「键不存在」的可观测差别 ⇒ 由 `引擎：孩子没起来 ⇒ 不带 budget 字段` 守。 ⇒ **现已有破坏点：`孩子没起来不带 budget 回执（#resultFromRecord）`**（当初「单行替换表达不了」的判断已被更精确的锚点推翻）。
4. **受理时钉死预算（排队期间改参数不生效）** — 缺席类。缺陷是「重新读了外部可变参数」，正确实现**只读受理时存下的入参**（`#inputs`），没有第二条读取路径可改 ⇒ 由 `引擎：受理时钉死预算（排队期间改参数不生效）` 守。 ⇒ **现已有破坏点：`受理时钉死预算（#dispatchReady 克隆入参）`**（当初「单行替换表达不了」的判断已被更精确的锚点推翻）。
5. **报告旗标与预算旗标不互相掩盖** — 缺席类。缺陷是「预算分支覆盖了报告旗标」，正确实现里两条旗标互不触碰 ⇒ 没有一行能把「覆盖」变出来 ⇒ 由 `引擎：软门后孩子交了差 ⇒ 报告旗标与预算旗标不互相掩盖` 守。 ⇒ **现已有破坏点：`报告旗标与预算旗标不互相掩盖（#resultFromRecord）`**（当初「单行替换表达不了」的判断已被更精确的锚点推翻）。
6. **跨子代理缓存共享（省钱的真正收益）** — 外部类。收益在 provider 侧（缓存键 / TTL / 会话亲和），本仓没有可改的代码 ⇒ 走 §3.5 的【需真机验证】；仓内能守的只是「前缀逐字节恒定」（P-01 / P-05 / P-06）。
7. **虚拟模型的 thinking 档位（路由后）** — 外部类。目录里查的是虚拟模型本身，档位由 provider 路由决定，本仓不可测 ⇒ 走 §3.5 的【需真机验证】。
8. **user message 的顺序（任务 → why → 隔离契约）** 与 **硬门先于软门判定** — 顺序类。缺陷是「语句顺序反了」，文本替换只能换字、换不了顺序 ⇒ 由 `拼命令：user message 的顺序是 任务 → why → 隔离契约` 与 `预算：硬门先于软门成立时直接进硬门（不先软门）` 守。（BP-22 杀的是「硬门判定缺一分支」这个变体；纯顺序变体只能靠断言。）
9. **黑板消息从不进提示词 / 报告契约文本一字不改** — 结构类。缺陷是「多了一段读板拼提示词的代码」或「契约文本被改」，正确实现里**没有**那段代码 ⇒ 由 `test/child.test.ts` 既有的附加块逐字节 golden 与 `报告契约：三段分工 + 反话钉 + why 条件句` 守。
10. **provider 侧的预热经济性判定** — 外部类。pi 自己算「预热划不划算」，本仓只负责「说不说 stop」⇒ 由 `成本：depth>0 的孩子关掉 cache 预热（action=stop）` 守「说了 stop」，经济性本身不可测。
11. **不给子代理写 `.pi/settings.json`** — 结构类。缺陷是「多了一段写文件的代码」，正确实现**没有**写文件这条路径 ⇒ 单行破坏点打不出「写了 vs 没写」的差异（本仓没有任何一行会创建这个文件）⇒ **不占破坏点**。这一条此前挂着一个「适配层：不给子代理写 .pi/settings.json（走钩子不写文件）」的用例——**该用例已删**：它只调了 `session_start`、没派子代理，断言的是一条没人碰过的路径（改任何源码都绿 ⇒ 假绿）。W-07 现在是**没有用例也没有破坏点**的结构类：真正的守门人是「成本：depth>0 的孩子关掉 cache 预热（action=stop）」——机制换成钩子后，写文件这条路径压根不存在。

> §2 各小节的边界情况清单里属于这三类的，逐条指到 §3.2 的用例标题：
>
> - §2.1.5「硬门杀掉的孩子的最终 status = `canceled`（不许装成 `succeeded`）」⇒ 缺席类，由 `引擎：硬门 ⇒ 收掉孩子（SIGTERM），部分正文照交` 守（该用例同时断言 status）。
> - §2.1.5「排队期间预算参数被改 ⇒ 不支持」⇒ 缺席类，由 `引擎：受理时钉死预算（排队期间改参数不生效）` 守。
> - §2.1.5「`reportChannel=none` ⇒ 预算照判、账照记」⇒ 缺席类，由 `引擎：没交报告时预算照样判（账上也有数）` 守。
> - §2.1.5「孩子没起（spawn 失败 / 排队时被取消）⇒ 结果里不带 budget 字段」⇒ 缺席类，由 `引擎：孩子没起来 ⇒ 不带 budget 字段` 守。
> - §2.1.5「软门后孩子自己交差了 ⇒ 既有旗标照常记，预算旗标独立」⇒ 缺席类，由 `引擎：软门后孩子交了差 ⇒ 报告旗标与预算旗标不互相掩盖` 守。
> - §2.2.5「模型是虚拟模型 ⇒ 目录里查的是虚拟模型本身」⇒ 外部类，§3.5 真机验证。
> - §2.2.5「调用方没给 `model` ⇒ 用 `sessionModel` 查目录」⇒ 可测，由 `思考档位：没给 model 时用会话模型查目录` 守（BP-46）。
> - §2.2.5「调用方没给 `thinkingLevel` ⇒ 不拼后缀（不擅自替父方降档）」⇒ 可测，由 `拼命令：没给档位时不拼后缀（a/b 不带冒号）` 守（BP-44）。
> - §2.3.4「隔离契约的顺序固定：任务 → why → 隔离契约」⇒ 顺序类，由 `拼命令：user message 的顺序是 任务 → why → 隔离契约` 守。
> - §2.3.4「理由里的 XML 实体 ⇒ 块内不许伪造标签」⇒ 可测，由 `拼命令：理由里的 XML 实体被转义（不会伪造标签）` 守（BP-50）。
> - §2.3.4「user message 不能以 `@` 开头 ⇒ 再补一条断言防将来有人在 task 前加前缀」⇒ 可测，由 `安检 18b：user message 不能以 @ 开头（pi 会把它当文件读）` 守（BP-26）。
> - §2.3.4「黑板消息从不进提示词 ⇒ 本次不动」⇒ 结构类，由既有的附加块 golden 守。
> - §2.4.3「孩子进程里 pi 版本 < 支持该钩子的版本 ⇒ 注册处 try/catch 兜底」⇒ 可测，由 `适配层：pi 不认识 cache_warming_decision 时不炸` 守（BP-55）。
> - §2.4.3「预热已经被别的扩展停掉 ⇒ 我们的 stop 不恢复预热（保守方向正确）」⇒ 可测但与 W-01 同一条功能点的另一个输入，由 `成本：depth>0 的孩子关掉 cache 预热（action=stop）` 守（BP-13）。

> `from` 必须在目标文件里**恰好出现一次**。以下锚点按 §2 的代码形状写；施工时以实际写出的代码为准，**先 `pnpm fmt` 再取锚点**。

| #     | 功能点                     | file                        | from                                                                                                                           | to                                                                                                                             | test                      | red（精确标题）                                                                  |
| ----- | -------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------- | -------------------------------------------------------------------------------- |
| BP-1  | 预算到点进软门             | `src/core/budget.ts`        | `  if (overUsd \|\| overTokens) {`                                                                                             | `  if (overUsd && overTokens) {`                                                                                               | `test/budget.test.ts`     | `预算：恰好等于上限 ⇒ 进软门（>= 不是 >）`                                       |
| BP-2  | 硬门倍数生效               | `src/core/budget.ts`        | `  const factor = budget.hardFactor ?? DEFAULT_HARD_FACTOR;`                                                                   | `  const factor = budget.hardFactor ?? DEFAULT_HARD_FACTOR * 2;`                                                               | `test/budget.test.ts`     | `预算：超过硬门倍数 ⇒ 进硬门`                                                    |
| BP-3  | 软门后宽限期到点进硬门     | `src/core/budget.ts`        | `  const hardByTime = input.softAt !== undefined && input.now - input.softAt >= grace;`                                        | `  const hardByTime = input.softAt !== undefined && input.now - input.softAt > grace;`                                         | `test/budget.test.ts`     | `预算：软门后超过宽限期 ⇒ 进硬门（不靠新用量）`                                  |
| BP-4  | token 口径含 cacheRead     | `src/core/budget.ts`        | `    (usage.cacheRead ?? 0) +`                                                                                                 | `    0 +`                                                                                                                      | `test/budget.test.ts`     | `预算：token 口径含 cacheRead（缓存型子代理的账不失真）`                         |
| BP-5  | 预算闸：至少一个上限       | `src/core/gates.ts`         | `  if (budget.maxUsd === undefined && budget.maxTokens === undefined)`                                                         | `  if (false)`                                                                                                                 | `test/core-logic.test.ts` | `安检 17：usageBudget 至少要给一个上限（maxUsd / maxTokens）`                    |
| BP-6  | 降级到 low                 | `src/core/thinking.ts`      | `  if (supported.includes("low")) return "low";`                                                                               | `  if (supported.includes("low")) return "off";`                                                                               | `test/thinking.test.ts`   | `思考档位：thinkingLevelMap 显式 null ⇒ 降到 low（vendor-local 的 medium）`      |
| BP-7  | 降级只往下不往上           | `src/core/thinking.ts`      | `  const cheaper = supported.filter((level) => COST_ORDER.indexOf(level as never) <= COST_ORDER.indexOf(requested as never));` | `  const cheaper = supported.filter((level) => COST_ORDER.indexOf(level as never) >= COST_ORDER.indexOf(requested as never));` | `test/thinking.test.ts`   | `思考档位：降级只往下不往上（生效档位的成本序不得高于请求档位）`                 |
| BP-8  | 只发 supported 里的档位    | `src/core/thinking.ts`      | `  if (supported.includes(requested))`                                                                                         | `  if (true)`                                                                                                                  | `test/thinking.test.ts`   | `思考档位：只发 supported 里的档位 ⇒ pi 的 clamp 不会再改它（档位必在支持集里）` |
| BP-9  | 附加块恒定（why 不进前缀） | `src/core/child.ts`         | `  argv.push("--append-system-prompt", CONTRACT_BLOCK);`                                                                       | `  argv.push("--append-system-prompt", CONTRACT_BLOCK + (options.why ?? ""));`                                                 | `test/child.test.ts`      | `拼命令：附加块恒定（why 不进系统提示词）`                                       |
| BP-10 | why 进 user message        | `src/core/child.ts`         | `    options.why ? \`<pi-dispatch-why>${escapeXmlText(options.why)}</pi-dispatch-why>\` : "",`                                 | `    "",`                                                                                                                      | `test/child.test.ts`      | `拼命令：why 进 user message`                                                    |
| BP-11 | 隔离契约进 user message    | `src/core/child.ts`         | `    options.isolation === "worktree" ? WORKTREE_CONTRACT_BLOCK : "",`                                                         | `    "",`                                                                                                                      | `test/child.test.ts`      | `拼命令：隔离契约进 user message，不进系统提示词`                                |
| BP-12 | 增量用量与终局口径一致     | `src/core/child.ts`         | `    acc.usage = addUsage(acc.usage, takeUsage(message.usage));`                                                               | `    acc.usage = takeUsage(message.usage);`                                                                                    | `test/child.test.ts`      | `收件：增量用量累加 = 终局 parseChildStream 的口径（同一段流，两条路同数）`      |
| BP-13 | 孩子侧关预热               | `src/core/cache-warming.ts` | `  return depth > 0 ? { action: "stop" } : undefined;`                                                                         | `  return depth > 0 ? undefined : undefined;`                                                                                  | `test/budget.test.ts`     | `成本：depth>0 的孩子关掉 cache 预热（action=stop）`                             |
| BP-14 | 预算到点 ⇒ 降级交付        | `src/core/engine.ts`        | `  if (decision.phase === "soft" && state.softAt === undefined) {`                                                             | `  if (decision.phase === "ok" && state.softAt === undefined) {`                                                               | `test/engine.test.ts`     | `引擎：预算到点 ⇒ 降级交付（不 failed，回执标 budgetExhausted）`                 |

> 「写不出单行破坏点的功能点」的完整清单在 §3.3.4（原三条已扩成 11 条，分类给出）。

### 3.4 等价变异（mutator 杀不掉、要写进测试文件头的段落）

新增文件 `test/budget.test.ts` / `test/thinking.test.ts` 的文件头要写「等价变异」段。写法照现有 `test/*.test.ts` 顶部的既有段落：**每条写清「变异是什么」+「为何在可达输入上等价」**。建议条目：

1. `totalTokens` 里四处 `usage.x ?? 0`：`??` → `||` 的分歧只在 `x === 0` 时，而右值就是 `0` ⇒ `0 || 0 === 0` ⇒ **可达输入上等价**（同 `child.ts` 里 `addUsage` 的既有条目）。
2. `usdOf` 的 `usage.cost ?? 0` → `||`：同上（`0 || 0 === 0`）。
3. `evaluateBudget` 里 `budget.maxUsd !== undefined && …` 的 `!==` → `!=`：`maxUsd` 是 `number | undefined`，`null` 不在类型里且闸已拒 ⇒ **可达输入上等价**。
4. `resolveThinkingLevel` 里 `args.requested?.trim() || undefined` → `?? undefined`：`trim()` 对非空串返回非空串 ⇒ 只有空串时两者都 undefined ⇒ 等价（`||` 的额外 falsy 情形被 `?.` 先行挡掉）。
5. `supportedThinkingLevels` 里 `mapped === null` → `mapped == null`：`thinkingLevelMap` 的值类型是 `string | null`（`undefined` 只在缺键时出现，缺键走另一条分支）⇒ **可达输入上等价**。
6. `COST_ORDER.indexOf(level as never)` 的比较方向 `>=` / `<=`：**不是等价变异**——由 `思考档位：降级只往下不往上` 杀掉，不要写进等价段。

`pnpm mutate` 的退出码 3 是基线（既有等价变异）；**新代码零幸存**才是线（AGENTS.md 第 5 步）。操作规程见 §3.7。

### 3.5 验收线（下一轮施工完成的标准）

每条都给「怎么判定」（看什么输出、什么退出码算通过）。计数口径见 §3.8。

| #   | 验收项                                                                       | 怎么判定                                                                                                                                                                                                           | 计数口径                                         |
| --- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| A-1 | `pnpm fmt` 后 `pnpm test` / `check` / `lint` / `fmt:check` 全绿              | 四条命令各自**退出码 0**；`pnpm test` 输出里 `# pass N` 的 N **> 0**（N=0 是「一条都没跑过」的假绿，`scripts/test.ts` 会自己退 1）                                                                                 | 用例数 = §3.8 的口径                             |
| A-2 | `pnpm check:breakpoints` 全 killed                                           | 命令**退出码 0**，末行 `N/N 红在该红的测试用例上` 且 N = §3.8 的破坏点总数；输出里**没有** `survived` / `wrong-red` / `bad-anchor` / `bad-title` / `bad-syntax`                                                    | 破坏点 = §3.8 的口径                             |
| A-3 | `pnpm mutate`：新文件零幸存                                                  | 命令**退出码 3**（= 全仓既有等价变异还在，这正是基线）**且** 三个新文件的 `survived` 计数为 0；差分看 `.metrics/mutate/` 里 `core.budget.edn` / `core.thinking.edn` / `core.cache-warming.edn` 的 `:survived` 计数 | 全仓基线 46 幸存（22 个 namespace，1210 killed） |
| A-4 | 等价变异写进测试文件头                                                       | `test/budget.test.ts` / `test/thinking.test.ts` 顶部有「等价变异」段，每条写清「变异是什么」+「为何在可达输入上等价」                                                                                              | §3.4 建议 5 条 + 施工时新增的幸存条目对应条数    |
| A-5 | `docs/spec/core-spec.html` 同步                                              | §安检（加第 13/14 道）、§命令怎么拼（改两行）、新增「预算：软门 + 硬门」与「预热：孩子侧关掉」两节——逐条能指到 §2.1.4 / §2.3.5 / §2.4.4 的改动清单                                                                 | 与 §2 的改动文件表逐行对应                       |
| A-6 | `pnpm check:breakpoints` **同时只能跑一个**                                  | 跑之前确认没有第二个在跑（它会临时改写源码再复原，并行两跑会读到对方改到一半的源码 ⇒ 锚点「出现 0 次」误判）                                                                                                       | —                                                |
| A-7 | **需真机验证**（下一轮 `pnpm test:mode`，因为改了 `buildPiArgv` 与用量通道） | 五条真机断言逐条有观察记录（见下）                                                                                                                                                                                 | 5 条                                             |

A-7 的五条真机断言（每条都要**看到证据**才算过）：

1. 派一个带 `usageBudget` 的子代理，确认到点后**交了报告**（软门路径），回执 `budgetExhausted: true`、status 仍是 `succeeded`。
2. 派一个 `thinkingLevel: "medium"` + `model: "regex:test-vendor/group/main"` 的子代理，确认回执里 `effective` 是 `low`、**且孩子实际跑的档位是 low**（看事件流里的 `thinkingLevel` 字段）。
3. 派两个只有 `why` 不同的子代理，对比首轮的 `usage.cacheRead`：**第二个应当命中前缀缓存**（若 provider 支持跨会话前缀共享）。⚠️ provider 不支持就**不算失败**——仓内能守的只是「前缀逐字节恒定」（P-01 / P-05 / P-06）。
4. 派一个 `isolation=worktree` 的子代理，确认它仍然**自己 commit**、没有 push（隔离契约搬到 user message 后的服从度）。
5. `isolation=worktree` + `usageBudget` 同时开：确认 worktree 里的孩子也能收到软门转向。

### 3.6 验红规程（怎么确认一条破坏点真的杀到了它该杀的东西）

> 术语照 GLOSSARY：**假绿** / **红错地方** / **验红**。
> 跑器是 `scripts/breakpoints.ts`（`pnpm check:breakpoints`），它把 `from` 改成 `to`、只跑 `red` 指名的那一条用例、要求它真红、再复原。**手改源码时也要走同一套流程**，否则就是凭感觉。

#### 3.6.1 操作流程

1. **改源码**：把目标文件里的 `from` 整段替换成 `to`（一字不差地替换整段，不是替换其中几个字）。
2. **只跑指名的那一条用例**：不要跑整棵 `test/`。手动跑法是 `node --test --test-name-pattern='<red 标题>' <test 文件>`（**注意**：正式门禁请用 `pnpm test` / `pnpm check:breakpoints`，直接 `node --test` 在测试进程或派发子代理里会一条都不跑却退 0 —— 那是假绿；`scripts/test.ts` 会先擦掉继承来的 `NODE_TEST_CONTEXT` / `PI_DISPATCH_DEPTH`）。
3. **要求它真红**：指名用例必须变成 `not ok N - <red 标题>`，且失败块里是 `ERR_ASSERTION`（断言失败），不是无关的 TypeError。
4. **复原**：把源码改回原样（`git diff` 里这一处应当干净）。

一次验红只碰一个功能点。跑器会自动复原；手改时**必须自己复原**，否则下一个破坏点的基线已经被污染了。

#### 3.6.2 三条判据：各自的含义与失败表现

| 判据         | 含义                                           | 失败表现（看到的现象）                                  | 怎么防                                                                                                                                                                                                                                                                                                                                                        |
| ------------ | ---------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **假绿**     | 改了源码，指名的那条用例**还是绿的**           | 跑完 `ok N - <red 标题>`，退出码 0                      | 换更狠的 `to`（把 `\|\|` 改成 `&&`、把 `>=` 改成 `>` 这种通常不够）；换锚点；确认这条用例**真的断言了这个功能点**（用例太松是根因）                                                                                                                                                                                                                           |
| **红错地方** | 套件红了，但红的是**别的**用例，不是指名的那条 | 指名用例 `ok`，别的用例 `not ok`                        | 看 TAP 里 `not ok` 的标题是不是指名那条；跑器记 `wrong-red`                                                                                                                                                                                                                                                                                                   |
| **标题写错** | `red` 标题在文件里**一条都没命中**             | node 输出 `ok 1 - <文件名>`、**退出码 0** —— 看着像通过 | ⚠️ **最隐蔽的坑**：0 命中时 node 把整个文件当「一个通过的用例」报出来，退出码 0。**防法**：① 跑完先看 TAP 里有没有 `not ok N - <red 标题>` 这一行（光看退出码不算数）；② 跑器有前置检查——指名用例在**未变异**时必须先是绿的，0 命中就记 `bad-title` 而不是 `killed`；③ 手工验红时在标题后加个错字试试，看它是否会「假通过」——会，就说明你正处在标题写错的状态 |

> **「标题写错」的三个征兆**：TAP 里只有一行 `ok 1 - test/xxx.test.ts`（没有用例级 `ok N - 标题`）；`# pass 1`；没有任何 `not ok`。看到这三条 ⇒ 标题没命中，**不是通过**。

#### 3.6.3 破坏点表自身的约束

1. **`from` 必须在目标文件里恰好出现一次**：出现 0 次或多次都要**判红**（跑器的 `bad-anchor`）。0 次 = 锚点写错或代码已经变了；多次 = 锚点不唯一，改一行会连带改到别处。
2. **先 `pnpm fmt` 再取锚点**：oxfmt 的折行会把一行拆成多行，锚点跨行就再也匹配不上——仓里踩过这个坑。**顺序是：写代码 → 写测试 → `pnpm fmt` → 再取锚点 → 写进 `scripts/breakpoints.ts`**。
3. **`pnpm check:breakpoints` 同时只能跑一个**：它会临时改写源码再复原，并行两跑会读到对方改到一半的源码 ⇒ 锚点「出现 0 次」或改到别人的行上。
4. **`to` 必须仍是合法 TS**：写坏了就不是「功能点被弄坏」，是「整个文件炸了」——跑器记 `bad-syntax`，而不是 killed。
5. **一条破坏点只钉一个功能点**：同一个 `from` 可以配不同的 `to`（本方案 BP-43 / BP-44、BP-13 / BP-51 / BP-52 就是这样），但一条破坏点只该有一条 red。
6. **写不出破坏点的功能点要在注释块里逐条说明理由**：照 `scripts/breakpoints.ts` 顶部的既有格式（分类 + 理由 + 由哪条用例守），不许静默缺。本方案的理由见 §3.3.4。

#### 3.6.4 一条功能点 = 一条测试 + 一条破坏点

- **一条功能点**（GLOSSARY：规格里一条可验证的行为）⇒ **一条测试用例**（§3.2 / §3.2.1 的标题之一）+ **一条破坏点**（§3.3 的 BP 编号之一）。
- 写不出破坏点的功能点：**必须**在 `scripts/breakpoints.ts` 顶部的注释块里逐条写明「缺席类 / 顺序类 / 结构类 / 外部类」+ 理由 + 由哪条用例守（本方案清单见 §3.3.4）。
- 覆盖矩阵（§3.3.3）是这条纪律的账本：**功能点 → 用例 → 破坏点 → 缺口**。矩阵里每行的「缺口怎么补」列要么是「—」（不缺），要么写清补哪条 BP / 补哪条用例。

### 3.7 变异测试规程（`pnpm mutate`）

#### 3.7.1 怎么跑、退出码什么意思

```bash
pnpm mutate                          # 整棵 src（package.json: "mutate": "mutator --no-coverage src"）
mutator --no-coverage src/core/budget.ts   # 单个文件（mutator 在 PATH 上，不在 node_modules/.bin）
```

> ⚠️ **别写 `pnpm mutate src/core/budget.ts`**：`pnpm run` 会把参数**追加**到脚本后面 ⇒ 实际执行的是 `mutator --no-coverage src src/core/budget.ts` ⇒ 整棵 `src` 照样全跑一遍（只是多跑一遍那个文件），看不到「单文件」的效果。要单文件就直接调 `mutator`（它在 PATH 上：`~/.local/bin/mutator`）。

| 退出码 | 含义                                     | 处置                                                                              |
| ------ | ---------------------------------------- | --------------------------------------------------------------------------------- |
| `0`    | 跑到的变异**全被杀干净**（或没东西可跑） | 新代码零幸存 ✅                                                                   |
| `1`    | 用法错误                                 | 改命令重跑                                                                        |
| `2`    | **基线测试就失败了**                     | 先修测试/代码；基线红的时候 mutator 不重写快照，别在这状态下看幸存数              |
| `3`    | **至少有一个变异幸存**                   | 这是本仓的**基线**（既有等价变异）⇒ 看幸存的是不是新代码，是就补测试/写等价变异段 |

> mutator 跑测试用的命令是 `package.json` 的 `test`（= `node scripts/test.ts`）⇒ 基线就是整棵 `test/`。它给每个变异开一个 `target/mutation-workers/` 下的软链覆盖层，**原仓不动**。

#### 3.7.2 三个新增源文件怎么单独跑、基线怎么记

```bash
mutator --no-coverage src/core/budget.ts
mutator --no-coverage src/core/thinking.ts
mutator --no-coverage src/core/cache-warming.ts
```

- mutator 是**差分**的：快照存在时只重跑「幸存者」+「文本变过的函数」里的位点；已杀的位点保持已杀（要全量重跑加 `--mutate-all`）。
- 单独跑一个文件时，**基线仍然是整棵 `test/`**（mutator 走 `package.json` 的 `test` 脚本 = `node scripts/test.ts`）⇒ 别的文件的变异不会混进这三个文件的幸存数。
- **基线怎么记**：本仓当前快照（2026-11-24，读 `.metrics/mutate/`）= **22 个 namespace、1210 killed、46 survived**。既有等价变异 ⇒ 基线退出码是 **3**。
- **新文件第一次跑**时快照里还没有它 ⇒ 该文件的所有位点会被全量执行；跑完看 `.metrics/mutate/core.budget.edn` / `core.thinking.edn` / `core.cache-warming.edn` 三个文件的 `:survived` 计数。

#### 3.7.3 「新代码零幸存」怎么判定

分两步，**别把既有等价变异当新代码幸存**：

1. **先看退出码**：退出码 3 = 有幸存（基线如此）⇒ 不是「全绿」，但也不是「新代码坏了」。
2. **再按命名空间拆**：幸存条目在 `.metrics/mutate/<namespace>.edn` 里，每条形如
   `["src/core/budget.ts","core.budget","defn/totalTokens",2162,2165,"??","||"] :survived`。
   - **路径落在三个新文件里** ⇒ **新代码幸存** ⇒ 两种处置：① 补一条测试断言把它杀掉（首选）；② 证明在可达输入上等价，写进测试文件头的「等价变异」段。
   - **路径落在既有文件里** ⇒ 既有等价变异，与本轮无关（基线里的 46 条）。
3. **新代码零幸存** = 三个新文件在 `.metrics/mutate/` 里的 `:survived` 计数**全为 0**，且 `src/core/gates.ts` / `src/core/child.ts` / `src/core/engine.ts` / `src/core/registry.ts` / `src/index.ts` 里**因本轮改动新增**的函数没有幸存（改过的函数会被差分重跑 ⇒ 它们的幸存数是本轮的责任）。
4. 改过的既有文件里，「本轮之前就幸存、且与本轮无关」的位点算既有基线 ⇒ 别把它记成本轮的锅；判定口径：**看函数名**——本轮碰过的函数（`usageBudgetGate` / `messageBytesGate` / `defaultGates` / `buildUserMessage` / `buildPiArgv` / `effectiveModel` / `createUsageTracker` / `#checkBudget` / `applyAttachBudget` / `cacheWarmingDecision` …）的幸存算本轮的，其余算既有的。

#### 3.7.4 幸存变异写进测试文件头的格式

照现有 `test/*.test.ts` 顶部的写法：**文件头一段「等价变异（…杀不掉，也不该杀）」，每条写清「变异是什么」+「为何在可达输入上等价」**。三个真实例子（照抄自现有文件头）：

```
//   三处 `x ?? y`（pid ?? 0、tools[name] ?? 0、close 的 code ?? -1）——
//   分歧只在 x 为 0 / "" 时，而这些 x 要么是进程 id（非负整数，0 只在读不到时，
//   但 ?? 与 || 对 0 都给 0），要么是工具计数（非负整数）。已穷举验证：可达输入上等价。
```

（`test/child.test.ts` 顶部）

```
//   src/core/registry.ts 的 `current.steers ?? []` → `||`——空数组是真值，两向同值 ⇒ 等价。
```

（`test/core-logic.test.ts` 顶部）

```
//   `Number(process.env.PI_DISPATCH_DEPTH ?? 0)` —— 未设时都给 0；设了是数字串，
//   "0" 在 ?? 下是 "0"、在 || 下是 0，Number 之后都是 0 ⇒ 等价。
```

（`test/adapter.test.ts` 顶部）

共同形状：**「表达式 → 变异」+「分歧只在哪种输入上」+「为什么那种输入不可达 / 两向同值」**。写「等价」但说不出**为什么不可达**，等于没写。

#### 3.7.5 常见等价变异模式清单

mutator 对 TypeScript 的变异集：`true`/`false`、`==`/`!=`、`===`/`!==`、`<`/`<=`、`>`/`>=`、`+`/`-`、`*`/`/`、`&&`/`||`、`!` 删除、`0`/`1`、`??`→`||`、`?.`→`.`。

**看着像等价、其实常常不等价的（别往等价段里写）**：

| 形态                        | 为什么不等价                                                                                                        | 谁杀它                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `??` → `\|\|`               | **只有**在右值与左值「同值时才同值」时才等价。右值不是 `0` / `""` / `false` 时，`??` 保左值、`\|\|` 换右值 ⇒ 不等价 | 具体看右值：右值是 `0` 才可能等价              |
| `?.` → `.`                  | 对象为 `undefined`/缺失时，`?.` 给 `undefined`、`.` 抛 TypeError ⇒ **永远不等价**（除非那处永远不为 undefined）     | 几乎所有 `?.` 都有被杀的可能                   |
| `!==` → `!=`                | `null` 不等于 `undefined` ⇒ `!=` 把 `null` 也算命中。类型里只有 `undefined`（没有 `null`）时才可能等价              | 类型里有 `null` ⇒ 不等价                       |
| `>=` → `>`（或 `<` → `<=`） | 边界值（恰好等于）上的行为不同 ⇒ 一般不等价                                                                         | §3.4 第 6 条的 `COST_ORDER` 比较方向就是这一类 |
| `&&` → `\|\|`               | 只在「两侧求值结果同值」时等价                                                                                      | 多分支逻辑里几乎总是不等价                     |
| `0` ↔ `1`（布尔/数字互换）  | 计数、序号、倍数都会变                                                                                              | 任何带数字的地方                               |
| `*` → `/`                   | 除数非零时结果不同                                                                                                  | 同上                                           |

**真正常见的等价变异**（写进等价段的典型形状）：

- `x ?? 0` → `x || 0`（右值就是 `0`，`0 || 0 === 0`）。
- `x ?? []` / `x ?? []` 之类右值是「恒真值」（空数组、对象、函数）的 `??` → `||`。
- `x !== undefined` → `x != undefined`（类型里没有 `null`）。
- `a.length === 0 || a.length > b.length` 的 `||` → `&&`（空段在别处已被滤掉 ⇒ 不可达）。
- `i < b.length` → `i <= b.length`（越界那轮比较的是 `undefined` 与字符串，恒不相等）。

#### 3.7.6 三个新增源文件各自的预期与验收线

| 文件                        | 预期（变异位点大概在哪）                                                                                                                                        | 验收线                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `src/core/budget.ts`        | `totalTokens`（`?? 0` ×4）、`usdOf`（`?? 0`）、`evaluateBudget`（`>=` / `>`、`&&` / `\|\|`、`!==`）、`hardFactor`/`hardGraceMs` 默认值                          | §3.4 的 1/2/3 条写成等价变异；**其余位点全被 §3.2 的 1–12 号用例杀掉** ⇒ 该文件 `:survived` = 0       |
| `src/core/thinking.ts`      | `supportedThinkingLevels`（`=== null` / `!== undefined`）、`findThinkingModel`（`length` 比较）、`resolveThinkingLevel`（`??` / `\|\|`）、`COST_ORDER` 比较方向 | §3.4 的 4/5 条写成等价变异；**`COST_ORDER` 比较方向必须被杀**（§3.4 第 6 条）⇒ 该文件 `:survived` = 0 |
| `src/core/cache-warming.ts` | 只有 `depth > 0` 一个判断 ⇒ 位点极少（`>` → `>=`、`0` ↔ `1`、删 `!`）                                                                                           | 全部被杀（§3.2 的 46/47/55 号用例）⇒ 该文件 `:survived` = 0                                           |

> 这三个文件都很小 ⇒ **位点少不代表覆盖好**：新文件任何一条幸存都要写清是「等价变异」还是「测试漏了」。写不出来就说明那条用例太松。

### 3.8 计数口径（别各处数字打架）

> **下表的数是施工完成后的实际值**（2026-11-24 核实）。本文前面几节写的是「施工单」口径（BP 编号、待补清单），与实际表已漂移的地方，以本节与 §3.3.3 矩阵的「破坏点」列为准。

| 数               | 口径                                                                                                                                                                                                                                                                                                                                                              | 实际值                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **功能点总数**   | §3.3.3 矩阵的行数（【1】33 + 【2】17 + 【3】12 + 【4】8 = 70）+ 「类型层」1 行（不算运行时功能点，只由 `pnpm check` 守）                                                                                                                                                                                                                                          | **71**（运行时功能点 **70**）                                                                  |
| **矩阵行数**     | §3.3.3 表格里 `B-` / `T-` / `P-` / `W-` 开头的行数                                                                                                                                                                                                                                                                                                                | 70                                                                                             |
| **用例总数**     | §3.2 的 49 条 + §3.2.1 的 13 条 = 62，**其中 1 条已删**（`适配层：不给子代理写 .pi/settings.json` 是假绿，见 §3.3.4 第 11 条）⇒ **61 条**；不含既有用例                                                                                                                                                                                                           | 61                                                                                             |
| **仓内用例总数** | `pnpm test` 的实跑条数（含既有用例）                                                                                                                                                                                                                                                                                                                              | 779                                                                                            |
| **破坏点总数**   | `scripts/breakpoints.ts` 的条目数（`feature:` 计数）                                                                                                                                                                                                                                                                                                              | 316                                                                                            |
| **既有破坏点**   | 施工前的条目数（`git show HEAD:scripts/breakpoints.ts`）                                                                                                                                                                                                                                                                                                          | 240                                                                                            |
| **本轮新增**     | 316 − 240                                                                                                                                                                                                                                                                                                                                                         | 76                                                                                             |
| **门禁总数**     | `pnpm check:breakpoints` 的总条数 = 破坏点总数                                                                                                                                                                                                                                                                                                                    | 316                                                                                            |
| **写不出破坏点** | §3.3.4 列了 11 条。其中**缺席类 5 条（第 1–5 条）已各自找到破坏点**（见矩阵 B-22 / B-25 / B-26 / B-27 / B-28 的「破坏点」列）⇒ 真正仍无破坏点的是 **6 条**：**顺序类 1**（第 8 条的纯顺序变体——BP 只能杀「缺一分支」，杀不了「顺序反了」）+ **结构类 2**（第 9 条的黑板契约 / 第 11 条的 settings.json）+ **外部类 3**（第 6、7、10 条，provider 行为本仓测不了） | 6（矩阵里 3 个 `—` 的行：T-17 / P-12 / W-07；另有 3 条是 §3.3.4 的横切约束，不对应单个矩阵行） |
| **闸数**         | `defaultGates` 的长度（`test/core-logic.test.ts` 的 `gates.length`）；施工前 11 道 ⇒ 新增 `usageBudgetGate` + `messageBytesGate` 追加在末尾 ⇒ 既有 11 道索引不动                                                                                                                                                                                                  | 13                                                                                             |
| **变异基线**     | 全仓 `.metrics/mutate/` 现状：22 namespace、1210 killed、46 survived ⇒ 退出码 3                                                                                                                                                                                                                                                                                   | 退出码 3                                                                                       |
| **真机验证**     | §3.5 的 A-7 五条                                                                                                                                                                                                                                                                                                                                                  | 5                                                                                              |

**「功能点」的数怎么来的**（免得两处打架）：矩阵的每一行 = 一个可验证的行为；同一功能的**多个输入**（例如「模型不在目录里」与「模型写成模式」都走「不校验」这条路径）合在一行，不重复计数。类型层（`types.ts` 的字段）不算运行时功能点，只由 `pnpm check` 守。

---

## 4. 取舍与风险

### 【1】usageBudget

| 取舍 / 风险                                                    | 说明与对策                                                                                                       |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 预算是**软上限**，实际会超（最多 `上限 × hardFactor`）         | 用量在请求完成后才观测得到，越线那一轮已付过钱。回执里报**已花的真实数**，不粉饰                                 |
| 降级交付会**降低质量**（孩子被要求提前收尾）                   | 这是「预算」的定义，不是缺陷。父方自己定上限；上限定得太紧就是父方的选择（回执里写明「降级交付」让父方看得见）   |
| 硬门会**打断在飞工具**                                         | 硬门是兜底，默认走软门（不打断）；宽限期 120s 让长工具跑完；硬门触发时 status 是 `canceled` 而不是假 `succeeded` |
| token 口径含 cacheRead ⇒ 缓存型子代理**看起来很贵**            | 因此**默认推荐 `maxUsd`**；`maxTokens` 给「限制上下文 churn」的场景。口径写在工具 schema 描述里，别让父方误读    |
| 预算判定依赖**观测到的 usage**，provider 不上报 cost 时按 0 算 | 那时美元上限失效（`usdOf` = 0）⇒ 回执里 `spentUsd` 恒 0，父方看得见；此时 token 上限仍然有效                     |
| 每次派发多一个「预算」键进记录与列表                           | 键只在给了预算时出现（既有「默认关时键不出现」的纪律）                                                           |

### 【2】thinking 校验

| 取舍 / 风险                                                              | 说明与对策                                                                                           |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| **降档会降低子代理的思考深度**（质量风险）                               | 只在**父方点名了一个该模型不支持的档位**时降；父方不给档位就一切照旧。回执 + 通知里明说「high→low」  |
| 「max 降成 low」在支持 max 的模型上**不会发生**（vendor-local 支持 max） | 支持就原样发；但 `max` 与 `high` 预算相同（16384）⇒ 别为 `max` 多付钱（写进「不做的事」）            |
| 模型目录快照是**会话开始时的快照**                                       | 会话中途改 models.json 不影响已派发任务；新派发用新快照（适配层每次读 `ctx.modelRegistry.getAll()`） |
| 虚拟模型的档位由**路由**决定，目录里查不到物理模型的 map                 | 查不到就不校验（不猜）。**【需真机验证】**                                                           |
| 「模型不在目录里 ⇒ 原样透传」= 校验不是全覆盖                            | 明说：回执 `modelKnown: false`。宁可漏校验，也不要瞎降档把好模型降残                                 |

### 【3】前缀稳定化

| 取舍 / 风险                                                      | 说明与对策                                                                        |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **跨子代理的缓存共享取决于 provider**（TTL、缓存键、会话亲和头） | 收益不保证。**【需真机验证】**；即使不命中，代价也只是「why 换了个位置」          |
| 隔离契约搬到 user message ⇒ **服从度可能下降**                   | 用真机 worktree 任务验一次（§3.5）                                                |
| 任务与理由**合并进一个 argv 参数** ⇒ 可能撞 128 KiB 上限         | 加闸：user message ≤ 64 KiB，超了 `rejection`（不进 argv）                        |
| `buildAppendBlock` 删除 ⇒ **导出面变化**                         | 只有 `test/child.test.ts` 用它；不是包的公开 API（`main` 只导出 `dist/index.js`） |
| **项目上下文（AGENTS.md）仍在系统提示词里**                      | 它按项目变 ⇒ 跨项目不共享、跨派发（同项目）共享。要不要也搬走？**不做**（见 §5）  |

### 【4】关预热

| 取舍 / 风险                                    | 说明与对策                                                     |
| ---------------------------------------------- | -------------------------------------------------------------- |
| 收益**很小**（每预热一次约 $0.00006 量级）     | 但实现只 ~10 行且严格非负；不算进主要节省                      |
| 老版本 pi 不知道 `cache_warming_decision` 事件 | 注册处 try/catch 兜底；**【需真机验证】**（本机 1.5.2 支持）   |
| 父子会话**预热策略不同**（父开子关）           | 这是有意的：父会话长命，预热对它有用；子代理短命，热缓存没人用 |

---

## 5. 明确不做的事

| 不做                                                  | 理由                                                                                                                         |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **不给子代理写 `.pi/settings.json`**                  | pi 的 `cacheWarming` 只读 agent 目录级，项目级写了**不生效**（C1）。写了还污染父方工作区、还要进 `.gitignore`                |
| **用 `PI_CODING_AGENT_DIR` 换 agent 目录**            | 会连 auth.json / models.json 一起换掉 ⇒ 认证与模型目录全丢；除非整套复制一份，不值当                                         |
| **改 compaction 阈值**                                | 本机 1M 窗口 + 16K 保留 ⇒ 要涨到 1,032,192 token 才触发；子代理跑几万 token 永远不触发；压缩自己还要调模型（实测一次 $0.32） |
| **收窄工具表来省 token**                              | 实测收窄到只读（427 token）比 coding 组合（382 token）**还多 45 token**——省三位数，砍真能力                                  |
| **加 `--no-prompt-templates` / `--no-themes`**        | 两者完全不进 system prompt ⇒ **0 token 收益**，只有启动速度差别                                                              |
| **给 vendor-local 派 `medium` / `minimal` / `xhigh`** | 这些档位在 vendor-local 的 map 里是显式 `null`（不支持）；本方案已经**自动降到 low**，不需要父方记住这件事                   |
| **为 `max` 档多付钱**                                 | `max` 与 `high` 预算相同（都 16384，被 clamp）——同一个钱，买不到更多思考                                                     |
| **把项目上下文（AGENTS.md）也搬出系统提示词**         | 它按项目变，本来就不跨项目共享；搬走会破坏「实施档要遵守仓库规则」这条纪律（AGENTS.md 明确要求）                             |
| **预算做成会话级总池**                                | 一次一单、互不影响更好推理；池化会把「谁超了」的归因变难（父方看不到单个任务的账）                                           |
| **预算触发时直接杀（不要软门）**                      | 会打断在飞工具、丢掉报告；软门 + 硬门兜底已经覆盖「孩子不理人」的情况                                                        |
| **对子代理的 thinking 档位做「智能推荐」**            | 那是模型该做的判断（它可以自己在任务里说「这个要深思」）；父方只给上限，core 只做**校验**不做**推荐**                        |

---

## 6. 施工顺序（下一轮）

> 每一步都带三件事：**做什么 → 做完先有哪条测试变红（§3.2 的标题）→ 该加哪条破坏点（§3.3 的 BP 编号）**。
> 「先变红」= 先写用例、再写实现（用例红是因为功能没实现，不是因为写错）。

| 步  | 做什么                                                                                                                                               | 先红的那条用例（§3.2 / §3.2.1 标题）                                                                                                                                        | 该加的破坏点                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | `src/core/types.ts`：加 `UsageBudget` / `BudgetReceipt` / `ThinkingReceipt` 与三个字段挂点                                                           | 无（纯类型）⇒ 由 `pnpm check` 守                                                                                                                                            | 无（类型层不算运行时功能点，见 §3.3.3 末）                                                               |
| 2   | `src/core/budget.ts` + `src/core/thinking.ts` + `src/core/cache-warming.ts`：三个纯函数模块                                                          | `预算：token 口径含 cacheRead（缓存型子代理的账不失真）` / `思考档位：模型支持该档 ⇒ 原样发（不降级）` / `成本：depth>0 的孩子关掉 cache 预热（action=stop）`               | BP-4 / BP-6 / BP-13（外加 §3.3.2 里指向这三个文件的全部条目）                                            |
| 3   | `src/core/gates.ts`：两道新闸 + `defaultGates` 末尾追加（既有 11 道索引不动）                                                                        | `安检 17：usageBudget 至少要给一个上限（maxUsd / maxTokens）` / `安检 18：user message 超过 64 KiB 要拒（拼进一个 argv 装不下）`                                            | BP-5 / BP-23 / BP-24 / BP-25 / BP-26 / BP-27                                                             |
| 4   | `src/core/child.ts`：`CONTRACT_BLOCK` / `buildUserMessage` / `effectiveModel` / `createUsageTracker`；删 `buildAppendBlock`                          | `拼命令：附加块恒定（why 不进系统提示词）` / `收件：增量用量累加 = 终局 parseChildStream 的口径（同一段流，两条路同数）` / `拼命令：降级后的档位进 --model 后缀（a/b:low）` | BP-9 / BP-10 / BP-11 / BP-12 / BP-28 / BP-29 / BP-43 / BP-44 / BP-46 / BP-47 / BP-48 / BP-49 / BP-50     |
| 5   | `src/core/engine.ts`：预算状态机（`#checkBudget` / 定时器 / `attach-budget`）、thinking 解析与回执                                                   | `引擎：预算到点 ⇒ 降级交付（不 failed，回执标 budgetExhausted）` / `引擎：thinking 降级写进回执（requested/effective/reason）`                                              | BP-14 / BP-20 / BP-30 / BP-31 / BP-45                                                                    |
| 6   | `src/core/registry.ts`：`attach-budget` 命令                                                                                                         | `引擎：预算回执带上限、已花的钱与 token`                                                                                                                                    | BP-32                                                                                                    |
| 7   | `src/index.ts`：schema、目录快照、预热钩子、列表与通知                                                                                               | `适配层：dispatch_task 的 schema 带 usageBudget` / `适配层：子代理进程（depth>0）注册 cache_warming_decision 并返回 stop`                                                   | BP-33 / BP-34 / BP-35 / BP-53 / BP-54 / BP-55                                                            |
| 8   | 测试：按 §3.2（49 条）+ §3.2.1（13 条）的标题逐条写；改既有用例 `安检 10：默认闸序含隔离/黑板两道值闸` 的闸数断言（11 → 13）                         | ——（这一步就是让上一步的用例变绿）                                                                                                                                          | ——                                                                                                       |
| 9   | `pnpm fmt` → 取 §3.3.1 / §3.3.2 的锚点 → `scripts/breakpoints.ts` 加 **55 条** → `pnpm check:breakpoints` 全 killed（门禁共 295 条 = 55 + 既有 240） | ——（§3.6 验红规程：逐条验红，见 §3.6.1 的四步）                                                                                                                             | BP-1 ~ BP-55（**注意 §3.3.1 的两处 red 归属改正**：BP-1 的 red 改指「两个上限都给了 ⇒ 任一越线即到点」） |
| 10  | `pnpm mutate` → 三个新文件零幸存；杀不掉的写进测试文件头的「等价变异」段（格式见 §3.7.4）                                                            | ——（§3.7 变异测试规程：退出码 3 是基线，判定看 `.metrics/mutate/` 里三个新文件的 `:survived`）                                                                              | ——（等价变异段按 §3.4 的 5 条建议 + 施工时新增的幸存条目）                                               |
| 11  | `docs/spec/core-spec.html` 同步                                                                                                                      | ——                                                                                                                                                                          | ——                                                                                                       |
| 12  | `pnpm test:mode` 跑 §3.5 的五条真机验证                                                                                                              | ——                                                                                                                                                                          | ——                                                                                                       |

**顺序里被补上的两个缺口**（原 12 步没写清楚，这轮补上）：

- **第 8 步与第 9 步之间原本没有「验红」这一步** ⇒ 现在第 9 步明确包含 §3.6.1 的四步（改源码 → 只跑指名用例 → 要求真红 → 复原），并且**第 8 步写的 62 条用例与第 9 步加的 55 条破坏点要逐条对得上**（对不上的看 §3.3.3 矩阵的「缺口怎么补」列）。
- **第 10 步原本只说「杀不掉的写进等价变异段」** ⇒ 现在补上判定口径（§3.7.3：按命名空间拆，落在三个新文件里的幸存才算本轮的）。

---

## 7. 修订说明（本轮：补全三节测试规程，2026-11-24）

**补了哪几节**（只改本文档，没动 `src/` / `test/` / `scripts/` / `docs/spec/core-spec.html`，没跑任何门禁命令）：

| 节                   | 补了什么                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §3.2.1（新增）       | 覆盖矩阵查出来的 **13 条用例缺口**（编号 50–62，与 §3.2 的 49 条并列）⇒ 用例总数 62                                                                                                                                                                                                                                                                                                                |
| §3.3（重写为四小节） | §3.3.1 已有 14 条（沿用，**两处 red 归属改正**：BP-1 的 red 改指「两个上限都给了 ⇒ 任一越线即到点」；BP-8 的 red 不变，另立 BP-36 守「原样发」） / §3.3.2 **新增 41 条**（BP-15~BP-55，给全 from/to/red）/ §3.3.3 **覆盖矩阵**（68 行：功能点 → 用例 → 破坏点 → 缺口）/ §3.3.4 **写不出破坏点的功能点 11 条**（原 3 条扩成 11 条，按缺席类 / 顺序类 / 结构类 / 外部类逐条写明理由 + 由哪条用例守） |
| §3.5（重写）         | 验收线改成 7 行表格，每行带「**怎么判定**」（看什么输出、什么退出码算通过）+ 计数口径                                                                                                                                                                                                                                                                                                              |
| §3.6（新增）         | **验红规程**：四步操作流程、三条判据（假绿 / 红错地方 / 标题写错）各自的含义与失败表现、破坏点表自身的 6 条约束、一功能点=一测试+一破坏点                                                                                                                                                                                                                                                          |
| §3.7（新增）         | **变异测试规程**：`pnpm mutate` 怎么跑 + 退出码 0/1/2/3 的含义、三个新文件怎么单独跑、基线（22 namespace / 1210 killed / 46 survived ⇒ 退出码 3）、「新代码零幸存」怎么判定（按命名空间拆）、幸存写进文件头的格式（引了 3 个现有真实例子）、常见等价变异模式清单（分「看着像等价其实不等价」与「真正常见等价」两栏）、三个新文件各自的预期与验收线                                                 |
| §3.8（新增）         | **计数口径**：用例 62 / 破坏点 55（门禁 295 = 55 + 既有 240）/ 功能点 69 / 写不出破坏点 11 / 变异基线 / 真机 5 条                                                                                                                                                                                                                                                                                  |
| §6（重写为表）       | 12 步逐行补上「**先红的那条用例**」+「**该加的 BP 编号**」，并点明补上的两个缺口（第 8↔9 步之间缺「验红」、第 10 步缺「幸存归属」判定口径）                                                                                                                                                                                                                                                        |

**覆盖矩阵里缺口数量**：

- **用例缺口 13 条**（§3.2.1 的 50–62）——原先 §2 写了行为、§3.2 没有对应用例的 13 条。
- **破坏点缺口 41 条**（§3.3.2 的 BP-15~BP-55）——原先 49 条用例只有 14 条破坏点；补完后 **58 个矩阵行有破坏点、10 行写不出**。
- **矩阵行数 68**（【1】31 + 【2】17 + 【3】12 + 【4】8）+ 类型层 1 行 = 功能点 69。

> ⚠️ **本节的数是「施工单那一轮」的快照，已过时。** 施工完成后：矩阵 70 行、功能点 71、破坏点 316 条、门禁 316 条；§3.3.4 的缺席类 5 条**已各自找到破坏点**（矩阵 B-22 / B-25 / B-26 / B-27 / B-28）。**以 §3.8 与 §3.3.3 矩阵为准。**

**确认写不出破坏点的功能点（11 条）**：

| 分类   | 条数 | 是哪几条                                                                                                                                |
| ------ | ---- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 缺席类 | 5    | ① 硬门走 `stop`（SIGTERM→SIGKILL）② 预算判定与报告通道解耦 ③ 孩子没起来不带 budget 字段 ④ 受理时钉死预算 ⑤ 报告旗标与预算旗标不互相掩盖 |
| 顺序类 | 1    | ⑧ user message 的顺序（任务→why→隔离契约）与硬门先于软门判定（覆盖 2 个矩阵行）                                                         |
| 结构类 | 2    | ⑨ 黑板消息从不进提示词 / 报告契约文本一字不改 ⑪ 不给子代理写 `.pi/settings.json`                                                        |
| 外部类 | 3    | ⑥ 跨子代理缓存共享 ⑦ 虚拟模型的 thinking 档位 ⑩ provider 侧的预热经济性判定                                                             |

**还有什么没覆盖到**（留给施工那一轮）：

1. **锚点全部是从 §2 的代码形状推导的**，不是从实际源码抄的（本轮明令不读 `src/`）⇒ 施工时**必须先 `pnpm fmt` 再按实际写出的代码重新取锚点**；本文的所有 `from` / `to` 都要当成**草案**看。
2. **BP-42 / BP-43 / BP-44 / BP-47 / BP-49 的锚点含模板串**，落地时要按实际变量名（`requested` / `model` / `thinkingLevel`）校准，且要确认**恰好出现一次**。
3. **§2.2.5「虚拟模型」与 §3.5 第 3 条「跨子代理缓存命中」是 provider 行为**，本仓测不了，只能真机验；provider 不支持就不算失败（仓内能守的只是「前缀逐字节恒定」）。
4. **§3.7 的「基线 46 幸存 / 退出码 3」是 2026-11-24 的快照数字**，施工时 `.metrics/mutate/` 已经变了 ⇒ 判定口径（§3.7.3：按命名空间拆）比数字更要紧。
5. **§3.2.1 的 13 条与 §3.3.2 的 41 条是新加的**，施工时要跟着写实现与用例；若实现形状变了，矩阵的「缺口怎么补」列要跟着改。
6. ~~**TUI 人看面没进矩阵**~~ **已补**：矩阵新增 **B-33**（`tui：行内带预算到点与档位降级提示`），用例在 `test/tui.test.ts`，破坏点 `TUI 行内带预算到点与档位降级提示` 在 `scripts/breakpoints.ts`。

---

## 8. 修订说明（P1 收尾：2026-11-24）

> P0 五项已全部完成并验证。本节记录 P1 收尾改了什么、为什么这么选。

| 项                           | 改了什么                                                                                                                                                                                                                   | 为什么这么选                                                                                                                                                                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 删死字段 `hardAt`            | `src/core/types.ts` 的 `BudgetReceipt.hardAt?: number` 删掉                                                                                                                                                                | 全仓零写入（声明了但没有任何地方赋值）⇒ 纯死字段。硬门触发时刻已经由 `exhausted` + `softAt` 表达，不需要第二个时刻字段                                                                                                                                                            |
| 删别名 `ALL_THINKING_LEVELS` | `src/core/thinking.ts`：引用改成 `COST_ORDER`，别名删掉                                                                                                                                                                    | 两个名字一个数组 = 两个真名。`COST_ORDER` 是全仓唯一真源（`costIndex` / `downgradeTarget` / `nearestLevel` 都用它），别名只在一个函数里用过一次 ⇒ 删别名比保留两个名字更省心                                                                                                      |
| `.pi/settings.json` 用例     | 该用例**本就不存在**（`grep settings.json test/` 零命中）⇒ 无需删                                                                                                                                                          | 但 §3.2.1 第 62 条与 §3.3.4 第 11 条还挂着它 ⇒ 本轮把这两处改成「已删 / 结构类无破坏点」的实况                                                                                                                                                                                    |
| 删 `#notStartedResult`       | 整个私有方法删掉；`#executeRun` / `#runToTerminal` / `#pump` 的返回类型改成 `Promise<void>`；7 个调用点改成裸 `return`                                                                                                     | 它的返回值**从来没被消费过**：`#startQueued` 是 `void this.#runToTerminal(...)`（fire-and-forget），一次性宿主等的是 `#awaitTerminal` + `#resultFromRecord`。每个「没起来」的分支本来就已经 `submit` 了 `resolve-exit` ⇒ 终态与正文都从记录来，方法里那 40 行是重复的第二条真相链 |
| TUI 渲染预算/档位            | `src/tui.ts` 加 `costHint(record)`，在飞/排队那几行行内带「预算到点」「档位 high→low」；用例 `tui：行内带预算到点与档位降级提示`（覆盖四种输入：两条提示都来 / 只降档 / 什么都没发生 / `thinking` 键不存在）；破坏点同名单 | AGENTS.md 的 TUI 完成线含「在飞上过屏」。通知里有、列表里有、面板里没有 ⇒ 父方在 TUI 下看不见哪一单超了预算。没发生时**不占位**（面板行宽有限）。`costHint` 的 5 个变异位点**全被杀**（`mutator --scan src/tui.ts` 逐个验过）                                                     |
| `hardFactor = 1`             | **保留 `= 1`**，定义为「跳过软门、直接硬门」；闸文案、`src/index.ts` 的 schema 描述、`docs/spec/core-spec.html` 三处写清；用例 `预算：hardFactor=1 ⇒ 跳过软门直接进硬门` + 破坏点同名单                                    | 这是**产品决策**不是 bug。`= 1` 有真实用途：「只认硬上限、不要降级交付的机会」。改成拒 `<= 1` 会把这个用途砍掉，还会把「硬门与软门同线时硬门先判」这条已写进 spec 的语义变成「不许配」                                                                                            |
| mutator 盲区                 | `AGENTS.md` 加一行：`pnpm mutate` 只覆盖导出的 defn/，`#` 私有方法不在扫描里；引擎接线由 `scripts/breakpoints.ts` 守                                                                                                       | 实测 `mutator --scan src/core/engine.ts` 只报 78 个位点、全是公有函数；`#checkBudget` / `#armBudgetTimer` / `#buildArgv` / `#resolveThinking` 零命中。这是环境事实，不查就不知道                                                                                                  |
| 矩阵「破坏点」列             | 从 BP 编号改成 `scripts/breakpoints.ts` 里的**实际 feature 字符串**；矩阵新增 B-32（hardFactor=1）与 B-33（TUI 提示）两行                                                                                                  | BP 编号是施工单阶段的临时编号，已与实际表漂移（BP-39 的 `mapped === undefined` 在现码里不存在）⇒ 改成实际字符串后，这一列可以直接拿去 `pnpm check:breakpoints` 里搜                                                                                                               |
| 计数口径                     | §3.8 换成**施工后的实际值**：矩阵 70 行 + 类型层 1 = 功能点 71；用例 61 条（62 减掉删掉的假绿）；破坏点 316 条（既有 240 + 新增 76）；闸 13 道                                                                             | 文档说 69 个功能点、矩阵 68 行、门禁 295 —— 三处对不上，且都不等于实际的 316 条破坏点                                                                                                                                                                                             |

**这轮没做的**：

- `pnpm test:mode`（要真模型钱）—— 没跑。真机验证的完成线仍是 §3.5 的 A-7 五条。
- `pnpm mutate` 的全量重跑—— 没跑；本轮只改了两处纯函数（删字段、删别名）与两处新行为（TUI 提示、hardFactor=1），新增逻辑的变异位点用 `mutator --scan` **逐个定点验过**：`costHint` 的 5 个位点全被杀（为此把 TUI 那条用例从 2 个输入加到 4 个——原先漏了「`thinking` 键不存在」与「只降档没到点」两种输入，`?.` → `.` 与 `> 0` → `> 1` 两条会幸存）；`budget.ts` 的 `hardFactor ?? DEFAULT` → `||` 是 P0 遗留的等价变异（闸拒 `hardFactor < 1` ⇒ 0 不可达），已写进 `test/budget.test.ts` 文件头。
- `docs/spec/cost-control.md`（事实基线）—— 按约定没动。
