// 归一化层：真夹具的**产量断言** + 两家的坑。
// 产量断言比判词断言值钱：适配器「什么都没认出来」时，判词测试照样全绿。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { audit, normalizeClaude, normalizeCodex, unwrapShell } from "../src/audit/index.ts";
import type { SessionEvent } from "../src/audit/index.ts";

const fixture = (name: string): string[] =>
  readFileSync(new URL(`./fixtures/session-audit/${name}`, import.meta.url), "utf8").split("\n");

type ToolEvent = Extract<SessionEvent, { kind: "tool" }>;
const bashOf = (events: readonly SessionEvent[]): ToolEvent[] =>
  events.filter((e): e is ToolEvent => e.kind === "tool" && e.name === "bash");
const writeOf = (events: readonly SessionEvent[]): ToolEvent[] =>
  events.filter((e): e is ToolEvent => e.kind === "tool" && e.name === "write");
const messageOf = (events: readonly SessionEvent[]) => events.filter((e) => e.kind === "message");

// ── 真夹具：精确条数（人工核过） ─────────────────────────────────────────

test("codex 真夹具：33 条命令全带退出码、1 条路径收据、27 条消息", () => {
  const result = normalizeCodex(fixture("codex-write.jsonl"));
  const bash = bashOf(result.events);
  assert.equal(bash.length, 33, "命令条数");
  assert.equal(bash.filter((e) => typeof e.exitCode === "number").length, 33, "每条都要有退出码");
  assert.equal(writeOf(result.events).length, 1, "FileChange 的键数");
  assert.equal(messageOf(result.events).length, 27);
  assert.equal(result.malformed, 0);
  assert.ok((result.report ?? "").trim() !== "", "报告要抽得出来");
});

test("codex 真夹具（只读会话）：11 条命令、0 条路径收据", () => {
  const result = normalizeCodex(fixture("codex-readonly.jsonl"));
  assert.equal(bashOf(result.events).length, 11);
  assert.equal(writeOf(result.events).length, 0);
  assert.equal(result.malformed, 0);
});

test("claude 真夹具：13 条命令、3 条写收据、Read 不算写", () => {
  const result = normalizeClaude(fixture("claude-write.jsonl"));
  const bash = bashOf(result.events);
  assert.equal(bash.length, 13);
  assert.equal(bash.filter((e) => typeof e.exitCode === "number").length, 13);
  // 夹具里有 2 次 Read、3 次 Edit：只有 Edit 进路径收据。
  assert.equal(writeOf(result.events).length, 3);
  assert.equal(result.malformed, 0);
  assert.ok((result.report ?? "").trim() !== "");
});

// ── codex 的坑 ──────────────────────────────────────────────────────────

test("codex：`command` 是 argv 数组时取最后一项（脚本本体）", () => {
  assert.equal(unwrapShell(["/bin/zsh", "-lc", "pnpm test"]), "pnpm test");
});

test("codex：字符串外壳只剥一层", () => {
  assert.equal(unwrapShell('/bin/zsh -lc "pnpm test && pnpm lint"'), "pnpm test && pnpm lint");
});

test("codex：同一 call_id 的两本账只记一条，命令串取原文", () => {
  // 历史里 `event_msg/CommandExecution` 与 `response_item/function_call` 描述同一批命令；
  // 执行侧会被包装（`rtk ls`），命令串要取原文，退出码取 CE。
  const lines = [
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "call_x",
        arguments: '{"cmd":"ls -la"}',
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          type: "CommandExecution",
          id: "call_x",
          command: ["/bin/zsh", "-lc", "rtk ls -la"],
          exit_code: 0,
        },
      },
    }),
  ];
  const result = normalizeCodex(lines);
  const bash = bashOf(result.events);
  assert.equal(bash.length, 1, "两本账不能双计");
  assert.equal(bash[0]!.input.command, "ls -la", "取原文，不取 rtk 包装串");
  assert.equal(bash[0]!.exitCode, 0);
});

test("codex：只有 function_call 没有完成项 ⇒ 不是收据", () => {
  const lines = [
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "call_y",
        arguments: '{"cmd":"ls"}',
      },
    }),
  ];
  assert.equal(bashOf(normalizeCodex(lines).events).length, 0);
});

test("codex：FileChange 的 changes 是对象，取键当路径收据", () => {
  const lines = [
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: { type: "FileChange", changes: { "/repo/a.ts": { type: "update" } } },
      },
    }),
  ];
  const writes = writeOf(normalizeCodex(lines).events);
  assert.deepEqual(
    writes.map((e) => e.kind === "tool" && e.input.path),
    ["/repo/a.ts"],
  );
});

// ── claude 的坑 ─────────────────────────────────────────────────────────

const claudeLine = (type: string, blocks: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type, message: { content: blocks }, ...extra });

