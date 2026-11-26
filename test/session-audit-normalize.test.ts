// 归一化层：真夹具的**产量断言** + 两家的坑。
// 产量断言比判词断言值钱：适配器「什么都没认出来」时，判词测试照样全绿。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  audit,
  normalizeClaude,
  normalizeCodex,
  normalizePi,
  unwrapShell,
} from "../src/audit/index.ts";
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

test("codex 实时流（真跑抓的）：snake_case 的 file_change / agent_message 都要认", () => {
  // 这份夹具是 `codex exec --json` 的真输出。历史是 PascalCase、实时是 snake_case，
  // 而且实时的 `changes` 是数组不是对象——两处都踩过。
  const result = normalizeCodex(fixture("codex-live.jsonl"));
  const writes = writeOf(result.events);
  assert.equal(writes.length, 1, "file_change 的数组形状");
  assert.equal(writes[0]!.input.path, "/tmp/cx/src/a.txt");
  assert.ok((result.report ?? "").includes("src/a.txt"), "agent_message.text 要直取");
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

test("claude 真夹具（只读会话）：5 条命令、0 条路径收据", () => {
  const result = normalizeClaude(fixture("claude-readonly.jsonl"));
  const bash = bashOf(result.events);
  assert.equal(bash.length, 5);
  assert.equal(bash.filter((e) => typeof e.exitCode === "number").length, 5);
  assert.equal(writeOf(result.events).length, 0, "Read 不算写");
  assert.equal(result.malformed, 0);
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

// ── 逐分支补测：把变异测试里幸存的分支钉住 ──────────────────────────────

test("codex：UserMessage 走 content[]，role 是 user", () => {
  const lines = [
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: { type: "UserMessage", content: [{ type: "text", text: "帮我看看" }] },
      },
    }),
  ];
  const roles = normalizeCodex(lines)
    .events.filter((e) => e.kind === "message")
    .map((e) => (e.kind === "message" ? e.role : ""));
  assert.deepEqual(roles, ["user"]);
});

test("codex：多条 final_answer 时报告取最后一条", () => {
  const lines = [
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "第一版", phase: "final_answer" },
    }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "第二版", phase: "final_answer" },
    }),
  ];
  assert.equal(normalizeCodex(lines).report, "第二版");
});

test("codex：没有 final_answer 时回落到最后一条 assistant", () => {
  const lines = [
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "旁白", phase: "commentary" },
    }),
  ];
  assert.equal(normalizeCodex(lines).report, "旁白");
});

test("codex：AgentMessage 只有 content[] 没有 text 也能取到", () => {
  const lines = [
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: { type: "AgentMessage", content: [{ type: "Text", text: "正文在 content 里" }] },
      },
    }),
  ];
  assert.equal(normalizeCodex(lines).report, "正文在 content 里");
});

test("codex：arguments 不是合法 JSON 时返回 undefined，不抛", () => {
  const lines = [
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "c1",
        arguments: "不是 JSON",
      },
    }),
  ];
  assert.equal(bashOf(normalizeCodex(lines).events).length, 0);
});

test("codex：坏行计入 malformed，不影响好行", () => {
  const result = normalizeCodex([
    "{ 坏行",
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "好" } }),
  ]);
  assert.equal(result.malformed, 1);
  assert.equal(result.report, "好");
});

test("codex：`meta` 带 cwd 时写进事件流，file:// 前缀去掉", () => {
  const lines = [JSON.stringify({ type: "session_meta", payload: { cwd: "file:///repo/x" } })];
  const meta = normalizeCodex(lines).events.find((e) => e.kind === "meta");
  assert.equal(meta?.kind === "meta" ? meta.cwd : undefined, "/repo/x");
});

