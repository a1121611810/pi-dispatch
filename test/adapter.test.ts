// 适配层探针：session_start 重复触发时不能累积 handler。
// 假 pi 只做两件事：记 handler、给退订函数——够验证第 5 条修复为止。
//
// 等价变异（变异器杀不掉，也不该杀）：
//   `JSON.stringify(value ?? null, null, 2) ?? "null"` 的第二个 ?? —— JSON.stringify 只在
//   undefined / function / symbol 时返回 undefined（此时两者都给 "null"），它从不返回空串 ⇒ 等价。
//   `process.env.HOME ?? "~"` —— HOME 未设（都给 "~"）或是非空绝对路径（都给路径）；
//   空串不是合法 HOME，pi 的 getAgentDir 也按同样口径处理 ⇒ 等价。
//   `Number(process.env.PI_DISPATCH_DEPTH ?? 0)` —— 未设时都给 0；设了是数字串，
//   "0" 在 ?? 下是 "0"、在 || 下是 0，Number 之后都是 0 ⇒ 等价。
//   `if (!engine) throw` 的 delete ! —— 工具只在 session_start 里注册，而 engine 在
//   注册之前已赋值 ⇒ 这条分支到不了 ⇒ 等价。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import entry, { deliver, textResult, toHostMode } from "../src/index.ts";
import { NotificationCenter } from "../src/core/notifications.ts";
import { TaskRegistry } from "../src/core/registry.ts";

/** 最小假 pi：只实现本扩展用到的 API。 */
function fakePi() {
  const handlers = new Map<string, Set<(...args: unknown[]) => unknown>>();
  const tools = new Map<string, unknown>();
  return {
    handlers,
    tools,
    pi: {
      on(event: string, handler: (...args: unknown[]) => unknown) {
        const set = handlers.get(event) ?? new Set();
        set.add(handler);
        handlers.set(event, set);
        return () => set.delete(handler); // pi 的 on 返回退订函数
      },
      registerTool(def: { name: string }) {
        tools.set(def.name, def);
      },
      sendMessage() {},
    },
  };
}

function fakeCtx(dir: string) {
  return { mode: "rpc" as const, cwd: dir, model: undefined };
}

test("适配层：session_start 触发两次后，turn_end 只剩 1 个 handler", async () => {
  const home = mkdtempSync(join(tmpdir(), "dispatch-adapter-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { pi, handlers, tools } = fakePi();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entry(pi as any);
    const start = [...(handlers.get("session_start") ?? [])];
    assert.equal(start.length, 1, "session_start 工厂层注册一次");

    const ctx = fakeCtx(home);
    await start[0]!(undefined, ctx);
    await start[0]!(undefined, ctx); // 模拟 /new 或 resume 再触发

    assert.equal(handlers.get("turn_end")!.size, 1, "turn_end 不能累积");
    assert.equal(handlers.get("session_shutdown")!.size, 1, "session_shutdown 不能累积");
    assert.deepEqual([...tools.keys()].sort(), ["dispatch_list", "dispatch_stop", "dispatch_task"]);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});

test("适配层：子代理进程（depth>0）只注册 child_report", async () => {
  const home = mkdtempSync(join(tmpdir(), "dispatch-adapter2-"));
  const oldHome = process.env.HOME;
  const oldDepth = process.env.PI_DISPATCH_DEPTH;
  process.env.HOME = home;
  process.env.PI_DISPATCH_DEPTH = "1";
  try {
    const { pi, handlers, tools } = fakePi();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entry(pi as any);
    await [...(handlers.get("session_start") ?? [])][0]!(undefined, fakeCtx(home));
    assert.deepEqual([...tools.keys()], ["child_report"], "孩子只拿回执工具");
    assert.equal(handlers.get("turn_end")?.size ?? 0, 0, "孩子不该装通知投递");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldDepth === undefined) delete process.env.PI_DISPATCH_DEPTH;
    else process.env.PI_DISPATCH_DEPTH = oldDepth;
  }
});

test("适配层：child_report 工具把报告放进 details.report", async () => {
  const home = mkdtempSync(join(tmpdir(), "dispatch-adapter3-"));
  const oldHome = process.env.HOME;
  const oldDepth = process.env.PI_DISPATCH_DEPTH;
  process.env.HOME = home;
  process.env.PI_DISPATCH_DEPTH = "1";
  try {
    const { pi, handlers, tools } = fakePi();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entry(pi as any);
    await [...(handlers.get("session_start") ?? [])][0]!(undefined, fakeCtx(home));
    const def = tools.get("child_report") as {
      execute: (
        id: string,
        args: unknown,
      ) => Promise<{
        content: Array<{ type: string; text: string }>;
        structuredContent?: unknown;
        details?: { report?: { summary?: string } };
      }>;
    };
    const args = {
      summary: "结论",
      why: "任务是字面要求",
      assessment: "边界没测全，有回归风险",
      files_touched: ["a.ts"],
    };
    const out = await def.execute("call_1", args);
    assert.equal(out.details?.report?.summary, "结论");
    assert.deepEqual(out.structuredContent, args);
    assert.ok(out.content[0]?.text);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldDepth === undefined) delete process.env.PI_DISPATCH_DEPTH;
    else process.env.PI_DISPATCH_DEPTH = oldDepth;
  }
});

