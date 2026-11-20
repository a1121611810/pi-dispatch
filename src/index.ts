import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { CHILD_REPORT_SCHEMA, CHILD_REPORT_TOOL_NAME, parseChildStream } from "./core/child.ts";
import { TaskEngine } from "./core/engine.ts";
import { TaskRegistry } from "./core/registry.ts";
import { NotificationCenter } from "./core/notifications.ts";
import { Storage, findProjectRoot } from "./core/storage.ts";
import type { DispatchInput, DispatchResult, HostMode } from "./core/types.ts";
import { attachTuiSurface } from "./tui.ts";

// pi 适配层：注册工具、装事件、投递通知。
// 不写任何业务规则——业务规则全在 src/core/。

/** ctx.mode → 核心层的宿主模式。tui 与 rpc 同属长驻；人看面另挂 src/tui.ts。 */
export function toHostMode(mode: string): HostMode {
  if (mode === "rpc" || mode === "tui") return "long-lived";
  return "one-shot"; // print / json
}

/** text 必须是字符串：JSON.stringify(undefined) 是 undefined ⇒ pi 下一轮读 .length 会崩。 */
export function textResult(value: unknown): {
  content: Array<{ type: "text"; text: string }>;
  details: undefined;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(value ?? null, null, 2) ?? "null" }],
    details: undefined,
  };
}

// ── 模型面归约 ──────────────────────────────────────────────────────────────
// dispatch_task 的正文全量进工具结果 = 每轮重发的大税（pi 对扩展工具结果没有尺寸守卫，
// 只有事后压缩）。归约成头+尾窗口，全文走 dispatch_read / outputPath。
// shortcut: 只按字符预算触发，未抄 pi 的 2000 行副条件——正文已散文化，字符预算是有效上界。

const SMALL_WINDOW_HEAD = 4 * 1024;
const SMALL_WINDOW_TAIL = 4 * 1024;
const BIG_WINDOW_MAX_CHARS = 50 * 1024;

/** 小窗三要件：回执在、非空转、核对挂过——全满足才享受 8KB 档，否则 50KB 档（无回执兜底窗）。 */
function hasReliableReport(result: DispatchResult): boolean {
  return Boolean(
    result.report &&
    result.reportChannel !== "none" &&
    !result.assessmentVacuous &&
    !result.deliveryUnverified,
  );
}

export function excerptDeliverable(result: DispatchResult): DispatchResult {
  if (!result.text || !result.outputPath) return result; // 无盘路径不截：交付物必须可达
  const budget = hasReliableReport(result)
    ? { head: SMALL_WINDOW_HEAD, tail: SMALL_WINDOW_TAIL }
    : {
        head: Math.floor(BIG_WINDOW_MAX_CHARS / 4),
        tail: BIG_WINDOW_MAX_CHARS - Math.floor(BIG_WINDOW_MAX_CHARS / 4),
      };
  if (result.text.length <= budget.head + budget.tail) return result;
  const omitted = result.text.length - budget.head - budget.tail;
  const marker = `\n\n…【省略 ${omitted} 字符：${
    hasReliableReport(result) ? "摘要见 report；" : ""
  }全文经 dispatch_read 或 ${result.outputPath} 可达】\n\n`;
  return {
    ...result,
    text: result.text.slice(0, budget.head) + marker + result.text.slice(-budget.tail),
  };
}

// ── dispatch_read：散文化 + 行锚 ────────────────────────────────────────────
// 盘上是原始 JSONL 事件流，模型直接读会拿到一堆 JSON 行——先 parseChildStream 取散文正文，
// 再打 omp hashline 口径的行锚（内容哈希，空白不敏感）：引用证据照抄 N:hash，窗口精读用 around。

const AROUND_ANCHOR_RE = /^(\d+):([0-9a-f]{4})$/;
const READ_MAX_CHARS_CAP = BIG_WINDOW_MAX_CHARS;

/** FNV-1a 取低 16 位（4 hex），对 trim 后的行内容——omp hashline 的加宽版。 */
export function lineHash(line: string): string {
  let h = 0x811c9dc5;
  const s = line.trim();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h & 0xffff).toString(16).padStart(4, "0");
}

