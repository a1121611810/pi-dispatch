// 成本控制：预算口径 / 阶段判定 / 预热决策。
// 纯函数层：不起进程、不碰 pi 运行时。
//
// 等价变异（mutator 杀不掉，也不该杀）：
//   totalTokens 里四处 `usage.x ?? 0`：`??` → `||` 的分歧只在 x === 0 时，
//   而右值就是 0 ⇒ `0 || 0 === 0` ⇒ 可达输入上等价（同 child.ts 里 addUsage 的既有条目）。
//   usdOf 的 `usage.cost ?? 0` → `||`：同上（`0 || 0 === 0`）。
//   ⚠️ 但 `?? 0` → `?? 1` **不是**等价变异：ChildUsage 四个字段全可选，{} 是
//   createUsageTracker 的初始形态（可达输入），兜底值写成 1 会让空 usage 凭空多出 4 个 token
//   / 1 美元。由「预算：空 usage 的 token 口径是 0」「预算：空 usage 的美元口径是 0」守。
//   evaluateBudget 里 `budget.maxUsd !== undefined` / `input.softAt !== undefined` 的 `!==` → `!=`：
//   maxUsd 与 softAt 都是 number | undefined，`null` 不在类型里且闸已拒 ⇒ 可达输入上等价。
//   hardReason 的 `input.softAt ?? input.now` → `||`：分歧只在 softAt === 0；
//   softAt 由引擎 Date.now() 写入，1970 年时间戳在活进程上不可达 ⇒ 等价。
//   evaluateBudget 里 `budget.hardFactor ?? DEFAULT_HARD_FACTOR` → `||`：分歧只在
//   hardFactor === 0，而闸拒 `hardFactor < 1` ⇒ 0 不可达 ⇒ 等价。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUDGET_STEER_TEXT,
  DEFAULT_HARD_FACTOR,
  DEFAULT_HARD_GRACE_MS,
  evaluateBudget,
  totalTokens,
  usdOf,
} from "../src/core/budget.ts";
import { cacheWarmingDecision } from "../src/core/cache-warming.ts";
import type { ChildUsage } from "../src/core/types.ts";

/** 一笔用量：便宜、缓存占大头（本机的真实形态）。 */
function usageOf(patch: ChildUsage = {}): ChildUsage {
  return { input: 100, output: 10, cacheRead: 1000, cacheWrite: 5, cost: 0.001, ...patch };
}

test("预算：token 口径含 cacheRead（缓存型子代理的账不失真）", () => {
  const withCache = totalTokens(usageOf({ cacheRead: 4000 }));
  const noCache = totalTokens(usageOf({ cacheRead: 0 }));
  assert.equal(withCache - noCache, 4000, "cacheRead 必须计入 token 口径");
  assert.equal(totalTokens(usageOf()), 100 + 10 + 1000 + 5);
});

test("预算：token 口径含 cacheWrite", () => {
  const withWrite = totalTokens(usageOf({ cacheWrite: 700 }));
  const noWrite = totalTokens(usageOf({ cacheWrite: 0 }));
  assert.equal(withWrite - noWrite, 700, "cacheWrite 必须计入 token 口径");
});

test("预算：没上报的字段按 0 算（cacheRead / cacheWrite 缺省也是 0）", () => {
  // 缺省值写成 1 会把「没上报」当成「用了 1」——差值断言能抓住
  assert.equal(totalTokens({ cacheRead: 7 }), 7, "其余字段缺省按 0");
  assert.equal(totalTokens({ cacheWrite: 7 }), 7, "其余字段缺省按 0");
});

test("预算：美元口径取累计 cost（没有 cost 时按 0 算）", () => {
  assert.equal(usdOf(usageOf({ cost: 0.25 })), 0.25);
  assert.equal(usdOf(usageOf({ cost: 0 })), 0);
  assert.equal(usdOf(usageOf({ cost: undefined })), 0, "没有 cost ⇒ 按 0（美元上限此时失效）");
  // 累计：孩子上报的是单次请求量，累加由 addUsage/tracker 做；这里验最后一段
  assert.equal(usdOf({ input: 1, output: 1, cost: 0.5 }), 0.5);
});

