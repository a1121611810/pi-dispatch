// 运行中转向的确定性逻辑：信箱解析、标记、内容归一、退出对账。
// 变异器只看模块级函数——这些用例就是 steer.ts 的杀手。
//
// 等价变异（写不出不等价的可达输入）：
//   `seq <= afterSeq` → `< afterSeq` 不等价（seq == afterSeq 会重投），已被
//   「只返回 afterSeq 之后的行」钉住；`Number.isInteger(seq)` 与 `seq > 0`
//   各拦一类坏行，均已覆盖。
//   `text.trim() === ""` → `!text` 不等价（纯空白会漏），由「纯空白行跳过」钉住。
//   `sort` 的比较函数返回 0 时依赖插入序；输入是 Map 的首次出现序，
//   与 seq 升序不同，故「乱序输入按 seq 升序」能杀掉。
//
// 等价变异（mutator 报存活，可达输入上同值）：
//   steerSeqFromText 的 `split("\n", 1)[0] ?? ""` —— split 恒返回数组，`[0]` 至少是空串。
//   textOfContent 的 `Boolean(part) && ...` —— 假值元素过不了后续 object/type/text 检查。
//   parseSteerLines 的 `!value || typeof value !== "object"` —— 假值 JSON 的 seq 仍是 undefined，
//     下一道 seq 校验照样跳过。
//   parseSteerLines 第一处 `||` → `&&` —— 非 number 必然非 integer，`A && B` 与 `A` 同值。
//   parseSteerLines 的 at 第一处 `||` → `&&` —— 非 number 必然非 finite，`A && B` 与 `A` 同值；
//     第二处由 `1e999`（JSON.parse 成 Infinity）钉住。
//   lastDeliveredLine 的 `>` → `>=` —— 行号相等时赋的是同一个值。
//   reconcileSteerReceipts 的 `deliveredAt ?? now` → `||` —— 时间戳只会是正数，不会用 0。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isReportStale,
  lastDeliveredLine,
  MAX_STEER_CHARS,
  MAX_STEERS,
  parseSteerLines,
  planSteer,
  reconcileSteerReceipts,
  steerSeqFromText,
  steerTag,
  steerWire,
  tallySteers,
  textOfContent,
} from "../src/core/steer.ts";
import type { SteerRecord } from "../src/core/types.ts";

test("转向：标记只认首行，正文里的伪造不算", () => {
  assert.equal(steerSeqFromText("[pi-dispatch-steer #3]\n改方向"), 3);
  assert.equal(steerSeqFromText("[pi-dispatch-steer #1]"), 1, "seq 1 是合法起点");
  assert.equal(steerSeqFromText("先说话\n[pi-dispatch-steer #3]"), undefined);
  assert.equal(steerSeqFromText("正文 [pi-dispatch-steer #3]"), undefined);
  assert.equal(steerSeqFromText("[pi-dispatch-steer #0]"), undefined);
  assert.equal(steerSeqFromText("[pi-dispatch-steer #x]"), undefined);
  assert.equal(steerSeqFromText("[pi-dispatch-steer #3] 额外"), undefined);
  assert.equal(steerSeqFromText(" [pi-dispatch-steer #3]"), undefined);
  assert.equal(steerSeqFromText("[pi-dispatch-steer #3]\r"), undefined);
  assert.equal(steerSeqFromText(""), undefined);
});

test("转向：wire 首行是标记，正文原样另起一行", () => {
  assert.equal(steerTag(7), "[pi-dispatch-steer #7]");
  assert.equal(
    steerWire(7, "改方向"),
    "[pi-dispatch-steer #7]\n父方在你运行期间调整了方向；这是对当前任务的补充/修正，不是新任务：\n改方向",
  );
  assert.equal(steerSeqFromText(steerWire(7, "改方向")), 7, "wire 首行仍能被精确识别");
});

test("转向：content 的 string 与 text block 等价，thinking 不算", () => {
  assert.equal(textOfContent("原文"), "原文");
  assert.equal(
    textOfContent([
      { type: "thinking", thinking: "不要" },
      { type: "text", text: "第一段" },
      { type: "text", text: "第二段" },
    ]),
    "第一段\n第二段",
  );
  assert.equal(textOfContent([{ type: "image" }]), "");
  assert.equal(textOfContent(undefined), "");
});