test("claude：第一条 user 文本是任务，后面才是转向", () => {
  const lines = [
    claudeLine("user", [{ type: "text", text: "任务" }]),
    claudeLine("user", [{ type: "text", text: "转向" }]),
  ];
  const messages = messageOf(normalizeClaude(lines).events);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.kind === "message" ? messages[0]!.steer : true, undefined);
  assert.equal(messages[1]!.kind === "message" ? messages[1]!.steer : false, true);
});

test("claude：配不上 tool_use 的 tool_result 直接忽略", () => {
  const lines = [
    claudeLine("user", [{ type: "tool_result", tool_use_id: "不存在", content: "Exit code 0" }]),
  ];
  const result = normalizeClaude(lines);
  assert.equal(bashOf(result.events).length, 0);
  assert.equal(result.malformed, 0);
});

test("claude：tool_result 的 content 是数组时也能取文本", () => {
  const lines = [
    claudeLine("assistant", [
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
    ]),
    claudeLine("user", [
      {
        type: "tool_result",
        tool_use_id: "t1",
        content: [{ type: "text", text: "Exit code 3\nboom" }],
      },
    ]),
  ];
  const bash = bashOf(normalizeClaude(lines).events);
  assert.equal(bash[0]!.exitCode, 3);
});

test("claude：NotebookEdit 也进路径收据", () => {
  const lines = [
    claudeLine("assistant", [
      {
        type: "tool_use",
        id: "t1",
        name: "NotebookEdit",
        input: { notebook_path: "/repo/n.ipynb" },
      },
    ]),
    claudeLine("user", [{ type: "tool_result", tool_use_id: "t1", content: "ok" }]),
  ];
  const writes = writeOf(normalizeClaude(lines).events);
  assert.equal(writes[0]!.input.path, "/repo/n.ipynb");
});

test("claude：没有 tool_result 的写不算收据", () => {
  const lines = [
    claudeLine("assistant", [
      { type: "tool_use", id: "t1", name: "Write", input: { file_path: "/repo/a.ts" } },
    ]),
  ];
  assert.equal(writeOf(normalizeClaude(lines).events).length, 0);
});

test("claude：侧链的 assistant 文本不进报告", () => {
  const lines = [
    claudeLine("assistant", [{ type: "text", text: "主链正文" }]),
    claudeLine("assistant", [{ type: "text", text: "侧链正文" }], { isSidechain: true }),
  ];
  assert.equal(normalizeClaude(lines).report, "主链正文");
});

// ── 再补一批：分词器的边界与「字段缺省」分支 ────────────────────────────

test("codex：CommandExecution 缺 id 时照样收命令（只是没有原文可对）", () => {
  const lines = [
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: { type: "CommandExecution", command: ["/bin/sh", "-c", "ls"], exit_code: 0 },
      },
    }),
  ];
  const bash = bashOf(normalizeCodex(lines).events);
  assert.equal(bash.length, 1);
  assert.equal(bash[0]!.input.command, "ls");
});

test("codex：空 changes 不产路径收据，也不崩", () => {
  const lines = [
    JSON.stringify({
      type: "event_msg",
      payload: { type: "item_completed", item: { type: "FileChange", changes: {} } },
    }),
  ];
  assert.equal(writeOf(normalizeCodex(lines).events).length, 0);
});

test("codex：不认识的 item 类型直接跳过", () => {
  const lines = [
    JSON.stringify({
      type: "event_msg",
      payload: { type: "item_completed", item: { type: "SomethingElse" } },
    }),
  ];
  const result = normalizeCodex(lines);
  assert.equal(result.events.length, 0);
  assert.equal(result.malformed, 0);
});

test("claude：tool_use 缺 id 时跳过（配不上结果）", () => {
  const lines = [
    claudeLine("assistant", [{ type: "tool_use", name: "Bash", input: { command: "ls" } }]),
  ];
  assert.equal(bashOf(normalizeClaude(lines).events).length, 0);
});

