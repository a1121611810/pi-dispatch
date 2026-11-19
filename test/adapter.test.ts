// 适配层探针：session_start 重复触发时不能累积 handler。
// 假 pi 只做两件事：记 handler、给退订函数——够验证第 5 条修复为止。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import entry, { deliver, textResult } from "../src/index.ts";
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

test("适配层：子代理进程（depth>0）不注册任何东西", async () => {
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
    assert.equal(tools.size, 0, "孩子不该注册父方工具");
    assert.equal(handlers.get("turn_end")?.size ?? 0, 0, "孩子不该装通知投递");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldDepth === undefined) delete process.env.PI_DISPATCH_DEPTH;
    else process.env.PI_DISPATCH_DEPTH = oldDepth;
  }
});

test("textResult：undefined 也输出合法 JSON（pi 下一轮读 .length 会崩）", () => {
  const out = textResult(undefined);
  assert.equal(out.content[0]!.type, "text");
  assert.doesNotThrow(() => JSON.parse(out.content[0]!.text));
  assert.equal(out.content[0]!.text, "null");
});

test("textResult：对象按缩进 2 输出", () => {
  assert.equal(textResult({ a: 1 }).content[0]!.text, '{\n  "a": 1\n}');
});

test("textResult：details 是 undefined（pi 的类型要求显式给）", () => {
  assert.equal(textResult(1).details, undefined);
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
    report: { summary: "s" },
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