test("转向：坏行/半行/纯空白不毒化，有效行按 seq 升序且同 seq 只取一次", () => {
  const raw = [
    '{"seq":2,"text":"乙","at":2}',
    "不是 JSON",
    '{"seq":1,"text":"甲","at":1}',
    '{"seq":1,"text":"重复","at":9}',
    '{"seq":3,"text":"   ","at":3}',
    '{"seq":4,"text":"半行"',
    "",
    '{"seq":5,"text":"丙","at":5}',
  ].join("\n");
  assert.deepEqual(
    parseSteerLines(raw).map((line) => [line.seq, line.text]),
    [
      [1, "甲"],
      [2, "乙"],
      [5, "丙"],
    ],
  );
  assert.deepEqual(
    parseSteerLines(raw, 2).map((line) => line.seq),
    [5],
  );
});

test("转向：空任务计数全零，不把 0 写成 1", () => {
  assert.deepEqual(tallySteers([]), { total: 0, delivered: 0, seen: 0, undelivered: 0 });
});

test("转向：混合状态计数——seen/delivered 算送达，其余算未送达", () => {
  const records: SteerRecord[] = [
    { seq: 1, text: "甲", at: 1, state: "sent" },
    { seq: 2, text: "乙", at: 2, state: "queued" },
    { seq: 3, text: "丙", at: 3, state: "delivered" },
    { seq: 4, text: "丁", at: 4, state: "seen" },
    { seq: 5, text: "戊", at: 5, state: "undelivered" },
  ];
  assert.deepEqual(tallySteers(records), {
    total: 5,
    delivered: 2,
    seen: 1,
    undelivered: 3,
  });
});

test("转向：afterSeq 等号不重投，正文 4096 放行、4097 跳过", () => {
  const exact = "x".repeat(MAX_STEER_CHARS);
  const raw = [
    JSON.stringify({ seq: 0, text: "零", at: 0 }),
    JSON.stringify({ seq: 2, text: "已投", at: 2 }),
    JSON.stringify({ seq: 3, text: exact, at: 3 }),
    JSON.stringify({ seq: 4, text: exact + "x", at: 4 }),
  ].join("\n");
  assert.deepEqual(
    parseSteerLines(raw, 2).map((line) => line.seq),
    [3],
  );
});

test("转向：非安全整数 seq / 超长正文不解析", () => {
  const raw = [
    '{"seq":1e21,"text":"大","at":1}',
    JSON.stringify({ seq: 2, text: "x".repeat(MAX_STEER_CHARS + 1), at: 2 }),
    JSON.stringify({ seq: 3, text: "正常", at: 3 }),
  ].join("\n");
  assert.deepEqual(
    parseSteerLines(raw).map((line) => line.seq),
    [3],
  );
});

test("转向：不传 afterSeq 时默认从 0 起，seq 1 也要返回", () => {
  const raw = JSON.stringify({ seq: 1, text: "甲", at: 1 });
  assert.deepEqual(
    parseSteerLines(raw).map((line) => line.seq),
    [1],
  );
});

test("转向：上限常量是 16 条 / 4096 字符", () => {
  assert.equal(MAX_STEERS, 16);
  assert.equal(MAX_STEER_CHARS, 4096);
});

test("转向：退出对账 seen > delivered > queued > undelivered，保留正文与时刻", () => {
  const records: SteerRecord[] = [
    { seq: 1, text: "甲", at: 1, state: "sent" },
    { seq: 2, text: "乙", at: 2, state: "sent" },
    { seq: 3, text: "丙", at: 3, state: "sent" },
    { seq: 4, text: "丁", at: 4, state: "sent" },
  ];
  const out = reconcileSteerReceipts(
    records,
    {
      queued: [{ seq: 3, line: 10 }],
      delivered: [
        { seq: 2, line: 20 },
        { seq: 3, line: 21 },
      ],
      seen: [{ seq: 2, line: 30 }],
      reportLine: 5,
    },
    99,
  );
  assert.deepEqual(
    out.map((record) => [record.seq, record.state, record.text, record.at]),
    [
      [1, "undelivered", "甲", 1],
      [2, "seen", "乙", 2],
      [3, "delivered", "丙", 3],
      [4, "undelivered", "丁", 4],
    ],
  );
  assert.equal(out[1]!.seenAt, 99);
  assert.equal(out[1]!.deliveredAt, 99, "sent 直接升 seen 也要补 deliveredAt");
  assert.equal(out[2]!.deliveredAt, 99);
});

