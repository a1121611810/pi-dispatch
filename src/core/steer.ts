import { hasC0, type SteerRecord, type SteerState } from "./types.ts";

/** 一条任务上所有转向的计数：送达 = 进了 transcript（delivered + seen）；其余都算未送达。 */
export interface SteerTally {
  total: number;
  /** 进了孩子 transcript 的条数（delivered + seen） */
  delivered: number;
  /** 回显之后确实又发生过一次 LLM 回合的条数 */
  seen: number;
  /** 只写了盘、没有 transcript 证据的条数（sent + queued + undelivered） */
  undelivered: number;
}

/** 从逐条收据算通知/汇总用的计数。写盘 ≠ 孩子看到：只有 delivered/seen 才算送达。 */
export function tallySteers(records: readonly SteerRecord[]): SteerTally {
  let delivered = 0;
  let seen = 0;
  let undelivered = 0;
  for (const record of records) {
    if (record.state === "seen") {
      seen += 1;
      delivered += 1;
    } else if (record.state === "delivered") {
      delivered += 1;
    } else {
      undelivered += 1;
    }
  }
  return { total: records.length, delivered, seen, undelivered };
}

// 运行中转向：父方写文件，孩子在 turn_end 读新行并作为 steer 交给 pi。
// 这里只放确定性逻辑——变异器只看模块级函数（类私有 # 方法在账本里零站点）。

/** 一个任务最多 16 条转向。 */
export const MAX_STEERS = 16;
/** 单条转向正文最多 4096 字符（trim 后）。 */
export const MAX_STEER_CHARS = 4096;

/**
 * 单条转向 JSON 编码后的上限。
 * 算术：16 条 × 15 KiB ≈ 240 KiB < 信箱读上限 256 KiB（MAX_STEER_INBOX_BYTES）。
 * 按「JSON 编码后」算才准：孤立代理项被转义成 6 字节（1 个 UTF-16 单元 → 6 字节），
 * 那才会撑爆信箱；按原始 UTF-8 字节算会把 4096 个汉字（12 KiB）误拒。
 */
export const MAX_STEER_JSON_BYTES = 15 * 1024;

/** 首行标记：整行必须正好是标记——正文/前后缀伪造不算。 */
const STEER_MARKER_RE = /^\[pi-dispatch-steer #(\d+)\]$/;

export function steerTag(seq: number): string {
  return `[pi-dispatch-steer #${seq}]`;
}

/** 投给孩子的 wire 文本：首行标记 + 一句「不是新任务」，正文另起一行原样。 */
export function steerWire(seq: number, text: string): string {
  return `${steerTag(seq)}\n父方在你运行期间调整了方向；这是对当前任务的补充/修正，不是新任务：\n${text}`;
}

/** 从一段文本的首行取 seq；不是精确标记就 undefined。 */
export function steerSeqFromText(text: string): number | undefined {
  const firstLine = text.split("\n", 1)[0] ?? "";
  const match = STEER_MARKER_RE.exec(firstLine);
  if (!match) return undefined;
  const seq = Number(match[1]);
  return Number.isInteger(seq) && seq > 0 ? seq : undefined;
}

/** user/steering 的 content 可能是 string，也可能是 text block 数组；其余形状为空。 */
export function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        Boolean(part) &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

/** 信箱的一行。坏行/半行跳过，不毒化整批。 */
export interface SteerLine {
  seq: number;
  text: string;
  at: number;
}

/** 解析 steer.jsonl，只返回 seq > afterSeq 的有效行；按 seq 升序、同 seq 取第一条。 */
export function parseSteerLines(raw: string, afterSeq = 0): SteerLine[] {
  const bySeq = new Map<number, SteerLine>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue; // 半行/坏 JSON：跳过，不毒化整批
    }
    if (!value || typeof value !== "object") continue;
    const seq = (value as { seq?: unknown }).seq;
    const text = (value as { text?: unknown }).text;
    const at = (value as { at?: unknown }).at;
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= afterSeq || seq <= 0)
      continue;
    if (typeof text !== "string" || text.trim() === "" || text.length > MAX_STEER_CHARS) continue;
    if (typeof at !== "number" || !Number.isFinite(at)) continue;
    if (!bySeq.has(seq)) bySeq.set(seq, { seq, text, at });
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** 受理一次转向所需的全部事实；`steer()` 只把这个结果落盘/入账。 */
export interface SteerPlanInput {
  status: string;
  text: string;
  existing: readonly SteerLine[];
  hasStorage: boolean;
  hasChildExtension: boolean;
}

