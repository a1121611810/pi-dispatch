// 散文 → 自述。这是本产品唯一没有标准答案的一环，所以规则写死成闭集，
// 剩下的（比喻、代词、非英文动词）进盲区。
import { posix } from "node:path";
import type { CommandClaim, ExtractedClaims } from "./types.ts";

/** 命令首 token 的闭集。不在里面的不当命令自述（`ls` / `cat` 这类也不认）。 */
const RUNNERS = new Set([
  "pnpm",
  "npm",
  "npx",
  "yarn",
  "bun",
  "node",
  "tsc",
  "vitest",
  "jest",
  "pytest",
  "cargo",
  "go",
  "make",
  "git",
]);

const CHANGE_VERB =
  /改|修改|新增|新建|删除|写入|implemented|changed|added|created|wrote|updated|fixed/gi;
const READ_VERB = /读|看了|查看|检查|搜索|grep|read|inspected|checked|reviewed|scanned/gi;
/** 失败词。裸「红」不算（「红利 / 红灯」会误伤）。 */
const FAIL_WORD = /失败|报错|挂了|failed|error|failing|not ok|未通过|没通过|没有通过/gi;
/** 完成词。`完成` 单独不算，除非同句有 实现 / 修复 / 改动。 */
const DONE_WORD =
  /已实现|已修复|已通过|全部通过|测试通过|全绿|fixed|implemented|passed|all tests pass/gi;
const DONE_LOOSE = /完成/;
const DONE_NEEDS = /实现|修复|改动/;
/** 否定词。`no` / `not` 带词边界，否则 `node` 里的 `no` 会误伤；裸 `0`/`零` 不收。 */
const NEG =
  /没有|没|未(?!来|知|必|免)|无|不是|并非|不算|\bnot\b|\bno\b|\bnever\b|\bdidn't\b|\bwithout\b/gi;
/** 自己就是失败短语，不能被自己的「未 / not」当成否定。 */
const FAIL_PHRASES = ["未通过", "没通过", "没有通过", "not ok"];
/** 说「这条没跑」的说法：它不能当完成词的绑定目标。 */
const NOT_RUN = /(?:没跑|未跑|未执行|没有运行|didn't run)\s*$/i;

const EXT = /^[\w-]{1,10}$/;

/** 句子分隔：句号/问号/叹号/换行/分号，以及「句点+空白」。反引号与围栏内部不切。 */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inCode = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "`") {
      inCode = !inCode;
      cur += ch;
      continue;
    }
    if (!inCode) {
      const hard = "。！？!?\n;；".includes(ch);
      const dot = ch === "." && /\s/.test(text[i + 1] ?? "");
      if (hard || dot) {
        out.push(cur);
        cur = "";
        continue;
      }
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s !== "");
}

/** 小句分隔：中英文逗号、顿号、转折/顺承多字词。单字 就/并/且/再 不切（会切在词内）。 */
const CONJ = /\s*(?:但是|不过|然而|而是|然后|之后|随后|但|却|but|however|then)\s*/i;

