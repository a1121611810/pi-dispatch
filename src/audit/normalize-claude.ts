// claude 历史日志 → 归一化事件。
//
// 只认顶层 `assistant` / `user`（历史里没有 `result` 行）。三条硬规矩：
//   1. `tool_result` 永不变成 user 消息——否则每次工具返回都会把报告判成陈旧；
//   2. `Read` / `Grep` / `Glob` 不算改过（`Read` 的 result 里也带 filePath，只能按工具名白名单取）；
//   3. claude 没有结构化退出码：`^Exit code N` 才算数字退出码；`is_error` 且无标记的命令
//      根本没跑（hook / 审批拦下），整条丢弃；其余无标记的前台调用按 0。
import type { SessionEvent } from "./types.ts";

interface NormalizedClaude {
  events: SessionEvent[];
  report: string | null;
  malformed: number;
}

const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);
const BACKGROUND_MARKERS = [
  "Command running in background",
  "did not complete within",
  "moved to the background",
];

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const textOf = (content: unknown): string | undefined => {
  if (typeof content === "string") return content === "" ? undefined : content;
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

interface PendingTool {
  name: string;
  input: { path?: string; command?: string; runInBackground?: boolean };
  sidechain: boolean;
}

/** 一条 tool_result 对应的退出码。`undefined` = 不是收据。 */
function exitCodeOf(output: string, isError: boolean, background: boolean): number | undefined {
  const marker = /^Exit code (\d+)/.exec(output.trim());
  if (marker !== null) return Number(marker[1]);
  if (isError) return undefined;
  if (background) return undefined;
  if (BACKGROUND_MARKERS.some((m) => output.includes(m))) return undefined;
  return 0;
}

export function normalizeClaude(lines: Iterable<string>): NormalizedClaude {
  const events: SessionEvent[] = [];
  const pending = new Map<string, PendingTool>();
  const messages: Array<{ text: string; sidechain: boolean }> = [];
  let malformed = 0;
  let seenUserText = false;
  let cwd: string | undefined;

  for (const line of lines) {
    if (line.trim() === "") continue;
    let record: { type?: unknown; message?: unknown; cwd?: unknown; isSidechain?: unknown };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      malformed++;
      continue;
    }
    if (cwd === undefined) cwd = str(record.cwd);
    const type = str(record.type);
    if (type !== "assistant" && type !== "user") continue;

    const message = (record.message ?? {}) as { content?: unknown };
    const sidechain = record.isSidechain === true;
    const blocks = Array.isArray(message.content) ? message.content : [];

    for (const raw of blocks) {
      if (!raw || typeof raw !== "object") continue;
      const block = raw as {
        type?: unknown;
        text?: unknown;
        name?: unknown;
        input?: unknown;
        id?: unknown;
        tool_use_id?: unknown;
        content?: unknown;
        is_error?: unknown;
      };
      const kind = str(block.type);

      if (kind === "text") {
        const text = str(block.text);
        if (text === undefined) continue;
        if (type === "assistant") {
          messages.push({ text, sidechain });
          continue;
        }
        // 第一条 user 文本是任务本身；其余是转向。工具结果不走这条路（见下）。
        if (seenUserText) events.push({ kind: "message", role: "user", text, steer: true });
        else events.push({ kind: "message", role: "user", text });
        seenUserText = true;
        continue;
      }

      if (kind === "tool_use" && type === "assistant") {
        const id = str(block.id);
        const name = str(block.name);
        if (id === undefined || name === undefined) continue;
        const input = (block.input ?? {}) as {
          file_path?: unknown;
          notebook_path?: unknown;
          command?: unknown;
          run_in_background?: unknown;
        };
        pending.set(id, {
          name,
          input: {
            ...(str(input.file_path) !== undefined
              ? { path: str(input.file_path)! }
              : str(input.notebook_path) !== undefined
                ? { path: str(input.notebook_path)! }
                : {}),
            ...(str(input.command) !== undefined ? { command: str(input.command)! } : {}),
            ...(input.run_in_background === true ? { runInBackground: true } : {}),
          },
          sidechain,
        });
        continue;
      }

      if (kind === "tool_result" && type === "user") {
        const id = str(block.tool_use_id);
        if (id === undefined) continue;
        const tool = pending.get(id);
        pending.delete(id);
        if (tool === undefined) continue;
        const output = textOf(block.content) ?? "";
        const isError = block.is_error === true;
        if (tool.sidechain) continue;

        if (tool.name === "bash" || tool.name === "Bash") {
          const exitCode = exitCodeOf(output, isError, tool.input.runInBackground === true);
          if (exitCode === undefined) continue; // 没跑完 / 被拦下：不是收据
          events.push({
            kind: "tool",
            name: "bash",
            input: { command: tool.input.command ?? "" },
            exitCode,
          });
          continue;
        }
        if (WRITE_TOOLS.has(tool.name)) {
          const path = tool.input.path;
          if (path === undefined) continue;
          events.push({ kind: "tool", name: "write", input: { path } });
        }
      }
    }
  }

  const mainChain = messages.filter((m) => !m.sidechain);
  const report = mainChain.length > 0 ? mainChain[mainChain.length - 1]!.text : null;
  for (const message of messages) {
    events.push({
      kind: "message",
      role: "assistant",
      text: message.text,
      ...(message.sidechain ? { sidechain: true as const } : {}),
    });
  }
  if (cwd !== undefined) events.unshift({ kind: "meta", cwd });

  return { events, report, malformed };
}
