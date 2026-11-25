import type { TurnUsage } from "./child.ts";

// 缓存复用可观测：纯函数层。与 budget.ts / thinking.ts 同层——
// 不 import pi、不起进程、可独立单测。
//
// ⚠️ 口径警告：firstTurnReuse 低 ≠ 前缀有问题。三种情况都会低：
//   1. 前缀形状是孤儿（没有兄弟可共享）⇒ 形状问题；
//   2. 亲和头失效 / 路由翻转 ⇒ 路由问题（实测只占 6.1%）；
//   3. 这个前缀从来没被写过（新的 taskId、新的 repo）⇒ 正常。
// ⇒ computeCacheMetrics 单独存在时只能判「机制状态」，判不了「原因」；
//   原因要靠前缀组数（PrefixShape / groupKeyOf）才能进一步区分。

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
/** 部分共享的下限：低于它算「首轮几乎没共享」。 */
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
export function computeCacheMetrics(turns: TurnUsage[]): CacheMetrics {
  if (turns.length === 0) {
    return {
      firstTurnReuse: null,
      incremental: [],
      verdict: "not-reusing",
      reason: "没有任何轮次观测",
    };
  }
  const first = turns[0]!;
  // 分母为 0 按 0 算：除零得 NaN 会污染判定与回执
  const reuse = first.promptTokens > 0 ? first.cacheRead / first.promptTokens : 0;
  const incremental = turns.slice(1).map((cur, index) => {
    const prev = turns[index]!;
    const maxReusable = Math.min(prev.promptTokens, cur.promptTokens);
    const rate = maxReusable > 0 ? cur.cacheRead / maxReusable : 0;
    return { turn: index + 1, rate, maxReusable };
  });
  let verdict: CacheVerdict;
  let reason: string;
  if (reuse >= HEALTHY_REUSE) {
    verdict = "healthy";
    reason = `首轮复用率 ${toPercent(reuse)}，前缀机制生效`;
  } else if (reuse >= PARTIAL_REUSE) {
    verdict = "partial";
    reason = `首轮复用率 ${toPercent(reuse)}，部分共享（可能落在块边界）`;
  } else {
    verdict = "not-reusing";
    reason = `首轮复用率 ${toPercent(reuse)}，首轮几乎没共享`;
  }
  return { firstTurnReuse: reuse, incremental, verdict, reason };
}

/** 百分比文案：理由与提示共用一处，别各写各的。 */
function toPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/**
 * 前缀形状：影响缓存的输入的可读描述。
 * 不做哈希——组数很少（实测 4 个工具家族），存形状更可读、能分组，
 * 也少一个可被等价变异的哈希实现。
 */
export interface PrefixShape {
  /** 工具名单，排序后 */
  tools: string[];
  /** 有没有 worktree 隔离 */
  isolated: boolean;
  /** cwd 所属的仓库根（不是完整路径） */
  repoRoot?: string;
}

/** 缓存复用的观测结果。父方只看这个，不看逐轮明细。 */
export interface CacheObservation {
  /** 判定 */
  verdict: CacheVerdict;
  /** 首轮复用率（0~1），唯一的数字 */
  reuse: number;
  /** 前缀形状（可读，出问题时能直接看出分叉维度） */
  shape?: PrefixShape;
}

/**
 * 从逐轮明细 + 形状合成父方回执。
 * 没有轮次时 reuse 按 0 计：「没观测到」与「观测到没共享」对父方同为机制未生效。
 */
export function observeCache(turns: TurnUsage[], shape: PrefixShape): CacheObservation {
  const metrics = computeCacheMetrics(turns);
  return {
    verdict: metrics.verdict,
    reuse: metrics.firstTurnReuse ?? 0,
    shape,
  };
}

/**
 * 形状 → 组 key：JSON.stringify 就是天然的组 key。
 * 工具名单排序后入 key ⇒ 同一组工具换序不裂组；repoRoot 缺省不出键。
 */
export function groupKeyOf(shape: PrefixShape): string {
  const normalized: PrefixShape = {
    tools: [...shape.tools].sort(),
    isolated: shape.isolated,
    ...(shape.repoRoot !== undefined ? { repoRoot: shape.repoRoot } : {}),
  };
  return JSON.stringify(normalized);
}
