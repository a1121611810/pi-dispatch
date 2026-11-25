# 施工单：缓存复用可观测（cache-metrics）

> **目标**：把「前缀有没有共享」变成会响的数字。
> **不做**：不改前缀、不改 vendor-local 配置、不改派发行为。
> **依据**：`docs/spec/cache-strategy-2026-11-25.md`（六 harness 评审 + 实测）
> **纪律**：先写用例再写实现；约束写进检查，不写成段落。

---

## 一、为什么是这件事（施工依据）

六家 harness 里有五家独立选了同一件事。它会亲手告诉我们「下一步该做什么」，
而不是像现在这样靠猜。

**它要回答的具体问题**（经过两轮修正后收敛）：

| 问题                             | 为什么重要                                       |
| -------------------------------- | ------------------------------------------------ |
| **首轮复用率**是多少？           | 低 ⇒ 前缀没共享上，缓存白买                      |
| **前缀组数 G** 是多少？          | 直接决定共享机会：`Σ nᵢ(nᵢ-1)/2` vs `N(N-1)/2`   |
| 冷启动是**孤儿**还是**有兄弟**？ | 孤儿 ⇒ 形状太独特；兄弟 ⇒ 形状没问题，是别的原因 |

**已知的事实在哪**（实测，别再重复推理）：

- 子代理首轮 `input` 中位 726，**最大 3819，没有一个超过 5000**
- 子代理的 system prompt 稳定在 ~5,700 字符
- `addendum`（我们的 CONTRACT_BLOCK）中位 1942 字符，**跨 400 份日志有 64 个取值**
  （改造③ 之前的历史记录；改造后是 1 个）
- 工具集是真正的分叉点：跨家族 LCP = **191 字符 = 3.9%**
- 冷启动里 **81.6%** 是「缓存池热但前缀没命中」⇒ 形状问题，只有 6.1% 是路由切换

---

## 二、改什么（三个文件，加一个字段）

### 改动 1：`src/core/child.ts` — `UsageTracker` 留住逐轮明细

**现在**（`child.ts:677-711`）只累加总额，逐轮明细被丢弃：

```ts
usage = addUsage(usage, takeUsage(message.usage)); // 逐轮的没了
```

（`addUsage` 是 `child.ts:538` 的模块私有函数，签名 `(total: ChildUsage | null, next: ChildUsage) => ChildUsage`，
口径是**逐轮相加**——这个口径正好让「逐轮明细的累计 == 总额」成为恒等式。）

**改成**：

```ts
export interface TurnUsage {
  /** 本轮 prompt 的未命中 token */
  input: number;
  output: number;
  /** 本轮命中缓存的 token */
  cacheRead: number;
  cacheWrite: number;
  /** 本轮 prompt 总 token（input + cacheRead + cacheWrite） */
  promptTokens: number;
}

export interface UsageTracker {
  push(chunk: string): void;
  finish(): void;
  snapshot(): { usage: ChildUsage | null; turns: number };
  /** 逐轮明细——缓存命中分析要它。 */
  turns: TurnUsage[];
}
```

**约束（要写成断言，不能只写在注释里）**：

- `turns.length === snapshot().turns` —— 计数与明细必须一致
- `turns` 的累计 input/output/cacheRead/cacheWrite **必须等于** `snapshot().usage` 的同名字段
  （`addUsage` 的口径就是「逐轮相加」⇒ 这条恒成立，但它现在是**隐式**的，
  改成显式断言，防止以后有人改了 `addUsage` 却不知道 tracker 的明细会跟着失真）
- `promptTokens === input + cacheRead + cacheWrite`（口径与 `budget.ts` 的 `totalTokens` 对齐）

**为什么必须留住**：不留住就没法算「首轮」（首轮 = 数组第 0 个）；
只有总额时，「首轮命中」和「全程命中」是同一个数，无法区分。

### 改动 2：`src/core/cache-metrics.ts` — 新增纯函数模块

**与 `budget.ts` / `thinking.ts` 同层**：不 import pi、不起进程、可独立单测。