test("claude：Bash 缺 command 时不产收据", () => {
  const lines = [
    claudeLine("assistant", [{ type: "tool_use", id: "t1", name: "Bash", input: {} }]),
    claudeLine("user", [{ type: "tool_result", tool_use_id: "t1", content: "Exit code 0" }]),
  ];
  const result = normalizeClaude(lines);
  // 空命令会被 collectReceipts 丢掉，这里断言归一化层也没崩。
  assert.equal(result.malformed, 0);
});

test("claude：空文本块不进消息", () => {
  const lines = [claudeLine("assistant", [{ type: "text", text: "" }])];
  assert.equal(messageOf(normalizeClaude(lines).events).length, 0);
});

test("claude：content 既不是数组也不是字符串时安全跳过", () => {
  const lines = [JSON.stringify({ type: "assistant", message: { content: 42 } })];
  const result = normalizeClaude(lines);
  assert.equal(result.events.length, 0);
  assert.equal(result.malformed, 0);
});

// ── 表驱动：把所有信封/工具/结果形状一次铺开 ────────────────────────────
// 单条用例覆盖一张表，比逐条写更省，也能一次钉住多个分支。

test("表驱动：codex 的每种信封与 item 类型各归各位", () => {
  const cases: Array<{ name: string; line: string; bash: number; write: number; msg: number }> = [
    {
      name: "历史 envelope + CommandExecution",
      line: JSON.stringify({
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: { type: "CommandExecution", command: ["/bin/sh", "-c", "ls"], exit_code: 0 },
        },
      }),
      bash: 1,
      write: 0,
      msg: 0,
    },
    {
      name: "实时 envelope + command_execution（snake）",
      line: JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", command: "ls", exit_code: 0 },
      }),
      bash: 1,
      write: 0,
      msg: 0,
    },
    {
      name: "历史 envelope + FileChange（对象）",
      line: JSON.stringify({
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: { type: "FileChange", changes: { "/a.ts": { type: "add" } } },
        },
      }),
      bash: 0,
      write: 1,
      msg: 0,
    },
    {
      name: "实时 envelope + file_change（数组）",
      line: JSON.stringify({
        type: "item.completed",
        item: { type: "file_change", changes: [{ path: "/a.ts" }] },
      }),
      bash: 0,
      write: 1,
      msg: 0,
    },
    {
      name: "AgentMessage（Pascal）",
      line: JSON.stringify({
        type: "item.completed",
        item: { type: "AgentMessage", content: [{ type: "Text", text: "hi" }] },
      }),
      bash: 0,
      write: 0,
      msg: 1,
    },
    {
      name: "agent_message（snake，带 text）",
      line: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hi" } }),
      bash: 0,
      write: 0,
      msg: 1,
    },
    {
      name: "UserMessage（content 数组）",
      line: JSON.stringify({
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: { type: "UserMessage", content: [{ type: "text", text: "喂" }] },
        },
      }),
      bash: 0,
      write: 0,
      msg: 1,
    },
    {
      name: "response_item/message（role=user）",
      line: JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "喂" }] },
      }),
      bash: 0,
      write: 0,
      msg: 1,
    },
    {
      name: "未知类型",
      line: JSON.stringify({ type: "turn.started" }),
      bash: 0,
      write: 0,
      msg: 0,
    },
  ];
  for (const item of cases) {
    const result = normalizeCodex([item.line]);
    assert.equal(bashOf(result.events).length, item.bash, `${item.name}：命令`);
    assert.equal(writeOf(result.events).length, item.write, `${item.name}：路径`);
    assert.equal(messageOf(result.events).length, item.msg, `${item.name}：消息`);
  }
});