function splitClauses(sentence: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inCode = false;
  for (const ch of sentence) {
    if (ch === "`") inCode = !inCode;
    if (!inCode && "，,、".includes(ch)) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out
    .flatMap((c) => c.split(CONJ))
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** 把四个失败短语抹成等长空格：算否定辖域时它们不算否定。 */
function maskFailPhrases(text: string): string {
  let out = text;
  for (const phrase of FAIL_PHRASES) {
    out = out.replace(new RegExp(phrase, "gi"), (m) => " ".repeat(m.length));
  }
  return out;
}

/** 位置 `at` 是否落在某个否定辖域里（否定词后 12 字以内）。 */
function isNegated(clause: string, at: number): boolean {
  const masked = maskFailPhrases(clause);
  const re = new RegExp(NEG.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const start = m.index;
    if (start >= at) break;
    if (at - start <= 12) return true;
  }
  return false;
}

interface Tok {
  t: "cmd" | "path" | "verb-change" | "verb-read" | "fail" | "done";
  v?: string;
  at: number;
}

/** 这一段的原文里，按出现顺序列出命令 / 路径 / 动词 / 失败词 / 完成词。 */
function tokensOf(clause: string): Tok[] {
  const toks: Tok[] = [];

  // 反引号里的东西：命令（首 token 是 runner）或路径。
  const codeSpans: Array<[number, number, string]> = [];
  const re = /`([^`]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clause)) !== null) {
    const inner = m[1]!.trim();
    codeSpans.push([m.index, m.index + m[0].length, inner]);
    const head = inner.split(/\s+/)[0] ?? "";
    if (RUNNERS.has(head)) toks.push({ t: "cmd", v: inner, at: m.index });
    else if (looksLikePath(inner)) toks.push({ t: "path", v: inner, at: m.index });
  }
  const inSpan = (at: number): boolean => codeSpans.some(([start, end]) => at >= start && at < end);

  // 裸 token：含 `/` 且末段带扩展名才算路径（`README.md` 这种没斜杠的不算）。
  for (const m2 of clause.matchAll(/[^\s`'"()（）[\]]+/g)) {
    const raw = m2[0]!.replace(/[.,;:。，；]+$/, "");
    if (!looksLikePath(raw)) continue;
    if (inSpan(m2.index ?? 0)) continue;
    toks.push({ t: "path", v: raw, at: m2.index ?? 0 });
  }

  for (const m3 of clause.matchAll(CHANGE_VERB)) toks.push({ t: "verb-change", at: m3.index ?? 0 });
  for (const m4 of clause.matchAll(READ_VERB)) toks.push({ t: "verb-read", at: m4.index ?? 0 });
  for (const m5 of clause.matchAll(FAIL_WORD)) toks.push({ t: "fail", at: m5.index ?? 0 });
  for (const m6 of clause.matchAll(DONE_WORD)) toks.push({ t: "done", at: m6.index ?? 0 });
  if (DONE_LOOSE.test(clause) && DONE_NEEDS.test(clause)) {
    const at = clause.search(DONE_LOOSE);
    if (at >= 0) toks.push({ t: "done", at });
  }

  return toks.sort((a, b) => a.at - b.at);
}

/** 带斜杠、末段带扩展名、不是 URL。 */
function looksLikePath(raw: string): boolean {
  if (raw.includes("://") || !raw.includes("/")) return false;
  const last = raw.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  if (dot <= 0) return false;
  return EXT.test(last.slice(dot + 1));
}

/** 相对路径只归一写法；带 `..` 的才按 cwd 解析成绝对路径。 */
export function normalizePath(raw: string, cwd?: string): string {
  let p = raw.trim().replace(/\\/g, "/").replace(/\/+$/, "").replace(/^\.\//, "");
  if (!p.includes("..")) return p;
  const base = typeof cwd === "string" && posix.isAbsolute(cwd) ? cwd : "/";
  p = posix.resolve(base, p);
  return p;
}

/**
 * 从报告正文抽自述。
 *
 * 三条绑定规则（顺序即优先级）：
 *   路径 → 「同一句子里最近的前置动词」属于改动闭集才算改动自述；
 *   失败词 → 绑「最近的前置命令」，把那条命令降成「只声称跑过」；
 *   完成词 → 先在本句找前置命令，找不到再绑上一句的最后一条。
 */
export function extractClaims(report: string): ExtractedClaims {
  const paths: string[] = [];
  const commands: CommandClaim[] = [];
  const vagueBindings: Array<number | null> = [];
  let prevSentenceLastCmd: number | null = null;

  for (const sentence of splitSentences(report)) {
    let lastVerb: "change" | "read" | null = null;
    let lastCmd: number | null = null;
    const doneToks: Tok[] = [];

    for (const clause of splitClauses(sentence)) {
      for (const tok of tokensOf(clause)) {
        // 说「这条没跑」的命令不当绑定目标（完成词用它会把诚实报告判成谎报）。
        const notRun = tok.t === "cmd" && NOT_RUN.test(clause.slice(0, tok.at));
        switch (tok.t) {
          case "verb-change":
            if (!isNegated(clause, tok.at)) lastVerb = "change";
            break;
          case "verb-read":
            if (!isNegated(clause, tok.at)) lastVerb = "read";
            break;
          case "cmd":
            commands.push({ command: tok.v!, wantOk: true });
            if (!notRun) lastCmd = commands.length - 1;
            break;
          case "path":
            if (lastVerb === "change" && !isNegated(clause, tok.at)) paths.push(tok.v!);
            break;
          case "fail":
            // 「没失败」「0 报错」不算失败。
            if (lastCmd !== null && !isNegated(clause, tok.at)) commands[lastCmd]!.wantOk = false;
            break;
          case "done":
            if (!isNegated(clause, tok.at)) doneToks.push(tok);
            break;
        }
      }
    }

    for (const _ of doneToks) {
      vagueBindings.push(lastCmd ?? prevSentenceLastCmd);
    }
    prevSentenceLastCmd = lastCmd ?? prevSentenceLastCmd;
  }

  const seen = new Set<string>();
  const uniquePaths = paths.filter((p) => {
    const key = p;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { paths: uniquePaths, commands, vagueBindings };
}
