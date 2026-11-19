// 验收判断的夹具测试：正反两面各断言一次。
// 夹具字段照抄真机跑出来的记录（见 ~/.pi/dispatch/<桶>/records/*.json），不自己编形状。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  judgeAllowScripts,
  judgeDispatch,
  judgeJsonStream,
  judgeReject,
  judgeRpc,
} from "../scripts/verdicts.ts";
import type { TaskRecord } from "../src/core/types.ts";

const good: TaskRecord = {
  id: "9e7e6d16",
  status: "succeeded",
  task: "读 /etc/hosts 报行数",
  delivery: { tools: { read: 1, bash: 1 }, paths: ["/etc/hosts"], errors: 0, textChars: 230 },
};

const failed: TaskRecord = { id: "b", status: "failed", task: "t" };

// ── 派发：成了且有正文才算数 ────────────────────────────────────────────

test("判断·派发：succeeded 且有正文 ⇒ 绿", () => {
  assert.equal(judgeDispatch(good).ok, true);
});

test("判断·派发：failed ⇒ 红（哪怕输出里有数字）", () => {
  assert.equal(judgeDispatch(failed).ok, false);
});

test("判断·派发：succeeded 但正文 0 字 ⇒ 红", () => {
  assert.equal(judgeDispatch({ ...good, delivery: { ...good.delivery!, textChars: 0 } }).ok, false);
});

test("判断·派发：没有记录 ⇒ 红", () => {
  assert.equal(judgeDispatch(undefined).ok, false);
});

// ── allowScripts：看工具声明 ─────────────────────────────────────────────

test("判断·allowScripts：声明里有 codemode ⇒ 绿", () => {
  assert.equal(
    judgeAllowScripts(good, "<tools>\n- read: ...\n- codemode: 跑脚本\n</tools>").ok,
    true,
  );
});

test("判断·allowScripts：声明里没有 codemode ⇒ 红", () => {
  assert.equal(judgeAllowScripts(good, "<tools>\n- read: ...\n- bash: ...\n</tools>").ok, false);
});

test("判断·allowScripts：没有记录 ⇒ 红（哪怕日志里有字样）", () => {
  assert.equal(judgeAllowScripts(undefined, "- codemode: 跑脚本").ok, false);
});

// ── 退回：一条记录都不该有 ───────────────────────────────────────────────

test("判断·退回：桶里空 ⇒ 绿", () => {
  assert.equal(judgeReject([]).ok, true);
});

test("判断·退回：桶里有记录 ⇒ 红", () => {
  assert.equal(judgeReject([good]).ok, false);
});

// ── JSON 事件流 ─────────────────────────────────────────────────────────

test("判断·事件流：能解析出工具调用 ⇒ 绿", () => {
  const stream = '{"type":"tool_execution_start","toolName":"dispatch_task","args":{}}';
  assert.equal(judgeJsonStream(stream).ok, true);
});

test("判断·事件流：没有任何事件 ⇒ 红", () => {
  assert.equal(judgeJsonStream("").ok, false);
});

test("判断·事件流：只有非工具事件 ⇒ 红", () => {
  assert.equal(judgeJsonStream('{"type":"agent_start"}').ok, false);
});

// ── rpc：两个都在 ───────────────────────────────────────────────────────

test("判断·rpc：工具往返 + 通知都在 ⇒ 绿", () => {
  assert.equal(judgeRpc(true, true).ok, true);
});

test("判断·rpc：通知没到 ⇒ 红", () => {
  assert.equal(judgeRpc(true, false).ok, false);
});

test("判断·rpc：工具往返没到 ⇒ 红", () => {
  assert.equal(judgeRpc(false, true).ok, false);
});