test("表驱动：claude 的每种工具与结果组合", () => {
  const bashUse = (name: string, input: unknown, id = "t1"): string =>
    claudeLine("assistant", [{ type: "tool_use", id, name, input }]);
  const result = (content: unknown, extra: Record<string, unknown> = {}, id = "t1"): string =>
    claudeLine("user", [{ type: "tool_result", tool_use_id: id, content, ...extra }]);

  const cases: Array<{ name: string; lines: string[]; bash: number; write: number }> = [
    {
      name: "Bash + Exit code 0",
      lines: [bashUse("Bash", { command: "ls" }), result("Exit code 0\nok")],
      bash: 1,
      write: 0,
    },
    {
      name: "Bash + Exit code 7",
      lines: [bashUse("Bash", { command: "ls" }), result("Exit code 7\nboom")],
      bash: 1,
      write: 0,
    },
    {
      name: "Bash + 无标记成功",
      lines: [bashUse("Bash", { command: "ls" }), result("普通输出")],
      bash: 1,
      write: 0,
    },
    {
      name: "Bash + is_error 无标记",
      lines: [bashUse("Bash", { command: "ls" }), result("hook error", { is_error: true })],
      bash: 0,
      write: 0,
    },
    {
      name: "Bash + 后台",
      lines: [
        bashUse("Bash", { command: "ls", run_in_background: true }),
        result("Command running in background"),
      ],
      bash: 0,
      write: 0,
    },
    {
      name: "Bash + 超时转后台",
      lines: [
        bashUse("Bash", { command: "ls" }),
        result("did not complete within its 120s timeout"),
      ],
      bash: 0,
      write: 0,
    },
    {
      name: "Write",
      lines: [bashUse("Write", { file_path: "/a.ts" }), result("ok")],
      bash: 0,
      write: 1,
    },
    {
      name: "Edit",
      lines: [bashUse("Edit", { file_path: "/a.ts" }), result("ok")],
      bash: 0,
      write: 1,
    },
    {
      name: "NotebookEdit",
      lines: [bashUse("NotebookEdit", { notebook_path: "/a.ipynb" }), result("ok")],
      bash: 0,
      write: 1,
    },
    {
      name: "Read 不算写",
      lines: [bashUse("Read", { file_path: "/a.ts" }), result("Exit code 0")],
      bash: 0,
      write: 0,
    },
    {
      name: "Grep 不算写",
      lines: [bashUse("Grep", { pattern: "x" }), result("ok")],
      bash: 0,
      write: 0,
    },
  ];
  for (const item of cases) {
    const normalized = normalizeClaude(item.lines);
    assert.equal(bashOf(normalized.events).length, item.bash, `${item.name}：命令`);
    assert.equal(writeOf(normalized.events).length, item.write, `${item.name}：路径`);
  }
});

test("类型闸：非字符串的 text 不当正文", () => {
  const lines = [
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: 123 } }),
  ];
  assert.equal(messageOf(normalizeCodex(lines).events).length, 0);
});

test("类型闸：空字符串 text 不当正文", () => {
  const lines = [
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "" } }),
  ];
  assert.equal(messageOf(normalizeCodex(lines).events).length, 0);
});

test("类型闸：字符串形式的 exit_code 不算退出码", () => {
  const lines = [
    JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", command: "ls", exit_code: "0" },
    }),
  ];
  const bash = bashOf(normalizeCodex(lines).events);
  assert.equal(bash.length, 1);
  assert.equal(typeof bash[0]!.exitCode, "undefined");
});

test("类型闸：content 是 null 的 tool_result 不崩", () => {
  const lines = [
    claudeLine("assistant", [
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
    ]),
    claudeLine("user", [{ type: "tool_result", tool_use_id: "t1", content: null }]),
  ];
  const result = normalizeClaude(lines);
  assert.equal(result.malformed, 0);
  // 空输出按成功算：marker 没有、is_error 没有、也没后台标记。
  assert.equal(bashOf(result.events).length, 1);
});

// ── 逐字段 deepEqual：一条用例钉死整个形状 ────────────────────────────────
// 计数只说明「数量对」，形状错（字段缺省、顺序、类型）照样漏。这两条把整份输出
// 一次比完——归一化层的任何字段级变异都跑不掉。

