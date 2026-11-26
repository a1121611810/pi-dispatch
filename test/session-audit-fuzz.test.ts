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

function fingerprint(text: string): string {
  const claims = extractClaims(text);
  const result = audit(EVENTS, text);
  const shape = {
    claims,
    verdict: result.deliverable,
    mismatch: result.mismatch,
    notes: result.notes,
  };
  const json = JSON.stringify(shape);
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16);
}

const EXPECTED = [
  "7a65b719",
  "747de041",
  "f2d3b592",
  "cdba8d16",
  "abb9ae01",
  "19009f02",
  "7a65b719",
  "627930bc",
  "7a65b719",
  "286ffdfc",
  "4c94d64f",
  "783db7bc",
  "cdba8d16",
  "ccef9213",
  "7a65b719",
  "718eaa3d",
  "783db7bc",
  "627930bc",
  "abb9ae01",
  "7a65b719",
  "8358ce1",
  "eac94636",
  "cdba8d16",
  "7a65b719",
  "4c94d64f",
  "7a65b719",
  "8358ce1",
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
  "7a65b719",
  "7a65b719",
  "286ffdfc",
  "7a65b719",
  "4c94d64f",
  "7a65b719",
  "747de041",
  "4c94d64f",
  "627930bc",
  "783db7bc",
  "a1388c1d",
  "c829c4c9",
  "627930bc",
  "5c921c70",
  "783db7bc",
  "3713bff1",
  "74922e0c",
  "7a65b719",
  "f5210963",
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
