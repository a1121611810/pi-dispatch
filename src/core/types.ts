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
  /** git status --porcelain 的非空行数 */
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
  /** 实际跑过的 bash 命令（原样记串不解析；去重、有上限）——对质「自检跑了没」的观测侧 */
  commands: string[];
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
  /** 孩子的真实交付轨迹（引擎抽的，不是模型自述） */
  delivery?: ChildDelivery;
  /** 自述的文件和收据一个都对不上——没有实测支撑 */
  deliveryUnverified?: boolean;
  /** 谎报自检被抓：声称跑过的命令，收据里一条都没观测到 */
  verifyUnverified?: boolean;
  /** assessment 空转（缺/过短/全正面）——小窗资格粗筛结果，信任只走记账规则 */
  assessmentVacuous?: boolean;
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
  /** 谎报自检被抓：声称跑过的命令，收据里一条都没观测到 */
  verifyUnverified?: boolean;
  /** assessment 空转（缺/过短/全正面）——小窗资格粗筛结果，信任只走记账规则 */
  assessmentVacuous?: boolean;
  outputTruncated: boolean;
  /** 隔离档位（只在开了时带出） */
  isolation?: Isolation;
  /** worktree 回执（只在开了隔离时带出） */
  worktree?: WorktreeInfo;
  /** 黑板信息（只在开了黑板时带出） */
  blackboard?: BlackboardInfo;
}

export type DispatchOutcome = DispatchHandle | TaskRejection | DispatchResult;