test("形状：codex 一条完整会话归一化后逐字段相等", () => {
  const lines = [
    JSON.stringify({ type: "session_meta", payload: { cwd: "file:///repo" } }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "c1",
        arguments: '{"cmd":"ls"}',
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          type: "CommandExecution",
          id: "c1",
          command: ["/bin/zsh", "-lc", "rtk ls"],
          exit_code: 0,
        },
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: { type: "FileChange", changes: { "/repo/a.ts": { type: "add" } } },
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "done" }],
      },
    }),
  ];
  assert.deepEqual(normalizeCodex(lines), {
    events: [
      { kind: "meta", cwd: "/repo" },
      { kind: "tool", name: "bash", input: { command: "ls" }, exitCode: 0 },
      { kind: "tool", name: "write", input: { path: "/repo/a.ts" }, cwd: "/repo" },
      { kind: "message", role: "assistant", text: "done" },
    ],
    report: "done",
    malformed: 0,
  });
});

test("形状：claude 一次会话归一化后逐字段相等", () => {
  const lines = [
    claudeLine("assistant", [
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/repo/a.ts" } },
      { type: "tool_use", id: "t2", name: "Bash", input: { command: "pnpm test" } },
      { type: "text", text: "做完了" },
    ]),
    claudeLine("user", [
      { type: "tool_result", tool_use_id: "t1", content: "ok" },
      { type: "tool_result", tool_use_id: "t2", content: "Exit code 0\nok" },
    ]),
  ];
  assert.deepEqual(normalizeClaude(lines), {
    events: [
      { kind: "tool", name: "write", input: { path: "/repo/a.ts" } },
      { kind: "tool", name: "bash", input: { command: "pnpm test" }, exitCode: 0 },
      { kind: "message", role: "assistant", text: "做完了" },
    ],
    report: "做完了",
    malformed: 0,
  });
});

// ── pi：同一件事的第三种形状 ────────────────────────────────────────────

test("形状：pi 一条会话归一化后逐字段相等", () => {
  const lines = [
    JSON.stringify({
      type: "tool_execution_start",
      toolName: "edit",
      toolCallId: "1",
      args: { path: "/repo/a.ts" },
    }),
    JSON.stringify({ type: "tool_execution_end", toolCallId: "1", isError: false }),
    JSON.stringify({
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "2",
      args: { command: "pnpm test" },
    }),
    JSON.stringify({ type: "tool_execution_end", toolCallId: "2", isError: false }),
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "改了 `src/a.ts`，`pnpm test` 跑通了。" }],
      },
    }),
  ];
  assert.deepEqual(normalizePi(lines), {
    events: [
      { kind: "tool", name: "write", input: { path: "/repo/a.ts" } },
      { kind: "tool", name: "bash", input: { command: "pnpm test" }, exitCode: 0 },
      { kind: "message", role: "assistant", text: "改了 `src/a.ts`，`pnpm test` 跑通了。" },
    ],
    report: "改了 `src/a.ts`，`pnpm test` 跑通了。",
    malformed: 0,
  });
});

test("pi：跑挂的命令记 exitCode 1，判词跟着降", () => {
  const lines = [
    JSON.stringify({
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "2",
      args: { command: "pnpm test" },
    }),
    JSON.stringify({ type: "tool_execution_end", toolCallId: "2", isError: true }),
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "`pnpm test` 跑通了。" }] },
    }),
  ];
  const normalized = normalizePi(lines);
  assert.equal(bashOf(normalized.events)[0]!.exitCode, 1);
  assert.equal(audit(normalized.events, normalized.report).deliverable, "unverified");
});