```ts
import type { TurnUsage } from "./child.ts";

/** 缓存复用的健康判定。 */
export type CacheVerdict = "healthy" | "partial" | "not-reusing";

export interface CacheMetrics {
  /** 首轮复用率：cacheRead / (input + cacheRead + cacheWrite)。没有轮次时 null。 */
  firstTurnReuse: number | null;
  /** 逐轮增量命中率：cacheRead / min(上一轮 prompt, 本轮 prompt)。 */
  incremental: Array<{ turn: number; rate: number; maxReusable: number }>;
  /** 判定。 */
  verdict: CacheVerdict;
  /** 判定理由（一句话，给日志/回执用）。 */
  reason: string;
}

/** 判定阈值。写死成常量并导出，方便破坏点与测试引用同一处。 */
export const HEALTHY_REUSE = 0.5;
export const PARTIAL_REUSE = 0.05;

/**
 * 从逐轮明细算缓存复用指标。
 *
 * 口径（依据 cache-strategy-2026-11-25.md 附七）：
 *   - firstTurnReuse 只看第 0 轮。后续轮天然会升高，混在一起会互相抵消。
 *   - 增量命中率的上限是 min(上一轮 prompt, 本轮 prompt)：
 *     本轮 prompt 可能比上轮短（compaction 截断），此时上轮全部都可能被复用。
 *   - verdict 判的是「机制有没有生效」，不是「这次省了多少钱」。
 */
export function computeCacheMetrics(turns: TurnUsage[]): CacheMetrics;
```

**判定规则**：

| 条件                              | verdict         | 含义                          |
| --------------------------------- | --------------- | ----------------------------- |
| 无轮次                            | `"not-reusing"` | 没有任何观测数据              |
| `firstTurnReuse >= HEALTHY_REUSE` | `"healthy"`     | 首轮就共享上了 ⇒ 前缀机制生效 |
| `firstTurnReuse >= PARTIAL_REUSE` | `"partial"`     | 部分共享（可能落在块边界）    |
| `firstTurnReuse < PARTIAL_REUSE`  | `"not-reusing"` | 首轮几乎没共享                |

**⚠️ 一个必须写清的口径警告**：

`firstTurnReuse` **低不等于前缀有问题**。三种情况都会低：

1. 前缀形状是孤儿（没有兄弟可共享）⇒ 形状问题
2. 亲和头失效 / 路由翻转 ⇒ 路由问题（实测只占 6.1%）
3. 这个前缀从来没被写过（新的 taskId、新的 repo）⇒ 正常

**⇒ 所以 `computeCacheMetrics` 单独存在时只能判「机制状态」，不能判「原因」。**
**⇒ 原因要靠 `prefixHash` 的组数（改动 3）才能进一步区分。**

### 改动 3：前缀指纹与组数

**问题**：`computeCacheMetrics` 说「没共享」，但**说不出为什么**。

**做法**：子代理侧知道自己的 system prompt 长什么样（argv 是我们自己拼的），
所以能算出一个指纹：

```ts
/** 前缀指纹：影响缓存的输入的哈希。 */
export function prefixFingerprint(parts: {
  /** 恒定的契约块 */
  contract: string;
  /** 工具名单（顺序敏感） */
  tools: string[];
  /** cwd（影响 pi 拼出来的 cwd 段） */
  cwd: string;
  /** 项目上下文（AGENTS.md 等） */
  projectContext?: string;
}): string;
```

**用什么哈希**：`node:crypto` 的 `createHash("sha256")`——仓库里已经用了吗？查一下。
如果没用，用一个更简单的方案：**把规范化后的拼接串直接当 key 存**（不哈希），
因为组数很少（实测 4 个工具家族），存原文更可调试、也避免哈希实现的破坏点难写。

**⚠️ 更好的选择：不做哈希，直接存「形状描述」**：

```ts
export interface PrefixShape {
  /** 工具名单，排序后 */
  tools: string[];
  /** 有没有 worktree 隔离 */
  isolated: boolean;
  /** cwd 所属的仓库根（不是完整路径） */
  repoRoot?: string;
}
```

**为什么形状比哈希好**：

1. **可读**——出问题时能直接看出「哦，是 strict 档」
2. **能分组**——`JSON.stringify(shape)` 就是天然的组 key
3. **不需要哈希实现** ⇒ 少一个可被等价变异的地方

**⇒ 采纳形状方案。**

### 改动 4：回执里只放两个字段

**⚠️ 不放逐轮明细、不放分组统计**——父方 context 有限
（Claude Code 专门警告过 subagent 描述超 15000 token 会告警）。

```ts
/** 缓存复用的观测结果。父方只看这个，不看逐轮明细。 */
export interface CacheObservation {
  /** 判定 */
  verdict: CacheVerdict;
  /** 首轮复用率（0~1），唯一的数字 */
  reuse: number;
  /** 前缀形状（可读，出问题时能直接看出分叉维度） */
  shape?: PrefixShape;
}
```

**放在 `TaskRecord` 上**（不是 `ChildReport` 上）：
`ChildReport` 是**孩子自述**的形状，观测值不该混进去。
`TaskRecord.usage` 已经是引擎观测的（`engine.ts:1122`），缓存观测跟它并列。

**落点链路（三处，缺一不可）**：

