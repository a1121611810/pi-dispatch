import type { ThinkingReceipt } from "./types.ts";

// 思考档位校验：纯函数（不 import pi 运行时）。
//
// 三条硬规矩（§2.2.1）：
//   ① 只降不升——生效档位的成本序不得高于请求档位。
//   ② 降级目标是 low（能干活又不肉疼），不是「最近的一档」。
//   ③ 只发 supported 里的档位——这样 pi 自己的 clampThinkingLevel 不会改动它，
//      回执里的「实际生效档位」就是孩子真跑的档位（事实，不是预测）。

/** 成本序：越往后越贵。xhigh ≈ max（两者预算相同）。 */
export const COST_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** 目录里一个模型的最小快照——core 只认这几个字段。 */
export interface ThinkingModelInfo {
  provider: string;
  id: string;
  /** 模型是否支持思考（false ⇒ 只支持 off） */
  reasoning: boolean;
  /** 档位映射：缺键 = 走 provider 默认值；null = 显式不支持。 */
  thinkingLevelMap?: Record<string, string | null | undefined>;
}

/**
 * 这个模型支持哪些档位（pi 的 getSupportedThinkingLevels 口径）。
 *   reasoning=false ⇒ 只有 off；
 *   thinkingLevelMap[档位] === null ⇒ 不支持；
 *   xhigh / max 缺键 ⇒ 也不支持（模型压根没提这一档）。
 */
export function supportedThinkingLevels(model: ThinkingModelInfo): string[] {
  if (!model.reasoning) return ["off"];
  return COST_ORDER.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

/**
 * 在目录里找模型：provider/id 精确命中；裸 id 唯一命中也算。
 * 命中不了（或裸 id 撞多个）⇒ undefined ⇒ 不校验、原样透传。
 */
export function findThinkingModel(
  catalog: readonly ThinkingModelInfo[],
  reference: string | undefined,
): ThinkingModelInfo | undefined {
  if (!reference) return undefined;
  const exact = catalog.find((m) => `${m.provider}/${m.id}` === reference);
  if (exact) return exact;
  const hits = catalog.filter((m) => m.id === reference);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) return undefined;
  return undefined;
}

/** 档位在成本序里的下标；不在序里（认不出的档位）当最贵（不许升）。 */
function costIndex(level: string): number {
  const index = COST_ORDER.indexOf(level as (typeof COST_ORDER)[number]);
  return index < 0 ? COST_ORDER.length - 1 : index;
}

/**
 * 降级目标：比请求档位更便宜（或同价）里最贵的一档。
 * 规则：先试 low；low 不可用退 off；再不行取目录里最便宜的一档。
 * 例外：请求档位本身比 low 还便宜（off / minimal）时，不能「降级」反而更贵。
 */
function downgradeTarget(supported: readonly string[], requested: string): string {
  const requestedIndex = costIndex(requested);
  const cheaper = supported.filter((level) => costIndex(level) <= requestedIndex);
  // 目录里没有任何不贵于请求档的档位 ⇒ 只能取最便宜的一档（pi 的 clamp 同样兜底到 availableLevels[0]）
  if (cheaper.length === 0) return supported[0] ?? "off";
  if (cheaper.includes("low")) return "low";
  if (cheaper.includes("off")) return "off";
  return cheaper[0]!;
}

/**
 * 解析思考档位。
 * 请求档位没给 ⇒ 不拼后缀（沿用会话默认），不擅自替父方降档。
 * 模型不在目录里 ⇒ 原样透传（modelKnown: false）。
 */
export function resolveThinkingLevel(args: {
  requested?: string;
  model?: ThinkingModelInfo;
}): ThinkingReceipt {
  const requested = args.requested?.trim() || undefined;
  if (!requested) {
    return {
      adjusted: false,
      modelKnown: args.model !== undefined,
      reason: "没给档位 ⇒ 沿用会话默认",
    };
  }
  const model = args.model;
  if (!model) {
    return {
      requested,
      effective: requested,
      adjusted: false,
      modelKnown: false,
      reason: "模型不在目录里 ⇒ 未校验，原样发",
    };
  }
  if (!model.reasoning) {
    return {
      requested,
      effective: "off",
      adjusted: requested !== "off",
      modelKnown: true,
      reason: "该模型不支持思考 ⇒ off",
    };
  }
  const supported = supportedThinkingLevels(model);
  if (supported.includes(requested)) {
    return {
      requested,
      effective: requested,
      adjusted: false,
      modelKnown: true,
      reason: "模型支持该档",
    };
  }
  // 认不出的档位（拼错的 / provider 私有值）：不猜，按最贵处理 ⇒ 降级目标是 low。
  if (!COST_ORDER.includes(requested as (typeof COST_ORDER)[number])) {
    const effective = downgradeTarget(supported, requested);
    return {
      requested,
      effective,
      adjusted: effective !== requested,
      modelKnown: true,
      reason: `认不出的档位 ${requested} ⇒ 降到 ${effective}`,
    };
  }
  const mapped = model.thinkingLevelMap?.[requested];
  if (mapped === null) {
    const effective = downgradeTarget(supported, requested);
    return {
      requested,
      effective,
      adjusted: effective !== requested,
      modelKnown: true,
      reason: `该模型没有 ${requested} 档（thinkingLevelMap=null）⇒ 降到 ${effective}`,
    };
  }
  // 缺键（只可能是 xhigh / max）：按 pi 口径落到最接近的一档。
  const nearest = nearestLevel(supported, requested);
  return {
    requested,
    effective: nearest,
    adjusted: nearest !== requested,
    modelKnown: true,
    reason: `该模型没有 ${requested} 档 ⇒ 按 pi 口径落到 ${nearest}`,
  };
}

/** 最接近的一档：先往更便宜的找，再往更贵的找（pi 的 clamp 口径）。 */
function nearestLevel(supported: readonly string[], requested: string): string {
  const requestedIndex = costIndex(requested);
  for (let i = requestedIndex; i < COST_ORDER.length; i++) {
    const candidate = COST_ORDER[i]!;
    if (supported.includes(candidate)) return candidate;
  }
  for (let i = requestedIndex - 1; i >= 0; i--) {
    const candidate = COST_ORDER[i]!;
    if (supported.includes(candidate)) return candidate;
  }
  return supported[0] ?? "off";
}