test("跨流（三家）：同一个任务三种形状判词相同", () => {
  const text = "改了 `src/a.ts`，`pnpm test` 跑通了。";
  const codex = normalizeCodex([
    JSON.stringify({
      type: "item.completed",
      item: { type: "file_change", changes: [{ path: "/repo/src/a.ts" }] },
    }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", command: "pnpm test", exit_code: 0 },
    }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }),
  ]);
  const claude = normalizeClaude([
    claudeLine("assistant", [
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/repo/src/a.ts" } },
      { type: "tool_use", id: "t2", name: "Bash", input: { command: "pnpm test" } },
    ]),
    claudeLine("user", [
      { type: "tool_result", tool_use_id: "t1", content: "ok" },
      { type: "tool_result", tool_use_id: "t2", content: "Exit code 0" },
    ]),
    claudeLine("assistant", [{ type: "text", text }]),
  ]);
  const pi = normalizePi([
    JSON.stringify({
      type: "tool_execution_start",
      toolName: "edit",
      toolCallId: "1",
      args: { path: "/repo/src/a.ts" },
    }),
    JSON.stringify({ type: "tool_execution_end", toolCallId: "1", isError: false }),
    JSON.stringify({
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "2",
      args: { command: "pnpm test" },
    }),
    JSON.stringify({ type: "tool_execution_end", toolCallId: "2", isError: false }),
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text }] },
    }),
  ]);
  const verdicts = [codex, claude, pi].map((r) => audit(r.events, r.report).deliverable);
  assert.deepEqual(verdicts, ["verified", "verified", "verified"]);
});

test("类型闸（表）：每个字段塞错类型都不产收据、也不崩", () => {
  const codexCases: string[] = [
    JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", command: 123, exit_code: 0 },
    }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "file_change", changes: "不是数组也不是对象" },
    }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "file_change", changes: [{ path: 123 }] },
    }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", content: [{ type: "Text", text: null }] },
    }),
    JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "assistant", content: "不是数组" },
    }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: 123, content: [] } }),
  ];
  for (const line of codexCases) {
    const result = normalizeCodex([line]);
    assert.equal(bashOf(result.events).length, 0, `codex 不该产命令：${line}`);
    assert.equal(writeOf(result.events).length, 0, `codex 不该产路径：${line}`);
    assert.equal(result.malformed, 0);
  }

  const claudeCases: Array<[string, unknown, unknown]> = [
    ["Bash", { command: 123 }, "Exit code 0"],
    ["Write", { file_path: 123 }, "ok"],
    ["Edit", { file_path: "" }, "ok"],
    ["NotebookEdit", { notebook_path: null }, "ok"],
  ];
  for (const [name, input, output] of claudeCases) {
    const lines = [
      claudeLine("assistant", [{ type: "tool_use", id: "t1", name, input }]),
      claudeLine("user", [{ type: "tool_result", tool_use_id: "t1", content: output }]),
    ];
    const result = normalizeClaude(lines);
    assert.equal(result.malformed, 0, `${name} 不该崩`);
    assert.equal(bashOf(result.events).length, 0, `${name} 不该产命令`);
    assert.equal(writeOf(result.events).length, 0, `${name} 不该产路径`);
  }
});

// ── 边界行为表：每行钉住一条规则的实际输出 ──────────────────────────────
// 这些不是「顺手记下来的现状」，每一条都对应方案里的一条裁定：
// 空命令不算收据、点开头的隐藏文件不算路径、侧链不算、没配对的 tool_result 丢掉、
// `is_error` 没标记就丢、`Exit code N` 只认开头。

