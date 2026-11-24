import type { ChildUsage, UsageBudget } from "./types.ts";

// 预算：纯函数。口径、阶段判定、收尾文案都在这里，引擎只负责执行。
//
// 口径（§2.1.1）：
//   美元 = 孩子上报的 usage.cost.total 累计（provider 不上报时按 0 算）。
//   token = input + output + cacheRead + cacheWrite —— **必须含 cacheRead**：
//   本机 27505 回合实测 cacheRead 占 prompt token 的 97.7%，不含的话缓存型子代理的账失真。
//   两个上限都给时任一越线即到点（OR 语义）。

/** 硬门相对软门的默认倍数。 */
export const DEFAULT_HARD_FACTOR = 2;

/** 软门之后多久还没交付就硬收（毫秒）。 */
export const DEFAULT_HARD_GRACE_MS = 120_000;

/** 累计处理过的 token：input + output + cacheRead + cacheWrite。 */
export function totalTokens(usage: ChildUsage): number {
  return (
    (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
  );
}

/** 累计成本（美元）。没有 cost 时按 0 算——那时美元上限失效，token 上限仍然有效。 */
export function usdOf(usage: ChildUsage): number {
  return usage.cost ?? 0;
}

/** 预算阶段的判定结果。 */
export type BudgetPhase = "ok" | "soft" | "hard";

export interface BudgetEvaluation {
  phase: BudgetPhase;
  /** 一句话说明（软门/硬门都带） */
  reason?: string;
}

export interface EvaluateBudgetInput {
  budget?: UsageBudget;
  /** 已观测到的累计成本（美元） */
  spentUsd: number;
  /** 已观测到的累计 token */
  spentTokens: number;
  /** 软门触发时刻（毫秒）；没触发过是 undefined */
  softAt?: number;
  /** 已经硬收过就一直是硬门（不回到软门） */
  hard?: boolean;
  /** 当前时刻（毫秒） */
  now: number;
}

/**
 * 判预算到了哪一步。
 * 硬门优先：已经硬收过、或用量超过硬门倍数、或软门后过了宽限期 ⇒ hard；
 * 否则到点 ⇒ soft；没到点 ⇒ ok。
 */
export function evaluateBudget(input: EvaluateBudgetInput): BudgetEvaluation {
  const budget = input.budget;
  if (!budget) return { phase: "ok" };
  if (input.hard) return { phase: "hard", reason: "已经硬收过" };
  const factor = budget.hardFactor ?? DEFAULT_HARD_FACTOR;
  const grace = budget.hardGraceMs ?? DEFAULT_HARD_GRACE_MS;
  const overUsd = budget.maxUsd !== undefined && input.spentUsd >= budget.maxUsd;
  const overTokens = budget.maxTokens !== undefined && input.spentTokens >= budget.maxTokens;
  const hardByUsd = budget.maxUsd !== undefined && input.spentUsd >= budget.maxUsd * factor;
  const hardByTokens =
    budget.maxTokens !== undefined && input.spentTokens >= budget.maxTokens * factor;
  const hardByTime = input.softAt !== undefined && input.now - input.softAt >= grace;
  if (hardByUsd || hardByTokens || hardByTime) {
    return { phase: "hard", reason: hardReason(budget, input, factor) };
  }
  if (overUsd || overTokens) {
    return { phase: "soft", reason: softReason(budget, input) };
  }
  return { phase: "ok" };
}

/** 软门理由：说清是哪条线越了。 */
function softReason(budget: UsageBudget, input: EvaluateBudgetInput): string {
  if (budget.maxUsd !== undefined && input.spentUsd >= budget.maxUsd) {
    return `已达美元上限 ${budget.maxUsd}（已花 ${input.spentUsd}）`;
  }
  return `已达 token 上限 ${budget.maxTokens}（已处理 ${input.spentTokens}）`;
}

/** 硬门理由：说清是哪条线越了（时间兜底也写明）。 */
function hardReason(budget: UsageBudget, input: EvaluateBudgetInput, factor: number): string {
  if (budget.maxUsd !== undefined && input.spentUsd >= budget.maxUsd * factor) {
    return `超美元硬门 ${budget.maxUsd * factor}（已花 ${input.spentUsd}）`;
  }
  if (budget.maxTokens !== undefined && input.spentTokens >= budget.maxTokens * factor) {
    return `超 token 硬门 ${budget.maxTokens * factor}（已处理 ${input.spentTokens}）`;
  }
  return `软门后宽限期已过（${input.now - (input.softAt ?? input.now)}ms）`;
}

/**
 * 软门写给孩子的收尾指令。
 * 措辞是「交付指令」不是「通知」——不然孩子可能只是「知道了」然后继续干。
 */
export const BUDGET_STEER_TEXT = [
  "预算到点：停止扩展工作。",
  "不要再开新工具、不要继续调研或改写；用你手上已有的结果收尾。",
  "按报告契约交付（summary / why / assessment / findings / files_touched / verified / usage），",
  "正文里写清「因预算到点而降级交付」，以及哪些部分没做完。",
].join("\n");
