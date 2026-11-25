import { deliverableOf } from "./child.ts";
import {
  isTerminal,
  type ClaimCoverage,
  type SteerState,
  type TaskRecord,
  type TaskStatus,
  type WorktreeInfo,
} from "./types.ts";

// 状态机：queued 入队即存在；终态没有出边。
// 往终态上写的迟到消息静默丢弃——竞态下这是常事，不报错。

/** 收据只能前进：迟到的 sent 不许把 seen 降回去。 */
const STEER_ORDER: Readonly<Record<SteerState, number>> = {
  sent: 0,
  undelivered: 1,
  queued: 2,
  delivered: 3,
  seen: 4,
};

const ALLOWED_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ["running", "canceled", "lost"],
  running: ["stopping", "succeeded", "failed", "lost"],
  stopping: ["succeeded", "canceled", "failed", "lost"],
  succeeded: [],
  failed: [],
  canceled: [],
  lost: [],
};

export type TaskCommand =
  | { kind: "spawn"; record: TaskRecord }
  | { kind: "transition"; id: string; to: TaskStatus }
  | { kind: "stop"; id: string; reason: string }
  | { kind: "cancel-queued"; id: string; reason: string }
  | { kind: "resolve-exit"; id: string; exitCode: number; detail?: string; notStarted?: boolean }
  | { kind: "reconcile-lost"; id: string; reason: string }
  | {
      kind: "attach-worktree";
      id: string;
      worktree: WorktreeInfo;
    }
  | {
      kind: "attach-report";
      id: string;
      report: TaskRecord["report"];
      channel: TaskRecord["reportChannel"];
      delivery?: TaskRecord["delivery"];
      /** 引擎观测到的真实用量（与报告独立：孩子没交报告，账也要有） */
      usage?: TaskRecord["usage"];
      /** 引擎算的缓存复用观测（与报告独立：孩子没交报告，观测也要有） */
      cache?: TaskRecord["cache"];
      /** 自述对不上收据（没有实测支撑） */
      unverified?: boolean;
      /** 谎报自检（声称的命令一条都没观测到） */
      verifyUnverified?: boolean;
      /** assessment 空转（小窗资格粗筛） */
      vacuous?: boolean;
      /** 改动自述只对上一部分（0 < matched < claimed） */
      deliveryPartial?: ClaimCoverage;
      /** 自检自述只对上一部分 */
      verifyPartial?: ClaimCoverage;
    }
  | {
      kind: "attach-steer";
      id: string;
      steers: NonNullable<TaskRecord["steers"]>;
      reportStale?: boolean;
    }
  | { kind: "attach-output"; id: string; outputPath: string; truncated?: boolean }
  | {
      kind: "attach-budget";
      id: string;
      budget: NonNullable<TaskRecord["budget"]>;
      exhausted?: boolean;
    };

export interface CommandResult {
  record: TaskRecord;
  /** null = 无写入（spawn 插入）；非 null 但 changed=false = 判定拒绝写入（竞态常态） */
  fromStatus: TaskStatus | null;
  changed: boolean;
}

type AttachWorktreeCommand = Extract<TaskCommand, { kind: "attach-worktree" }>;
type AttachSteerCommand = Extract<TaskCommand, { kind: "attach-steer" }>;
type ResolveExitCommand = Extract<TaskCommand, { kind: "resolve-exit" }>;
type AttachBudgetCommand = Extract<TaskCommand, { kind: "attach-budget" }>;

/**
 * worktree 回执：磁盘观测事实，不是生命周期——全状态可写（含终态），永不改 status。
 * 终态上的迟到写入是崩溃恢复对账，无害。
 * 返回新记录（记录不可变），changed 恒真（每次都换一个对象）。
 */
export function applyAttachWorktree(
  current: TaskRecord,
  command: AttachWorktreeCommand,
): CommandResult {
  const next: TaskRecord = { ...current, worktree: command.worktree };
  return { record: next, fromStatus: current.status, changed: true };
}

/**
 * 预算回执：全状态可写（含终态），永不改 status——它是观测事实，不是生命周期。
 * 终态上的迟到写入是崩溃恢复对账，无害。
 */
export function applyAttachBudget(
  current: TaskRecord,
  command: AttachBudgetCommand,
): CommandResult {
  const next: TaskRecord = {
    ...current,
    budget: command.budget,
    ...(command.exhausted ? { budgetExhausted: true as const } : {}),
  };
  return { record: next, fromStatus: current.status, changed: true };
}

/** 成功终态才带判词：退出码 0 也要说清交付有没有实测支撑，两件事分开记。 */
function deliverablePatch(current: TaskRecord, to: TaskStatus): Partial<TaskRecord> {
  return to === "succeeded" ? { deliverable: deliverableOf(current) } : {};
}

/**
 * resolve-exit 的判定：
 *   stopping（建盘/等启动名额期间被叫停）⇒ canceled（notStarted 清 startedAt）；
 *   running ⇒ succeeded / failed（notStarted 清 startedAt；非零退出的死因进 stopReason）；
 *   终态 ⇒ undefined（迟到消息静默丢弃）。
 * 只算「去哪 + 补什么」，真正的写入仍由 #move 在写锁内做。
 */