test("预算：恰好等于上限 ⇒ 进软门（>= 不是 >）", () => {
  const decision = evaluateBudget({
    budget: { maxUsd: 0.5 },
    spentUsd: 0.5,
    spentTokens: 0,
    now: 1000,
  });
  assert.equal(decision.phase, "soft");
});

test("预算：低于上限 ⇒ 不动", () => {
  const decision = evaluateBudget({
    budget: { maxTokens: 1000 },
    spentUsd: 0,
    spentTokens: 999,
    now: 1000,
  });
  assert.equal(decision.phase, "ok");
});

test("预算：两个上限都给了 ⇒ 任一越线即到点", () => {
  const onlyTokens = evaluateBudget({
    budget: { maxUsd: 100, maxTokens: 10 },
    spentUsd: 0,
    spentTokens: 10,
    now: 1,
  });
  assert.equal(onlyTokens.phase, "soft", "token 越线、美元没越线也算到点");
  assert.match(onlyTokens.reason ?? "", /token 上限/, "理由必须落在 token 线");
  const onlyUsd = evaluateBudget({
    budget: { maxUsd: 1, maxTokens: 10_000 },
    spentUsd: 1,
    spentTokens: 0,
    now: 1,
  });
  assert.equal(onlyUsd.phase, "soft", "美元越线、token 没越线也算到点");
});

test("预算：软门理由指名美元线（恰好等于上限也算越线）", () => {
  const decision = evaluateBudget({
    budget: { maxUsd: 0.5, maxTokens: 1000 },
    spentUsd: 0.5,
    spentTokens: 10,
    now: 1,
  });
  assert.equal(decision.phase, "soft");
  // 理由必须落在美元线：回落成 token 文案说明边界比较写成了 >
  assert.equal(decision.reason, "已达美元上限 0.5（已花 0.5）");
});

test("预算：硬门理由指名美元硬门（等于倍数也算越线，文案带真实倍数）", () => {
  const decision = evaluateBudget({
    budget: { maxUsd: 0.1 },
    spentUsd: 0.2,
    spentTokens: 0,
    now: 1,
  });
  assert.equal(decision.phase, "hard");
  // 边界写成 > 会掉到宽限期文案；倍数写成除会得到 0.05
  assert.equal(decision.reason, "超美元硬门 0.2（已花 0.2）");
  // maxTokens 有值但没到它的硬门线：理由不许被 token 分支抢走
  const tokenNotHard = evaluateBudget({
    budget: { maxUsd: 0.1, maxTokens: 1000 },
    spentUsd: 0.2,
    spentTokens: 600,
    now: 1,
  });
  assert.equal(tokenNotHard.phase, "hard");
  assert.equal(tokenNotHard.reason, "超美元硬门 0.2（已花 0.2）");
});

test("预算：token 硬门触发时理由写 token 线（美元没到硬门不抢理由）", () => {
  // maxUsd=0.1、倍数 2：美元硬门线是 0.2，已花 0.06 没到；
  // 硬门是 token 线触发的。若美元判断里的乘积写成除（0.1/2=0.05），
  // 0.06 就会被误判成越了美元硬门 ⇒ 理由指错线（文案却仍是改前那句）。
  const decision = evaluateBudget({
    budget: { maxUsd: 0.1, maxTokens: 10 },
    spentUsd: 0.06,
    spentTokens: 10 * DEFAULT_HARD_FACTOR,
    now: 1,
  });
  assert.equal(decision.phase, "hard");
  assert.match(decision.reason ?? "", /超 token 硬门 20/);
  assert.doesNotMatch(decision.reason ?? "", /美元硬门/);
});

test("预算：超过硬门倍数 ⇒ 进硬门", () => {
  const decision = evaluateBudget({
    budget: { maxUsd: 0.1 },
    spentUsd: 0.1 * DEFAULT_HARD_FACTOR,
    spentTokens: 0,
    now: 1,
  });
  assert.equal(decision.phase, "hard");
});

