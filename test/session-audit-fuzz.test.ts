// 行为指纹：60 条确定性生成的报告 × 固定事件集，逐条比 claims / 判词 / mismatch / notes。
//
// 为什么要有它：手写用例只能钉住想得到的情况，变异测试里死不掉的那批（索引挪一位、
// 边界改一个数、`&&` 写成 `||`）恰恰落在「想不到但可达」的输入上。这份语料用固定
// 种子生成，覆盖动词/路径/命令/否定/失败词/完成词/各种标点的组合；任何一处行为漂移
// 都会让某条指纹变化。
//
// 行为**故意**变了（改判词规则）时，重新生成指纹：把 EXPECTED 换成打印出来的新值，
// 并在提交信息里写清为什么变。
import { test } from "node:test";
import assert from "node:assert/strict";
import { audit, extractClaims } from "../src/audit/index.ts";
import type { SessionEvent } from "../src/audit/index.ts";

const VERBS = ["改", "修改", "读了", "查看", "没有修改", "未改动", "新增", "删除"];
const NOUNS = ["`src/a.ts`", "`src/b.ts`", "`/repo/lib/c.ts`", "`a`", "`README.md`"];
const CMDS = ["`pnpm test`", "`pnpm lint`", "`node ./x.ts`", "`ls`"];
const TAILS = ["。", "，", "；", ". ", "\n"];
const WORDS = ["失败", "报错", "通过", "已修复", "全部通过", "未通过", "完成", "实现了"];

/** 固定种子的线性同余，任何时候都生成同一份语料。 */
function corpus(): string[] {
  let seed = 42;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)]!;
  const out: string[] = [];
  for (let i = 0; i < 60; i++) {
    const parts: string[] = [];
    const n = 2 + Math.floor(rnd() * 4);
    for (let k = 0; k < n; k++) {
      const r = rnd();
      if (r < 0.35) parts.push(`${pick(VERBS)} ${pick(NOUNS)}`);
      else if (r < 0.7) parts.push(pick(CMDS));
      else parts.push(pick(WORDS));
      parts.push(pick(TAILS));
    }
    out.push(parts.join(""));
  }
  return out;
}

const EVENTS: SessionEvent[] = [
  { kind: "tool", name: "write", input: { path: "src/a.ts" } },
  { kind: "tool", name: "bash", input: { command: "pnpm test" }, exitCode: 0 },
  { kind: "tool", name: "bash", input: { command: "pnpm lint" }, exitCode: 1 },
];

function fingerprintOf(value: unknown): string {
  const json = JSON.stringify(value);
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16);
}

function fingerprint(text: string): string {
  const claims = extractClaims(text);
  const result = audit(EVENTS, text);
  return fingerprintOf({
    claims,
    verdict: result.deliverable,
    mismatch: result.mismatch,
    notes: result.notes,
  });
}

const EXPECTED_SCENARIOS: string[] = [
  "11f739d2",
  "9656bf01",
  "8d66c386",
  "f08d2de5",
  "2c3fce45",
  "26fc86ca",
  "11f739d2",
  "853ea80f",
  "cefa3791",
  "977f1081",
  "50bb77a6",
  "134ffabf",
  "f08d2de5",
  "650c9571",
  "11f739d2",
  "c2481c83",
  "134ffabf",
  "853ea80f",
  "2c3fce45",
  "cefa3791",
  "c52c5e0a",
  "3268de96",
  "c7df25df",
  "8aa98f75",
  "c225e65e",
  "d643b4c",
  "c52c5e0a",
  "91b81913",
  "7c7dc5a5",
  "5d436353",
  "b8d3602e",
  "8eeb2c16",
  "8aa98f75",
  "4ac74abc",
  "c52c5e0a",
  "e846bd79",
  "8eeb2c16",
  "91b81913",
  "c225e65e",
  "7c7dc5a5",
  "20987048",
  "a3a5d901",
  "7527c17c",
  "79b82d9f",
  "708471a5",
  "152e69d8",
  "20987048",
  "66bb72ef",
  "96ca0493",
  "20bde5bb",
  "a61acb16",
  "8312a4af",
  "79b82d9f",
  "5a389caf",
  "20987048",
  "af0a3db3",
  "8312a4af",
  "66bb72ef",
  "708471a5",
  "96ca0493",
  "4699d619",
  "1c22f8ae",
  "5806b89d",
  "4213a350",
  "f919fde",
  "6bc73052",
  "4699d619",
  "cb7648f6",
  "a0202fd0",
  "1e49a558",
  "b54c98ef",
  "b0ea11d2",
  "4213a350",
  "c375c3b4",
  "4699d619",
  "d55cc066",
  "b0ea11d2",
  "cb7648f6",
  "f919fde",
  "a0202fd0",
  "b9d70d46",
  "d9147005",
  "f125741c",
  "6689a21",
  "32a84375",
  "4ae202f",
  "b9d70d46",
  "19aa13bd",
  "53aaf05",
  "631a401f",
  "103d4712",
  "e807de0a",
  "6689a21",
  "a7426bd1",
  "b9d70d46",
  "d52593c5",
  "e807de0a",
  "19aa13bd",
  "32a84375",
  "53aaf05",
];

