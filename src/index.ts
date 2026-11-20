import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { CHILD_REPORT_SCHEMA, CHILD_REPORT_TOOL_NAME } from "./core/child.ts";
import { TaskEngine } from "./core/engine.ts";
import { TaskRegistry } from "./core/registry.ts";
import { NotificationCenter } from "./core/notifications.ts";
import { Storage, findProjectRoot } from "./core/storage.ts";
import type { DispatchInput, HostMode } from "./core/types.ts";

// pi 适配层：注册工具、装事件、投递通知。
// 不写任何业务规则——业务规则全在 src/core/。

/** ctx.mode → 核心层的宿主模式。加 tui 时只加一行。 */
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
      return textResult(outcome);
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
          outputPath: r.outputPath,
          outputTruncated: r.outputTruncated,
        }));
      return textResult({ total: records.length, records });
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
