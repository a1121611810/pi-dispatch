// 派发核心的类型定义。
// 核心层不 import pi —— 所有与宿主相关的形状都在这里定义，由适配层翻译。

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

export function isTerminal(status: TaskStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * 宿主模式：长驻（rpc）可以异步派发 + 终态通知；一次性（print/json）必须同步等终态。
 * tui 本期不做，但映射表留好位置。
 */
export type HostMode = "long-lived" | "one-shot";

/** 只读档位。strict 挡「改」不挡「读」——它不是沙箱。 */
export type ReadOnlyTier = "strict" | "lenient";

/** 项目上下文加载方式。 */
export type ProjectContext = "auto" | "none";

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
  /** 实际碰过的路径（去重，按出现顺序） */
  paths: string[];
  /** 工具执行失败次数 */
  errors: number;
  /** 孩子最终正文长度（字符）——0 = 空交 */
  textChars: number;
};

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

/** 孩子交回的结构化报告。 */
export interface ChildReport {
  summary: string;
  findings?: Array<{ what: string; evidence?: string }>;
  files_touched?: string[];
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
  /** 孩子的真实交付轨迹（引擎抽的，不是模型自述） */
  delivery?: ChildDelivery;
  /** 自述的文件和收据一个都对不上——没有实测支撑 */
  deliveryUnverified?: boolean;
  /** 产出落盘位置 */
  outputPath?: string;
  /** 孩子 stdout 超尾部上限被截断 */
  outputTruncated?: boolean;
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
  errorMessage?: string;
  readOnlyTier: ReadOnlyTier;
  outputPath: string;
  whySuppressed?: boolean;
  report?: ChildReport;
  reportChannel: ReportChannel;
  delivery?: ChildDelivery;
  /** 自述的文件和收据一个都对不上——没有实测支撑 */
  deliveryUnverified?: boolean;
  outputTruncated: boolean;
}

export type DispatchOutcome = DispatchHandle | TaskRejection | DispatchResult;