test("codex 边界表", () => {
  const J = JSON.stringify;
  const cases: Array<[string[], number, string | undefined]> = [
    // [行, 期望事件数, 期望第一个命令]
    [
      [
        J({
          type: "item.completed",
          item: { type: "command_execution", command: ["sh", "-lc", "ls"], exit_code: 0 },
        }),
      ],
      1,
      "ls",
    ],
    [
      [
        J({
          type: "item.completed",
          item: { type: "command_execution", command: "", exit_code: 0 },
        }),
      ],
      0,
      undefined,
    ],
    [[J({ type: "item.completed", item: { type: "file_change", changes: {} } })], 0, undefined],
    [
      [
        J({
          type: "item.completed",
          item: { type: "agent_message", text: "", phase: "final_answer" },
        }),
      ],
      0,
      undefined,
    ],
    [
      [
        J({ type: "session_meta", payload: { cwd: "/repo" } }),
        J({ type: "item.completed", item: { type: "file_change", changes: [{ path: "/a.ts" }] } }),
      ],
      2,
      undefined,
    ],
    [
      [
        J({
          type: "item.completed",
          item: { type: "command_execution", command: "ls", exit_code: -1 },
        }),
      ],
      1,
      "ls",
    ],
  ];
  for (const [lines, count, first] of cases) {
    const result = normalizeCodex(lines);
    assert.equal(result.events.length, count, `事件数不对：${lines.join(" ")}`);
    const commands = bashOf(result.events);
    if (first === undefined) assert.equal(commands.length, 0);
    else assert.equal(commands[0]!.input.command, first);
  }
});

test("claude 边界表", () => {
  const J = JSON.stringify;
  const A = (content: unknown[], extra: Record<string, unknown> = {}): string =>
    J({ type: "assistant", message: { content }, ...extra });
  const U = (content: unknown[]): string => J({ type: "user", message: { content } });

  // 配对的顺序不影响结果，退出码按各自的 tool_use_id 归位
  const pair = normalizeClaude([
    A([
      { type: "tool_use", id: "a", name: "Bash", input: { command: "ls" } },
      { type: "tool_use", id: "b", name: "Write", input: { file_path: "/x.ts" } },
    ]),
    U([
      { type: "tool_result", tool_use_id: "b", content: "Exit code 0" },
      { type: "tool_result", tool_use_id: "a", content: "Exit code 7" },
    ]),
  ]);
  // 顺序：写盘在 tool_use 那一刻就落事件，命令要等 tool_result 配对后才落，
  // 所以写在前、命令在后——下游 collectReceipts 不依赖顺序。
  assert.deepEqual(pair.events, [
    { kind: "tool", name: "write", input: { path: "/x.ts" } },
    { kind: "tool", name: "bash", input: { command: "ls" }, exitCode: 7 },
  ]);

  // 不在写白名单里的工具（Read）不算路径；没过 is_error 也没标记的丢掉
  const read = normalizeClaude([
    A([{ type: "tool_use", id: "a", name: "Read", input: { file_path: "/x.ts" } }]),
    U([{ type: "tool_result", tool_use_id: "a", content: "Exit code 0" }]),
  ]);
  assert.deepEqual(read.events, []);

  const errored = normalizeClaude([
    A([{ type: "tool_use", id: "a", name: "Bash", input: { command: "ls" } }]),
    U([{ type: "tool_result", tool_use_id: "a", is_error: true }]),
  ]);
  assert.deepEqual(errored.events, []);

  // `Exit code N` 只认输出开头：夹在中间的当普通输出，按「配对且没报错」记 0
  const midMarker = normalizeClaude([
    A([{ type: "tool_use", id: "a", name: "Bash", input: { command: "ls" } }]),
    U([{ type: "tool_result", tool_use_id: "a", content: "输出\nExit code 3\ntail" }]),
  ]);
  assert.equal(bashOf(midMarker.events)[0]!.exitCode, 0);

  // 侧链不算；没配对的 tool_result 丢掉
  const sidechain = normalizeClaude([
    A([{ type: "tool_use", id: "a", name: "Bash", input: { command: "ls" } }], {
      isSidechain: true,
    }),
    U([{ type: "tool_result", tool_use_id: "a", content: "Exit code 0" }]),
  ]);
  assert.deepEqual(sidechain.events, []);

  const orphan = normalizeClaude([
    A([{ type: "tool_use", id: "a", name: "Bash", input: { command: "ls" } }]),
    U([{ type: "tool_result", tool_use_id: "zzz", content: "Exit code 0" }]),
  ]);
  assert.deepEqual(orphan.events, []);
});
