// 派发核心的类型定义。
// 核心层不 import pi —— 所有与宿主相关的形状都在这里定义，由适配层翻译。
import type { CacheObservation } from "./cache-metrics.ts";

/** 任务状态。四个终态哪儿也去不了。 */
export type TaskStatus =
  | "queued"
  | "running"
  | "stopping"
  | "succeeded"
  | "failed"
  | "canceled"
  | "lost";

export const TERMINAL_STATUSES = [
  "succeeded",
  "failed",
  "canceled",
  "lost",
] as const satisfies readonly TaskStatus[];

/** 全部任务状态（恢复记录的结构闸用）：七个值，少一个都不许进账。 */
export const TASK_STATUSES = [
  "queued",
  "running",
  "stopping",
  "succeeded",
  "failed",
  "canceled",
  "lost",
] as const satisfies readonly TaskStatus[];

/**
 * C0 控制字符（NUL 等）不许进 argv / 附加块 / 信箱 / 编号。
 * \n \t \r 放行——它们是正常的文本换行与制表。
 */
// oxlint-disable-next-line no-control-regex -- 要匹配的正是控制字符本身
const C0_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

/** 文本里有 C0 控制字符吗（\n \t \r 不算）。 */
export function hasC0(text: string): boolean {
  return C0_RE.test(text);
}