test("预算：没到硬门倍数 ⇒ 仍是软门", () => {
  const decision = evaluateBudget({
    budget: { maxUsd: 0.1 },
    spentUsd: 0.1 * 1.5,
    spentTokens: 0,
    now: 1,
  });
  assert.equal(decision.phase, "soft");
});

test("预算：软门后超过宽限期 ⇒ 进硬门（不靠新用量）", () => {
  const softAt = 10_000;
  const decision = evaluateBudget({
    budget: { maxUsd: 100 },
    spentUsd: 1,
    spentTokens: 0,
    softAt,
    now: softAt + DEFAULT_HARD_GRACE_MS,
  });
  assert.equal(decision.phase, "hard", "宽限期到点即硬门，不用等新用量");
  const notYet = evaluateBudget({
    budget: { maxUsd: 100 },
    spentUsd: 1,
    spentTokens: 0,
    softAt,
    now: softAt + DEFAULT_HARD_GRACE_MS - 1,
  });
  assert.equal(notYet.phase, "ok", "还没到宽限期 ⇒ 不动");
});

test("预算：时间兜底硬门的理由不冒充 token 线", () => {
  const softAt = 1_000;
  const decision = evaluateBudget({
    budget: { maxUsd: 10, maxTokens: 100_000 },
    spentUsd: 1,
    spentTokens: 100,
    softAt,
    now: softAt + DEFAULT_HARD_GRACE_MS,
  });
  assert.equal(decision.phase, "hard");
  // 两条上限都在、都没越硬门：理由只能是宽限期，不能是 token 硬门
  assert.equal(decision.reason, `软门后宽限期已过（${DEFAULT_HARD_GRACE_MS}ms）`);
});

test("预算：软门时刻为 0 时理由里的毫秒数如实（不把 0 当没给）", () => {
  // 注入时钟可以从 0 起算（单调时钟），0 是合法时刻，不是「没给」
  const decision = evaluateBudget({
    budget: { maxUsd: 10 },
    spentUsd: 1,
    spentTokens: 0,
    softAt: 0,
    now: DEFAULT_HARD_GRACE_MS,
  });
  assert.equal(decision.phase, "hard");
  assert.equal(decision.reason, `软门后宽限期已过（${DEFAULT_HARD_GRACE_MS}ms）`);
});

test("预算：已经硬收过就一直是硬门（不回到软门）", () => {
  const decision = evaluateBudget({
    budget: { maxUsd: 1 },
    spentUsd: 0.5,
    spentTokens: 0,
    hard: true,
    now: 1,
  });
  assert.equal(decision.phase, "hard", "硬收过之后不再回落到软门");
});

test("预算：没给预算 ⇒ phase ok", () => {
  assert.equal(evaluateBudget({ spentUsd: 999, spentTokens: 999, now: 1 }).phase, "ok");
});

test("预算：硬门先于软门成立时直接进硬门（不先软门）", () => {
  const decision = evaluateBudget({
    budget: { maxTokens: 100 },
    spentUsd: 0,
    spentTokens: 100 * 3,
    now: 1,
  });
  assert.equal(decision.phase, "hard", "一次就超到硬门 ⇒ 直接硬门，不先发软门转向");
  // 美元线独立成立：只砍掉美元硬门分支也必须让它红
  const byUsd = evaluateBudget({ budget: { maxUsd: 1 }, spentUsd: 3, spentTokens: 0, now: 1 });
  assert.equal(byUsd.phase, "hard", "美元一次就超到硬门 ⇒ 也直接硬门");
});

test("预算：收尾转向是交付指令，不是「知道了」", () => {
  assert.match(BUDGET_STEER_TEXT, /停止扩展工作/);
  assert.match(BUDGET_STEER_TEXT, /按报告契约交付/);
});

test("成本：depth>0 的孩子关掉 cache 预热（action=stop）", () => {
  assert.deepEqual(cacheWarmingDecision(1), { action: "stop" });
});