| #   | 文件                   | 改什么                                                                                                  |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------- |
| 1   | `src/core/types.ts`    | `TaskRecord` 加 `cache?: CacheObservation`                                                              |
| 2   | `src/core/registry.ts` | `attach-report` 命令加 `cache` 字段；`registry.ts:276` 的分支里 `cache: command.cache ?? current.cache` |
| 3   | `src/core/engine.ts`   | `attach-report` 提交（`engine.ts:1116-1126`）带上 `cache: parsed.cacheObservation`                      |

**⚠️ `engine.ts` 的 `parsed` 从哪来**：`parsed` 是 `parseChildStream` 的产物
（`engine.ts:1079` 附近已在用它）。**逐轮明细要在 `parseChildStream` 里一起吐出来**
（它已经在解析 `message_end` 的 usage）——这是最省事的接法：
`parseChildStream` 现在产出 `observedUsageTotal`，加一个 `observedTurns` 即可，
**不需要把 `UsageTracker` 的数组往引擎传**（两套路径，别搞成两套口径）。

```ts
export interface TaskRecord {
  // ...
  /** 孩子的真实用量（引擎从事件流逐轮累加，不依赖孩子交报告） */
  usage?: ChildUsage;
  /** 缓存复用观测（引擎算，不依赖孩子交报告） */
  cache?: CacheObservation;
}
```

---

## 三、用例（先写这些，再写实现）

### `test/cache-metrics.test.ts`（新文件，纯函数层）

| #   | 用例标题                                          | 断言                                                              |
| --- | ------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | 缓存：首轮复用率是 cacheRead 除以 prompt 总 token | 构造 `[input=100, cacheRead=900]` ⇒ reuse = 0.9                   |
| 2   | 缓存：没有轮次时判定是 not-reusing                | `computeCacheMetrics([])` ⇒ verdict = "not-reusing"、reuse = null |
| 3   | 缓存：首轮复用率高于 0.5 判 healthy               | reuse = 0.9 ⇒ "healthy"                                           |
| 4   | 缓存：首轮复用率在 0.05~0.5 判 partial            | reuse = 0.2 ⇒ "partial"                                           |
| 5   | 缓存：首轮复用率低于 0.05 判 not-reusing          | reuse = 0.01 ⇒ "not-reusing"                                      |
| 6   | 缓存：增量命中率的上限是上下两轮 prompt 的较小值  | 上一轮 1000、本轮 500、cacheRead=500 ⇒ rate = 1.0                 |
| 7   | 缓存：只看首轮判判定，后续轮不参与                | 第 0 轮 reuse=0.9、第 1 轮 reuse=0.1 ⇒ verdict 仍是 healthy       |
| 8   | 缓存：逐轮明细的累计等于总额（tracker 一致性）    | tracker.snapshot().usage 与 turns 累加一致                        |
| 9   | 缓存：形状相同就是同一组                          | 两个相同 shape ⇒ groupKey 相同                                    |
| 10  | 缓存：工具名单不同就是不同组                      | 工具名单差一个 ⇒ groupKey 不同                                    |
| 11  | 缓存：工具名单顺序不影响分组                      | `["a","b"]` 与 `["b","a"]` ⇒ 同组                                 |
| 12  | 缓存：隔离与不隔离是不同组                        | isolated 不同 ⇒ 不同组                                            |

### `test/child.test.ts`（追加）

| #   | 用例标题                     | 断言                                                |
| --- | ---------------------------- | --------------------------------------------------- |
| 13  | 用量：tracker 留住逐轮明细   | 喂两轮 `message_end` ⇒ `tracker.turns.length === 2` |
| 14  | 用量：逐轮明细的累计等于总额 | `tracker.turns` 累加 == `tracker.snapshot().usage`  |

### `test/engine.test.ts`（追加）

| #   | 用例标题                                    | 断言                                                  |
| --- | ------------------------------------------- | ----------------------------------------------------- |
| 15  | 引擎：回执带上缓存观测（判定 + 首轮复用率） | 跑一个假孩子，回执有 `cache.verdict` 与 `cache.reuse` |
| 16  | 引擎：首轮没共享时回执带一行提示            | 首轮 cacheRead=0 ⇒ 结果文本里出现「前缀未共享」       |

---

## 四、破坏点（照现有格式，`scripts/breakpoints.ts`）

**放哪**：紧跟「成本控制：前缀稳定化（§2.3）」那一段之后。