export function isTerminal(status: TaskStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * 宿主模式：长驻（rpc / tui）可以异步派发 + 终态通知；一次性（print/json）必须同步等终态。
 * tui 的人看面在适配层 src/tui.ts（常驻 widget + footer 状态），core 不知道。
 */
export type HostMode = "long-lived" | "one-shot";

/** 只读档位。strict 挡「改」不挡「读」——它不是沙箱。 */
export type ReadOnlyTier = "strict" | "lenient";

/** 项目上下文加载方式。 */
export type ProjectContext = "auto" | "none";

/** 隔离档位。v1 只有一种：独立 git 工作区。 */
export type Isolation = "worktree";

/**
 * worktree 的观测回执。
 * 字段观测不到就留 undefined——**观测不到 ≠ 干净**（没测到脏，不能报 0）。
 */
export interface WorktreeInfo {
  /** worktree 目录（<bucket>/worktrees/<taskId>） */
  path: string;
  /** 分支名（pi-dispatch/<taskId>） */
  branch: string;
  /** 受理时钉死的基点提交 */
  baseCommit: string;
  /** 观测到的 HEAD（观测不到就没有） */
  headCommit?: string;
  /** git status --porcelain --untracked-files=all 的非空行数（= 脏文件数） */
  dirty?: number;
  /** 是不是在预期分支上 */
  onExpectedBranch?: boolean;
  /** 相对基点前进的提交数 */
  commitsAhead?: number;
  /** 目录已经不在（被手工删了） */
  missing?: boolean;
  /** 观测失败：只记，不回改终态 */
  captureError?: string;
}

/** 黑板。引擎会话级一块板，父方与孩子共读共写。 */
export interface BlackboardInfo {
  boardId: string;
  path: string;
}

/** 父方递给核心的派发参数。 */
export interface DispatchInput {
  /** 任务描述。必填，空就退回。子代理只看得到这一段。 */
  task: string;
  /** 为什么派它。会进子代理的提示词。 */
  why?: string;
  readOnly?: ReadOnlyTier;
  /** 覆盖子代理跑的模型。 */
  model?: string;
  /** 覆盖子代理的思考档位。 */
  thinkingLevel?: string;
  /** 最多跑多久（毫秒）。超了收掉。不给 = 不设限。 */
  timeoutMs?: number;
  projectContext?: ProjectContext;
  /** 子代理能不能写脚本批量调工具。不给 = 用会话默认值。 */
  allowScripts?: boolean;
  /** 要不要把子代理放进独立工作区。不给 = 与父方共享目录。 */
  isolation?: Isolation;
  /** 要不要开共享黑板。不给 = 不开。 */
  blackboard?: boolean;
  /** 用量预算。不给 = 不设限（受理时钉死，排队期间改不动）。 */
  usageBudget?: UsageBudget;
}

/** 安检不过时的理由。 */
export interface TaskRejection {
  status: "rejected";
  errorMessage: string;
}

/**
 * 孩子的真实交付轨迹（引擎从事件流抽，不依赖模型自述）——父核对结论的唯一非自述证据。
 * 用 type 而非 interface：类型别名才有隐式索引签名（要进 JSON 结构化载荷）。
 */
export type ChildDelivery = {
  /** 实际调用的工具与次数（按工具名） */
  tools: Record<string, number>;
  /** 实际改过的路径（只收写类工具的 args.path，去重、按出现顺序；读过的不算） */
  paths: string[];
  /** 实际跑过的 bash 命令（原样记串不解析；去重、有上限）——对质「自检跑了没」的观测侧 */
  commands: string[];
  /** 工具执行失败次数 */
  errors: number;
  /** 孩子最终正文长度（字符）——0 = 空交 */
  textChars: number;
  /** 畸形事件行数（不是合法事件的行）：好行照留，坏行计数 */
  malformed?: number;
  /** 路径收据到上限被丢弃过：截断只是丢了证据，判「对不上」时要放行 */
  pathsTruncated?: true;
  /** 命令收据按「留最近 N 条」丢过旧条目 */
  commandsTruncated?: true;
};

/**
 * 用量预算。软上限：用量在请求完成后才观测得到，越线的那一轮已经付过钱了。
 * 两个上限都给时任一越线即到点（OR 语义）。
 */
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

/** 预算回执：上限、已花、到点时刻。 */
export interface BudgetReceipt {
  maxUsd?: number;
  maxTokens?: number;
  /** 已观测到的累计成本（美元） */
  spentUsd: number;
  /** 已观测到的累计 token（含 cacheRead / cacheWrite） */
  spentTokens: number;
  /** 到点了（软门或硬门都算） */
  exhausted?: true;
  /** 软门触发时刻（毫秒） */
  softAt?: number;
  /** 软门没送达（没留痕目录 / 没装孩子扩展）——靠硬门兜底 */
  softSteerFailed?: true;
}

/**
 * 思考档位回执：父方要的档位与实际发给孩子的档位。
 * `modelKnown: false` = 模型不在目录里 ⇒ 未校验、原样透传。
 */
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

/** 用量。子代理自报为空或零时，用主方观察到的顶上去。 */
export interface ChildUsage {
  input?: number;
  output?: number;
  cost?: number;
  turns?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** 报告的到达通道。none = 什么都没交，要说出来，不要装成交了。 */
export type ReportChannel = "tool" | "prompt-json" | "none";

/**
 * 交付判词。退出码只说进程怎么了；这一列说交付有没有实测支撑，两件事分开记。
 * 定终态时由 registry 算一次，永不改 status——status 是进程事实，不是质量结论。
 */
export type Deliverable =
  /** 有自述，且每条自述都在收据里对上了 */
  | "verified"
  /** 有报告、没有可核对的自述（只读分析任务的诚实形态） */
  | "unclaimed"
  /** 有自述，只有一部分对上 */
  | "partial"
  /** 有自述但零命中、assessment 空转、或工具报告早于最后一次转向 */
  | "unverified"
  /** 没交报告，正文也是空的（空跑） */
  | "absent";

/** 自述覆盖度：声称几条、对上了几条。只在 0 < matched < claimed 时记。 */
export type ClaimCoverage = { claimed: number; matched: number };

/** 一条转向的收据状态。sent = 只写了盘；queued = 孩子队列见过；delivered = user 回显；seen = 回显后有过 assistant 回合；undelivered = 退出时无证据。 */
export type SteerState = "sent" | "queued" | "delivered" | "seen" | "undelivered";

/** 运行中转向的收据。运行中只写 sent；退出时按事件流证据补终态。 */
export interface SteerRecord {
  seq: number;
  /** 父方原文（不含首行标记） */
  text: string;
  at: number;
  state: SteerState;
  queuedAt?: number;
  deliveredAt?: number;
  seenAt?: number;
}

/** 孩子交回的结构化报告。三段式：summary=是什么，why=为什么，assessment=怎么样；后两段是判断，findings 是证据，files_touched/usage 是回执。 */
export interface ChildReport {
  summary: string;
  why: string;
  assessment: string;
  findings?: Array<{ what: string; evidence?: string }>;
  files_touched?: string[];
  /** 交付前跑过的自检（声称——对质走收据 commands；没跑就不给此字段） */
  verified?: Array<{ command: string; exitCode?: number }>;
  usage?: ChildUsage;
}

/** 记录本体。字段随状态变迁再长。 */
export interface TaskRecord {
  id: string;
  status: TaskStatus;
  task: string;
  ownerPid?: number;
  /** 主方进程的启动时刻——进程号会被系统重复使用，要两个都对才算活着。 */
  ownerStartMs?: number;
  startedAt?: number;
  finishedAt?: number;
  /** 子进程的真实退出码（起不来是 -1；未启动则没有） */
  exitCode?: number;
  stopReason?: string;
  /** 理由被开关丢弃的事实——记事件不记内容。 */
  whySuppressed?: boolean;
  report?: ChildReport;
  reportChannel?: ReportChannel;
  /** 孩子的真实用量（引擎从事件流逐轮累加，不依赖孩子交报告） */
  usage?: ChildUsage;
  /** 缓存复用观测（引擎算，不依赖孩子交报告） */
  cache?: CacheObservation;
  /** 孩子的真实交付轨迹（引擎抽的，不是模型自述） */
  delivery?: ChildDelivery;
  /** 自述的文件和收据一个都对不上——没有实测支撑 */
  deliveryUnverified?: boolean;
  /** 谎报自检被抓：声称跑过的命令，收据里一条都没观测到 */
  verifyUnverified?: boolean;
  /** assessment 空转（缺/过短/全正面）——小窗资格粗筛结果，信任只走记账规则 */
  assessmentVacuous?: boolean;
  /** 交付判词：退出码之外的第二条轴，定终态时算一次 */
  deliverable?: Deliverable;
  /** 改动自述只对上一部分（0 < matched < claimed） */
  deliveryPartial?: ClaimCoverage;
  /** 自检自述只对上一部分 */
  verifyPartial?: ClaimCoverage;
  /** 产出落盘位置 */
  outputPath?: string;
  /** 孩子 stdout 超尾部上限被截断 */
  outputTruncated?: boolean;
  /** 隔离档位（只在开了时写——默认关时记录里不出现这个键） */
  isolation?: Isolation;
  /** worktree 回执（只在开了隔离时写） */
  worktree?: WorktreeInfo;
  /** 黑板信息（只在开了黑板时写） */
  blackboard?: BlackboardInfo;
  /** 转向收据（只在写过转向时出现） */
  steers?: SteerRecord[];
  /** 工具通道报告早于最后一次送达的转向——小窗资格失效 */
  reportStale?: true;
  /** 预算回执（只在给了预算时出现——默认关时记录里不出现这个键） */
  budget?: BudgetReceipt;
  /** 预算到点（软门或硬门都算）——降级交付的旗标 */
  budgetExhausted?: true;
  /** 思考档位回执（只在解析过档位时出现） */
  thinking?: ThinkingReceipt;
}

/** 派发的结果。长驻模式返回 handle，一次性模式返回完整结果。 */
export interface DispatchHandle {
  status: "queued" | "running";
  taskId: string;
  whySuppressed?: boolean;
}

/** 跑完之后的完整结果。 */
export interface DispatchResult {
  status: "succeeded" | "failed" | "canceled" | "lost";
  taskId: string;
  text: string;
  exitCode: number;
  /** 孩子到底有没有被起起来（取消/拒绝时是 false） */
  started: boolean;
  /** finishedAt - startedAt（ms） */
  durationMs: number;
  usage?: ChildUsage;
  /** 缓存复用观测（引擎算，不依赖孩子交报告） */
  cache?: CacheObservation;
  errorMessage?: string;
  readOnlyTier: ReadOnlyTier;
  outputPath: string;
  whySuppressed?: boolean;
  report?: ChildReport;
  reportChannel: ReportChannel;
  delivery?: ChildDelivery;
  /** 自述的文件和收据一个都对不上——没有实测支撑 */
  deliveryUnverified?: boolean;
  /** 谎报自检被抓：声称跑过的命令，收据里一条都没观测到 */
  verifyUnverified?: boolean;
  /** assessment 空转（缺/过短/全正面）——小窗资格粗筛结果，信任只走记账规则 */
  assessmentVacuous?: boolean;
  /** 交付判词：退出码之外的第二条轴 */
  deliverable?: Deliverable;
  /** 改动自述只对上一部分 */
  deliveryPartial?: ClaimCoverage;
  /** 自检自述只对上一部分 */
  verifyPartial?: ClaimCoverage;
  outputTruncated: boolean;
  /** 隔离档位（只在开了时带出） */
  isolation?: Isolation;
  /** worktree 回执（只在开了隔离时带出） */
  worktree?: WorktreeInfo;
  /** 黑板信息（只在开了黑板时带出） */
  blackboard?: BlackboardInfo;
  /** 转向收据（只在写过转向时带出） */
  steers?: SteerRecord[];
  /** 工具通道报告早于最后一次送达的转向 */
  reportStale?: true;
  /** 预算回执（只在给了预算时带出） */
  budget?: BudgetReceipt;
  /** 预算到点（降级交付） */
  budgetExhausted?: true;
  /** 思考档位回执（只在解析过档位时带出） */
  thinking?: ThinkingReceipt;
}

/** 转向受理结果。 */
export type SteerOutcome =
  | { ok: true; taskId: string; seq: number; state: "sent"; path: string }
  | { ok: false; taskId: string; error: string };

export type DispatchOutcome = DispatchHandle | TaskRejection | DispatchResult;