test("转向：退出对账时只有 queued 证据的保留 queued，不并进 undelivered", () => {
  const out = reconcileSteerReceipts(
    [
      { seq: 1, text: "甲", at: 1, state: "sent" },
      { seq: 2, text: "乙", at: 2, state: "queued", queuedAt: 5 },
    ],
    { queued: [{ seq: 1, line: 10 }], delivered: [], seen: [] },
    99,
  );
  assert.deepEqual(
    out.map((record) => [record.seq, record.state]),
    [
      [1, "queued"],
      [2, "queued"],
    ],
  );
  assert.equal(out[0]!.queuedAt, 99, "sent 补成 queued 时记对账时刻");
  assert.equal(out[1]!.queuedAt, 5, "已是 queued 的不改时刻");
});

test("转向：最后一次送达的行号取最大，空证据没有行号", () => {
  assert.equal(
    lastDeliveredLine({
      queued: [],
      delivered: [
        { seq: 1, line: 7 },
        { seq: 2, line: 9 },
      ],
      seen: [],
    }),
    9,
  );
  assert.equal(lastDeliveredLine({ queued: [], delivered: [], seen: [] }), undefined);
});

test("转向：受理计划只认 running、4096/4097 边界、16 条与续号", () => {
  const base = {
    status: "running",
    text: "x",
    existing: [] as Array<{ seq: number; text: string; at: number }>,
    hasStorage: true,
    hasChildExtension: true,
  };
  assert.equal(planSteer({ ...base, status: "queued" }).ok, false);
  assert.equal(planSteer({ ...base, status: "succeeded" }).ok, false);
  assert.equal(planSteer({ ...base, hasStorage: false }).ok, false);
  assert.equal(planSteer({ ...base, hasChildExtension: false }).ok, false);
  assert.equal(planSteer({ ...base, text: "   " }).ok, false);
  assert.equal(planSteer({ ...base, text: 42 as unknown as string }).ok, false);
  assert.deepEqual(planSteer({ ...base, text: "x".repeat(4096) }), {
    ok: true,
    seq: 1,
    text: "x".repeat(4096),
  });
  assert.equal(planSteer({ ...base, text: "x".repeat(4097) }).ok, false);
  const sixteen = Array.from({ length: 16 }, (_, i) => ({ seq: i + 1, text: "x", at: i }));
  assert.equal(planSteer({ ...base, existing: sixteen }).ok, false);
  assert.equal(
    planSteer({ ...base, existing: [{ seq: Number.MAX_SAFE_INTEGER, text: "旧", at: 1 }] }).ok,
    false,
  );
  assert.deepEqual(planSteer({ ...base, existing: [{ seq: 7, text: "旧", at: 1 }] }), {
    ok: true,
    seq: 8,
    text: "x",
  });
});

test("转向：isReportStale 只在报告行早于最后送达时为 true", () => {
  const base = { queued: [], delivered: [{ seq: 1, line: 9 }], seen: [] };
  assert.equal(isReportStale({ ...base, reportLine: 5 }), true);
  assert.equal(isReportStale({ ...base, reportLine: 10 }), false);
  assert.equal(isReportStale({ ...base, reportLine: 9 }), false, "同行不算 stale");
  assert.equal(isReportStale({ ...base, reportLine: undefined }), false);
  assert.equal(
    isReportStale({ queued: [], delivered: [], seen: [], reportLine: 1 }),
    false,
    "没有送达不判",
  );
});

test("转向：at 非有限数（NaN/字符串）跳过，不毒化整批", () => {
  const raw = [
    JSON.stringify({ seq: 1, text: "甲", at: Number.NaN }),
    JSON.stringify({ seq: 2, text: "乙", at: "10" }),
    JSON.stringify({ seq: 3, text: "丙", at: 10 }),
  ].join("\n");
  assert.deepEqual(
    parseSteerLines(raw).map((line) => line.seq),
    [3],
  );
});

test("转向：对账输出按 seq 升序，不靠输入顺序", () => {
  const records: SteerRecord[] = [
    { seq: 2, text: "乙", at: 2, state: "sent" },
    { seq: 1, text: "甲", at: 1, state: "sent" },
  ];
  assert.deepEqual(
    reconcileSteerReceipts(records, { queued: [], delivered: [], seen: [] }, 99).map((r) => r.seq),
    [1, 2],
  );
});

test("转向：at 为 1e999（Infinity）时跳过", () => {
  const raw = '{"seq":1,"text":"甲","at":1e999}\n{"seq":2,"text":"乙","at":10}';
  assert.deepEqual(
    parseSteerLines(raw).map((line) => line.seq),
    [2],
  );
});