test("成本：父会话（depth=0）不表态（不返回 action，预热照旧）", () => {
  assert.equal(cacheWarmingDecision(0), undefined);
});

test("成本：depth=2 的孩子也关掉 cache 预热", () => {
  assert.deepEqual(cacheWarmingDecision(2), { action: "stop" });
});

test("预算：空 usage 的 token 口径是 0，不是「每个字段各算 1」", () => {
  // ChildUsage 的四个字段全可选，{} 是 createUsageTracker 的初始形态（可达输入）。
  // 兜底值写错成 1 会让「还没花一分钱」的子代理凭空多出 4 个 token，预算提前到点。
  assert.equal(totalTokens({}), 0, "一个字段都没有 ⇒ 0，不是 4");
  assert.equal(totalTokens({ input: 5 }), 5, "只有 input ⇒ 就是 5，其余字段兜底必须补 0");
  assert.equal(totalTokens({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }), 10);
});

test("预算：空 usage 的美元口径是 0，不是 1", () => {
  assert.equal(usdOf({}), 0, "没报 cost ⇒ 按 0 算，不是 1（否则美元上限当场失效）");
  assert.equal(usdOf({ cost: 0 }), 0);
  assert.equal(usdOf({ cost: 0.5 }), 0.5);
});

test("预算：token 硬门的理由写的是上限×倍数，不是上限÷倍数", () => {
  // hardReason 里的 `maxTokens * factor` 只影响理由文案（phase 早在 evaluateBudget 里定了），
  // 但写错成 / 会让父方读到「硬门 500」而实际硬门是 2000 —— 排错时被带偏。
  const decision = evaluateBudget({
    budget: { maxTokens: 1000, hardFactor: 2 },
    spentUsd: 0,
    spentTokens: 2500,
    now: 1000,
  });
  assert.equal(decision.phase, "hard");
  assert.match(decision.reason ?? "", /超 token 硬门 2000/, "理由是 1000×2=2000");
  assert.doesNotMatch(decision.reason ?? "", /硬门 500/, "不许把乘写成除");
});

test("预算：宽限期硬门不许被误报成 token 硬门（token 没到倍数就说宽限期）", () => {
  // hardReason 依次判美元线、token 线、宽限期。token 只有 1000（上限 1000、倍数 2 ⇒ 硬门 2000），
  // 没到 —— 若条件里的 `*` 写成 `/`，1000 >= 500 成立，理由会被误报成「超 token 硬门 500」。
  const decision = evaluateBudget({
    budget: { maxTokens: 1000, hardFactor: 2, hardGraceMs: 1000 },
    spentUsd: 0,
    spentTokens: 1000,
    softAt: 0,
    now: 5000,
    hard: false,
  });
  assert.equal(decision.phase, "hard", "宽限期已过 ⇒ hard");
  assert.match(decision.reason ?? "", /宽限期/, "token 没到硬门倍数 ⇒ 理由必须说宽限期");
  assert.doesNotMatch(decision.reason ?? "", /超 token 硬门/, "不许误报 token 硬门");
});

test("预算：hardFactor=1 ⇒ 跳过软门直接进硬门", () => {
  // hardFactor=1 时硬门与软门同条件（上限×1 = 上限），硬门先判 ⇒ 软门永远进不去。
  // 这是有意的产品语义：「只要到点就收掉，不给降级交付的机会」。
  const atLimit = evaluateBudget({
    budget: { maxUsd: 1, hardFactor: 1 },
    spentUsd: 1,
    spentTokens: 0,
    now: 1,
  });
  assert.equal(atLimit.phase, "hard", "恰好等于上限 ⇒ 直接硬门，不走软门");
  // 不到上限 ⇒ 仍不动（软门也没到）
  const below = evaluateBudget({
    budget: { maxUsd: 1, hardFactor: 1 },
    spentUsd: 0.999,
    spentTokens: 0,
    now: 1,
  });
  assert.equal(below.phase, "ok", "不到上限 ⇒ 不动");
});