test("适配层：停不存在的任务不崩（status 是 undefined）", async () => {
  const home = mkdtempSync(join(tmpdir(), "dispatch-adapter4-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { pi, handlers, tools } = fakePi();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entry(pi as any);
    await [...(handlers.get("session_start") ?? [])][0]!(undefined, fakeCtx(home));
    const def = tools.get("dispatch_stop") as {
      execute: (id: string, args: unknown) => Promise<{ content: Array<{ text: string }> }>;
    };
    let out: { content: Array<{ text: string }> } | undefined;
    await assert.doesNotReject(async () => {
      out = await def.execute("call_1", { taskId: "不存在的编号" });
    });
    const payload = JSON.parse(out!.content[0]!.text) as { status?: string; reason: string };
    assert.equal(payload.status, undefined, "没这条记录 ⇒ status 是 undefined");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});

test("适配层：理由是空串当没给（回落 user stop）", async () => {
  const home = mkdtempSync(join(tmpdir(), "dispatch-adapter5-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { pi, handlers, tools } = fakePi();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entry(pi as any);
    await [...(handlers.get("session_start") ?? [])][0]!(undefined, fakeCtx(home));
    const def = tools.get("dispatch_stop") as {
      execute: (id: string, args: unknown) => Promise<{ content: Array<{ text: string }> }>;
    };
    const out = await def.execute("call_1", { taskId: "不存在的编号", reason: "" });
    const payload = JSON.parse(out.content[0]!.text) as { reason: string };
    assert.equal(payload.reason, "user stop", "空串是坏值 ⇒ 回落默认理由");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});

test("textResult：undefined 也输出合法 JSON（pi 下一轮读 .length 会崩）", () => {
  const out = textResult(undefined);
  assert.equal(out.content[0]!.type, "text");
  assert.doesNotThrow(() => JSON.parse(out.content[0]!.text));
  assert.equal(out.content[0]!.text, "null");
});

test("toHostMode：rpc/tui 长驻，print/json 一次性", () => {
  assert.equal(toHostMode("rpc"), "long-lived");
  assert.equal(toHostMode("tui"), "long-lived");
  assert.equal(toHostMode("print"), "one-shot");
  assert.equal(toHostMode("json"), "one-shot");
});

test("textResult：0 是有效值（不是 null）", () => {
  assert.equal(textResult(0).content[0]!.text, "0");
  assert.equal(textResult(false).content[0]!.text, "false");
  assert.equal(textResult("").content[0]!.text, '""');
});

test("textResult：对象按缩进 2 输出", () => {
  assert.equal(textResult({ a: 1 }).content[0]!.text, '{\n  "a": 1\n}');
});

test("textResult：details 是 undefined（pi 的类型要求显式给）", () => {
  assert.equal(textResult(1).details, undefined);
});

test("deliver：通知带 display=true", async () => {
  const registry = new TaskRegistry();
  const notifications = new NotificationCenter();
  notifications.attach(registry as never);
  await registry.submit({
    kind: "spawn",
    record: { id: "abcdef1234", status: "succeeded", task: "t", finishedAt: 1700000000000 },
  });
  const sent: Array<{ display?: boolean }> = [];
  deliver({ sendMessage: (m: { display?: boolean }) => sent.push(m) } as never, notifications);
  assert.equal(sent[0]!.display, true, "通知要显示出来（display 不为 true 会被 pi 折叠掉）");
});

test("deliver：把待投递的通知发成一条 custom 消息（编号前缀 + 状态）", async () => {
  const registry = new TaskRegistry();
  const notifications = new NotificationCenter();
  notifications.attach(registry as never);
  await registry.submit({
    kind: "spawn",
    record: { id: "abcdef1234", status: "succeeded", task: "t", finishedAt: 1700000000000 },
  });
  const sent: Array<{ customType?: string; content?: string }> = [];
  deliver(
    { sendMessage: (m: { customType?: string; content?: string }) => sent.push(m) } as never,
    notifications,
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.customType, "dispatch-notifications");
  assert.match(sent[0]!.content!, /abcdef12/, "编号截前 8 位");
  assert.match(sent[0]!.content!, /succeeded/);
  assert.ok(!sent[0]!.content!.includes("没有实测支撑"), "已验证的任务不该带警告");
  assert.equal(notifications.pendingCount(), 0, "取走即清");
});

test("deliver：未核实的交付在通知里写出警告", async () => {
  const registry = new TaskRegistry();
  const notifications = new NotificationCenter();
  notifications.attach(registry as never);
  await registry.submit({
    kind: "spawn",
    record: { id: "abcdef1234", status: "queued", task: "t" },
  });
  await registry.submit({ kind: "transition", id: "abcdef1234", to: "running" });
  await registry.submit({
    kind: "attach-report",
    id: "abcdef1234",
    report: { summary: "s", why: "w", assessment: "a" },
    channel: "prompt-json",
    unverified: true,
  });
  await registry.submit({ kind: "resolve-exit", id: "abcdef1234", exitCode: 0 });
  const sent: string[] = [];
  deliver(
    { sendMessage: (m: { content?: string }) => sent.push(m.content ?? "") } as never,
    notifications,
  );
  assert.match(sent[0]!, /没有实测支撑/);
});

test("deliver：sendMessage 抛错不冒出去（best-effort）", async () => {
  const registry = new TaskRegistry();
  const notifications = new NotificationCenter();
  notifications.attach(registry as never);
  await registry.submit({ kind: "spawn", record: { id: "x", status: "succeeded", task: "t" } });
  const pi = {
    sendMessage: () => {
      throw new Error("boom");
    },
  };
  assert.doesNotThrow(() => deliver(pi as never, notifications));
  assert.equal(notifications.pendingCount(), 0, "失败也取走了，不阻塞下一轮");
});