export interface AnchoredReadResult {
  text?: string;
  totalLines: number;
  /** around 命中的窗口（1 起，含端点） */
  from?: number;
  to?: number;
  /** 锚失配时回该行当前的鲜锚 */
  freshAnchor?: string;
  error?: string;
}

export function anchoredRead(
  prose: string,
  opts: { maxChars?: number; around?: string; contextLines?: number } = {},
): AnchoredReadResult {
  const lines = prose.split("\n");
  if (opts.around !== undefined) {
    const m = AROUND_ANCHOR_RE.exec(opts.around.trim());
    if (!m) return { totalLines: lines.length, error: `锚格式不对：${opts.around}（要 N:hash）` };
    const n = Number(m[1]);
    const line = lines[n - 1];
    if (line === undefined)
      return { totalLines: lines.length, error: `行号 ${n} 越界（共 ${lines.length} 行）` };
    const fresh = lineHash(line);
    if (fresh !== m[2])
      return {
        totalLines: lines.length,
        error: `锚失配：第 ${n} 行内容已变或锚写错，拒绝读取`,
        freshAnchor: `${n}:${fresh}`,
      };
    const ctx = Math.max(0, Math.floor(opts.contextLines ?? 20));
    const from = Math.max(0, n - 1 - ctx);
    const to = Math.min(lines.length, n - 1 + ctx + 1);
    return {
      text: lines
        .slice(from, to)
        .map((l, i) => `${from + i + 1}:${lineHash(l)}|${l}`)
        .join("\n"),
      totalLines: lines.length,
      from: from + 1,
      to,
    };
  }
  const joined = lines.map((l, i) => `${i + 1}:${lineHash(l)}|${l}`).join("\n");
  const maxChars = Math.min(opts.maxChars ?? 8192, READ_MAX_CHARS_CAP);
  if (joined.length <= maxChars) return { text: joined, totalLines: lines.length };
  const head = Math.floor(maxChars / 4);
  const tail = maxChars - head;
  return {
    text:
      joined.slice(0, head) +
      `\n…【省略 ${joined.length - head - tail} 字符：用 around="N:hash" 拉窗口】\n` +
      joined.slice(-tail),
    totalLines: lines.length,
  };
}

const DISPATCH_TASK_SCHEMA = {
  type: "object",
  properties: {
    taskDescription: {
      type: "string",
      description: "要干的活。一段文字。子代理能看到的只有这一段。必填。",
    },
    why: {
      type: "string",
      description: "为什么派它。会进子代理的提示词。不给 = 没给理由（不等于「理由被丢了」）。",
    },
    readOnly: {
      type: "string",
      enum: ["strict", "lenient"],
      description:
        "strict = 只给读工具（read/grep/find/ls），挡「改」不挡「读」——不是沙箱；lenient = 不收窄。默认 lenient。写错值会被拒（不会悄悄变宽松）。",
    },
    model: { type: "string", description: "覆盖子代理跑的模型。缺省继承会话模型。" },
    thinkingLevel: { type: "string", description: "覆盖子代理的思考深度。" },
    timeoutMs: {
      type: "number",
      description: "最多跑多久（毫秒），超了收掉。缺省不设限（只靠卡住判定）。",
    },
    projectContext: {
      type: "string",
      enum: ["auto", "none"],
      description: "auto = 照常加载项目说明文件；none = 不加载（省固定税）。默认 auto。",
    },
    allowScripts: {
      type: "boolean",
      description:
        "true = 这个子代理能写脚本批量调工具：脚本里可以循环、并行调工具，只有脚本的输出回到模型（中间结果不进上下文）。适合「同形态调用很多次」的机械活——批量读文件、批量改、批量查。代价两条：① 子代理的输入会多一份工具声明（吃 token）；② 它不保证子代理真的会写脚本——要它写，就在任务里明说「用写脚本的方式」。不传 = 用会话的默认值。",
    },
  },
  required: ["taskDescription"],
} as const;