const EXPECTED = [
  "faf30a68",
  "a5525774",
  "f2d3b592",
  "cdba8d16",
  "abb9ae01",
  "19009f02",
  "faf30a68",
  "627930bc",
  "d846a19f",
  "286ffdfc",
  "4c94d64f",
  "783db7bc",
  "cdba8d16",
  "ccef9213",
  "faf30a68",
  "718eaa3d",
  "783db7bc",
  "627930bc",
  "abb9ae01",
  "d846a19f",
  "8358ce1",
  "eac94636",
  "cdba8d16",
  "d846a19f",
  "4c94d64f",
  "faf30a68",
  "ef1a3e39",
  "f504fa2e",
  "5524bbff",
  "283ad475",
  "783db7bc",
  "4ee5089",
  "a1388c1d",
  "627930bc",
  "f127b1db",
  "783db7bc",
  "cdba8d16",
  "d31940b1",
  "5524bbff",
  "283ad475",
  "286ffdfc",
  "faf30a68",
  "faf30a68",
  "286ffdfc",
  "faf30a68",
  "4c94d64f",
  "faf30a68",
  "747de041",
  "4c94d64f",
  "627930bc",
  "969ea9e",
  "a1388c1d",
  "c829c4c9",
  "8a8f93ae",
  "5c921c70",
  "783db7bc",
  "3713bff1",
  "74922e0c",
  "faf30a68",
  "f0138b38",
];

test("行为指纹：60 条确定性语料逐条不漂移", () => {
  const inputs = corpus();
  assert.equal(inputs.length, EXPECTED.length, "语料条数与指纹条数必须一致");
  const actual = inputs.map((text) => fingerprint(text));
  for (let i = 0; i < inputs.length; i++) {
    assert.equal(
      actual[i],
      EXPECTED[i],
      `第 ${i + 1} 条语料行为变了：${JSON.stringify(inputs[i])}`,
    );
  }
});

test("行为指纹：同一输入跑两次结果相同（无隐藏状态）", () => {
  for (const text of corpus().slice(0, 20)) {
    assert.equal(fingerprint(text), fingerprint(text));
  }
});

// ── 事件集维度：同一批报告 × 五种收据状态 ─────────────────────────────────
// 判词层的大部分分支（命中/未命中/被截断/只有路径收据/过期）取决于收据而不
// 取决于文字，所以固定文字、换事件集再打一遍指纹。

const EVENT_SETS: Array<{ name: string; events: SessionEvent[]; opts?: { maxReceipts?: number } }> =
  [
    { name: "无收据", events: [] },
    {
      name: "命令全中",
      events: [
        { kind: "tool", name: "bash", input: { command: "pnpm test" }, exitCode: 0 },
        { kind: "tool", name: "bash", input: { command: "pnpm lint" }, exitCode: 0 },
        { kind: "tool", name: "write", input: { path: "src/a.ts" } },
        { kind: "tool", name: "write", input: { path: "src/b.ts" } },
      ],
    },
    {
      name: "命令全挂",
      events: [
        { kind: "tool", name: "bash", input: { command: "pnpm test" }, exitCode: 1 },
        { kind: "tool", name: "bash", input: { command: "pnpm lint" }, exitCode: 2 },
      ],
    },
    {
      name: "只有路径",
      events: [{ kind: "tool", name: "write", input: { path: "src/a.ts" } }],
    },
    {
      name: "截断",
      events: [
        { kind: "tool", name: "bash", input: { command: "pnpm test" }, exitCode: 0 },
        { kind: "tool", name: "bash", input: { command: "pnpm lint" }, exitCode: 0 },
      ],
      opts: { maxReceipts: 1 },
    },
  ];

function scenarioFingerprint(
  text: string,
  events: SessionEvent[],
  opts?: { maxReceipts?: number },
): string {
  const result = opts === undefined ? audit(events, text) : audit(events, text, opts);
  return fingerprintOf(result);
}

test("行为指纹：20 条报告 × 5 种收据状态逐条不漂移", () => {
  const inputs = corpus().slice(0, 20);
  const actual: string[] = [];
  for (const set of EVENT_SETS) {
    for (const text of inputs) actual.push(scenarioFingerprint(text, set.events, set.opts));
  }
  assert.equal(actual.length, 100);
  assert.deepEqual(actual, EXPECTED_SCENARIOS);
});
