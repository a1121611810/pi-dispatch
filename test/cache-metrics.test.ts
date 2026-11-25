// 缓存复用可观测：纯函数层（computeCacheMetrics / observeCache / groupKeyOf）。
// 与 budget.test.ts 同层：不起进程、不碰 pi 运行时。
//
// 等价变异（mutator 杀不掉，也不该杀）：
//   observeCache 的 `metrics.firstTurnReuse ?? 0`——`??` → `||` 的分歧只在左值为假值非 null 时；
//   firstTurnReuse 是 number | null：0 两向都给 0（`0 || 0 === 0`），null 两向都给 0
//   ⇒ 可达输入上等价（与 budget.ts totalTokens 的既有条目同型）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeCacheMetrics,
  groupKeyOf,
  HEALTHY_REUSE,
  PARTIAL_REUSE,
} from "../src/core/cache-metrics.ts";
import { createUsageTracker, type TurnUsage } from "../src/core/child.ts";

/** 一轮用量：prompt 三件套给全，promptTokens 缺省按口径（input + cacheRead + cacheWrite）算。 */
function turnOf(patch: Partial<TurnUsage> = {}): TurnUsage {
  const input = patch.input ?? 0;
  const cacheRead = patch.cacheRead ?? 0;
  const cacheWrite = patch.cacheWrite ?? 0;
  return {
    input,
    output: patch.output ?? 0,
    cacheRead,
    cacheWrite,
    promptTokens: patch.promptTokens ?? input + cacheRead + cacheWrite,
  };
}

test("缓存：首轮复用率是 cacheRead 除以 prompt 总 token", () => {
  const metrics = computeCacheMetrics([turnOf({ input: 100, cacheRead: 900 })]);
  assert.equal(metrics.firstTurnReuse, 0.9, "900 / (100 + 900) = 0.9");
  // 边界：prompt 为 0 ⇒ 复用率是 0，不是 NaN（除零会污染判定与回执）
  const zero = computeCacheMetrics([turnOf({ output: 5 })]);
  assert.equal(zero.firstTurnReuse, 0, "prompt 总 token 为 0 ⇒ 0，不是 NaN");
  // 边界：prompt 只有 1 个 token 也照算（防把 > 0 写成 > 1）
  const tiny = computeCacheMetrics([turnOf({ cacheRead: 1 })]);
  assert.equal(tiny.firstTurnReuse, 1, "1 / 1 = 1");
});

test("缓存：没有轮次时判定是 not-reusing", () => {
  const metrics = computeCacheMetrics([]);
  assert.equal(metrics.verdict, "not-reusing");
  assert.equal(metrics.firstTurnReuse, null, "没有观测 ⇒ null，不是 0");
  assert.deepEqual(metrics.incremental, []);
});

test("缓存：首轮复用率高于 0.5 判 healthy", () => {
  const high = computeCacheMetrics([turnOf({ input: 100, cacheRead: 900 })]);
  assert.equal(high.verdict, "healthy");
  assert.ok(high.reason.includes("90.0%"), "理由里带首轮复用率");
  // 边界：恰好等于 HEALTHY_REUSE 也算 healthy（>= 不是 >）
  const atLine = computeCacheMetrics([turnOf({ input: 500, cacheRead: 500 })]);
  assert.equal(atLine.firstTurnReuse, HEALTHY_REUSE);
  assert.equal(atLine.verdict, "healthy", "恰好在健康线上 ⇒ healthy");
});

test("缓存：首轮复用率在 0.05~0.5 判 partial", () => {
  const mid = computeCacheMetrics([turnOf({ input: 800, cacheRead: 200 })]);
  assert.equal(mid.verdict, "partial");
  // 边界：恰好等于 PARTIAL_REUSE 也算 partial（>= 不是 >）
  const atLine = computeCacheMetrics([turnOf({ input: 190, cacheRead: 10 })]);
  assert.equal(atLine.firstTurnReuse, PARTIAL_REUSE);
  assert.equal(atLine.verdict, "partial", "恰好在部分共享线上 ⇒ partial");
});

test("缓存：首轮复用率低于 0.05 判 not-reusing", () => {
  const low = computeCacheMetrics([turnOf({ input: 990, cacheRead: 10 })]);
  assert.equal(low.firstTurnReuse, 0.01);
  assert.equal(low.verdict, "not-reusing");
  // 全冷：cacheRead 一个都没有
  const cold = computeCacheMetrics([turnOf({ input: 726 })]);
  assert.equal(cold.firstTurnReuse, 0);
  assert.equal(cold.verdict, "not-reusing");
});