export default function piDispatchEntry(pi: ExtensionAPI): void {
  // session_start 会因 new / resume / fork 再次触发（同一进程）。
  // 不清理上一轮的 handler 与引擎，就会累积引擎、留下没人收的子代理。
  let cleanup: (() => void) | undefined;
  let engine: TaskEngine | undefined;
  // 工具只在 session_start 之后被调用；重注册同名工具时 pi 保留首个闭包，
  // 所以工具必须读这个外层变量而不是捕获某个会话的实例。
  const current = (): TaskEngine => {
    if (!engine) throw new Error("dispatch engine is not ready（没有活动会话）");
    return engine;
  };

  // 注册必须发生在 session_start——factory 阶段 getActiveTools() 是 throw 的桩。
  pi.on("session_start", (_event, ctx) => {
    cleanup?.();
    void engine?.shutdown();
    cleanup = undefined;

    // 子代理进程（depth>0）：只装配回执工具，不做宿主侧任何事
    if (Number(process.env.PI_DISPATCH_DEPTH ?? 0) > 0) {
      registerChildReportTool(pi);
      return;
    }

    const session = startSession(pi, ctx);
    engine = session.engine;
    cleanup = session.cleanup;
    registerTools(pi, current);
  });
}

/** 一个会话的装配：引擎 + 通知投递 + 退订句柄。 */
function startSession(
  pi: ExtensionAPI,
  ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
): { engine: TaskEngine; cleanup: () => void } {
  const notifications = new NotificationCenter();
  const storage = new Storage(
    // 外壳注入存储根：~/.pi/dispatch（核心不知道默认该落哪）
    (process.env.HOME ?? "~") + "/.pi/dispatch",
    findProjectRoot(ctx.cwd),
  );
  const engine = new TaskEngine({
    registry: new TaskRegistry(),
    storage,
    hostMode: toHostMode(ctx.mode),
    piVersion: safe(() => PI_VERSION),
    childExtensionPath: fileURLToPath(import.meta.url),
    sessionModel: () => {
      try {
        return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      } catch {
        return undefined;
      }
    },
  });
  notifications.attach(engine.registry);

  // TUI 常驻面：在飞/排队给人看（模型面终态通知仍走 turn 边界的 deliver）
  const detachTui =
    ctx.mode === "tui" ? attachTuiSurface({ registry: engine.registry, ui: ctx.ui }) : undefined;

  // 终态进待投递队列，turn 边界按 100 KB 分批投递
  const offTurn = pi.on("turn_end", () => deliver(pi, notifications));
  const offShutdown = pi.on("session_shutdown", () => {
    void engine.shutdown();
  });
  return {
    engine,
    cleanup: () => {
      offTurn();
      offShutdown();
      detachTui?.();
    },
  };
}

/** 把待投递的通知按批发出。best-effort：失败不阻塞 turn。 */
export function deliver(pi: ExtensionAPI, notifications: NotificationCenter): void {
  for (const batch of notifications.drain()) {
    const text = batch
      .map((n) => {
        const hint = n.deliveryUnverified
          ? "｜报告里的改动没有实测支撑（查 dispatch_list 复核）"
          : "";
        return `· 任务 ${n.taskId.slice(0, 8)}… ${n.status}（${new Date(n.at).toLocaleTimeString()}）${hint}`;
      })
      .join("\n");
    try {
      pi.sendMessage(
        { customType: "dispatch-notifications", content: text, display: true },
        { deliverAs: "nextTurn" },
      );
    } catch {
      // 通知是 best-effort：失败不阻塞 turn
    }
  }
}

