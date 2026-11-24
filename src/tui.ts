// pi TUI 常驻面：在飞/排队状态给人看。模型面终态通知仍走 turn 边界的 sendMessage（src/index.ts deliver），不动这里。
// 只在 ctx.mode === "tui" 时挂载；core 不 import 这里。

import type { TaskRegistry } from "./core/registry.ts";
import { processStartMs } from "./core/storage.ts";
import type { SteerOutcome, TaskRecord, TaskStatus } from "./core/types.ts";

export const TUI_WIDGET_KEY = "pi-dispatch";
export const TUI_STATUS_KEY = "pi-dispatch";

/** 宿主 InteractiveMode.MAX_WIDGET_LINES = 10；超了宿主只给一行截断提示，行数预算自己守。 */
const WIDGET_MAX_LINES = 10;
/** 任务行里描述的上限：CJK 全宽会折行，给终端窄窗口留余量。 */
const SNIPPET_MAX_CHARS = 36;

/** 主方戳：引擎派发时盖 ownerPid=process.pid + ownerStartMs=processStartMs(pid)。 */
export interface TuiOwner {
  pid: number;
  startMs: number;
}

/**
 * 本会话记录 = 主方戳两个都对（与引擎 restore 判活同口径）。
 * restore 装回的历史记录、同项目别家进程的记录，全部排除——不污染面板计数。
 */
export function isSessionRecord(record: TaskRecord, owner: TuiOwner): boolean {
  return record.ownerPid === owner.pid && record.ownerStartMs === owner.startMs;
}

const ACTIVE_TEXT: Readonly<Record<string, string>> = {
  running: "在飞",
  stopping: "收队",
  queued: "排队",
};

function count(records: readonly TaskRecord[], status: TaskStatus): number {
  return records.reduce((n, r) => (r.status === status ? n + 1 : n), 0);
}

function snippet(task: string): string {
  const first = task.split("\n", 1)[0]?.trim() ?? "";
  return first.length > SNIPPET_MAX_CHARS ? `${first.slice(0, SNIPPET_MAX_CHARS)}…` : first;
}

/**
 * 行内成本提示：预算到点 / 档位降级。
 * 没有就不占位——面板行宽有限，提示只在真发生时出现。
 */
function costHint(record: TaskRecord): string {
  const hints: string[] = [];
  if (record.budgetExhausted) hints.push("预算到点");
  if (record.thinking?.adjusted && record.thinking.requested && record.thinking.effective)
    hints.push(`档位 ${record.thinking.requested}→${record.thinking.effective}`);
  return hints.length > 0 ? `｜${hints.join("｜")}` : "";
}

/** 汇总行：在飞（含收队中）/排队 + 本会话终态四计数。 */
function summaryLine(records: readonly TaskRecord[]): string {
  const flying = count(records, "running") + count(records, "stopping");
  return (
    `派单｜在飞 ${flying} · 排队 ${count(records, "queued")} · ` +
    `成功 ${count(records, "succeeded")} · 失败 ${count(records, "failed")} · ` +
    `取消 ${count(records, "canceled")} · 丢失 ${count(records, "lost")}`
  );
}

/**
 * widget 行（≤10 行）；无在飞/排队时返回 undefined（全跑完即清）。
 * 终态只进汇总计数——面板是「正在干」的面，账在 dispatch_list。
 */
export function renderWidgetLines(
  records: readonly TaskRecord[],
  owner: TuiOwner,
): string[] | undefined {
  const mine = records.filter((r) => isSessionRecord(r, owner));
  const active = mine.filter((r) => r.status === "running" || r.status === "stopping");
  const queued = mine.filter((r) => r.status === "queued");
  if (active.length + queued.length === 0) return undefined;
  const byAge = (a: TaskRecord, b: TaskRecord): number => (a.startedAt ?? 0) - (b.startedAt ?? 0);
  const lines = [...active.sort(byAge), ...queued].map(
    (r) =>
      `#${r.id.slice(0, 8)} ${ACTIVE_TEXT[r.status] ?? r.status} ${snippet(r.task)}${costHint(r)}`,
  );
  const budget = WIDGET_MAX_LINES - 1; // 汇总行占 1
  if (lines.length > budget) {
    const hidden = lines.length - (budget - 1);
    return [
      summaryLine(mine),
      ...lines.slice(0, budget - 1),
      `… 还有 ${hidden} 个（dispatch_list 看全）`,
    ];
  }
  return [summaryLine(mine), ...lines];
}

/** footer 一行：无在飞/排队时 undefined。 */
export function renderStatusText(
  records: readonly TaskRecord[],
  owner: TuiOwner,
): string | undefined {
  const mine = records.filter((r) => isSessionRecord(r, owner));
  const flying = count(mine, "running") + count(mine, "stopping");
  const queued = count(mine, "queued");
  if (flying + queued === 0) return undefined;
  const bad = count(mine, "failed") + count(mine, "lost");
  return bad > 0
    ? `派单 在飞${flying} · 排队${queued} · 败/丢${bad}`
    : `派单 在飞${flying} · 排队${queued}`;
}

