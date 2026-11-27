#!/usr/bin/env node
// 实验：让模型按「动作块」格式重写真实日志里的工具动作，测两件事——
//   1) 格式遵从率（能不能稳定吐合法 JSON）
//   2) 漏记率 / 幻觉率（和日志里真实的收据对账）
//
// 这模拟的是「如果当初提示 agent 用这个格式写，审计能拿到什么」。
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const ROUNDS = Number(process.argv[2] ?? 49);
const REPO = new URL("..", import.meta.url).pathname;
const SESSIONS = `${process.env.HOME}/.codex/sessions`;
const OUT = "/tmp/pd-actions-probe";

const JUDGE_MARK = "只回答一行：SUPPORTED";
const PROMPT_HEAD = [
  "下面是一份编码 agent 的会话日志（JSONL）。请把日志里**真实发生过的**工具动作整理成一个 JSON 动作块。",
  "只输出 JSON，不要任何解释，格式：",
  '{"ran":[{"cmd":"<原样命令>","exit":<数字或null>}],"wrote":["<写入的文件路径>"],"read":["<读取的文件路径>"]}',
  "规则：只写日志里确实出现过的；命令原样照抄，不要改写；没有的字段给空数组。",
].join("\n");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".jsonl")) out.push({ path: p, size: st.size, mtime: st.mtimeMs });
  }
  return out;
}

function digest(raw, cap = 12_000) {
  const lines = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const item = ev.item ?? ev.payload?.item;
    const type = String(item?.type ?? "")
      .toLowerCase()
      .replace(/[_-]/g, "");
    if (type === "commandexecution") {
      const cmd = Array.isArray(item.command) ? item.command.at(-1) : item.command;
      lines.push(`[cmd exit=${item.exit_code ?? "?"}] ${String(cmd).slice(0, 200)}`);
    } else if (type === "filechange") {
      const changes = item.changes;
      const paths = Array.isArray(changes)
        ? changes.map((c) => c?.path)
        : changes && typeof changes === "object"
          ? Object.keys(changes)
          : [];
      lines.push(`[write] ${paths.join(" ")}`);
    }
  }
  const joined = lines.join("\n");
  return joined.length > cap ? joined.slice(-cap) : joined;
}

function receiptsOf(logPath) {
  let raw = "";
  try {
    raw = execFileSync(
      "node",
      [`${REPO}dist/session-audit.js`, logPath, "--format", "codex", "--max", "500", "--json"],
      {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    raw = String(error.stdout ?? "");
  }
  try {
    return JSON.parse(raw).receipts;
  } catch {
    return null;
  }
}

function askBlock(digestText) {
  const prompt = `${PROMPT_HEAD}\n\n=== 日志 ===\n${digestText}`;
  const started = Date.now();
  let out = "";
  try {
    out = execFileSync(
      "codex",
      ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "-C", "/tmp", prompt],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 240_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    out = String(error.stdout ?? "");
  }
  let text = "";
  let usage = { input_tokens: 0, output_tokens: 0 };
  for (const line of out.split("\n")) {
    if (line.trim() === "") continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const item = ev.item ?? ev.payload?.item;
    if (
      String(item?.type ?? "")
        .toLowerCase()
        .replace(/[_-]/g, "") === "agentmessage" &&
      typeof item?.text === "string"
    )
      text += `${item.text}\n`;
    if (ev.type === "turn.completed" && ev.usage) usage = ev.usage;
  }
  return { text, ms: Date.now() - started, tokens: usage.input_tokens + usage.output_tokens };
}

const squash = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

function parseBlock(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    const ran = Array.isArray(parsed.ran)
      ? parsed.ran.filter((r) => r && typeof r.cmd === "string")
      : null;
    const wrote = Array.isArray(parsed.wrote)
      ? parsed.wrote.filter((p) => typeof p === "string")
      : null;
    const read = Array.isArray(parsed.read)
      ? parsed.read.filter((p) => typeof p === "string")
      : null;
    if (!ran || !wrote || !read) return null;
    return { ran, wrote, read };
  } catch {
    return null;
  }
}

mkdirSync(OUT, { recursive: true });
const files = walk(SESSIONS)
  .filter((f) => f.size > 20_000)
  .sort((a, b) => b.mtime - a.mtime)
  .filter((f) => {
    const head = readFileSync(f.path, "utf8");
    if (head.includes(JUDGE_MARK) || head.includes("SUPPORTED（记录支持报告）")) return false;
    try {
      return JSON.parse(head.split("\n")[0]).payload?.cwd?.startsWith("/Users/") ?? false;
    } catch {
      return false;
    }
  })
  .slice(0, ROUNDS);

const rows = [];
for (const [i, file] of files.entries()) {
  const raw = readFileSync(file.path, "utf8");
  const receipts = receiptsOf(file.path);
  const answer = askBlock(digest(raw));
  const block = parseBlock(answer.text);

  const observedCmds = new Set((receipts?.commands ?? []).map((c) => squash(c.command)));
  const observedPaths = new Set((receipts?.paths ?? []).map((p) => squash(p)));
  const lastSeg = (p) => squash(p).split("/").pop();

  const matchedRan = block
    ? block.ran.filter((r) =>
        [...observedCmds].some(
          (o) => o === squash(r.cmd) || o.includes(squash(r.cmd)) || squash(r.cmd).includes(o),
        ),
      ).length
    : 0;
  const matchedWrote = block
    ? block.wrote.filter(
        (p) =>
          observedPaths.has(squash(p)) || [...observedPaths].some((o) => lastSeg(o) === lastSeg(p)),
      ).length
    : 0;

  rows.push({
    i: i + 1,
    file: file.path.replace(SESSIONS, "~/.codex/sessions"),
    compliant: block !== null,
    ran: block?.ran.length ?? 0,
    wrote: block?.wrote.length ?? 0,
    observedCmds: observedCmds.size,
    observedPaths: observedPaths.size,
    matchedRan,
    matchedWrote,
    coverage: observedCmds.size
      ? Math.round((matchedRan / Math.min(observedCmds.size, block?.ran.length || 1)) * 100)
      : 100,
    hallucinated: block && block.ran.length ? block.ran.length - matchedRan : 0,
    tokens: answer.tokens,
    ms: answer.ms,
    preview: answer.text.replace(/\s+/g, " ").slice(0, 160),
  });
  writeFileSync(`${OUT}/results.json`, JSON.stringify(rows, null, 2));
  console.error(
    `${rows.length}. compliant=${rows.at(-1).compliant} ran=${rows.at(-1).ran}/${observedCmds.size} wrote=${rows.at(-1).wrote}/${observedPaths.size}`,
  );
}
console.error(`\n完成 ${rows.length} 轮`);