export type SteerPlan = { ok: true; seq: number; text: string } | { ok: false; error: string };

/**
 * 运行中转向的受理规则（纯函数，变异器可见）：
 * 只 running；trim 后非空且 ≤4096；已有信箱至多 16 条；seq 接在最后一条之后。
 */
export function planSteer(input: SteerPlanInput): SteerPlan {
  if (input.status !== "running")
    return { ok: false, error: `task is ${input.status}, not running` };
  if (!input.hasStorage) return { ok: false, error: "steering needs storage" };
  if (!input.hasChildExtension) return { ok: false, error: "steering needs the child extension" };
  if (typeof input.text !== "string") return { ok: false, error: "steer message must be a string" };
  const trimmed = input.text.trim();
  if (!trimmed) return { ok: false, error: "empty steer message" };
  if (trimmed.length > MAX_STEER_CHARS)
    return { ok: false, error: `steer message exceeds ${MAX_STEER_CHARS} chars` };
  // 体积上限按 JSON 编码后算：16 条 × 15KiB ≈ 240KiB < 信箱 256KiB 读上限。
  if (Buffer.byteLength(JSON.stringify(trimmed), "utf8") > MAX_STEER_JSON_BYTES)
    return {
      ok: false,
      error: `steer message exceeds ${MAX_STEER_JSON_BYTES} bytes after JSON encoding`,
    };
  // C0 控制字符（NUL 等）不许进信箱：JSON.stringify 会把它转义成 6 字节，撑爆读上限
  if (hasC0(trimmed)) return { ok: false, error: "steer message contains control characters" };
  if (input.existing.length >= MAX_STEERS)
    return { ok: false, error: `task already has ${MAX_STEERS} steers` };
  const last = input.existing[input.existing.length - 1];
  if (last && last.seq >= Number.MAX_SAFE_INTEGER)
    return { ok: false, error: "steering sequence exhausted" };
  const seq = last ? last.seq + 1 : 1;
  return { ok: true, seq, text: trimmed };
}

/** 解析出的投递证据；行号用于判断报告是否早于最后一次送达。 */
export interface SteerEvidence {
  queued: Array<{ seq: number; line: number }>;
  delivered: Array<{ seq: number; line: number }>;
  seen: Array<{ seq: number; line: number }>;
  /** 工具通道报告到达的行；prompt 通道没有行，判不了就不判。 */
  reportLine?: number;
}

/**
 * 退出时把运行中只记了 sent 的收据，按证据补成终态。
 * 优先级：seen > delivered > queued > sent→undelivered。终态不降级。
 */
export function reconcileSteerReceipts(
  records: readonly SteerRecord[],
  evidence: SteerEvidence,
  now: number,
): SteerRecord[] {
  const seen = new Set(evidence.seen.map((item) => item.seq));
  const delivered = new Set(evidence.delivered.map((item) => item.seq));
  const queued = new Set(evidence.queued.map((item) => item.seq));
  return records
    .map((record): SteerRecord => {
      const state: SteerState =
        record.state === "seen" || seen.has(record.seq)
          ? "seen"
          : record.state === "delivered" || delivered.has(record.seq)
            ? "delivered"
            : record.state === "queued" || queued.has(record.seq)
              ? "queued"
              : "undelivered";
      if (state === record.state) return record;
      if (state === "seen")
        return { ...record, state, deliveredAt: record.deliveredAt ?? now, seenAt: now };
      if (state === "delivered") return { ...record, state, deliveredAt: now };
      if (state === "queued") return { ...record, state, queuedAt: now };
      return { ...record, state };
    })
    .sort((a, b) => a.seq - b.seq);
}

/** 最后一次进入孩子上下文的转向行。 */
export function lastDeliveredLine(evidence: SteerEvidence): number | undefined {
  let last: number | undefined;
  for (const item of evidence.delivered) {
    if (last === undefined || item.line > last) last = item.line;
  }
  return last;
}

/** 报告早于最后一次送达才算 stale；没有报告行或没有送达证据都不判。 */
export function isReportStale(evidence: SteerEvidence): boolean {
  const delivered = lastDeliveredLine(evidence);
  return (
    evidence.reportLine !== undefined && delivered !== undefined && delivered > evidence.reportLine
  );
}
