// 会话审计 CLI：读一份日志，判它自述做过的事有没有被自己的动作记录支撑。
//
// 退出码（给 CI 用，必须稳定）：
//   0  verified；或 unclaimed（默认不罚，--strict 时算 1）
//   1  partial / unverified / absent
//   2  解析不了这份文件（不可读 / 一条事件都没认出来 / --format 不认识）
import { createReadStream } from "node:fs";
import { parseArgs } from "node:util";
import { audit, normalizeClaude, normalizeCodex, normalizePi } from "../audit/index.ts";
import type { AuditResult, SessionEvent } from "../audit/index.ts";

const FORMATS = ["codex", "claude", "pi"] as const;
type Format = (typeof FORMATS)[number];

const USAGE = `用法：session-audit <file.jsonl> --format codex|claude|pi [--cwd DIR] [--max N] [--json] [--strict]

  0  verified；或 unclaimed 且没有任何收据
  1  partial / unverified / absent；或 unclaimed 但动过手（有路径收据）；--strict 时任何 unclaimed
  2  解析不了这份文件`;

/** 读一份日志的每一行。流式：214MB 的历史目录也吃得下。 */
async function readLines(path: string): Promise<string[]> {
  const lines: string[] = [];
  const stream = createReadStream(path, { encoding: "utf8" });
  let buffered = "";
  for await (const chunk of stream) {
    buffered += chunk;
    const parts = buffered.split("\n");
    buffered = parts.pop() ?? "";
    for (const line of parts) lines.push(line);
  }
  if (buffered !== "") lines.push(buffered);
  return lines;
}

function render(result: AuditResult): string {
  const describe = result.receipts.commands
    .slice(0, 5)
    .map(
      (c) =>
        `${c.command}${typeof c.exitCode === "number" ? ` (exit ${c.exitCode})` : " (no exit)"}`,
    );
  const lines = [
    `判词 ${result.deliverable}`,
    `自述 ${result.claims.paths.length} 路径 / ${result.claims.commands.length} 命令`,
    `收据 ${result.receipts.paths.length} 路径 / ${result.receipts.commands.length} 命令`,
  ];
  if (result.mismatch.paths.length > 0)
    lines.push(`对不上(路径) ${result.mismatch.paths.join(", ")}`);
  if (result.mismatch.commands.length > 0)
    lines.push(`对不上(命令) ${result.mismatch.commands.join(", ")}`);
  if (describe.length > 0) lines.push(`收据样例 ${describe.join(" | ")}`);
  if (result.truncated) lines.push("收据被截断");
  for (const note of result.notes) lines.push(`备注 ${note}`);
  return lines.join("\n");
}

function exitCodeOf(result: AuditResult, strict: boolean): number {
  if (result.deliverable === "verified") return 0;
  if (result.deliverable === "unclaimed") {
    // 零自述但真的动过手：默认就红（不给「写完文件说 Done」留出口）。
    const touched = result.receipts.paths.length > 0 || result.truncated;
    if (strict || touched) return 1;
    return 0;
  }
  return 1;
}

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        format: { type: "string" },
        cwd: { type: "string" },
        max: { type: "string" },
        json: { type: "boolean", default: false },
        strict: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch {
    console.error(USAGE);
    return 2;
  }
  if (parsed.values.help === true) {
    console.log(USAGE);
    return 0;
  }

  const file = parsed.positionals[0];
  const format = parsed.values.format;
  if (
    file === undefined ||
    format === undefined ||
    !(FORMATS as readonly string[]).includes(format)
  ) {
    console.error(USAGE);
    return 2;
  }

  let lines: string[];
  try {
    lines = await readLines(file);
  } catch {
    console.error(`读不了 ${file}`);
    return 2;
  }

  const normalized =
    format === ("codex" satisfies Format)
      ? normalizeCodex(lines)
      : format === ("claude" satisfies Format)
        ? normalizeClaude(lines)
        : normalizePi(lines);
  const events: SessionEvent[] = normalized.events;
  // pi 的归一化会带出上游的截断位；codex/claude 没有这两个字段。
  const upstreamFlags = normalized as { pathsTruncated?: boolean; commandsTruncated?: boolean };
  const upstream: { pathsTruncated?: boolean; commandsTruncated?: boolean } = {};
  if (upstreamFlags.pathsTruncated === true) upstream.pathsTruncated = true;
  if (upstreamFlags.commandsTruncated === true) upstream.commandsTruncated = true;
  if (
    events.length === 0 &&
    upstream.pathsTruncated !== true &&
    upstream.commandsTruncated !== true
  ) {
    console.error(`这份文件一条事件都没认出来（${format}）：${file}`);
    return 2;
  }

  const options: {
    cwd?: string;
    maxReceipts?: number;
    pathsTruncated?: boolean;
    commandsTruncated?: boolean;
  } = { ...upstream };
  if (parsed.values.cwd !== undefined) options.cwd = parsed.values.cwd;
  if (parsed.values.max !== undefined) {
    const max = Number(parsed.values.max);
    if (!Number.isInteger(max) || max <= 0) {
      console.error(`--max 需要正整数：${parsed.values.max}`);
      return 2;
    }
    options.maxReceipts = max;
  }
  const result = audit(events, normalized.report, options);

  if (parsed.values.json === true) console.log(JSON.stringify(result, null, 2));
  else console.log(render(result));
  return exitCodeOf(result, parsed.values.strict === true);
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  });
