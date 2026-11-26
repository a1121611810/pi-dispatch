// codex 日志 → 归一化事件。
//
// 两种信封都要认：
//   历史：`event_msg` → `payload.type === "item_completed"` → `payload.item`（PascalCase）
//   实时：顶层 `item.completed` → `item`（snake_case）
// 两本账（`event_msg/CommandExecution` 与 `response_item/function_call`）描述同一批命令，
// 按 `CommandExecution.id === function_call.call_id` 合并：命令串取原文（执行侧会被包装成
// `rtk …`），退出码取 CE 的结构化字段。
import type { SessionEvent } from "./types.ts";

interface Raw {
  id?: string;
  type?: string;
  command?: unknown;
  exit_code?: unknown;
  cwd?: unknown;
  changes?: unknown;
  content?: unknown;
  text?: unknown;
  phase?: unknown;
}

interface NormalizedCodex {
  events: SessionEvent[];
  /** agent 最后写给用户的那段话 */
  report: string | null;
  malformed: number;
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** `["/bin/zsh","-lc",script]` → script；`/bin/zsh -lc "…"` → 内层；其余原样。 */
export function unwrapShell(command: unknown): string | undefined {
  if (Array.isArray(command)) {
    const last = command[command.length - 1];
    return typeof last === "string" ? last : undefined;
  }
  const text = str(command);
  if (text === undefined) return undefined;
  const m = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z|da|k)?sh\s+-l?c\s+(["'])([\s\S]*)\1$/.exec(text.trim());
  return m ? m[2]! : text;
}

/** `arguments` 是 JSON 字符串，命令在里面。 */
function cmdOfArguments(arguments_: unknown): string | undefined {
  if (typeof arguments_ !== "string") return undefined;
  try {
    const parsed = JSON.parse(arguments_) as { cmd?: unknown };
    return str(parsed.cmd);
  } catch {
    return undefined;
  }
}

const textOf = (content: unknown): string | undefined => {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as { type?: unknown; text?: unknown };
      if (typeof b.text === "string" && b.text !== "") parts.push(b.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
};

/**
 * 解析整份 codex 日志。
 * `malformed` 只数坏行；CLI 用「一条事件都没有」判退出码 2，不拿坏行判死。
 */
export function normalizeCodex(lines: Iterable<string>): NormalizedCodex {
  const originals = new Map<string, string>();
  const commands: Array<{ id?: string; command: string; exitCode?: number; cwd?: string }> = [];
  const writes: Array<{ path: string; cwd?: string }> = [];
  const messages: Array<{ role: "assistant" | "user"; text: string; phase?: string }> = [];
  let malformed = 0;
  let cwd: string | undefined;

  for (const line of lines) {
    if (line.trim() === "") continue;
    let record: { type?: unknown; payload?: unknown; item?: unknown };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      malformed++;
      continue;
    }
    const payload = (record.payload ?? {}) as {
      type?: unknown;
      item?: unknown;
      role?: unknown;
      content?: unknown;
      name?: unknown;
      arguments?: unknown;
      call_id?: unknown;
      cwd?: unknown;
    };
    const payloadType = str(payload.type);
    const topType = str(record.type);

    // 会话级 cwd：codex 存成 file:// 形式
    const metaCwd = str(payload.cwd)?.replace(/^file:\/\//, "");
    if (cwd === undefined && metaCwd !== undefined) cwd = metaCwd;

    // 原文命令：function_call / custom_tool_call 的 arguments
    if (topType === "response_item" && payloadType === "function_call") {
      const callId = str(payload.call_id);
      const cmd = cmdOfArguments(payload.arguments);
      if (callId !== undefined && cmd !== undefined) originals.set(callId, cmd);
      continue;
    }

    const envelopeItem = payloadType === "item_completed" ? (payload.item as Raw) : undefined;
    const topItem =
      topType === "item.completed" ? ((record as { item?: Raw }).item ?? undefined) : undefined;
    const item = envelopeItem ?? topItem;
    if (item !== undefined) {
      const type = (item.type ?? "").toLowerCase();
      if (type === "commandexecution") {
        const command = unwrapShell(item.command);
        if (command !== undefined) {
          commands.push({
            ...(item.id !== undefined ? { id: item.id } : {}),
            command,
            ...(typeof item.exit_code === "number" ? { exitCode: item.exit_code } : {}),
            ...(str(item.cwd) !== undefined
              ? { cwd: str(item.cwd)!.replace(/^file:\/\//, "") }
              : {}),
          });
        }
        continue;
      }
      if (type === "filechange") {
        const changes = item.changes;
        if (changes && typeof changes === "object") {
          for (const path of Object.keys(changes as Record<string, unknown>)) {
            writes.push({ path, ...(cwd !== undefined ? { cwd } : {}) });
          }
        }
        continue;
      }
      if (type === "agentmessage") {
        const text = str(item.text) ?? textOf(item.content);
        if (text !== undefined) {
          messages.push({
            role: "assistant",
            text,
            ...(str(item.phase) !== undefined ? { phase: str(item.phase)! } : {}),
          });
        }
        continue;
      }
      if (type === "usermessage") {
        const text = textOf(item.content) ?? str(item.text);
        if (text !== undefined) messages.push({ role: "user", text });
        continue;
      }
    }

    // 角色消息：event_msg 里没有，统一从 response_item/message 取（是超集）。
    if (topType === "response_item" && payloadType === "message") {
      const role = str(payload.role);
      const text = textOf(payload.content);
      if ((role === "user" || role === "assistant") && text !== undefined) {
        messages.push({ role, text });
      }
    }
  }

  const events: SessionEvent[] = [];
  if (cwd !== undefined) events.push({ kind: "meta", cwd });
  for (const command of commands) {
    const command_ =
      (command.id !== undefined ? originals.get(command.id) : undefined) ?? command.command;
    events.push({
      kind: "tool",
      name: "bash",
      input: { command: command_ },
      ...(command.exitCode !== undefined ? { exitCode: command.exitCode } : {}),
      ...(command.cwd !== undefined ? { cwd: command.cwd } : {}),
    });
  }
  for (const write of writes) {
    events.push({
      kind: "tool",
      name: "write",
      input: { path: write.path },
      ...(write.cwd !== undefined ? { cwd: write.cwd } : {}),
    });
  }
  for (const message of messages) {
    events.push({ kind: "message", role: message.role, text: message.text });
  }

  const finalAnswer = [...messages]
    .reverse()
    .find((m) => m.role === "assistant" && m.phase === "final_answer");
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const report = finalAnswer?.text ?? lastAssistant?.text ?? null;

  return { events, report, malformed };
}
