import { randomUUID } from "node:crypto";
import { ChildActivityTracker, DEFAULT_STALL_MS, STALL_CHECK_INTERVAL_MS } from "./activity.ts";
import {
  assessmentVacuous,
  buildPiArgv,
  deliveryUnverified,
  parseChildStream,
  extractReportFromText,
  spawnChild,
  STDOUT_KEEP_CHARS,
  verifyUnverified,
  type ChildHandle,
  type SpawnChild,
} from "./child.ts";
import { defaultGates, type Gate, rejection } from "./gates.ts";
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
import {
  branchNameFor,
  createWorktree,
  execFileGit,
  observeWorktree,
  resolveHead,
  sweepWorktrees,
  type GitRunner,
} from "./worktree.ts";
import type { TaskRegistry } from "./registry.ts";
import type {
  DispatchInput,
  DispatchOutcome,
  DispatchResult,
  HostMode,
  TaskRecord,
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
  /** 追加的安检（默认 6 道之外） */
  gates?: Gate[];
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
  /** 派发开关。谓词不是值。 */
  dispatchEnabled?: () => boolean;
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
  /** 机器规格（总内存 + 核数）：恒定，启动时读一次 */
  readonly #spec: MachineSpec;
  /** 座位上限（启动时算，此后不变） */
  readonly #seatCap: number;
  #wakeTimer?: NodeJS.Timeout;
  #ending = false;
  #teardown = false;

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
      ...(deps.gates ??
        defaultGates({
          isEnabled: deps.dispatchEnabled ?? (() => true),
          isEnding: () => this.#ending,
          depth: () => Number(process.env.PI_DISPATCH_DEPTH ?? 0),
          maxDepth: this.#maxDepth,
          // 没注入就当不是 git 仓 ⇒ 不许开隔离（缺省配置不许做没把握的事）
          isGitRepo: deps.isGitRepo ?? (() => false),
        })),
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
    const input: DispatchInput = {
      ...rawInput,
      why: whyEnabled ? rawInput.why : undefined,
      allowScripts: rawInput.allowScripts ?? this.#allowScriptsDefault(),
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
    const taskId = randomUUID();
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

  async #runToTerminal(taskId: string, input: DispatchInput): Promise<DispatchResult> {
    try {
      return await this.#executeRun(taskId, input);
    } catch {
      // 泵内异常（spawn 同步抛、磁盘写失败…）不许升级成宿主未处理拒绝
      const r = await this.#registry
        .submit({ kind: "resolve-exit", id: taskId, exitCode: -1 })
        .catch(() => undefined);
      if (r) this.#notifyTerminal(r.record);
      return this.#notStartedResult(taskId, input, "任务内部错误（见日志）", "failed");
    }
  }

  async #executeRun(taskId: string, input: DispatchInput): Promise<DispatchResult> {
    const entered = await this.#registry.submit({ kind: "transition", id: taskId, to: "running" });
    if (!entered.changed) {
      // 等座期间记录已被取消——不 spawn
      return this.#notStartedResult(taskId, input, "任务在启动前已取消", "canceled");
    }
    if (this.#teardown) {
      const r = await this.#registry
        .submit({ kind: "resolve-exit", id: taskId, exitCode: -1 })
        .catch(() => undefined);
      if (r) this.#notifyTerminal(r.record);
      return this.#notStartedResult(taskId, input, "会话拆卸发生在启动前", "failed");
    }
    // CPU 启动节流：名额只护「启动」这一段，不起子进程就还回去（不占座）
    await this.#acquireLaunchSlot();
    let child: ChildHandle;
    try {
      const beforeSpawn = this.#registry.get(taskId);
      if (!beforeSpawn || beforeSpawn.status !== "running") {
        this.#releaseLaunchSlot();
        return this.#notStartedResult(taskId, input, "等启动名额时被叫停", "canceled");
      }
      // 启动名额内建 worktree：建不出来 ⇒ 失败。
      // 绝不降级共享 cwd、绝不 spawn（孩子在共享目录里干活比失败更糟）。
      const prepared = await this.#prepareWorktree(taskId, input);
      if (!prepared.ok) {
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
        return this.#notStartedResult(
          taskId,
          input,
          `worktree 创建失败：${prepared.error}`,
          "failed",
        );
      }
      child = this.#spawnChild(input, taskId, prepared.worktree);
      this.#children.set(taskId, child);
    } finally {
      this.#releaseLaunchSlot(); // 起了（或抛错）就交还名额，别占整个运行期
    }
    return this.#pump(taskId, input, child);
  }

  /** 受理时钉 base：读仓库当前的 HEAD。读不到就返回失败（引擎据此退回，不留痕）。 */
  async #pinBase(): Promise<{ ok: true; headCommit: string } | { ok: false; error: string }> {
    if (!this.#repoRoot) return { ok: false, error: "不知道 git 仓库根（repoRoot 未注入）" };
    try {
      const headCommit = await resolveHead(this.#git, this.#repoRoot);
      return { ok: true, headCommit };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * 启动名额内建 worktree。
   * 失败 ⇒ 返回错误（绝不降级共享 cwd、绝不 spawn）。
   * 非隔离任务 ⇒ 直接放行（没有 worktree 要建）。
   */
  async #prepareWorktree(
    taskId: string,
    input: DispatchInput,
  ): Promise<
    | { ok: true; worktree?: { path: string; branch: string; baseCommit: string } }
    | { ok: false; error: string }
  > {
    if (input.isolation !== "worktree") return { ok: true };
    const base = this.#registry.get(taskId)?.worktree;
    if (!base) return { ok: false, error: "记录里没有 worktree 基线" };
    const created = await createWorktree(this.#git, {
      repoRoot: this.#repoRoot ?? "",
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
    const argv = this.#buildArgv(input);
    const env = this.#childEnv(taskId);
    if (!worktree) {
      return this.#spawn(argv, env);
    }
    return this.#spawn(argv, env, { cwd: worktree.path });
  }

  #buildArgv(input: DispatchInput): string[] {
    return buildPiArgv({
      task: input.task,
      why: input.why,
      model: input.model,
      thinkingLevel: input.thinkingLevel,
      readOnly: input.readOnly,
      projectContext: input.projectContext,
      allowScripts: input.allowScripts,
      isolation: input.isolation,
      sessionModel: this.#sessionModel?.(),
      piVersion: this.#piVersion,
      piPath: this.#piPath,
      childExtensionPath: this.#childExtensionPath,
    });
  }

  /** 深度 + 编号：孩子知道自己 depth 与父任务 id。 */
  #childEnv(taskId: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      PI_DISPATCH_DEPTH: String(Number(process.env.PI_DISPATCH_DEPTH ?? 0) + 1),
      PI_DISPATCH_TASK_ID: taskId,
    };
  }

  /** 盯住已经起好的孩子：超时 / 卡住 / 收四样 / 定终态。 */
  async #pump(taskId: string, input: DispatchInput, child: ChildHandle): Promise<DispatchResult> {
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
    child.onOutput((chunk) => {
      activity.push(chunk);
      text += chunk;
      if (text.length > STDOUT_KEEP_CHARS) {
        text = text.slice(-STDOUT_KEEP_CHARS); // 砍头留尾：报告/usage 在最末尾
        outputTruncated = true;
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
    if (stallGuard) clearInterval(stallGuard);
    this.#children.delete(taskId);

    const outputPath = this.#storage ? this.#storage.persistOutput(taskId, text) : "";
    const parsed = parseChildStream(text);
    const finalText = parsed.text || text;

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
    // 观测 worktree：孩子跑完了，留下什么看磁盘。
    // 观测失败只记 captureError，不回改终态（终态是既成事实）。
    const base = this.#registry.get(taskId)?.worktree;
    if (base) {
      const probe = await observeWorktree(this.#git, {
        path: base.path,
        branch: base.branch,
        baseCommit: base.baseCommit,
      });
      const receipt: WorktreeInfo = {
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
      await this.#registry.submit({ kind: "attach-worktree", id: taskId, worktree: receipt });
    }
    await this.#registry.submit({
      kind: "attach-report",
      id: taskId,
      report,
      channel,
      delivery: parsed.delivery,
      usage: parsed.observedUsageTotal ?? undefined,
      unverified,
      verifyUnverified: verifyFailed,
      vacuous: assessmentVacuous(report),
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

    return this.#resultFromRecord(taskId, input, result.record, finalText);
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
      assessmentVacuous: record.assessmentVacuous,
      outputTruncated: record.outputTruncated ?? false,
      // 隔离的键只在开启时出现（默认关时 Object.keys 不变）
      ...(record.isolation ? { isolation: record.isolation } : {}),
      ...(record.worktree ? { worktree: record.worktree } : {}),
    };
  }

  #notStartedResult(
    taskId: string,
    input: DispatchInput,
    errorMessage: string,
    status: "canceled" | "failed",
  ): DispatchResult {
    const record = this.#registry.get(taskId);
    return {
      status,
      taskId,
      text: "",
      exitCode: -1,
      started: false,
      durationMs: 0,
      errorMessage,
      readOnlyTier: input.readOnly ?? "lenient",
      outputPath: "",
      whySuppressed: input.why ? !this.#whyEnabled() : undefined,
      reportChannel: "none",
      outputTruncated: false,
      // 隔离的键只在开启时出现（默认关时 Object.keys 不变）
      ...(input.isolation ? { isolation: input.isolation } : {}),
      ...(record?.worktree ? { worktree: record.worktree } : {}),
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
