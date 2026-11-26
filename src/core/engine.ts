import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { ChildActivityTracker, DEFAULT_STALL_MS, STALL_CHECK_INTERVAL_MS } from "./activity.ts";
import {
  assessmentVacuous,
  buildPiArgv,
  createSteerEvidenceTracker,
  deliveryCoverage,
  deliveryUnverified,
  createUsageTracker,
  verifyCoverage,
  effectiveModel,
  parseChildStream,
  extractReportFromText,
  receiptGap,
  spawnChild,
  STDOUT_KEEP_CHARS,
  verifyUnverified,
  type ChildHandle,
  type SpawnChild,
} from "./child.ts";
import { defaultGates, parseDepth, type Gate, rejection } from "./gates.ts";
import { BlackboardStore, type BlackboardOwner, type BlackboardRead } from "./blackboard.ts";
import {
  canOpenAnother,
  maxConcurrentStarts,
  perSeatBytes,
  poolBytes,
  seatCount,
  systemMachineReader,
  type MachineReader,
  type MachineSpec,
} from "./pool.ts";
import { Storage, isPidAlive, processStartMs } from "./storage.ts";
import { isReportStale, parseSteerLines, planSteer, reconcileSteerReceipts } from "./steer.ts";
import {
  branchNameFor,
  createWorktree,
  execFileGit,
  observeWorktree,
  removeWorktree,
  resolveHead,
  sweepWorktrees,
  type GitRunner,
} from "./worktree.ts";
import {
  BUDGET_STEER_TEXT,
  DEFAULT_HARD_GRACE_MS,
  evaluateBudget,
  totalTokens,
  usdOf,
} from "./budget.ts";
import { findThinkingModel, resolveThinkingLevel, type ThinkingModelInfo } from "./thinking.ts";
import { observeCache } from "./cache-metrics.ts";
import type { TaskRegistry } from "./registry.ts";
import type {
  BudgetReceipt,
  ChildUsage,
  DispatchInput,
  DispatchOutcome,
  DispatchResult,
  HostMode,
  SteerOutcome,
  TaskRecord,
  ThinkingReceipt,
  WorktreeInfo,
} from "./types.ts";
import { isTerminal } from "./types.ts";

// 任务引擎：闸 → 建记录 → 要座位 → 改状态 → 起 → 盯 → 收四样 → 定终态 → 还座位 → 通知。
//
// 座位模型：seatCap 是启动时算出的固定上限（此后不变）；
// 每次派发前另算「此刻池子」——座位够但池子紧也不能开。
// 还座位（子代理结束）时把座位给最早在等的那个 —— 叫醒 ≠ 启动，提拔后必须真的起。
// 实现上「带提拔的还座位」由 #startQueued 承担：它按记录顺序找最早在等的排队者并起它，
// 不另设计数器（记录本身就是队列）。

export interface EngineDeps {
  registry: TaskRegistry;
  /**
   * 追加的安检。默认九道闸始终在最前面，自定义闸只能追加在后面——
   * 注入不是替换：替换会让默认闸（只读档、超时、深度…）凭空消失。
   */
  extraGates?: Gate[];
  /** 起子进程（测试注入假 spawn） */
  spawnChild?: SpawnChild;
  /** 读机器（测试注入假读数） */
  machineReader?: MachineReader;
  /** 留痕。给了才有重启恢复。 */
  storage?: Storage;
  /** 终态热存上限（条）。默认 500。 */
  terminalKeep?: number;
  /** 归档保留天数。默认 30。 */
  archiveTtlDays?: number;
  /** 卡住阈值（毫秒）。默认 5 分钟；0 = 关掉。 */
  stallMs?: number;
  /** 深度上限。默认 3。 */
  maxDepth?: number;
  /** 理由开关。谓词不是值。 */
  whyEnabled?: () => boolean;
  /** allowScripts 的会话默认值 */
  allowScriptsDefault?: () => boolean;
  /** 宿主模式：长驻异步 / 一次性等终态。 */
  hostMode?: HostMode;
  /** pi 版本（拼命令时的 --no-mcp 版本门） */
  piVersion?: string;
  /** 会话当前模型（拼命令时的回落） */
  sessionModel?: () => string | undefined;
  /** pi 可执行文件路径 */
  piPath?: string;
  /** 孩子自己的扩展文件路径（-e 装进孩子，回执工具才在） */
  childExtensionPath?: string;
  /** 时钟（测试注入假时钟） */
  now?: () => number;
  /** 跑 git（测试注入假 runner；缺省真跑 git） */
  git?: GitRunner;
  /** git 仓库根（适配层问 git 拿的；缺省 = 隔离不可用） */
  repoRoot?: string;
  /** 是不是可用的 git 仓（喂安检 9；缺省 = 否 ⇒ 不许开隔离） */
  isGitRepo?: () => boolean;
  /**
   * 模型目录快照（思考档位校验用）。缺省 = 空目录 = 不校验、原样透传。
   * 它是**数据**不是机器读：适配层从 ctx.modelRegistry 摊成纯数据传进来。
   */
  thinkingCatalog?: () => readonly ThinkingModelInfo[];
}

const DEFAULT_STOP_GRACE_MS = 5_000;
const DEFAULT_TERMINAL_KEEP = 500;
const DEFAULT_ARCHIVE_TTL_DAYS = 30;
const WAKE_INTERVAL_MS = 5_000;

/** 缺省配置：一个地方定全部默认值。构造器只做「表 + 显式给的覆盖」。 */
const DEFAULT_ENGINE = {
  spawnChild,
  machineReader: systemMachineReader,
  terminalKeep: DEFAULT_TERMINAL_KEEP,
  archiveTtlDays: DEFAULT_ARCHIVE_TTL_DAYS,
  stallMs: DEFAULT_STALL_MS,
  maxDepth: 3,
  hostMode: "long-lived" as HostMode,
  whyEnabled: () => true,
  allowScriptsDefault: () => false,
  now: Date.now,
} as const;

/**
 * 去掉值为 undefined 的键。
 * 直接 `{...defaults, ...deps}` 会让显式的 `undefined` 覆盖默认值；
 * 这里先滤掉，默认值才真的生效。
 */
