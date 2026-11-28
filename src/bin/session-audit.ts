// 会话审计 CLI：读一份日志，判它自述做过的事有没有被自己的动作记录支撑。
//
// 退出码（给 CI 用，必须稳定）：
//   0  verified；或 unclaimed（默认不罚，--strict 时算 1）
//   1  partial / unverified / absent
//   2  解析不了这份文件（不可读 / 一条事件都没认出来 / --format 不认识）
import { createReadStream, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  audit,
  normalizeClaude,
  normalizeCodex,
  normalizeKimi,
  normalizePi,
} from "../audit/index.ts";
import type { AuditResult, SessionEvent } from "../audit/index.ts";

const FORMATS = ["codex", "claude", "pi", "kimi"] as const;
type Format = (typeof FORMATS)[number];

/** 归一化器的签名：只要 events + report，截断旗由下面的 upstream 嗅探兜。 */
type Normalizer = (lines: string[]) => { events: SessionEvent[]; report: string | null };

/**
 * 查表而不是嵌套三元：三元的分支漏项会静默落到 `normalizePi`，把 kimi 日志
 * 吃成 0 事件、每份退 2——而 `Record<Format, …>` 会在 `pnpm check` 就报缺键。
 */
const NORMALIZERS: Record<Format, Normalizer> = {
  codex: normalizeCodex,
  claude: normalizeClaude,
  pi: normalizePi,
  kimi: normalizeKimi,
};

const USAGE = `用法：session-audit <file.jsonl> --format codex|claude|pi|kimi [--cwd DIR] [--max N] [--json] [--strict]

  0  verified；或 unclaimed 且没有任何收据
  1  partial / unverified / absent；或 unclaimed 但动过手（有路径收据）；--strict 时任何 unclaimed
  2  解析不了这份文件`;

/**
 * kimi 的日志在会话目录四层下面：`<session>/agents/main/wire.jsonl`。
 * 只拼主代理这一条，绝不 glob `agents/agent-*`——那是子代理侧链，并进来就成了另一份账。
 */
function resolveInput(file: string, format: Format): string {
  if (format !== "kimi") return file;
  try {
    if (!statSync(file).isDirectory()) return file;
  } catch {
    return file; // 不存在就走「读不了 → 2」，别在这里造第二种失败
  }
  return join(file, "agents", "main", "wire.jsonl");
}

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

  const fmt = format as Format;
  const target = resolveInput(file, fmt);
  let lines: string[];
  try {
    lines = await readLines(target);
  } catch {
    console.error(target === file ? `读不了 ${file}` : `读不了 ${target}（来自目录 ${file}）`);
    return 2;
  }

  const normalized = NORMALIZERS[fmt](lines);
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
    // kimi 的「零事件」有两个具体成因，说清楚比只说「认不出来」有用：
    // wire 1.0（从 kimi-cli 导入的另一套格式）与只有 append_message 的会话。
    const hint =
      fmt === "kimi"
        ? "\n  kimi 只读 agents/main 的 loop 事件；wire 1.0 与只有 append_message 的会话不支持"
        : "";
    console.error(`这份文件一条事件都没认出来（${fmt}）：${file}${hint}`);
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

// 只设 exitCode，不调 process.exit：管道下 stdout 是异步写，硬退出会把 128 KiB 之后的
// 尾巴丢掉（kimi 一份真会话的 --json 有 300 KB，`| jq` 直接报 Unterminated string）。
main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