test("claude：`Exit code N` 取 N", () => {
  const lines = [
    claudeLine("assistant", [
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm test" } },
    ]),
    claudeLine("user", [{ type: "tool_result", tool_use_id: "t1", content: "Exit code 1\nboom" }]),
  ];
  const bash = bashOf(normalizeClaude(lines).events);
  assert.equal(bash.length, 1);
  assert.equal(bash[0]!.exitCode, 1);
});

test("claude：`is_error` 且无标记 ⇒ 不是收据（命令根本没跑）", () => {
  const lines = [
    claudeLine("assistant", [
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm test" } },
    ]),
    claudeLine("user", [
      {
        type: "tool_result",
        tool_use_id: "t1",
        is_error: true,
        content: "PreToolUse:Bash hook error: blocked",
      },
    ]),
  ];
  assert.equal(bashOf(normalizeClaude(lines).events).length, 0);
});

test("claude：后台命令不是收据（退出码还没出来）", () => {
  const lines = [
    claudeLine("assistant", [
      {
        type: "tool_use",
        id: "t1",
        name: "Bash",
        input: { command: "pnpm build", run_in_background: true },
      },
    ]),
    claudeLine("user", [
      {
        type: "tool_result",
        tool_use_id: "t1",
        content: "Command running in background with ID: b1",
      },
    ]),
  ];
  assert.equal(bashOf(normalizeClaude(lines).events).length, 0);
});

test("claude：前台超时被转后台也不是收据", () => {
  const lines = [
    claudeLine("assistant", [
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm test" } },
    ]),
    claudeLine("user", [
      {
        type: "tool_result",
        tool_use_id: "t1",
        content:
          "The command did not complete within its 120s timeout and was moved to the background",
      },
    ]),
  ];
  assert.equal(bashOf(normalizeClaude(lines).events).length, 0);
});

test("claude：`tool_result` 不会变成 user 消息（否则报告永远被当陈旧）", () => {
  const lines = [
    claudeLine("assistant", [
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
    ]),
    claudeLine("user", [{ type: "tool_result", tool_use_id: "t1", content: "Exit code 0\nok" }]),
  ];
  const roles = messageOf(normalizeClaude(lines).events).map((e) => e.kind === "message" && e.role);
  assert.deepEqual(roles, []);
});

test("claude：侧链的写不算主链收据", () => {
  const lines = [
    claudeLine(
      "assistant",
      [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/repo/a.ts" } }],
      {
        isSidechain: true,
      },
    ),
    claudeLine("user", [{ type: "tool_result", tool_use_id: "t1", content: "ok" }], {
      isSidechain: true,
    }),
  ];
  assert.equal(writeOf(normalizeClaude(lines).events).length, 0);
});

test("跨流：同一份任务在 codex 与 claude 两条流上判词相同", () => {
  // 验收第 3 条。两份夹具是**同一次任务**的两种形状（手工按真机形状写的）：
  // 一条 `pnpm test`、一次写 `src/a.ts`、一句「改了 src/a.ts，pnpm test 跑通了」。
  const codexLines = [
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "call_1",
        arguments: '{"cmd":"pnpm test"}',
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          type: "CommandExecution",
          id: "call_1",
          command: ["/bin/zsh", "-lc", "pnpm test"],
          exit_code: 0,
        },
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: { type: "FileChange", changes: { "/repo/src/a.ts": { type: "add" } } },
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "改了 `src/a.ts`，`pnpm test` 跑通了。" }],
      },
    }),
  ];
  const claudeLines = [
    claudeLine("assistant", [
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/repo/src/a.ts" } },
      { type: "tool_use", id: "t2", name: "Bash", input: { command: "pnpm test" } },
    ]),
    claudeLine("user", [
      { type: "tool_result", tool_use_id: "t1", content: "ok" },
      { type: "tool_result", tool_use_id: "t2", content: "Exit code 0\nall pass" },
    ]),
    claudeLine("assistant", [{ type: "text", text: "改了 `src/a.ts`，`pnpm test` 跑通了。" }]),
  ];
  const a = normalizeCodex(codexLines);
  const b = normalizeClaude(claudeLines);
  assert.equal(audit(a.events, a.report).deliverable, audit(b.events, b.report).deliverable);
  assert.equal(audit(a.events, a.report).deliverable, "verified");
});

test("claude：非 Bash 的 result 里出现 `Exit code` 不会被当退出码", () => {
  const lines = [
    claudeLine("assistant", [
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/repo/a.ts" } },
    ]),
    claudeLine("user", [
      { type: "tool_result", tool_use_id: "t1", content: "Exit code 0\n(this is file text)" },
    ]),
  ];
  const events = normalizeClaude(lines).events;
  assert.equal(bashOf(events).length, 0);
  assert.equal(writeOf(events).length, 0);
});