| #    | feature                          | file                        | from → to                                                                                                                                     | test                         | red                                              |
| ---- | -------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------ |
| BP-A | 首轮复用率只看第 0 轮            | `src/core/cache-metrics.ts` | `const first = turns[0]` → `const first = turns[turns.length - 1]`                                                                            | `test/cache-metrics.test.ts` | 缓存：只看首轮判判定，后续轮不参与               |
| BP-B | 增量命中率的分母取上下两轮较小值 | `src/core/cache-metrics.ts` | `Math.min(prev.promptTokens, cur.promptTokens)` → `prev.promptTokens`                                                                         | 同上                         | 缓存：增量命中率的上限是上下两轮 prompt 的较小值 |
| BP-C | 健康判定用 0.5 阈值              | `src/core/cache-metrics.ts` | `reuse >= HEALTHY_REUSE` → `reuse >= 0.99`                                                                                                    | 同上                         | 缓存：首轮复用率高于 0.5 判 healthy              |
| BP-D | 形状分组按工具名单排序           | `src/core/cache-metrics.ts` | `tools: [...shape.tools].sort()` → `tools: [...shape.tools]`                                                                                  | 同上                         | 缓存：工具名单顺序不影响分组                     |
| BP-E | tracker 累加总额也记明细         | `src/core/child.ts`         | `usage = addUsage(usage, takeUsage(message.usage));` → `usage = addUsage(usage, takeUsage(message.usage)); /* 不记明细 */`（删掉 turns.push） | `test/child.test.ts`         | 用量：tracker 留住逐轮明细                       |

**⚠️ BP-E 的写法陷阱**：注释掉 `turns.push` 那行会让 `turns.length` 不变吗？
不会——`turns` 会空数组。**但 `turns` 是 `UsageTracker` 接口的必填字段**，
删掉 push 后 `turns` 恒为 `[]` ⇒ 用例 13 会红。**✓ 这个破坏点成立。**

**⚠️ 破坏点写完后必须验红**：`pnpm check:breakpoints` 要全绿（含新增的 5 条）。

---

## 五、验收

| 门     | 命令                                       | 期望                    |
| ------ | ------------------------------------------ | ----------------------- |
| 单测   | `pnpm test`                                | 779 + 16 = **795** 全绿 |
| 类型   | `pnpm check`                               | 通过                    |
| Lint   | `pnpm lint`                                | 0 warning / 0 error     |
| 格式   | `pnpm fmt:check`                           | 通过                    |
| 破坏点 | `pnpm check:breakpoints`                   | 316 + 5 = **321/321**   |
| 变异   | `pnpm mutate -- src/core/cache-metrics.ts` | 见下                    |

**变异测试的预期**：

- `?? 0` → `||`：**等价变异**（`0 || 0 === 0`），与 `budget.ts` 既有条目同型
  ⇒ 在测试文件顶部按既有格式登记为「已知等价变异」（照 `test/budget.test.ts` 开头的既有格式写）
- `>=` → `>`：**可杀**（用例 3 边界）
- `Math.min` → `Math.max`：**可杀**（用例 6）
- `turns[0]` → `turns[turns.length - 1]`：**可杀**（用例 7）

---

## 六、不做什么（写进 PR 描述）

1. **不改前缀组装**（`buildPiArgv` / `buildUserMessage` / `CONTRACT_BLOCK`）——
   改造③ 已经对了，实测 why 进 user message 不破缓存
2. **不改 vendor-local 配置** —— 用户的两条时段规则精准避开 DeepSeek 高峰价，是省钱的设计
3. **不引入 DeepSeek 的 PromptSection/PromptContext 框架** —— 那是为长命多轮 Session 设计的
4. **不做前缀内容比对**（逐字节 diff）—— 只存形状，不存原文
5. **不在回执里放逐轮明细** —— 父方 context 有限
6. **不改路由、不改工具档位** —— 那些要等观测数据出来再决定

---

## 七、施工顺序

1. **先写 `test/cache-metrics.test.ts`**（12 个用例，红）
2. 写 `src/core/cache-metrics.ts`（绿）
3. **写 `test/child.test.ts` 的 2 个追加用例**（红）
4. 改 `src/core/child.ts` 的 `UsageTracker`（绿）
5. **写 `test/engine.test.ts` 的 2 个追加用例**（红）
6. 改 `src/core/engine.ts` + `src/core/types.ts`（绿）
7. 加 5 条破坏点，跑 `pnpm check:breakpoints`
8. 跑全部门禁 + `pnpm mutate`
9. **提交**（按仓库惯例：`feat(...)` 中文摘要）

---

## 八、施工后能回答的问题

跑几天真实派发后，`dispatch_list` / 记录里会有：

- 每个子代理的 `cache.verdict` 与 `cache.reuse`
- 按 `shape` 分组后的**前缀组数 G**
- 冷启动请求里「有兄弟」vs「孤儿」的比例

**然后才能回答**：

1. 工具档位分叉（实测 LCP 3.9%）实际损失多少？
2. cwd 分叉实际损失多少？
3. 要不要统一工具档位？（codex 明确反对：拿真能力换 $0.00038）
4. 值不值得为「形状亲和」放弃自动容灾？

**⇒ 在这之前，任何进一步的缓存优化都是猜。**