/** 父方的三个工具。与会话生命周期分开：注册一次，闭包读 current()。 */
function registerTools(pi: ExtensionAPI, current: () => TaskEngine): void {
  pi.registerTool({
    name: "dispatch_task",
    label: "派任务",
    description: "派一个子代理出去干活。立刻返回编号（长驻宿主）或等它跑完返回结果（一次性宿主）。",
    parameters: DISPATCH_TASK_SCHEMA as never,
    execute: async (_id, args) => {
      const a = args as {
        taskDescription: string;
        why?: string;
        readOnly?: "strict" | "lenient";
        model?: string;
        thinkingLevel?: string;
        timeoutMs?: number;
        projectContext?: "auto" | "none";
        allowScripts?: boolean;
      };
      const input: DispatchInput = {
        task: a.taskDescription,
        why: a.why,
        readOnly: a.readOnly,
        model: a.model,
        thinkingLevel: a.thinkingLevel,
        timeoutMs: a.timeoutMs,
        projectContext: a.projectContext,
        allowScripts: a.allowScripts,
      };
      const outcome = await current().dispatch(input);
      return textResult("text" in outcome ? excerptDeliverable(outcome) : outcome);
    },
  });

  pi.registerTool({
    name: "dispatch_list",
    label: "查任务",
    description: "查派发记录：状态、时长、用量、报告通道、收据。",
    parameters: { type: "object", properties: {}, required: [] } as never,
    execute: async () => {
      const records = current()
        .registry.list()
        .map((r) => ({
          id: r.id,
          status: r.status,
          startedAt: r.startedAt,
          finishedAt: r.finishedAt,
          stopReason: r.stopReason,
          reportChannel: r.reportChannel,
          usage: r.usage,
          delivery: r.delivery,
          deliveryUnverified: r.deliveryUnverified,
          assessmentVacuous: r.assessmentVacuous,
          outputPath: r.outputPath,
          outputTruncated: r.outputTruncated,
        }));
      return textResult({ total: records.length, records });
    },
  });

  pi.registerTool({
    name: "dispatch_read",
    label: "读产出",
    description:
      '读任务产出的散文正文（不是原始 JSONL 流）。每行带 N:hash 锚；用 around="N:hash" 拉该行±contextLines 窗口，锚失配会拒绝并回新鲜锚。',
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "任务编号" },
        maxChars: { type: "number", description: "无 around 时摘要上限（默认 8192）" },
        around: { type: "string", description: '形如 "12:9f3a" 的行锚' },
        contextLines: { type: "number", description: "around 窗口半径（默认 20）" },
      },
      required: ["taskId"],
    } as never,
    execute: async (_id, args) => {
      const a = args as {
        taskId: string;
        maxChars?: number;
        around?: string;
        contextLines?: number;
      };
      const raw = await current().readOutput(a.taskId);
      if (raw === undefined)
        return textResult({ taskId: a.taskId, error: "还没落盘：任务未结束或编号不存在" });
      // 盘上的是原始 JSONL 事件流——模型直接读会拿到一堆 JSON 行；先散文化再锚定
      const prose = parseChildStream(raw).text || raw;
      return textResult({ taskId: a.taskId, ...anchoredRead(prose, a) });
    },
  });

  pi.registerTool({
    name: "dispatch_stop",
    label: "停任务",
    description: "停一个任务：排队中的抽掉；在跑的 SIGTERM→SIGKILL。",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "任务编号" },
        reason: { type: "string", description: "停的原因" },
      },
      required: ["taskId"],
    } as never,
    execute: async (_id, args) => {
      const a = args as { taskId: string; reason?: string };
      // 空串当没给：理由是坏值时回落默认（与 core 的 nonEmpty 口径一致）
      const reason = a.reason || "user stop";
      await current().stop(a.taskId, reason);
      // 停完要回一句话（pi 的 details 是必填；text 不能是 undefined）
      return textResult({
        taskId: a.taskId,
        reason,
        status: current().registry.get(a.taskId)?.status,
      });
    },
  });
}

/** 孩子的回执工具：四样报告经 toolResult 的 details.report 回给父方（tool 通道）。 */
function registerChildReportTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: CHILD_REPORT_TOOL_NAME,
    label: "交报告",
    description:
      "把四样结构化回执交给父方（summary / findings / files_touched / usage）。报告只是摘要，交付物仍是你最终消息的正文。",
    parameters: CHILD_REPORT_SCHEMA as never,
    execute: async (_id, args) => ({
      content: [{ type: "text", text: "child report received" }],
      structuredContent: args,
      details: { report: args },
    }),
  });
}

/** 读 pi 的 VERSION 导出（不 shell out）；读不到就 undefined。 */
function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