/** 面板与 /steer 用同一个 owner 戳；不一致会互相看不见任务。 */
export function currentOwner(): TuiOwner {
  return { pid: process.pid, startMs: processStartMs(process.pid) ?? 0 };
}

/** 可被 /steer 选中的任务：本会话 + running；按派发时间升序，同刻按 id。 */
export function runningSteerTargets(records: readonly TaskRecord[], owner: TuiOwner): TaskRecord[] {
  return records
    .filter((record) => isSessionRecord(record, owner) && record.status === "running")
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.id.localeCompare(b.id));
}

export function steerChoiceLabel(record: TaskRecord): string {
  return `#${record.id.slice(0, 8)} ${snippet(record.task)}`;
}

/** 序号让选项字符串唯一；调用方用 index 回映记录，绝不解析字符串当 id。 */
export function renderSteerOptions(targets: readonly TaskRecord[]): string[] {
  return targets.map((record, index) => `${index + 1}) ${steerChoiceLabel(record)}`);
}

export function steerReceipt(outcome: Extract<SteerOutcome, { ok: true }>): {
  text: string;
  level: "info";
} {
  return {
    text: `已受理 #${outcome.taskId.slice(0, 8)} · seq ${outcome.seq} · state=sent（只代表写进信箱；送达与生效看任务结束通知）`,
    level: "info",
  };
}

export interface SteerUi {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, level: "info" | "warning" | "error"): void;
}

export interface SteerDeps {
  hasUI: boolean;
  args: string;
  owner: TuiOwner;
  records: readonly TaskRecord[];
  ui: SteerUi;
  steer(taskId: string, text: string): Promise<SteerOutcome>;
}

/** 人直接转向的唯一状态机：0/1/多任务、args、Esc、空输入、任务退出都在这里。 */
export async function runSteerCommand(deps: SteerDeps): Promise<void> {
  if (!deps.hasUI) return;
  const targets = runningSteerTargets(deps.records, deps.owner);
  if (targets.length === 0) {
    deps.ui.notify("没有在飞任务（排队中的先 dispatch_stop 再重派）", "warning");
    return;
  }
  let target = targets[0]!;
  if (targets.length > 1) {
    const options = renderSteerOptions(targets);
    const choice = await deps.ui.select("转向哪个在飞任务？", options);
    if (choice === undefined) return;
    const index = options.indexOf(choice);
    if (index < 0) {
      deps.ui.notify("选择器返回了未知选项，没发", "error");
      return;
    }
    target = targets[index]!;
  }
  let text = deps.args.trim();
  if (text === "") {
    const answer = await deps.ui.input(`转向 #${target.id.slice(0, 8)}：`, "一句话，下一回合生效");
    if (answer === undefined) return;
    text = answer.trim();
  }
  if (text === "") {
    deps.ui.notify("空转向，没发", "warning");
    return;
  }
  try {
    const outcome = await deps.steer(target.id, text);
    if (outcome.ok) {
      const receipt = steerReceipt(outcome);
      deps.ui.notify(receipt.text, receipt.level);
    } else {
      deps.ui.notify(outcome.error, "error");
    }
  } catch (error) {
    deps.ui.notify(`转向失败：${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

/** 接线用的最小 ui 面（ctx.ui 结构兼容）。 */
export interface TuiUi {
  setWidget(key: string, content: string[] | undefined): void;
  setStatus(key: string, text: string | undefined): void;
}

/**
 * 订阅 registry 驱动 widget + footer；返回清面句柄（会话重配/关机时调）。
 * UI 调用 best-effort：宿主面挂了不拖垮派发。
 */
export function attachTuiSurface(opts: {
  registry: Pick<TaskRegistry, "subscribe" | "list">;
  ui: TuiUi;
  /** 测试注入；缺省用本进程戳。 */
  owner?: TuiOwner;
}): () => void {
  // shortcut: ps 读不到本进程启动时刻时面板静默空白；engine 判活同依赖 ps，残宿主下不是面板独有的问题
  const owner = opts.owner ?? currentOwner();
  const update = (): void => {
    try {
      const records = opts.registry.list();
      opts.ui.setWidget(TUI_WIDGET_KEY, renderWidgetLines(records, owner));
      opts.ui.setStatus(TUI_STATUS_KEY, renderStatusText(records, owner));
    } catch {
      // best-effort：面板挂了不影响派发
    }
  };
  update();
  opts.registry.subscribe(() => update());
  return () => {
    try {
      opts.ui.setWidget(TUI_WIDGET_KEY, undefined);
      opts.ui.setStatus(TUI_STATUS_KEY, undefined);
    } catch {
      // best-effort 同上
    }
  };
}