function definedOnly<T extends object>(source: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

// ── 确定性逻辑（模块级函数）─────────────────────────────────────────────────
// 抽到模块级的理由：变异器只看得到模块级 defn；类私有 # 方法在变异账本里零站点。
// 这里只做「解析 / 判定 / 组装」，编排与副作用留在类方法里（类方法只做薄封装）。

/** 受理时钉 base：读仓库当前的 HEAD。读不到就返回失败（引擎据此退回，不留痕）。 */
export async function pinBaseCommit(
  git: GitRunner,
  repoRoot: string | undefined,
): Promise<{ ok: true; headCommit: string } | { ok: false; error: string }> {
  if (!repoRoot) return { ok: false, error: "不知道 git 仓库根（repoRoot 未注入）" };
  try {
    const headCommit = await resolveHead(git, repoRoot);
    return { ok: true, headCommit };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 开板：确保有留痕目录、写 owner.json。
 * 开不出来 ⇒ 退回（不留记录不占座位）——闸在铸 id 前。
 */
export function openBoardState(
  storage: Storage | undefined,
  owner: { pid: number; startMs: number },
  boardId: string,
): { ok: true; board: { boardId: string; path: string } } | { ok: false; error: string } {
  if (!storage) return { ok: false, error: "blackboard 需要留痕目录（storage 未配置）" };
  const path = storage.blackboardDir(boardId);
  try {
    new BlackboardStore({ root: storage.blackboardsDir, boardId }).ensureOwner(owner);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `blackboard 开板失败：${why}` };
  }
  return { ok: true, board: { boardId, path } };
}

/**
 * 启动名额内建 worktree。
 * 失败 ⇒ 返回错误（绝不降级共享 cwd、绝不 spawn）。
 * 非隔离任务 ⇒ 直接放行（没有 worktree 要建）。
 */
export async function prepareIsolationFor(
  git: GitRunner,
  repoRoot: string,
  record: TaskRecord | undefined,
): Promise<
  | { ok: true; worktree?: { path: string; branch: string; baseCommit: string } }
  | { ok: false; error: string }
> {
  if (record?.isolation !== "worktree") return { ok: true };
  const base = record.worktree;
  if (!base) return { ok: false, error: "记录里没有 worktree 基线" };
  const created = await createWorktree(git, {
    repoRoot,
    path: base.path,
    branch: base.branch,
    baseCommit: base.baseCommit,
  });
  if (!created.ok) {
    return { ok: false, error: created.error ?? "worktree 创建失败" };
  }
  return {
    ok: true,
    worktree: { path: base.path, branch: base.branch, baseCommit: base.baseCommit },
  };
}

/** 深度 + 编号：孩子知道自己 depth 与父任务 id；继承来的黑板 env 一律擦掉（G5）。 */
export function childEnvFor(
  baseEnv: NodeJS.ProcessEnv,
  taskId: string,
  blackboard?: { boardId: string; path: string },
  steerFile?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    PI_DISPATCH_DEPTH: String(Number(baseEnv.PI_DISPATCH_DEPTH ?? 0) + 1),
    PI_DISPATCH_TASK_ID: taskId,
  };
  // 继承来的黑板/转向 env 一律擦掉：这块会话没开就不该有对应目录
  delete env.PI_DISPATCH_BLACKBOARD_DIR;
  delete env.PI_DISPATCH_BLACKBOARD_ID;
  delete env.PI_DISPATCH_STEER_FILE;
  if (blackboard) {
    env.PI_DISPATCH_BLACKBOARD_DIR = blackboard.path;
    env.PI_DISPATCH_BLACKBOARD_ID = blackboard.boardId;
  }
  if (steerFile) env.PI_DISPATCH_STEER_FILE = steerFile;
  return env;
}

/** 观测 worktree：只取磁盘事实；观测不到 ≠ 干净（dirty 不兜 0）。 */
export async function captureWorktreeFor(
  git: GitRunner,
  worktree: { path: string; branch: string; baseCommit: string },
): Promise<WorktreeInfo> {
  const probe = await observeWorktree(git, worktree);
  return {
    path: probe.path,
    branch: probe.branch,
    baseCommit: probe.baseCommit,
    headCommit: probe.headCommit,
    // 观测不到 ≠ 干净：观测不到就留空，绝不兜 0
    dirty: probe.dirty,
    onExpectedBranch: probe.onExpectedBranch,
    commitsAhead: probe.commitsAhead,
    missing: probe.missing,
    captureError: probe.captureError,
  };
}

/** 结果里的 worktree 回执：目录不在（没建 / 建好又回收）⇒ 标 missing，不谎报路径可用。 */
export function worktreeReceipt(worktree: WorktreeInfo | undefined): { worktree?: WorktreeInfo } {
  if (!worktree) return {};
  return { worktree: existsSync(worktree.path) ? worktree : { ...worktree, missing: true } };
}

/** 判活要问系统的两件事（测试注入假实现；生产用缺省）。 */
export interface OwnerProbes {
  alive: (pid: number) => boolean;
  startMs: (pid: number) => number | undefined;
}

const DEFAULT_OWNER_PROBES: OwnerProbes = { alive: isPidAlive, startMs: processStartMs };

/**
 * owner 还活着吗？
 * 判活 fail-safe：pid 活着但启动时刻读不到（权限/ps 失败）⇒ 证不死 ⇒ 按活处理（宁留垃圾，不删证据）。
 */
export function ownerIsActive(
  owner: BlackboardOwner,
  probes: OwnerProbes = DEFAULT_OWNER_PROBES,
): boolean {
  if (owner.closedAt !== undefined) return false;
  if (!probes.alive(owner.pid)) return false;
  const start = probes.startMs(owner.pid);
  if (start === undefined) return true;
  return start === owner.startMs;
}

/** owner 被证死了吗？板已关，或 pid 已死，或启动时刻读得到且对不上。读不到启动时刻 ⇒ 证不死。 */
export function ownerProvenDead(
  owner: BlackboardOwner,
  probes: OwnerProbes = DEFAULT_OWNER_PROBES,
): boolean {
  if (owner.closedAt !== undefined) return true;
  if (!probes.alive(owner.pid)) return true;
  const start = probes.startMs(owner.pid);
  return start !== undefined && start !== owner.startMs;
}

/**
 * 这块板还活着吗？
 * 两条判据：① 有非终态的记录还引用它（有人在跑）；② 它的 owner 还活着（pid + 启动时刻两个都对）且板没关。
 */
export function boardIsActive(
  records: readonly TaskRecord[],
  store: BlackboardStore,
  boardId: string,
  probes: OwnerProbes = DEFAULT_OWNER_PROBES,
): boolean {
  for (const record of records) {
    if (record.blackboard?.boardId !== boardId) continue;
    if (!isTerminal(record.status)) return true;
  }
  const owner = store.ownerInfo(boardId);
  if (!owner) return false;
  return ownerIsActive(owner, probes);
}

export class TaskEngine {
  readonly #registry: TaskRegistry;
  readonly #gates: Gate[];
  readonly #spawn: SpawnChild;
  readonly #machine: MachineReader;
  readonly #storage?: Storage;
  readonly #terminalKeep: number;
  readonly #archiveTtlDays: number;
  readonly #stallMs: number;
  readonly #maxDepth: number;
  readonly #whyEnabled: () => boolean;
  readonly #allowScriptsDefault: () => boolean;
  readonly #hostMode: HostMode;
  readonly #piVersion?: string;
  readonly #sessionModel?: () => string | undefined;
  readonly #piPath?: string;
  readonly #childExtensionPath?: string;
  readonly #now: () => number;
  readonly #git: GitRunner;
  readonly #repoRoot?: string;
  readonly #owner: { pid: number; startMs: number };
  readonly #thinkingCatalog?: () => readonly ThinkingModelInfo[];
  /** 受理时解析出的思考档位后缀（拼进 --model 的 :<档位>）。key = taskId。 */
  readonly #thinkingSuffixes = new Map<string, string | undefined>();
  /** 预算状态机：软门时刻 / 硬门已触发。key = taskId。 */
  readonly #budgetStates = new Map<string, { softAt?: number; hard: boolean }>();
  /** 硬门的时间兜底定时器（软门后宽限期到了还没交 ⇒ 收掉）。 */
  readonly #budgetTimers = new Map<string, NodeJS.Timeout>();
  readonly #ready: Promise<void>;
  /** 在跑的孩子（占用座位） */
  readonly #children = new Map<string, ChildHandle>();
  /** 排队任务的入参（被提拔时拼 argv 用） */
  readonly #inputs = new Map<string, DispatchInput>();
  /** 一次性宿主等终态的 waiter */
  readonly #terminalWaiters = new Map<string, Array<(r: TaskRecord) => void>>();
  /** CPU 启动节流 */
  #starting = 0;
  readonly #launchLimit: number;
  readonly #launchWaiters: Array<() => void> = [];
  /** 本会话的黑板编号（懒生成）——引擎实例 = 会话，一会话一块板 */
  #boardId?: string;
  /** 机器规格（总内存 + 核数）：恒定，启动时读一次 */
  readonly #spec: MachineSpec;
  /** 座位上限（启动时算，此后不变） */
  readonly #seatCap: number;
  #wakeTimer?: NodeJS.Timeout;
  #ending = false;
  #teardown = false;
  /** 转向串行尾：两次并发 steer 不许读到同一个 seq 再各写一行。 */
  #steerTail: Promise<unknown> = Promise.resolve();
  /** 已经进入退出对账的任务：不再受理新的转向（spawn 前仍可受理）。 */
  readonly #steerClosed = new Set<string>();

  constructor(deps: EngineDeps) {
    this.#registry = deps.registry;
    const cfg = { ...DEFAULT_ENGINE, ...definedOnly(deps) };
    this.#spawn = cfg.spawnChild;
    this.#machine = cfg.machineReader;
    this.#storage = deps.storage;
    this.#terminalKeep = cfg.terminalKeep;
    this.#archiveTtlDays = cfg.archiveTtlDays;
    this.#stallMs = cfg.stallMs;
    this.#maxDepth = cfg.maxDepth;
    this.#whyEnabled = cfg.whyEnabled;
    this.#allowScriptsDefault = cfg.allowScriptsDefault;
    this.#hostMode = cfg.hostMode;
    this.#thinkingCatalog = deps.thinkingCatalog;
    this.#piVersion = deps.piVersion;
    this.#sessionModel = deps.sessionModel;
    this.#piPath = deps.piPath;
    this.#childExtensionPath = deps.childExtensionPath;
    this.#now = cfg.now;
    this.#git = deps.git ?? execFileGit;
    this.#repoRoot = deps.repoRoot;
    this.#spec = this.#machine.readSpec();
    this.#launchLimit = maxConcurrentStarts(this.#spec.cpus);
    // 座位上限：启动那一刻的可用 − 预留，÷ 每座份额
    this.#seatCap = seatCount(
      poolBytes(this.#machine.readAvailable(), this.#spec.totalBytes),
      perSeatBytes(this.#spec.totalBytes),
    );
    this.#owner = { pid: process.pid, startMs: processStartMs(process.pid) ?? this.#now() };
    this.#gates = [
      ...defaultGates({
        isEnding: () => this.#ending,
        depth: () => parseDepth(process.env.PI_DISPATCH_DEPTH),
        maxDepth: this.#maxDepth,
        // 没注入就当不是 git 仓 ⇒ 不许开隔离（缺省配置不许做没把握的事）
        isGitRepo: deps.isGitRepo ?? (() => false),
      }),
      // 自定义闸只能追加：默认闸始终在最前面，不许被注入抹掉
      ...(deps.extraGates ?? []),
    ];
    this.#ready = this.#storage ? this.#restore() : Promise.resolve();
    this.#startWakeTimer();
  }

  /** 恢复完成的信号——有 storage 时等它，重启恢复（装载 + 标 lost）才算做完。 */
  get ready(): Promise<void> {
    return this.#ready;
  }

  #startWakeTimer(): void {
    if (this.#hostMode !== "long-lived") return;
    const tick = (): void => {
      if (this.#teardown) return;
      this.#startQueued();
      this.#wakeTimer = setTimeout(tick, WAKE_INTERVAL_MS);
      this.#wakeTimer.unref();
    };
    this.#wakeTimer = setTimeout(tick, WAKE_INTERVAL_MS);
    this.#wakeTimer.unref();
  }

  /** 已交给 #runToTerminal、子进程还没起来的任务。它们也算占座，否则会超发。 */
  readonly #claimed = new Set<string>();

  /** 此刻还能不能再开一个（座位够 + 池子不紧） */
  #canStart(): boolean {
    // #claimed 就是「已占用」：先进 claimed，起了之后同时也在 children 里，结束时一起删。
    // 把两个相加会把每个在跑的任务数两次——错峰时座位空着也不放行。
    if (this.#claimed.size >= this.#seatCap) return false;
    return canOpenAnother(this.#machine.readAvailable(), this.#claimed.size, this.#spec);
  }

  /**
   * 把最早在等的排队任务起起来（叫醒 ≠ 启动——这里必须真的去起）。
   * 派发时、子代理结束时、定时器兜底时都会调它。
   */
  #startQueued(): void {
    while (this.#canStart()) {
      // 跳过已交出去、还没转成 running 的——否则会反复看到同一条
      const next = this.#registry
        .list()
        .find((r) => r.status === "queued" && !this.#claimed.has(r.id));
      if (!next) return;
      const input = this.#inputs.get(next.id);
      if (!input) return;
      this.#inputs.delete(next.id);
      this.#claimed.add(next.id);
      // 交出去后，等它结束再叫下一个——`#startQueued` 在这里统一重入，
      // 因为 claimed 要到 promise 落定才释放（#spawnAndPump 内部还座位时它还占着）。
      void this.#runToTerminal(next.id, input).finally(() => {
        this.#claimed.delete(next.id);
        this.#startQueued();
      });
    }
  }

  dispatch(input: DispatchInput): Promise<DispatchOutcome> {
    return this.#ready.then(() => this.#dispatchReady(input));
  }

  /**
   * 运行中转向：只受理 running；写一行、记 sent，孩子在下一个 turn_end 取走。
   * 串行化是为了并发两次调用得到 seq 1/2，而不是都从文件尾读到同一个 seq。
   */
  steer(taskId: string, text: string): Promise<SteerOutcome> {
    const run = this.#steerTail.then(() => this.#steerNow(taskId, text));
    this.#steerTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #steerNow(taskId: string, text: string): Promise<SteerOutcome> {
    await this.#ready;
    const record = this.#registry.get(taskId);
    if (!record) return { ok: false, taskId, error: "unknown task id" };
    // 进入退出对账后不再收：避免终态 reconcile 之后再来一笔 sent 永久挂着。
    // 不用 #children.has：spawn 前 status 已是 running，那个窗口里转向是合法的。
    if (this.#steerClosed.has(taskId))
      return { ok: false, taskId, error: "child is finishing; steer window closed" };
    // 用户原话是「孩子还在跑的时候」；queued 还没开工，改任务应该 stop + 重派。
    let existing;
    try {
      existing = this.#storage ? parseSteerLines(this.#storage.readSteer(taskId)) : [];
    } catch (error) {
      return {
        ok: false,
        taskId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const plan = planSteer({
      status: record.status,
      text,
      existing,
      hasStorage: Boolean(this.#storage),
      hasChildExtension: Boolean(this.#childExtensionPath),
    });
    if (!plan.ok) return { ok: false, taskId, error: plan.error };
    const seq = plan.seq;
    const trimmed = plan.text;
    const at = this.#now();
    let path: string;
    try {
      path = this.#storage!.appendSteer(taskId, JSON.stringify({ seq, text: trimmed, at }));
    } catch (error) {
      return {
        ok: false,
        taskId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    // 写盘成功才记 sent；写失败不能先在账上记一笔。
    await this.#registry.submit({
      kind: "attach-steer",
      id: taskId,
      steers: [{ seq, text: trimmed, at, state: "sent" }],
    });
    return { ok: true, taskId, seq, state: "sent", path };
  }

  async #dispatchReady(rawInput: DispatchInput): Promise<DispatchOutcome> {
    if (this.#teardown) return rejection("session is ending：拆卸中不再收新的派发");
    for (const gate of this.#gates) {
      const rejected = gate(rawInput);
      if (rejected) return rejected; // 闸在铸 id 前：不留记录不占座位
    }
    // 一次性宿主里「没人会还座位」的情形：座位 0 或池子永久紧时，
    // 这个进程里没有任何子代理能结束并腾出座位 ⇒ 等就是挂住父方（实测永不返回）。
    // 在铸编号之前退回，不留记录。
    if (this.#hostMode === "one-shot" && this.#claimed.size === 0 && !this.#canStart()) {
      return rejection("machine is too tight：此刻开不出座位，一次性宿主无法等待");
    }
    // 理由开关关掉时丢内容，但记一笔「理由被丢了」
    const whyEnabled = this.#whyEnabled();
    const whySuppressed = !whyEnabled && rawInput.why !== undefined;
    const allowScripts = rawInput.allowScripts ?? this.#allowScriptsDefault();
    // 默认值 provider 是 JS 可调的：非 boolean 的 truthy 会悄悄开 codemode（能力扩大）⇒ 退回
    if (typeof allowScripts !== "boolean") {
      return rejection(`allowScripts 默认值必须是 boolean：${String(allowScripts)}`);
    }
    const input: DispatchInput = {
      ...rawInput,
      why: whyEnabled ? rawInput.why : undefined,
      allowScripts,
      // 预算在受理时钉死：克隆一份，排队期间调用方改参数不影响这一单。
      ...(rawInput.usageBudget ? { usageBudget: { ...rawInput.usageBudget } } : {}),
    };
    // 闸后、铸 id 前：钉死 base（受理时的 HEAD）——排队期间父仓 HEAD 前进也不漂移。
    // 钉不住就退回：闸在铸 id 前，不留记录不占座位。
    let probe: { headCommit: string } | undefined;
    if (input.isolation === "worktree") {
      if (!this.#storage) {
        return rejection("isolation=worktree 需要留痕目录（storage 未配置）");
      }
      const head = await this.#pinBase();
      if (!head.ok) {
        return rejection(`isolation=worktree：钉不住 base commit —— ${head.error}`);
      }
      probe = { headCommit: head.headCommit };
    }
    // 黑板：闸后、铸 id 前——开不出来就退回，不留记录不占座位。
    let board: { boardId: string; path: string } | undefined;
    if (input.blackboard === true) {
      const opened = this.#openBoard();
      if (!opened.ok) return rejection(opened.error);
      board = opened.board;
    }
    const taskId = randomUUID();
    // 模型也在受理时钉死：排队期间父会话换模型，不许让 argv 用新模型配旧档位。
    const acceptedModel = effectiveModel({
      model: input.model,
      sessionModel: this.#sessionModel?.(),
    });
    if (acceptedModel !== undefined) input.model = acceptedModel;
    // 思考档位：受理时解析并钉死（跟预算一样是受理时的入参，排队期间改不动）。
    const thinking = this.#resolveThinking(input);
    if (thinking) this.#thinkingSuffixes.set(taskId, thinking.suffix);
    // 预算回执的初始形态：上限钉死，已花为 0。
    const budget = input.usageBudget
      ? {
          ...(input.usageBudget.maxUsd !== undefined ? { maxUsd: input.usageBudget.maxUsd } : {}),
          ...(input.usageBudget.maxTokens !== undefined
            ? { maxTokens: input.usageBudget.maxTokens }
            : {}),
          spentUsd: 0,
          spentTokens: 0,
        }
      : undefined;
    const record: TaskRecord = {
      id: taskId,
      status: "queued",
      task: input.task,
      whySuppressed,
      ownerPid: this.#owner.pid,
      ownerStartMs: this.#owner.startMs,
      // 隔离的键只在开启时出现（默认关时 Object.keys 不变）
      ...(probe
        ? {
            isolation: "worktree" as const,
            worktree: {
              path: this.#worktreePath(taskId),
              branch: branchNameFor(taskId),
              baseCommit: probe.headCommit,
            },
          }
        : {}),
      // 黑板的键只在开启时出现（默认关时 Object.keys 不变）
      ...(board ? { blackboard: board } : {}),
      // 预算与档位的键只在开启/解析过时出现（默认关时 Object.keys 不变）
      ...(budget ? { budget } : {}),
      ...(thinking ? { thinking: thinking.receipt } : {}),
    };
    await this.#registry.submit({ kind: "spawn", record });
    this.#inputs.set(taskId, input);
    this.#startQueued(); // 座位够就起，不够就排队等

    if (this.#hostMode === "one-shot") {
      // 一次性宿主：等终态，拿完整结果（含正文）。
      // 注意 #startQueued 是 fire-and-forget——结果从终态 waiter 旁边的 text 通道拿。
      const finalRecord = await this.#awaitTerminal(taskId);
      const text = this.#finalTexts.get(taskId) ?? "";
      this.#finalTexts.delete(taskId);
      return this.#resultFromRecord(taskId, input, finalRecord, text);
    }
    return { status: "queued", taskId, whySuppressed };
  }

  /** 一次性宿主拿正文的通道：#spawnAndPump 写完，#dispatchReady 读走。 */
  readonly #finalTexts = new Map<string, string>();

  #awaitTerminal(taskId: string): Promise<TaskRecord> {
    const current = this.#registry.get(taskId);
    if (current && isTerminal(current.status)) return Promise.resolve(current);
    return new Promise((resolve) => {
      const list = this.#terminalWaiters.get(taskId) ?? [];
      list.push(resolve);
      this.#terminalWaiters.set(taskId, list);
    });
  }

  #notifyTerminal(record: TaskRecord): void {
    const waiters = this.#terminalWaiters.get(record.id);
    if (!waiters) return;
    this.#terminalWaiters.delete(record.id);
    for (const resolve of waiters) resolve(record);
  }

  async #runToTerminal(taskId: string, input: DispatchInput): Promise<void> {
    try {
      await this.#executeRun(taskId, input);
    } catch {
      // 泵内异常（spawn 同步抛、磁盘写失败…）不许升级成宿主未处理拒绝
      const r = await this.#registry
        .submit({ kind: "resolve-exit", id: taskId, exitCode: -1 })
        .catch(() => undefined);
      if (r) this.#notifyTerminal(r.record);
    } finally {
      this.#forgetTask(taskId);
    }
  }

  /** 任务走到终态后清掉所有 per-task 状态，避免长驻会话里只增不减。 */
  #forgetTask(taskId: string): void {
    const timer = this.#budgetTimers.get(taskId);
    if (timer) clearTimeout(timer);
    this.#budgetTimers.delete(taskId);
    this.#budgetStates.delete(taskId);
    this.#thinkingSuffixes.delete(taskId);
    this.#budgetSteerFailed.delete(taskId);
  }

  async #executeRun(taskId: string, input: DispatchInput): Promise<void> {
    const entered = await this.#registry.submit({ kind: "transition", id: taskId, to: "running" });
    if (!entered.changed) {
      // 等座期间记录已被取消——不 spawn
      return;
    }
    if (this.#teardown) {
      const r = await this.#registry
        .submit({ kind: "resolve-exit", id: taskId, exitCode: -1 })
        .catch(() => undefined);
      if (r) this.#notifyTerminal(r.record);
      return;
    }
    // CPU 启动节流：名额只护「启动」这一段，不起子进程就还回去（不占座）
    await this.#acquireLaunchSlot();
    let child: ChildHandle;
    try {
      const beforeSpawn = this.#registry.get(taskId);
      if (!beforeSpawn || beforeSpawn.status !== "running") {
        // 记录已转 stopping（stop 命令先走一步）；不补这张 resolve-exit，
        // 记录会永远停在 stopping——一次性宿主的 #awaitTerminal 永久挂住。
        const r = await this.#registry
          .submit({
            kind: "resolve-exit",
            id: taskId,
            exitCode: -1,
            notStarted: true,
            detail: "等启动名额时被叫停",
          })
          .catch(() => undefined);
        if (r) this.#notifyTerminal(r.record);
        return;
      }
      // 启动名额内建 worktree：建不出来 ⇒ 失败。
      // 绝不降级共享 cwd、绝不 spawn（孩子在共享目录里干活比失败更糟）。
      const prepared = await this.#prepareWorktree(taskId);
      if (!prepared.ok) {
        // git worktree add 失败前可能已经把目录落在盘上（建了一半/元数据写了一半）。
        // 失败结果不带路径 ⇒ 从记录里取本次路径，best-effort 非强制回收；回收失败交给清扫。
        const attempted = this.#registry.get(taskId)?.worktree;
        if (attempted) {
          await removeWorktree(
            this.#git,
            this.#repoRoot ?? "",
            attempted.path,
            attempted.branch,
          ).catch(() => undefined);
        }
        const r = await this.#registry
          .submit({
            kind: "resolve-exit",
            id: taskId,
            exitCode: -1,
            notStarted: true,
            detail: `worktree 创建失败：${prepared.error}`,
          })
          .catch(() => undefined);
        if (r) this.#notifyTerminal(r.record);
        return;
      }
      // 建盘是 await（git worktree add 最长 30s）：回来时任务可能已被叫停/会话已拆卸。
      // 此刻 #children 里还没有句柄，SIGTERM 无处发，shutdown 也走不到它 ⇒ 必须在这里复查。
      const afterPrepare = this.#registry.get(taskId);
      if (this.#teardown || afterPrepare?.status !== "running") {
        // 刚建好的盘 best-effort 非强制回收；回收失败留给清扫。
        if (prepared.worktree) {
          await removeWorktree(
            this.#git,
            this.#repoRoot ?? "",
            prepared.worktree.path,
            prepared.worktree.branch,
          ).catch(() => undefined);
        }
        const r = await this.#registry
          .submit({
            kind: "resolve-exit",
            id: taskId,
            exitCode: -1,
            notStarted: true,
            detail: "取消发生在 worktree 检出之后",
          })
          .catch(() => undefined);
        if (r) this.#notifyTerminal(r.record);
        return;
      }
      try {
        child = this.#spawnChild(input, taskId, prepared.worktree);
      } catch (error) {
        const detail = `无法启动子进程：${error instanceof Error ? error.message : String(error)}`;
        const r = await this.#registry
          .submit({ kind: "resolve-exit", id: taskId, exitCode: -1, notStarted: true, detail })
          .catch(() => undefined);
        if (r) this.#notifyTerminal(r.record);
        return;
      }
      this.#children.set(taskId, child);
    } finally {
      this.#releaseLaunchSlot(); // 起了（或抛错）就交还名额，别占整个运行期
    }
    await this.#pump(taskId, input, child);
  }

  /** 受理时钉 base：读仓库当前的 HEAD。读不到就返回失败（引擎据此退回，不留痕）。 */
  #pinBase(): Promise<{ ok: true; headCommit: string } | { ok: false; error: string }> {
    return pinBaseCommit(this.#git, this.#repoRoot);
  }

  /**
   * 开板：确保有留痕目录、懒生成板号、写 owner.json。
   * 开不出来 ⇒ 退回（不留记录不占座位）——闸在铸 id 前。
   */
  #openBoard():
    | { ok: true; board: { boardId: string; path: string } }
    | { ok: false; error: string } {
    const boardId = (this.#boardId ??= randomUUID());
    return openBoardState(this.#storage, this.#owner, boardId);
  }

  /**
   * 启动名额内建 worktree。
   * 失败 ⇒ 返回错误（绝不降级共享 cwd、绝不 spawn）。
   * 非隔离任务 ⇒ 直接放行（没有 worktree 要建）。
   */
  #prepareWorktree(
    taskId: string,
  ): Promise<
    | { ok: true; worktree?: { path: string; branch: string; baseCommit: string } }
    | { ok: false; error: string }
  > {
    return prepareIsolationFor(this.#git, this.#repoRoot ?? "", this.#registry.get(taskId));
  }

  /** 受管 worktree 的落点（隔离任务的 cwd）。 */
  #worktreePath(taskId: string): string {
    return this.#storage!.worktreePath(taskId);
  }

  /**
   * 起孩子：隔离时把 cwd 指到 worktree；默认关不传第三参（连键都不出现）。
   */
  #spawnChild(
    input: DispatchInput,
    taskId: string,
    worktree: { path: string } | undefined,
  ): ChildHandle {
    const argv = this.#buildArgv(input, taskId);
    const env = this.#childEnv(taskId, input);
    if (!worktree) {
      return this.#spawn(argv, env);
    }
    return this.#spawn(argv, env, { cwd: worktree.path });
  }

  #buildArgv(input: DispatchInput, taskId: string): string[] {
    // 受理时解析好的档位（已按模型目录校验/降级）；没解析过就用调用给的原值。
    const resolved = this.#thinkingSuffixes.get(taskId);
    const thinkingLevel = this.#thinkingSuffixes.has(taskId)
      ? resolved
      : (input.thinkingLevel ?? undefined);
    return buildPiArgv({
      task: input.task,
      why: input.why,
      model: input.model,
      thinkingLevel,
      readOnly: input.readOnly,
      projectContext: input.projectContext,
      allowScripts: input.allowScripts,
      isolation: input.isolation,
      blackboard: input.blackboard,
      piVersion: this.#piVersion,
      piPath: this.#piPath,
      childExtensionPath: this.#childExtensionPath,
    });
  }

  /**
   * 解析思考档位（受理时做一次，钉死）。
   * 模型目录缺省是空的 ⇒ 查不到模型 ⇒ 原样透传（modelKnown: false）。
   * 返回两样：回执（给父方看）与 argv 后缀（真正发给孩子的档位）。
   */
  #resolveThinking(input: DispatchInput):
    | {
        receipt: ThinkingReceipt;
        suffix: string | undefined;
      }
    | undefined {
    if (!input.thinkingLevel) return undefined;
    const model = effectiveModel({
      model: input.model,
      sessionModel: this.#sessionModel?.(),
    });
    const catalog = this.#thinkingCatalog?.() ?? [];
    const found = findThinkingModel(catalog, model);
    const receipt = resolveThinkingLevel({ requested: input.thinkingLevel, model: found });
    // 非思考模型：不拼后缀（= off，它压根不能思考）。
    // 其余情况拼回执里的生效档位——它必在 supported 里 ⇒ pi 的 clamp 不会再改它。
    const suffix = found && !found.reasoning ? undefined : receipt.effective;
    return { receipt, suffix };
  }

  /**
   * 判预算：软门写一条收尾转向（不打断在飞工具），硬门收掉孩子。
   * 硬门触发时 status 仍是 canceled（不许装成 succeeded），部分正文照交。
   */
  async #checkBudget(
    taskId: string,
    input: DispatchInput,
    usage: ChildUsage | null,
  ): Promise<void> {
    const budget = input.usageBudget;
    if (!budget) return;
    const state = this.#budgetStates.get(taskId) ?? { hard: false };
    const decision = evaluateBudget({
      budget,
      spentUsd: usage ? usdOf(usage) : 0,
      spentTokens: usage ? totalTokens(usage) : 0,
      softAt: state.softAt,
      hard: state.hard,
      now: this.#now(),
    });
    if (decision.phase === "ok") return;
    if (decision.phase === "soft" && state.softAt === undefined) {
      state.softAt = this.#now();
      this.#budgetStates.set(taskId, state);
      // 先 arm 再 await：steer / attach 卡住或抛错时，硬门的时间兜底不能跟着失效。
      this.#armBudgetTimer(taskId, input);
      // 软门走现成的转向通道：写一条「收尾交付」指令，不打断在飞工具。
      // 没装孩子扩展 / 没留痕目录 ⇒ 写不进去 ⇒ 只记 exhausted，靠硬门兜底。
      const outcome = await this.steer(taskId, BUDGET_STEER_TEXT);
      if (!outcome.ok) this.#budgetSteerFailed.add(taskId);
      await this.#attachBudget(taskId, input, usage, state);
      return;
    }
    if (decision.phase === "hard") {
      state.hard = true;
      this.#budgetStates.set(taskId, state);
      try {
        await this.#attachBudget(taskId, input, usage, state);
      } finally {
        // 记账失败也要收掉孩子：硬门不能依赖回执写盘成功。
        await this.stop(taskId, `budget exhausted: ${decision.reason ?? "用量到点"}`);
      }
    }
  }

  /** 软门写不进去的标记（回执里明说「软门未送达」）。 */
  readonly #budgetSteerFailed = new Set<string>();

  /** 预算回执落账。 */
  async #attachBudget(
    taskId: string,
    input: DispatchInput,
    usage: ChildUsage | null,
    state: { softAt?: number; hard: boolean },
  ): Promise<void> {
    const budget = input.usageBudget;
    if (!budget) return;
    const receipt: BudgetReceipt = {
      ...(budget.maxUsd !== undefined ? { maxUsd: budget.maxUsd } : {}),
      ...(budget.maxTokens !== undefined ? { maxTokens: budget.maxTokens } : {}),
      spentUsd: usage ? usdOf(usage) : 0,
      spentTokens: usage ? totalTokens(usage) : 0,
      ...(state.softAt !== undefined ? { softAt: state.softAt } : {}),
      ...(state.softAt !== undefined || state.hard ? { exhausted: true as const } : {}),
      ...(this.#budgetSteerFailed.has(taskId) ? { softSteerFailed: true as const } : {}),
    };
    await this.#registry.submit({
      kind: "attach-budget",
      id: taskId,
      budget: receipt,
      exhausted: state.softAt !== undefined || state.hard,
    });
  }

  /**
   * 硬门的时间兜底：软门触发时 arm 一个 hardGraceMs 的定时器。
   * 孩子卡在长工具里时不会有新用量事件 ⇒ 靠这个定时器收尸。
   */
  #armBudgetTimer(taskId: string, input: DispatchInput): void {
    const budget = input.usageBudget;
    if (!budget) return;
    const grace = budget.hardGraceMs ?? DEFAULT_HARD_GRACE_MS;
    const existing = this.#budgetTimers.get(taskId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.#budgetTimers.delete(taskId);
      const state = this.#budgetStates.get(taskId);
      if (!state || state.hard) return;
      state.hard = true;
      this.#budgetStates.set(taskId, state);
      void this.stop(taskId, "budget exhausted: 软门后宽限期已过").catch(() => {});
    }, grace);
    timer.unref();
    this.#budgetTimers.set(taskId, timer);
  }

  /** 深度 + 编号：孩子知道自己 depth 与父任务 id。 */
  #childEnv(taskId: string, input: DispatchInput): NodeJS.ProcessEnv {
    const board = this.#registry.get(taskId)?.blackboard;
    return childEnvFor(
      process.env,
      taskId,
      input.blackboard === true ? board : undefined,
      this.#storage?.steerPath(taskId),
    );
  }

  /**
   * 盯住已经起好的孩子：超时 / 卡住 / 收四样 / 定终态。
   * 不返回结果：一次性宿主等的是 #awaitTerminal，最终结果由 #resultFromRecord 现算。
   */
  async #pump(taskId: string, input: DispatchInput, child: ChildHandle): Promise<void> {
    const timeoutMs =
      typeof input.timeoutMs === "number" && input.timeoutMs > 0 ? input.timeoutMs : undefined;
    const timer = timeoutMs
      ? setTimeout(() => {
          void this.stop(taskId, `timeout after ${timeoutMs}ms`);
        }, timeoutMs)
      : undefined;
    timer?.unref();

    // 停滞护栏：静默 + 无在飞工具，超过阈值收尸
    const activity = new ChildActivityTracker(this.#now);
    const stallMs = this.#stallMs > 0 ? this.#stallMs : undefined;
    const stallGuard = stallMs
      ? setInterval(
          () => {
            if (activity.isStalled(this.#now(), stallMs)) {
              void this.stop(taskId, `stalled: no activity for ${stallMs}ms`);
            }
          },
          Math.min(STALL_CHECK_INTERVAL_MS, stallMs),
        )
      : undefined;
    stallGuard?.unref();

    let text = "";
    let outputTruncated = false;
    const evidence = createSteerEvidenceTracker();
    // 运行中用量通道：边喂 stdout 边累计（口径与退出时的 parseChildStream 完全一致）。
    const usageTracker = createUsageTracker();
    let lastTurns = -1;
    child.onOutput((chunk) => {
      activity.push(chunk);
      evidence.push(chunk);
      usageTracker.push(chunk);
      text += chunk;
      if (text.length > STDOUT_KEEP_CHARS) {
        text = text.slice(-STDOUT_KEEP_CHARS); // 砍头留尾：报告/usage 在最末尾
        outputTruncated = true;
      }
      // 只在真的有新用量时判预算（同一个回合里的多个 chunk 不重复判）
      const snap = usageTracker.snapshot();
      if (snap.turns !== lastTurns) {
        lastTurns = snap.turns;
        void this.#checkBudget(taskId, input, snap.usage).catch(() => {});
      }
    });

    let stderrTail = "";
    const exitCode = await new Promise<number>((resolveExit) => {
      child.onExit((code, stderr) => {
        stderrTail = stderr;
        resolveExit(code);
      });
    });
    if (timer) clearTimeout(timer);
    // 硬门的时间兜底：孩子退出就撤掉定时器（没到点就不收尸）
    const budgetTimer = this.#budgetTimers.get(taskId);
    if (budgetTimer) clearTimeout(budgetTimer);
    this.#budgetTimers.delete(taskId);
    // 冲刷末尾的半行，让运行中用量与退出后的记账同数
    usageTracker.finish();
    const finalUsage = usageTracker.snapshot().usage;
    if (stallGuard) clearInterval(stallGuard);
    this.#steerClosed.add(taskId);
    this.#children.delete(taskId);
    // 先把已受理的转向落账，再做唯一一次终态对账：否则刚过线的 steer 会被静默丢掉。
    await this.#steerTail;

    const outputPath = this.#storage ? this.#storage.persistOutput(taskId, text) : "";
    const parsed = parseChildStream(text);
    const finalText = parsed.text || text;
    // 缓存复用观测：逐轮明细来自 parseChildStream（与记账同一口径），
    // 形状取 pi 实际给孩子声明的工具清单（观测，不是预测）+ 隔离档位 + 仓库根。
    const cacheObservation = observeCache(parsed.observedTurns, {
      tools: parsed.declaredTools,
      isolated: input.isolation === "worktree",
      ...(this.#repoRoot ? { repoRoot: this.#repoRoot } : {}),
    });
    const steerEvidence = evidence.finish();
    // 预算回执的终值：已花的钱与 token 以观测为准（孩子自报的不算数）
    if (input.usageBudget) {
      const state = this.#budgetStates.get(taskId) ?? { hard: false };
      await this.#attachBudget(taskId, input, finalUsage ?? parsed.observedUsageTotal, state);
    }

    // 转向：运行中只记了 sent；退出时按真机事件证据补终态。
    // 先于 resolve-exit 写，终态记录和一次性宿主的结果都能看到。
    const currentSteers = this.#registry.get(taskId)?.steers;
    if (currentSteers && currentSteers.length > 0) {
      const steers = reconcileSteerReceipts(currentSteers, steerEvidence, this.#now());
      const reportStale = isReportStale(steerEvidence);
      await this.#registry.submit({ kind: "attach-steer", id: taskId, steers, reportStale });
    }

    // 报告四通道：tool 优先；退 prompt；都没有 = none（明说没交）
    let report = parsed.toolReport ?? undefined;
    let channel: TaskRecord["reportChannel"];
    if (report) {
      channel = "tool";
    } else {
      const extracted = extractReportFromText(finalText);
      report = extracted.report ?? undefined;
      channel = extracted.channel;
    }
    // 自报 usage 为空/零时，用主方观察到的顶上去
    const selfUsage = report?.usage;
    const selfUsageEmpty = !selfUsage || (!selfUsage.input && !selfUsage.output && !selfUsage.cost);
    if (report && selfUsageEmpty && parsed.observedUsageTotal) {
      report = { ...report, usage: parsed.observedUsageTotal };
    }
    const unverified = deliveryUnverified(report, parsed.delivery);
    const verifyFailed = verifyUnverified(report, parsed.delivery);
    // 收据被截断**且那一维有自述** ⇒ 判词因此不给盖章。与硬旗分开：
    // 硬旗是「说了但没证据」，截断是「证据太多收不下，没法核」。
    // 口径必须与 deliverableOf 同一份（receiptGap），否则通知会说错降级原因
    // （实测：没交报告 + 收据截断 ⇒ 通知说「收据超出上限」，真因是没交报告）。
    const receiptTruncated = receiptGap(report, parsed.delivery);
    // 部分命中：一条对上不能洗白整张表，但也不到「零命中」那种硬指控
    const deliveryPartial = deliveryCoverage(report, parsed.delivery);
    const verifyPartial = verifyCoverage(report, parsed.delivery);
    // 观测 worktree：孩子跑完了，留下什么看磁盘。
    // 观测失败只记 captureError，不回改终态（终态是既成事实）。
    const base = this.#registry.get(taskId)?.worktree;
    if (base) {
      const receipt = await captureWorktreeFor(this.#git, base);
      await this.#registry.submit({ kind: "attach-worktree", id: taskId, worktree: receipt });
    }
    await this.#registry.submit({
      kind: "attach-report",
      id: taskId,
      report,
      channel,
      delivery: parsed.delivery,
      usage: parsed.observedUsageTotal ?? undefined,
      cache: cacheObservation,
      unverified,
      verifyUnverified: verifyFailed,
      receiptTruncated,
      vacuous: assessmentVacuous(report),
      deliveryPartial,
      verifyPartial,
    });
    await this.#registry.submit({
      kind: "attach-output",
      id: taskId,
      outputPath,
      truncated: outputTruncated,
    });
    // 先把正文放好再定终态——storage 订阅会在 resolve-exit 提交时同步唤醒 waiter，
    // 若那时还没放，一次性宿主会读到空正文（实测 race）。
    // 只有一次性宿主会读它；长驻模式不存，否则每个任务的正文会永久留在内存。
    if (this.#hostMode === "one-shot") this.#finalTexts.set(taskId, finalText);
    const result = await this.#registry.submit({
      kind: "resolve-exit",
      id: taskId,
      exitCode,
      detail: exitDetail(exitCode, stderrTail),
    });
    // 终态落库后才还座位（先定终态，后还座位——顺序不能反）
    this.#notifyTerminal(result.record);
    this.#evictAndPurge("runtime");
  }

  #resultFromRecord(
    taskId: string,
    input: DispatchInput,
    record: TaskRecord,
    text: string,
  ): DispatchResult {
    const startedAt = record.startedAt ?? 0;
    const finishedAt = record.finishedAt ?? 0;
    return {
      status:
        record.status === "succeeded"
          ? "succeeded"
          : record.status === "canceled"
            ? "canceled"
            : record.status === "lost"
              ? "lost"
              : "failed",
      taskId,
      text,
      // 记录里存的是子进程真实退出码；未启动/取消时没有，落 -1
      exitCode: record.exitCode ?? (record.status === "succeeded" ? 0 : -1),
      started: startedAt > 0,
      durationMs: startedAt && finishedAt ? finishedAt - startedAt : 0,
      usage: record.usage ?? record.report?.usage,
      // 缓存观测跟用量并列（键只在引擎观测到时出现）
      ...(record.cache ? { cache: record.cache } : {}),
      errorMessage:
        record.status === "succeeded" ? undefined : (record.stopReason ?? record.status),
      readOnlyTier: input.readOnly ?? "lenient",
      outputPath: record.outputPath ?? "",
      whySuppressed: record.whySuppressed,
      report: record.report,
      reportChannel: record.reportChannel ?? "none",
      delivery: record.delivery,
      deliveryUnverified: record.deliveryUnverified,
      verifyUnverified: record.verifyUnverified,
      // 判词因「收据没法对质」而降级时带出这一位——通知里只给布尔提示，
      // 父方要看原因得靠 dispatch_list，这条得跟着走到公共结果上。
      receiptTruncated: record.receiptTruncated,
      assessmentVacuous: record.assessmentVacuous,
      deliverable: record.deliverable,
      deliveryPartial: record.deliveryPartial,
      verifyPartial: record.verifyPartial,
      outputTruncated: record.outputTruncated ?? false,
      // 隔离的键只在开启时出现（默认关时 Object.keys 不变）
      ...(record.isolation ? { isolation: record.isolation } : {}),
      ...worktreeReceipt(record.worktree),
      ...(record.blackboard ? { blackboard: record.blackboard } : {}),
      ...(record.steers ? { steers: record.steers } : {}),
      ...(record.reportStale ? { reportStale: true as const } : {}),
      // 预算与档位的键只在开启/解析过时出现（默认关时 Object.keys 不变）。
      // 没跑起来（spawn 失败 / 排队被取消）就没有用量 ⇒ 不带预算回执。
      ...(record.budget && startedAt > 0 ? { budget: record.budget } : {}),
      ...(record.budgetExhausted && startedAt > 0 ? { budgetExhausted: true as const } : {}),
      ...(record.thinking ? { thinking: record.thinking } : {}),
    };
  }

  #acquireLaunchSlot(): Promise<void> {
    if (this.#starting >= this.#launchLimit) {
      return new Promise<void>((resolve) => {
        this.#launchWaiters.push(resolve);
      }).then(() => this.#acquireLaunchSlot());
    }
    this.#starting++;
    return Promise.resolve();
  }

  #releaseLaunchSlot(): void {
    this.#starting--;
    const next = this.#launchWaiters.shift();
    if (next) next();
  }

  /** 停一个任务：排队的抽掉；在跑的 SIGTERM → SIGKILL。 */
  async stop(taskId: string, reason: string): Promise<void> {
    // 不认识的编号：静静返回。给模型一个「没这条」的回答，不抛异常。
    if (!this.#registry.get(taskId)) return;
    const canceled = await this.#registry.submit({ kind: "cancel-queued", id: taskId, reason });
    if (canceled.changed) {
      this.#inputs.delete(taskId);
      this.#notifyTerminal(canceled.record);
      return;
    }
    if (canceled.record.status !== "running") return;
    await this.#registry.submit({ kind: "stop", id: taskId, reason });
    const child = this.#children.get(taskId);
    if (!child) return;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (this.#children.has(taskId)) child.kill("SIGKILL");
    }, DEFAULT_STOP_GRACE_MS).unref();
  }

  /** 只读访问 registry（适配层查列表用） */
  get registry(): TaskRegistry {
    return this.#registry;
  }

  /** 恢复时被结构闸挡下的记录条数（坏 JSON / 形状不对 / 文件名与 id 对不上）。 */
  get skippedRecords(): number {
    return this.#storage?.skippedRecords ?? 0;
  }

  isEnding(): boolean {
    return this.#ending;
  }

  readOutput(taskId: string): Promise<string | undefined> {
    return Promise.resolve(
      this.#storage?.readOutput(taskId) ?? this.#storage?.readArchivedOutput(taskId),
    );
  }

  readArchivedRecord(taskId: string) {
    return this.#storage?.readArchivedRecord(taskId);
  }

  // 落盘（写穿）+ 重启恢复（装载 → owner 已死者标 lost）
  async #restore(): Promise<void> {
    const storage = this.#storage!;
    for (const record of storage.restoreRecords()) {
      await this.#registry.submit({ kind: "spawn", record }).catch(() => undefined);
    }
    this.#registry.subscribe((record, prev) => {
      storage.persistRecord(record);
      // 只在终态变迁时唤醒一次性宿主的 waiter
      if (prev?.status !== record.status && isTerminal(record.status)) {
        this.#notifyTerminal(record);
      }
    });
    for (const record of this.#registry.list()) {
      if (isTerminal(record.status)) continue;
      // owner 还活着且启动时刻对得上 → 是别的会话的在飞任务，不装载（避免「假停」）
      if (record.ownerPid !== undefined && isPidAlive(record.ownerPid)) {
        const ownerStart = processStartMs(record.ownerPid);
        if (ownerStart !== undefined && ownerStart === record.ownerStartMs) continue;
      }
      // owner 已死（或无主）：上次会话没来得及收，标 lost
      await this.#registry
        .submit({ kind: "reconcile-lost", id: record.id, reason: "lost_on_session_restart" })
        .catch(() => undefined);
    }
    // 启动即剪历史债务（boot 模式 = 直接删除）+ 归档 TTL 清理
    this.#evictAndPurge("boot");
    storage.purgeExpiredArchive(this.#archiveTtlDays);
    // 清扫受管 worktree：有账本（热记录或归档）⇒ 保护；无账本且过期 ⇒ 非强制地清
    await this.#sweepWorktrees();
    // 清扫黑板：活跃板整板跳过；非活跃板的笔记按 TTL 清
    this.#sweepBlackboards();
  }

  /**
   * 清扫黑板。
   * 规则：活跃板（有人在用）⇒ 整板跳过；非活跃板 ⇒ 笔记按 mtime 过 TTL 就清，
   * 清空了的板把目录删掉。
   */
  #sweepBlackboards(): void {
    const storage = this.#storage;
    if (!storage) return;
    const store = new BlackboardStore({
      root: storage.blackboardsDir,
      boardId: this.#boardId ?? "",
    });
    try {
      store.purgeExpired({
        ttlMs: this.#archiveTtlDays * 86_400_000,
        isActive: (boardId) => this.#boardActive(store, boardId),
        // 判死才清：读不到启动时刻 / pid 还活着但证不死 ⇒ 不动（purge 自己还会再查 owner 可读）
        isOwnerDead: (owner) => ownerProvenDead(owner),
      });
    } catch {
      // 清扫失败不拖垮启动——下轮再收
    }
  }

  /**
   * 这块板还活着吗？
   * 两条判据：① 有非终态的记录还引用它（有人在跑）；② 它的 owner 还活着（pid + 启动时刻两个都对）且板没关。
   */
  #boardActive(store: BlackboardStore, boardId: string): boolean {
    return boardIsActive(this.#registry.list(), store, boardId);
  }

  /**
   * 清扫受管 worktree。
   * 规则：有账本 ⇒ 保护（不看 mtime）；无账本且 mtime 过了 TTL ⇒ 非强制地清
   * （worktree remove → branch -d；脏的、未合并的 git 自己会拒 ⇒ 留下）。
   */
  async #sweepWorktrees(): Promise<void> {
    const storage = this.#storage;
    if (!storage || !this.#repoRoot) return;
    await sweepWorktrees({
      git: this.#git,
      repoRoot: this.#repoRoot,
      worktreesDir: storage.worktreesDir,
      ttlMs: this.#archiveTtlDays * 86_400_000,
      hasLedger: (id) => this.#registry.get(id) !== undefined || storage.hasArchivedRecord(id),
    }).catch(() => undefined);
  }

  #evictAndPurge(mode: "runtime" | "boot"): void {
    // 挤掉时把记录本体带出来——回查会拿到 undefined（已从内存删掉）
    const evicted = this.#registry.evictTerminal(this.#terminalKeep);
    if (!this.#storage || evicted.length === 0) return;
    if (mode === "boot") {
      for (const record of evicted) this.#storage.removeTrace(record.id);
      return;
    }
    for (const record of evicted) {
      // 异步归档：setImmediate 让事件循环转一圈，主线不等
      setImmediate(() => this.#storage!.archiveOne(record));
    }
  }

  /** 会话结束：拒新、取消排队、SIGTERM 在跑的孩子。 */
  async shutdown(): Promise<void> {
    this.#ending = true;
    this.#teardown = true;
    if (this.#wakeTimer) clearTimeout(this.#wakeTimer);
    for (const record of this.#registry.list()) {
      if (record.status !== "queued") continue;
      const canceled = await this.#registry.submit({
        kind: "cancel-queued",
        id: record.id,
        reason: "session shutdown",
      });
      this.#inputs.delete(record.id);
      // 用提交后的记录：`record` 是取消前的快照（还是 queued），等待者会读错状态
      this.#notifyTerminal(canceled.record);
    }
    for (const [taskId, child] of this.#children) {
      if (this.#registry.get(taskId)?.status !== "running") continue;
      await this.#registry.submit({ kind: "stop", id: taskId, reason: "session ended" });
      child.kill("SIGTERM");
    }
    // 收尾：给当前板补 closedAt（原子写）——不删任何笔记，证据留着
    this.#closeBoard();
  }

  /** 关板：给 owner.json 补 closedAt。没开过板 ⇒ 没得关。 */
  #closeBoard(): void {
    const storage = this.#storage;
    const boardId = this.#boardId;
    if (!storage || !boardId) return;
    try {
      new BlackboardStore({ root: storage.blackboardsDir, boardId }).close(this.#now());
    } catch {
      // 关板失败不阻塞收尾
    }
  }

  /**
   * 父方读黑板（只读）。
   * 缺省读当前板；给了别的编号 ⇒ 本会话没有那块板（v1 不存在跨会话板）。
   */
  blackboardView(
    options: { boardId?: string; after?: string; limit?: number } = {},
  ): BlackboardRead | { error: string } {
    const current = this.#boardId;
    if (options.boardId !== undefined && options.boardId !== current) {
      return { error: "本会话没有该黑板" };
    }
    if (!current) return { error: "本会话还没有黑板" };
    const storage = this.#storage;
    if (!storage) return { error: "本会话还没有黑板" };
    try {
      return new BlackboardStore({ root: storage.blackboardsDir, boardId: current }).read({
        after: options.after,
        limit: options.limit,
      });
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
}

/** 非零退出的死因摘要：errorMessage 第一行给模型和调用方读——退出码 + stderr 末行（provider 401、段错误都写在 stderr 里）。 */
function exitDetail(exitCode: number, stderrTail: string): string | undefined {
  if (exitCode === 0) return undefined;
  const lastLine = (stderrTail.trim().split("\n").pop() ?? "").trim();
  const clipped = lastLine.length > 200 ? `…${lastLine.slice(-200)}` : lastLine;
  if (exitCode === -1) return clipped || "exit code -1（信号不明或起不来）";
  return clipped ? `exit code ${exitCode} — ${clipped}` : `exit code ${exitCode}`;
}
