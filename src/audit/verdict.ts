// 判词。只做判断，不读磁盘、不看时钟——所有输入都是调用方给的事件数组。
//
// 与 core 的 `deliverableOf` 有四处**已知分歧**（这边按 spec 的顺序，core 保持原样）：
//   1. `stale + partial`：core 给 partial，这里给 unverified；
//   2. 整维零命中（如路径 1/1 命中、命令 0/1）：core 给 unverified，这里按全局并集给 partial；
//   3. `receiptGap` 在 core 里排在 partial 之后，这里排在 partial 之前；
//   4. 只有「报告里出现完成词」这一条还分歧：core 不看完成词，这里判 `unverified`。
//      （零自述 + 路径收据已统一成 `unclaimed` + note `no auditable claim`。）
// 不复用 `deliverableOf` 的判词链，也不复用 `claimSatisfied`（内部有整串快路，且 wantOk
// 是从 exitCode 推的）——只复用 `scanCommand` / `segmentsMatch` 两个原语。
import { pathMatches, scanCommand, segmentsMatch } from "../core/child.ts";
import type { Deliverable } from "../core/types.ts";
import { extractClaims, normalizePath } from "./claims.ts";
import type {
  AuditOptions,
  AuditResult,
  ClaimSet,
  CommandClaim,
  CommandReceipt,
  ExtractedClaims,
  Receipts,
  SessionEvent,
} from "./types.ts";

const DEFAULT_MAX = Number.POSITIVE_INFINITY;

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

/** 命令自述有没有被某条收据兑现。 */
export function claimHit(claim: CommandClaim, receipts: CommandReceipt[]): boolean {
  return receipts.some((receipt) => claimHitIn(claim, receipt));
}

/**
 * 一条自述能不能被**这一条**收据兑现。
 *
 * - 声称跑通（wantOk）：要 exitCode 0，且命中段的 `known` 为真；
 * - 声称失败（wantOk=false）：要 exitCode 非零，且命中段的 `failed` 为真
 *   （`a && b` 退 1 时两边都不可推，不能把「b 失败了」算成兑现）。
 */
export function claimHitIn(claim: CommandClaim, receipt: CommandReceipt): boolean {
  const segs = scanCommand(claim.command, true).filter((seg) => seg.tokens.length > 0);
  if (segs.length === 0) return false;
  const usable = claim.wantOk
    ? receipt.exitCode === 0
    : typeof receipt.exitCode === "number" && receipt.exitCode !== 0;
  if (!usable) return false;

  // 整串快路只在自述不含任何分隔符时启用：含分隔符的自述必须逐段校验。
  if (!/[|;&\n]/.test(claim.command)) {
    const target = squash(claim.command);
    if (squash(receipt.command) === target) return true;
  }

  return segs.every((seg) =>
    scanCommand(receipt.command, false).some(
      (os) => (claim.wantOk ? os.known : os.failed) && segmentsMatch(seg.tokens, os.tokens, false),
    ),
  );
}

/** 从事件里收收据。路径保最先 N 条、命令保最近 N 条——与 core 一致。 */
/** 这条 shell 命令把内容写进了哪些文件（`>` / `>>` / `tee`）。 */
function redirectTargets(command: string): string[] {
  // 引号里的 `>` 不是重定向：先把引号内容抹成空串再扫。
  const bare = command.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  const out: string[] = [];
  const push = (target: string): void => {
    if (target.startsWith("&") || target.startsWith("/dev/") || target === "") return;
    if (!looksLikeWrittenFile(target)) return;
    if (!out.includes(target)) out.push(target);
  };
  for (const m of bare.matchAll(/(?:^|[\s;&|(])\d?>>?\s*([^\s;&|)<]+)/g)) push(m[1]!);
  for (const m of bare.matchAll(/(?:^|[\s;&|(])tee\s+(?:-a\s+)?([^\s;&|)]+)/g)) push(m[1]!);
  return out;
}

