import { isTerminal, type TaskRecord, type TaskStatus } from "./types.ts";

// 状态机：queued 入队即存在；终态没有出边。
// 往终态上写的迟到消息静默丢弃——竞态下这是常事，不报错。

const ALLOWED_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ["running", "canceled", "lost"],
  running: ["stopping", "succeeded", "failed", "lost"],
  stopping: ["canceled", "failed", "lost"],
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
  | { kind: "resolve-exit"; id: string; exitCode: number }
  | { kind: "reconcile-lost"; id: string; reason: string }
  | {
      kind: "attach-report";
      id: string;
      report: TaskRecord["report"];
      channel: TaskRecord["reportChannel"];
      delivery?: TaskRecord["delivery"];
      /** 引擎观测到的真实用量（与报告独立：孩子没交报告，账也要有） */
      usage?: TaskRecord["usage"];
      /** 自述对不上收据（没有实测支撑） */
      unverified?: boolean;
    }
  | { kind: "attach-output"; id: string; outputPath: string; truncated?: boolean };

export interface CommandResult {
  record: TaskRecord;
  /** null = 无写入（spawn 插入）；非 null 但 changed=false = 判定拒绝写入（竞态常态） */
  fromStatus: TaskStatus | null;
  changed: boolean;
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
    // 注：这块有 5 个变异点在本仓不可达（见 test/core-logic.test.ts 顶部说明），
    // 它们只在「两条记录 id 相同」时才有区别，而 registry 拒绝重复 id。
    terminal.sort((a, b) => {
      const at = a.finishedAt ?? 0;
      const bt = b.finishedAt ?? 0;
      if (at !== bt) return at - bt;
      if (a.id === b.id) return 0;
      return a.id < b.id ? -1 : 1;
    });
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
        if (current.status === "stopping") return this.#move(command.id, "canceled", {});
        if (current.status === "running") {
          return this.#move(command.id, command.exitCode === 0 ? "succeeded" : "failed", {
            exitCode: command.exitCode,
          });
        }
        return { record: current, fromStatus: current.status, changed: false };
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
          ...(command.unverified ? { deliveryUnverified: true } : {}),
        };
        this.#records.set(command.id, next);
        this.#emit(next, current);
        return { record: next, fromStatus: current.status, changed: true };
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
      // 出队转 running 的那一刻盖 startedAt，durationMs 量孩子跑起来之后的时间
      startedAt: to === "running" ? Date.now() : current.startedAt,
      finishedAt: isTerminal(to) ? Date.now() : current.finishedAt,
    };
    this.#records.set(id, next);
    this.#emit(next, current);
    return { record: next, fromStatus: current.status, changed: true };
  }
}