export function applyResolveExit(
  current: TaskRecord,
  command: ResolveExitCommand,
): { to: TaskStatus; patch: Partial<TaskRecord> } | undefined {
  if (current.status === "stopping") {
    const to: TaskStatus = command.exitCode === 0 ? "succeeded" : "canceled";
    return {
      // 孩子已经成功退出（退出码 0）时 stop 来晚了：记 succeeded，不是 canceled
      to,
      patch: {
        ...deliverablePatch(current, to),
        ...(command.notStarted ? { startedAt: undefined } : {}),
        // 叫停过也要记真实退出码：孩子确实以 143 退出的，账上不该回落 -1
        exitCode: command.exitCode,
        // 死因只在没有别的理由时补：stop 命令已经写过 stopReason（用户为什么叫停），别覆盖它
        ...(command.exitCode !== 0 && command.detail && !current.stopReason
          ? { stopReason: command.detail }
          : {}),
      },
    };
  }
  if (current.status === "running") {
    return {
      to: command.exitCode === 0 ? "succeeded" : "failed",
      patch: {
        // 判词跟同一条退出码判据走：只有 succeeded 才带（别的终态没有「交付」可言）
        ...deliverablePatch(current, command.exitCode === 0 ? "succeeded" : "failed"),
        // 孩子压根没起（建 worktree 失败 / 等名额被叫停）：startedAt 要清——
        // 记录里 startedAt 有值必须恒等于「孩子真起过」。
        ...(command.notStarted ? { startedAt: undefined } : {}),
        exitCode: command.exitCode,
        // 孩子自己非零退出：死因进 stopReason——errorMessage 第一行才可读（模型和调用方最先读它）
        ...(command.exitCode !== 0 && command.detail ? { stopReason: command.detail } : {}),
      },
    };
  }
  return undefined;
}

/**
 * 终态淘汰的排序比较器：先按结束时刻（缺失当 0），同刻按编号字典序。
 * 抽成具名函数是为了能直接钉住「同刻时编号大的一方排在后面」——
 * 只经 Array.sort 观察时，返回 0 与 1 在互异 id 上会得到同一个序，变异杀不掉。
 */