/** 只认「像文件」的目标：带目录，或带字母扩展名（`out.txt`）。 */
function looksLikeWrittenFile(target: string): boolean {
  if (target.includes("/")) return true;
  return /^[^\s/]+\.[A-Za-z][\w-]{0,9}$/.test(target);
}

export function collectReceipts(
  events: readonly SessionEvent[],
  max = DEFAULT_MAX,
): { receipts: Receipts; pathsTruncated: boolean; commandsTruncated: boolean } {
  const paths: string[] = [];
  const commands: CommandReceipt[] = [];
  let pathsTruncated = false;
  let commandsTruncated = false;

  for (const event of events) {
    if (event.kind !== "tool") continue;
    if (event.name === "write") {
      const raw = event.input.path;
      if (typeof raw !== "string" || raw === "") continue;
      const path = normalizePath(raw, event.cwd);
      if (paths.includes(path)) continue;
      if (paths.length >= max) {
        pathsTruncated = true;
        continue;
      }
      paths.push(path);
      continue;
    }
    if (event.name === "bash") {
      const command = event.input.command;
      if (typeof command !== "string" || command.trim() === "") continue;
      // shell 重定向也是写盘：`printf x > out.txt` 之后说「已写入 out.txt」不算空口。
      if (typeof event.exitCode !== "number" || event.exitCode === 0) {
        for (const target of redirectTargets(command)) {
          const path = normalizePath(target, event.cwd);
          if (paths.includes(path)) continue;
          if (paths.length >= max) {
            pathsTruncated = true;
            continue;
          }
          paths.push(path);
        }
      }
      commands.push({
        command,
        ...(typeof event.exitCode === "number" ? { exitCode: event.exitCode } : {}),
        trusted: typeof event.exitCode === "number",
      });
      if (commands.length > max) {
        commands.shift();
        commandsTruncated = true;
      }
    }
  }

  return { receipts: { paths, commands }, pathsTruncated, commandsTruncated };
}

export interface VerdictFacts {
  hasBody: boolean;
  pathsTruncated: boolean;
  truncated: boolean;
  stale: boolean;
  total: number;
  hits: number;
  /** 完成词绑到一条「没命中 / 跑过但失败」的命令 */
  vagueBoundMissed: boolean;
  /** 完成词绑不到任何命令 */
  vagueUnbound: boolean;
  /** 只在零自述时算数：有路径收据 */
  hasPathReceipts: boolean;
  notes: string[];
}

/**
 * 九条判定链，顺序即优先级，每条 return。
 * `notes` 是副作用：`stale` 与 `vague` 各自往里写一句。
 */
export function verdictOf(facts: VerdictFacts): Deliverable {
  if (!facts.hasBody && !facts.hasPathReceipts && !facts.pathsTruncated) return "absent";
  if (!facts.hasBody) return "unverified";
  if (facts.stale) {
    facts.notes.push("report predates last steer");
    return "unverified";
  }
  if (facts.vagueBoundMissed) {
    facts.notes.push("vague success claim");
    return "unverified";
  }
  if (facts.total === 0 && facts.vagueUnbound) {
    facts.notes.push("vague success claim");
    return "unverified";
  }
  if (facts.total === 0) {
    // 零自述就是没有可核对的东西。有收据只说明「动过手」，不说明「声称过」。
    if (facts.hasPathReceipts) facts.notes.push("no auditable claim");
    return "unclaimed";
  }
  if (facts.total > 0 && facts.hits === 0) return "unverified";
  if (facts.truncated && facts.hits < facts.total) return "unverified";
  if (facts.hits > 0 && facts.hits < facts.total) return "partial";
  if (facts.hits === facts.total && facts.total > 0) return "verified";
  return "unverified";
}

/** 报告在流里的位置：最后一条主链 assistant 文本；没有就落到流末尾。 */
function reportIndex(events: readonly SessionEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === "message" && e.role === "assistant" && !e.sidechain && e.text.trim() !== "") {
      return i;
    }
  }
  return events.length;
}