test("缓存：增量命中率的上限是上下两轮 prompt 的较小值", () => {
  const metrics = computeCacheMetrics([turnOf({ input: 1000 }), turnOf({ cacheRead: 500 })]);
  assert.equal(metrics.incremental.length, 1, "两轮 ⇒ 一条增量（第 0 轮没有上一轮）");
  const entry = metrics.incremental[0]!;
  assert.equal(entry.turn, 1, "增量从第 1 轮起算");
  assert.equal(entry.maxReusable, 500, "上限是 min(1000, 500)，本轮短按本轮算");
  assert.equal(entry.rate, 1, "cacheRead 500 / 上限 500 = 1.0");
  // 边界：两轮 prompt 都是 0 ⇒ rate 是 0 不是 NaN
  const zero = computeCacheMetrics([turnOf({ output: 3 }), turnOf({ output: 4 })]);
  assert.equal(zero.incremental[0]!.rate, 0, "没有可复用的 prompt ⇒ 0，不是 NaN");
  // 边界：上限只有 1 个 token 也照算（防把 > 0 写成 > 1）
  const tiny = computeCacheMetrics([turnOf({ input: 1 }), turnOf({ cacheRead: 1 })]);
  assert.equal(tiny.incremental[0]!.rate, 1, "1 / 1 = 1");
});

test("缓存：只看首轮判判定，后续轮不参与", () => {
  const metrics = computeCacheMetrics([
    turnOf({ input: 100, cacheRead: 900 }), // 首轮 reuse 0.9
    turnOf({ input: 900, cacheRead: 100 }), // 次轮 reuse 0.1
  ]);
  assert.equal(metrics.firstTurnReuse, 0.9);
  assert.equal(metrics.verdict, "healthy", "首轮共享上了就是 healthy，次轮低迷不拖判");
});

test("缓存：逐轮明细的累计等于总额（tracker 一致性）", () => {
  const stream = [
    '{"type":"message_end","message":{"role":"assistant","content":[],"usage":{"input":100,"output":10,"cacheRead":900,"cacheWrite":5}}}',
    '{"type":"message_end","message":{"role":"assistant","content":[],"usage":{"input":50,"output":20}}}',
  ].join("\n");
  const tracker = createUsageTracker();
  tracker.push(`${stream}\n`);
  tracker.finish();
  const snap = tracker.snapshot();
  assert.equal(tracker.turns.length, snap.turns, "明细条数 == 计数");
  const sum = (key: "input" | "output" | "cacheRead" | "cacheWrite"): number =>
    tracker.turns.reduce((total, turn) => total + turn[key], 0);
  assert.equal(sum("input"), snap.usage?.input);
  assert.equal(sum("output"), snap.usage?.output);
  assert.equal(sum("cacheRead"), snap.usage?.cacheRead);
  assert.equal(sum("cacheWrite"), snap.usage?.cacheWrite);
  for (const turn of tracker.turns) {
    assert.equal(turn.promptTokens, turn.input + turn.cacheRead + turn.cacheWrite);
  }
});

test("缓存：形状相同就是同一组", () => {
  const a = groupKeyOf({ tools: ["read", "grep"], isolated: false, repoRoot: "/repo" });
  const b = groupKeyOf({ tools: ["read", "grep"], isolated: false, repoRoot: "/repo" });
  assert.equal(a, b);
  // 反面：repoRoot 不同 ⇒ 不同组（cwd 是前缀分叉维度之一）
  const elsewhere = groupKeyOf({ tools: ["read", "grep"], isolated: false, repoRoot: "/other" });
  assert.notEqual(a, elsewhere, "repoRoot 不同 ⇒ 不同组");
});

test("缓存：工具名单不同就是不同组", () => {
  const base = groupKeyOf({ tools: ["read", "grep"], isolated: false });
  const more = groupKeyOf({ tools: ["read", "grep", "bash"], isolated: false });
  assert.notEqual(base, more, "工具名单差一个 ⇒ 不同组");
});

test("缓存：工具名单顺序不影响分组", () => {
  const a = groupKeyOf({ tools: ["read", "grep"], isolated: false });
  const b = groupKeyOf({ tools: ["grep", "read"], isolated: false });
  assert.equal(a, b, "同一组工具换序 ⇒ 同组");
});

test("缓存：隔离与不隔离是不同组", () => {
  const shared = groupKeyOf({ tools: ["read"], isolated: false });
  const isolated = groupKeyOf({ tools: ["read"], isolated: true });
  assert.notEqual(shared, isolated, "isolated 不同 ⇒ 不同组");
});