export function compareTerminal(a: TaskRecord, b: TaskRecord): number {
  const at = a.finishedAt ?? 0;
  const bt = b.finishedAt ?? 0;
  if (at !== bt) return at - bt;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * 转向收据：按 seq upsert，保留第一次写入的正文与时刻，只补 state 与时间。
 * 终态上的迟到写入静默丢弃（与报告/产出同一姿态）。
 */
export function applyAttachSteer(current: TaskRecord, command: AttachSteerCommand): CommandResult {
  if (isTerminal(current.status))
    return { record: current, fromStatus: current.status, changed: false };
  const bySeq = new Map((current.steers ?? []).map((steer) => [steer.seq, steer]));
  for (const steer of command.steers) {
    const previous = bySeq.get(steer.seq);
    const state =
      previous && STEER_ORDER[previous.state] > STEER_ORDER[steer.state]
        ? previous.state
        : steer.state;
    bySeq.set(
      steer.seq,
      previous ? { ...previous, ...steer, state, text: previous.text, at: previous.at } : steer,
    );
  }
  const next: TaskRecord = {
    ...current,
    steers: [...bySeq.values()].sort((a, b) => a.seq - b.seq),
    ...(command.reportStale ? { reportStale: true as const } : {}),
  };
  return { record: next, fromStatus: current.status, changed: true };
}

/** 记录的唯一合法写入者。判定在写锁内做，命令不点名目标终态。 */
export class TaskRegistry {
  readonly #records = new Map<string, TaskRecord>();
  #writeTail: Promise<unknown> = Promise.resolve();
  readonly #listeners: Array<(next: TaskRecord, prev: TaskRecord | null) => void>;

  constructor(listener?: (next: TaskRecord, prev: TaskRecord | null) => void) {
    this.#listeners = listener ? [listener] : [];
  }

  subscribe(listener: (next: TaskRecord, prev: TaskRecord | null) => void): void {
    this.#listeners.push(listener);
  }

  #emit(next: TaskRecord, prev: TaskRecord | null): void {
    for (const listener of this.#listeners) listener(next, prev);
  }

  get(id: string): TaskRecord | undefined {
    return this.#records.get(id);
  }

  list(): TaskRecord[] {
    return [...this.#records.values()];
  }

  /**
   * 终态痕迹容量边界：按 (finishedAt, taskId) 最老先出挤掉，返回被挤掉的记录。
   * 返回对象而不是编号——调用方要拿它去归档，回查时记录已经从内存删掉了。
   * 只挤终态——还在「在等」「在跑」「要停」的是活账，永不挤。
   */
  evictTerminal(keep: number): TaskRecord[] {
    const terminal: TaskRecord[] = [];
    for (const record of this.#records.values()) {
      if (isTerminal(record.status)) terminal.push(record);
    }
    // 排序键：结束时刻（缺失当 0）+ 编号。写成显式比较而不是三元嵌套——
    // 同值时靠编号定序，缺失一律当 0，不引入「缺失比 0 新」的语义。
    terminal.sort(compareTerminal);
    const evicted = terminal.slice(0, Math.max(0, terminal.length - keep));
    for (const record of evicted) this.#records.delete(record.id);
    return evicted;
  }

  submit(command: TaskCommand): Promise<CommandResult> {
    const result: Promise<CommandResult> = this.#writeTail.then(() => this.#apply(command));
    this.#writeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #apply(command: TaskCommand): CommandResult {
    switch (command.kind) {
      case "spawn": {
        if (this.#records.has(command.record.id))
          throw new Error(`duplicate task id ${command.record.id}`);
        this.#records.set(command.record.id, command.record);
        this.#emit(command.record, null);
        return { record: command.record, fromStatus: null, changed: true };
      }
      case "transition":
        return this.#move(command.id, command.to, {});
      case "stop":
        return this.#move(command.id, "stopping", { stopReason: command.reason });
      case "cancel-queued": {
        // 写入器读当前状态——还是 queued 才 canceled，不是则原样返回、不写、不报错
        const current = this.#require(command.id);
        if (current.status !== "queued")
          return { record: current, fromStatus: current.status, changed: false };
        return this.#move(command.id, "canceled", { stopReason: command.reason });
      }
      case "resolve-exit": {
        const current = this.#require(command.id);
        const next = applyResolveExit(current, command);
        if (!next) return { record: current, fromStatus: current.status, changed: false };
        return this.#move(command.id, next.to, next.patch);
      }
      case "reconcile-lost":
        return this.#move(command.id, "lost", { stopReason: command.reason });
      case "attach-report": {
        // 报告随记录存活；终态上的迟到报告静默丢弃（竞态常态）
        const current = this.#require(command.id);
        if (isTerminal(current.status))
          return { record: current, fromStatus: current.status, changed: false };
        const next: TaskRecord = {
          ...current,
          report: command.report,
          reportChannel: command.channel,
          delivery: command.delivery ?? current.delivery,
          usage: command.usage ?? current.usage,
          cache: command.cache ?? current.cache,
          ...(command.unverified ? { deliveryUnverified: true } : {}),
          ...(command.verifyUnverified ? { verifyUnverified: true } : {}),
          ...(command.vacuous ? { assessmentVacuous: true } : {}),
          ...(command.deliveryPartial ? { deliveryPartial: command.deliveryPartial } : {}),
          ...(command.verifyPartial ? { verifyPartial: command.verifyPartial } : {}),
        };
        this.#records.set(command.id, next);
        this.#emit(next, current);
        return { record: next, fromStatus: current.status, changed: true };
      }
      case "attach-worktree": {
        const current = this.#require(command.id);
        const next = applyAttachWorktree(current, command);
        this.#records.set(command.id, next.record);
        this.#emit(next.record, current);
        return next;
      }
      case "attach-budget": {
        const current = this.#require(command.id);
        const next = applyAttachBudget(current, command);
        this.#records.set(command.id, next.record);
        this.#emit(next.record, current);
        return next;
      }
      case "attach-steer": {
        const current = this.#require(command.id);
        const next = applyAttachSteer(current, command);
        if (next.changed) {
          this.#records.set(command.id, next.record);
          this.#emit(next.record, current);
        }
        return next;
      }
      case "attach-output": {
        // 产出路径挂记录：任务链的「产出」锚点；终态上的迟到写入静默丢弃
        const current = this.#require(command.id);
        if (isTerminal(current.status))
          return { record: current, fromStatus: current.status, changed: false };
        const next: TaskRecord = {
          ...current,
          outputPath: command.outputPath,
          outputTruncated: command.truncated ?? false,
        };
        this.#records.set(command.id, next);
        this.#emit(next, current);
        return { record: next, fromStatus: current.status, changed: true };
      }
    }
  }

  #require(id: string): TaskRecord {
    const record = this.#records.get(id);
    if (!record) throw new Error(`unknown task id ${id}`);
    return record;
  }

  #move(id: string, to: TaskStatus, patch: Partial<TaskRecord>): CommandResult {
    const current = this.#require(id);
    if (isTerminal(current.status))
      return { record: current, fromStatus: current.status, changed: false };
    if (!ALLOWED_TRANSITIONS[current.status].includes(to)) {
      throw new Error(`illegal transition ${current.status} → ${to}`);
    }
    const next: TaskRecord = {
      ...current,
      ...patch,
      status: to,
      // 出队转 running 的那一刻盖 startedAt，durationMs 量孩子跑起来之后的时间。
      // patch 显式给了 startedAt（notStarted ⇒ undefined）就照 patch 走：
      // 孩子压根没起，记录里不能留起始时刻。
      startedAt:
        "startedAt" in patch ? patch.startedAt : to === "running" ? Date.now() : current.startedAt,
      finishedAt: isTerminal(to) ? Date.now() : current.finishedAt,
    };
    this.#records.set(id, next);
    this.#emit(next, current);
    return { record: next, fromStatus: current.status, changed: true };
  }
}