function lastAssistantText(events: readonly SessionEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === "message" && e.role === "assistant" && !e.sidechain) {
      if (e.text.trim() !== "") return e.text;
    }
  }
  return undefined;
}

function lastSteerIndex(events: readonly SessionEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === "message" && e.role === "user" && e.steer === true) return i;
  }
  return -1;
}

const toClaimSet = (claims: ExtractedClaims): ClaimSet => ({
  paths: [...claims.paths],
  commands: claims.commands.map((c) => c.command),
});

/**
 * 审一段会话。
 *
 * - `events`：按时间顺序的归一化事件；
 * - `report`：agent 最后写给用户的那段话；`null` 时用流里最后一条主链 assistant 文本；
 * - `opts.cwd`：解析 `..` 的基准；相对路径当 `/`。
 */
export function audit(
  events: readonly SessionEvent[],
  report: string | null,
  opts: AuditOptions = {},
): AuditResult {
  const max = opts.maxReceipts ?? DEFAULT_MAX;
  const collected = collectReceipts(events, max);
  const { receipts } = collected;
  // 上游截断与本地截断取「或」：任何一处丢过证据都算截断，不能被另一处洗白。
  const pathsTruncated = collected.pathsTruncated || opts.pathsTruncated === true;
  const commandsTruncated = collected.commandsTruncated || opts.commandsTruncated === true;

  const text = (report ?? lastAssistantText(events) ?? "").trim();
  const hasBody = text !== "";
  const claims = opts.claims ?? extractClaims(text);

  const pathHits = claims.paths.filter((claim) =>
    receipts.paths.some((path) => pathMatches(normalizePath(claim, opts.cwd), path)),
  );
  const commandHits = claims.commands.filter((claim) => claimHit(claim, receipts.commands));

  const total = claims.paths.length + claims.commands.length;
  const hits = pathHits.length + commandHits.length;

  // 完成词只有在「绑到一条声称成功且命中的命令」时才不扣分；
  // 绑到「跑过但失败」的命令，等于拿失败当交付。
  const vagueBoundMissed = claims.vagueBindings.some((binding) => {
    if (binding === null) return false;
    const bound = claims.commands[binding]!;
    return !bound.wantOk || !commandHits.includes(bound);
  });
  const vagueUnbound = claims.vagueBindings.some((binding) => binding === null);

  const notes: string[] = [];
  const deliverable = verdictOf({
    hasBody,
    pathsTruncated,
    truncated: pathsTruncated || commandsTruncated,
    stale: lastSteerIndex(events) > reportIndex(events),
    total,
    hits,
    vagueBoundMissed,
    vagueUnbound,
    hasPathReceipts: receipts.paths.length > 0,
    notes,
  });

  // 诚实的负评也要能被认出来：判词是 verified，但它兑现的是「失败」。
  if (deliverable === "verified") {
    const negative = claims.commands.filter(
      (claim) => !claim.wantOk && commandHits.includes(claim),
    );
    const lastRight = negative.some((claim) => {
      const matched = receipts.commands.filter((receipt) => claimHitIn(claim, receipt));
      const last = matched.at(-1);
      return last !== undefined && typeof last.exitCode === "number" && last.exitCode !== 0;
    });
    if (lastRight) notes.push("self-reported failure");
  }

  const matchedPaths = new Set(pathHits);
  const matchedCommands = new Set(commandHits.map((c) => c.command));

  return {
    deliverable,
    claims: toClaimSet(claims),
    receipts,
    mismatch: {
      paths: claims.paths.filter((p) => !matchedPaths.has(p)),
      commands: claims.commands.map((c) => c.command).filter((c) => !matchedCommands.has(c)),
    },
    truncated: pathsTruncated || commandsTruncated,
    notes,
  };
}
