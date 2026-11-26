// pi 的事件流 → 归一化事件。
//
// 不另写解析器：pi 的流格式（`parseChildStream`）本来就带「工具轨迹 + 正文」，
// 派发引擎的判词也是从这一份数据算的。这里只做搬运：
//   路径收据 ← delivery.paths；命令收据 ← delivery.commands（跑挂的记 exitCode 1）；
//   报告 ← 最后一条 assistant 的文本。
import { parseChildStream } from "../core/child.ts";
import type { SessionEvent } from "./types.ts";

export interface NormalizedPi {
  events: SessionEvent[];
  report: string | null;
  malformed: number;
}

export function normalizePi(lines: Iterable<string>): NormalizedPi {
  const raw = [...lines].join("\n");
  const parsed = parseChildStream(raw);
  const events: SessionEvent[] = [];

  for (const path of parsed.delivery.paths) {
    events.push({ kind: "tool", name: "write", input: { path } });
  }
  const failed = new Set(parsed.delivery.failedCommands);
  for (const command of parsed.delivery.commands) {
    events.push({
      kind: "tool",
      name: "bash",
      input: { command },
      exitCode: failed.has(command) ? 1 : 0,
    });
  }

  const text = parsed.text.trim();
  if (text !== "") events.push({ kind: "message", role: "assistant", text });

  return { events, report: text === "" ? null : text, malformed: 0 };
}
