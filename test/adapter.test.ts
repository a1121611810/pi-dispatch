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
//   `raw.length > MAX_STOP_REASON_CHARS` → `>=`——理由截到 500 字符后 slice(0, 500) 是恒等：
//   长度恰好 500 时截断与不截断同值 ⇒ 等价。
//   黑板工具的 `process.env.PI_DISPATCH_TASK_ID ?? "unknown"` → `||`——任务编号要么没设
//   （undefined，两向都给 "unknown"）要么是非空串（恒真，两向同值）⇒ 等价。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import entry, {
  anchoredRead,
  deliver,
  excerptDeliverable,
  isGitRepoAt,
  lineHash,
  resolveRepoRoot,
  textResult,
  toHostMode,
} from "../src/index.ts";
import { NotificationCenter } from "../src/core/notifications.ts";
import { TaskRegistry } from "../src/core/registry.ts";
import { encodeBucket, findProjectRoot, Storage } from "../src/core/storage.ts";
import type { TaskRecord } from "../src/core/types.ts";

/** 最小假 pi：只实现本扩展用到的 API。 */
function fakePi(
  options: { failSends?: number; noSendUserMessage?: boolean; unknownEvents?: string[] } = {},
) {
  const handlers = new Map<string, Set<(...args: unknown[]) => unknown>>();
  const tools = new Map<string, unknown>();
  const commands = new Map<string, { handler: (...args: unknown[]) => unknown }>();
  const commandRegistrations: string[] = [];
  const sent: Array<{ content: unknown; options: unknown }> = [];
  let failures = options.failSends ?? 0;
  return {
    handlers,
    tools,
    commands,
    commandRegistrations,
    sent,
    pi: {
      on(event: string, handler: (...args: unknown[]) => unknown) {
        if (options.unknownEvents?.includes(event)) throw new Error(`unknown event: ${event}`); // 老版本 pi 不认识这个事件
        const set = handlers.get(event) ?? new Set();
        set.add(handler);
        handlers.set(event, set);
        return () => set.delete(handler); // pi 的 on 返回退订函数
      },
      registerTool(def: { name: string }) {
        tools.set(def.name, def);
      },
      registerCommand(name: string, def: { handler: (...args: unknown[]) => unknown }) {
        commands.set(name, def);
        commandRegistrations.push(name);
      },
      sendMessage() {},
      ...(options.noSendUserMessage
        ? {}
        : {
            sendUserMessage(content: unknown, sendOptions: unknown) {
              if (failures > 0) {
                failures--;
                throw new Error("send failed");
              }
              sent.push({ content, options: sendOptions });
            },
          }),
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
    assert.deepEqual([...tools.keys()].sort(), [
      "dispatch_blackboard",
      "dispatch_list",
      "dispatch_read",
      "dispatch_steer",
      "dispatch_stop",
      "dispatch_task",
    ]);
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

test("适配层：stop 的理由超长要截断（不随 dispatch_list 反复重发）", async () => {
  const home = mkdtempSync(join(tmpdir(), "dispatch-adapter-stop-"));
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
    const out = await def.execute("call_1", { taskId: "不存在的编号", reason: "x".repeat(10_000) });
    const payload = JSON.parse(out.content[0]!.text) as { reason: string; status?: string };
    assert.equal(payload.reason.length, 500, "理由截断到 500 字符");
    assert.equal(payload.status, undefined, "截断不影响 stop 本身（不存在的编号照样正常回）");
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

test("deliver：谎报自检在通知里写出警告", async () => {
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
    verifyUnverified: true,
  });
  await registry.submit({ kind: "resolve-exit", id: "abcdef1234", exitCode: 0 });
  const sent: string[] = [];
  deliver(
    { sendMessage: (m: { content?: string }) => sent.push(m.content ?? "") } as never,
    notifications,
  );
  assert.ok(sent[0]!.includes("自检没有实测支撑"), "谎报自检要写出自己的警告");
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

test("deliver：转向收据写进终态通知（送达 = 进了孩子 transcript）", async () => {
  const registry = new TaskRegistry();
  const notifications = new NotificationCenter();
  notifications.attach(registry as never);
  await registry.submit({
    kind: "spawn",
    record: {
      id: "steered0001",
      status: "succeeded",
      task: "t",
      finishedAt: 1700000000000,
      steers: [
        { seq: 1, text: "甲", at: 1, state: "sent" },
        { seq: 2, text: "乙", at: 2, state: "queued" },
        { seq: 3, text: "丙", at: 3, state: "delivered", deliveredAt: 4 },
        { seq: 4, text: "丁", at: 4, state: "seen", deliveredAt: 5, seenAt: 6 },
        { seq: 5, text: "戊", at: 5, state: "undelivered" },
      ],
    },
  });
  const sent: string[] = [];
  deliver(
    { sendMessage: (m: { content?: string }) => sent.push(m.content ?? "") } as never,
    notifications,
  );
  // 送达 2（delivered + seen）/ 生效 1（seen）/ 未送达 3（sent + queued + undelivered）
  assert.match(sent[0]!, /｜转向 5 条：送达 2 \/ 生效 1（未送达 3）/);
});

test("deliver：一条转向都没进 transcript 时明说未观测到送达", async () => {
  const registry = new TaskRegistry();
  const notifications = new NotificationCenter();
  notifications.attach(registry as never);
  await registry.submit({
    kind: "spawn",
    record: {
      id: "steered0002",
      status: "failed",
      task: "t",
      finishedAt: 1700000000000,
      steers: [
        { seq: 1, text: "甲", at: 1, state: "sent" },
        { seq: 2, text: "乙", at: 2, state: "undelivered" },
      ],
    },
  });
  const sent: string[] = [];
  deliver(
    { sendMessage: (m: { content?: string }) => sent.push(m.content ?? "") } as never,
    notifications,
  );
  assert.match(sent[0]!, /｜转向 2 条：未观测到送达/);
  assert.ok(!sent[0]!.includes("送达 0"), "没证据不能写成送达 0 条");
});

test("deliver：没转向过的任务不带转向收据（空数组也不行）", async () => {
  const registry = new TaskRegistry();
  const notifications = new NotificationCenter();
  notifications.attach(registry as never);
  await registry.submit({
    kind: "spawn",
    record: { id: "steered0003", status: "succeeded", task: "t", steers: [] },
  });
  const sent: string[] = [];
  deliver(
    { sendMessage: (m: { content?: string }) => sent.push(m.content ?? "") } as never,
    notifications,
  );
  assert.ok(!sent[0]!.includes("转向"), "没写过转向就没这一行");
});

// ── 模型面归约 ──────────────────────────────────────────────────────────────

const BIG_TEXT = "x".repeat(60 * 1024);

function resultWith(overrides: Record<string, unknown>) {
  return {
    status: "succeeded",
    taskId: "t",
    text: BIG_TEXT,
    exitCode: 0,
    started: true,
    durationMs: 1,
    readOnlyTier: "lenient" as const,
    outputPath: "/tmp/out.log",
    reportChannel: "none" as const,
    outputTruncated: false,
    ...overrides,
  };
}

test("归约：无回执 ⇒ 50KB 大窗，省略标记不点名 report", () => {
  const out = excerptDeliverable(resultWith({}) as never);
  assert.match(out.text, /省略 \d+ 字符/);
  assert.ok(!out.text.includes("摘要见 report"), "无回执不点名 report");
  assert.ok(out.text.length > 50 * 1024, "50KB 预算 + 标记");
  assert.ok(out.text.length < 51 * 1024);
});

test("归约：可靠回执 ⇒ 8KB 小窗且标记点名 report", () => {
  const out = excerptDeliverable(
    resultWith({
      report: {
        summary: "s",
        why: "w",
        assessment: "主流程已验证。边界场景还没覆盖全，存在回归风险。",
      },
      reportChannel: "tool",
      deliverable: "verified",
    }) as never,
  );
  assert.ok(out.text.includes("摘要见 report"));
  assert.ok(out.text.length < 12 * 1024, "8KB 窗 + 标记");
});

test("归约：小窗只认判词——报告齐全但判词没到（或不是 verified/unclaimed）⇒ 大窗", () => {
  const report = {
    summary: "s",
    why: "w",
    assessment: "主流程已验证。边界场景还没覆盖全，存在回归风险。",
  };
  const noVerdict = excerptDeliverable(resultWith({ report, reportChannel: "tool" }) as never);
  assert.ok(!noVerdict.text.includes("摘要见 report"), "没有判词就不许换小窗");
  const partial = excerptDeliverable(
    resultWith({ report, reportChannel: "tool", deliverable: "partial" }) as never,
  );
  assert.ok(!partial.text.includes("摘要见 report"), "部分对上也吃大窗");
  const unclaimed = excerptDeliverable(
    resultWith({ report, reportChannel: "tool", deliverable: "unclaimed" }) as never,
  );
  assert.ok(unclaimed.text.includes("摘要见 report"), "只读任务的诚实形态不罚");
});

test("归约：回执空转或核对挂了 ⇒ 落回大窗", () => {
  const vacuous = excerptDeliverable(
    resultWith({
      report: { summary: "s", why: "w", assessment: "整体非常顺利圆满达成。" },
      reportChannel: "tool",
      assessmentVacuous: true,
      deliverable: "unverified",
    }) as never,
  );
  assert.ok(!vacuous.text.includes("摘要见 report"), "空回执不享受小窗");
  const unverified = excerptDeliverable(
    resultWith({
      report: {
        summary: "s",
        why: "w",
        assessment: "主流程已验证。边界场景还没覆盖全，存在回归风险。",
      },
      reportChannel: "tool",
      deliveryUnverified: true,
      deliverable: "unverified",
    }) as never,
  );
  assert.ok(!unverified.text.includes("摘要见 report"), "核对挂了失去小窗资格");
});

test("归约：报告早于最后一次转向 ⇒ 落回大窗", () => {
  const out = excerptDeliverable(
    resultWith({
      report: {
        summary: "s",
        why: "w",
        assessment: "主流程已验证。边界场景还没覆盖全，存在回归风险。",
      },
      reportChannel: "tool",
      reportStale: true,
      deliverable: "unverified",
    }) as never,
  );
  assert.ok(!out.text.includes("摘要见 report"), "stale 报告不能享受小窗");
});

test("归约：谎报自检 ⇒ 落回大窗", () => {
  const out = excerptDeliverable(
    resultWith({
      report: {
        summary: "s",
        why: "w",
        assessment: "主流程已验证。边界场景还没覆盖全，存在回归风险。",
      },
      reportChannel: "tool",
      verifyUnverified: true,
      deliverable: "unverified",
    }) as never,
  );
  assert.ok(!out.text.includes("摘要见 report"), "谎报自检失去小窗资格");
});

test("归约：无 outputPath 不截——交付物必须可达", () => {
  const out = excerptDeliverable(resultWith({ outputPath: "" }) as never);
  assert.equal(out.text, BIG_TEXT);
});

test("归约：小文本原样过", () => {
  const out = excerptDeliverable(resultWith({ text: "短文" }) as never);
  assert.equal(out.text, "短文");
});

test("归约：恰好等于窗口预算 ⇒ 原样过（不插 0 字符省略标记）", () => {
  const text = "y".repeat(8 * 1024);
  const out = excerptDeliverable(
    resultWith({
      text,
      report: {
        summary: "s",
        why: "w",
        assessment: "主流程已验证。边界场景还没覆盖全，存在回归风险。",
      },
      reportChannel: "tool",
      deliverable: "verified",
    }) as never,
  );
  assert.equal(out.text, text, "恰好装得下就不截（<= 不是 <）");
});

// ── dispatch_read 行锚 ──────────────────────────────────────────────────────

test("anchoredRead：around 命中给窗口，失配拒绝并回鲜锚", () => {
  const prose = ["alpha", "beta", "gamma", "delta", "epsilon"].join("\n");
  const hit = anchoredRead(prose, { around: `3:${lineHash("gamma")}`, contextLines: 1 });
  assert.equal(hit.error, undefined);
  assert.match(
    hit.text!,
    new RegExp(`^2:[0-9a-f]{4}\\|beta\\n3:[0-9a-f]{4}\\|gamma\\n4:[0-9a-f]{4}\\|delta$`),
  );
  const miss = anchoredRead(prose, { around: "3:0000" });
  assert.match(miss.error!, /锚失配/);
  assert.equal(miss.freshAnchor, `3:${lineHash("gamma")}`);
});

test("anchoredRead：空白不敏感与格式/越界明说", () => {
  const prose = "  indented line\nplain";
  const hit = anchoredRead(prose, { around: `1:${lineHash("indented line")}` });
  assert.equal(hit.error, undefined, "行首空格不影响锚");
  assert.match(anchoredRead("a\nb", { around: "xx" }).error!, /锚格式不对/);
  assert.match(anchoredRead("a\nb", { around: `9:${lineHash("x")}` }).error!, /越界/);
});

test("anchoredRead：无 around 全量读出按 1 起编号", () => {
  const out = anchoredRead(["alpha", "beta"].join("\n"));
  assert.equal(out.error, undefined);
  assert.equal(out.text, `1:${lineHash("alpha")}|alpha\n2:${lineHash("beta")}|beta`);
  const win = anchoredRead(["alpha", "beta", "gamma"].join("\n"), {
    around: `2:${lineHash("beta")}`,
    contextLines: 0,
  });
  assert.equal(win.error, undefined);
  assert.equal(win.from, 2, "窗口起点按 1 起报");
  assert.equal(win.to, 2);
});

test("lineHash：钉死算法国定向量——锚是会话内的线路格式，不许静默漂移", () => {
  assert.equal(lineHash("gamma"), "140a");
  assert.equal(lineHash("第一行结论"), "de92");
  assert.equal(lineHash(""), "9dc5");
  assert.equal(lineHash("  gamma  "), "140a", "空白不敏感");
});

test("anchoredRead：超 maxChars 给头尾窗口并提示 around", () => {
  const prose = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
  const out = anchoredRead(prose, { maxChars: 2048 });
  assert.match(out.text!, /省略 \d+ 字符：用 around="N:hash" 拉窗口/);
});

test("anchoredRead：坏参数要拒并说清，不静默夹取", () => {
  const prose = ["alpha", "beta"].join("\n");
  assert.match(anchoredRead(prose, { maxChars: -1 }).error!, /maxChars 必须是正整数/);
  assert.match(anchoredRead(prose, { maxChars: 1.5 }).error!, /maxChars 必须是正整数/);
  assert.match(anchoredRead(prose, { contextLines: -1 }).error!, /contextLines 必须是非负整数/);
  assert.match(anchoredRead(prose, { around: 3 as never }).error!, /around 必须是字符串/);
  // 坏参数不许被悄悄夹成「能读」——错误信息里没有正文
  assert.equal(anchoredRead(prose, { maxChars: -1 }).text, undefined);
});

test("适配层：dispatch_read 把原始 JSONL 散文化并带行锚", async () => {
  const home = mkdtempSync(join(tmpdir(), "dispatch-adapter-read-"));
  const project = mkdtempSync(join(tmpdir(), "dispatch-proj-"));
  mkdirSync(join(project, ".git"), { recursive: true });
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { pi, handlers, tools } = fakePi();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entry(pi as any);
    await [...(handlers.get("session_start") ?? [])][0]!(undefined, fakeCtx(project));
    const stream = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "第一行结论\n第二行细节" }],
      },
    });
    const outDir = join(
      home,
      ".pi",
      "dispatch",
      encodeBucket(findProjectRoot(project)),
      "tasks",
      "abc123",
    );
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "output.log"), stream, "utf8");

    const def = tools.get("dispatch_read") as {
      execute: (id: string, args: unknown) => Promise<{ content: Array<{ text: string }> }>;
    };
    const out = await def.execute("call_1", { taskId: "abc123" });
    const payload = JSON.parse(out.content[0]!.text) as { text?: string; error?: string };
    assert.equal(payload.error, undefined);
    assert.match(payload.text!, /^1:[0-9a-f]{4}\|第一行结论\n2:[0-9a-f]{4}\|第二行细节$/);
    assert.ok(!payload.text!.includes("message_end"), "不给原始 JSONL");

    const missing = await def.execute("call_2", { taskId: "nope" });
    const missingPayload = JSON.parse(missing.content[0]!.text) as { error?: string };
    assert.match(missingPayload.error!, /还没落盘/);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});

// ── git 根探测（隔离能力的前置） ──────────────────────────────────────────

/** 真的 git 仓（git init 出来的）——rev-parse 只认真仓。 */
function makeGitRepo(withCommit: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-adapter-git-"));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd: dir, env, encoding: "utf8" });
  try {
    git(["init", "-b", "main"]);
  } catch {
    git(["init"]);
    git(["checkout", "-b", "main"]);
  }
  git(["config", "user.email", "verify@example.invalid"]);
  git(["config", "user.name", "verify"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["config", "core.hooksPath", join(dir, ".no-hooks")]);
  if (withCommit) git(["commit", "--allow-empty", "-m", "base"]);
  return dir;
}

test("适配层：非 git 目录 ⇒ 没有 git 根，隔离能力关着", () => {
  const plain = mkdtempSync(join(tmpdir(), "dispatch-adapter-plain-"));
  assert.equal(resolveRepoRoot(plain), undefined);
  assert.equal(isGitRepoAt(undefined), false, "没有 git 根 ⇒ 不是 git 仓");
});

test("适配层：真 git 仓 ⇒ git 根就是仓根，isGitRepoAt 为真", () => {
  const repo = makeGitRepo(true);
  const root = resolveRepoRoot(repo);
  assert.ok(root !== undefined, "真 git 仓问得出根");
  assert.equal(realpathSync(root), realpathSync(repo));
  assert.equal(isGitRepoAt(root), true);
});

test("适配层：空仓（还没提交）⇒ HEAD 不存在，不算可用 git 仓", () => {
  const empty = makeGitRepo(false);
  const root = resolveRepoRoot(empty);
  assert.ok(root !== undefined, "空仓也问得出根");
  assert.equal(isGitRepoAt(root), false, "钉不住 base ⇒ 隔离能力关着");
});

// ── 黑板：父方工具 / 孩子的黑板工具 / schema ──────────────────────────────

/** 装一个子代理进程（depth>0），在它活着的时候跑 fn（env 在 fn 期间保持不变）。 */
async function withChildTools<T>(
  env: Record<string, string | undefined>,
  fn: (tools: Map<string, unknown>) => Promise<T>,
): Promise<T> {
  const old = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    old.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    const { pi, handlers, tools } = fakePi();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entry(pi as any);
    await [...(handlers.get("session_start") ?? [])][0]!(undefined, fakeCtx(process.cwd()));
    return await fn(tools);
  } finally {
    for (const [key, value] of old) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("适配层：depth>0 时有黑板 env 才注册黑板工具", async () => {
  const plain = await withChildTools({ PI_DISPATCH_DEPTH: "1" }, async (tools) => tools);
  assert.deepEqual([...plain.keys()], ["child_report"], "没开黑板 ⇒ 孩子的工具表不变");

  const boardRoot = mkdtempSync(join(tmpdir(), "dispatch-board-"));
  const boardId = "11111111-2222-4333-8444-555555555555";
  const tools = await withChildTools(
    {
      PI_DISPATCH_DEPTH: "1",
      PI_DISPATCH_BLACKBOARD_DIR: join(boardRoot, boardId),
      PI_DISPATCH_BLACKBOARD_ID: boardId,
      PI_DISPATCH_TASK_ID: "task-123",
    },
    async (t) => t,
  );
  assert.deepEqual(
    [...tools.keys()].sort(),
    ["blackboard_read", "blackboard_write", "child_report"],
    "开了黑板 ⇒ 多两个黑板工具",
  );
});

test("黑板：作者取自 env，参数伪造不了", async () => {
  const boardRoot = mkdtempSync(join(tmpdir(), "dispatch-board-"));
  const boardId = "11111111-2222-4333-8444-555555555555";
  await withChildTools(
    {
      PI_DISPATCH_DEPTH: "1",
      PI_DISPATCH_BLACKBOARD_DIR: join(boardRoot, boardId),
      PI_DISPATCH_BLACKBOARD_ID: boardId,
      PI_DISPATCH_TASK_ID: "task-123",
    },
    async (tools) => {
      const write = tools.get("blackboard_write") as {
        execute: (id: string, args: unknown) => Promise<{ content: Array<{ text: string }> }>;
      };
      const out = await write.execute("call_1", {
        text: "我看到 X 了",
        author: "冒充的",
        trust: "verified",
      });
      const payload = JSON.parse(out.content[0]!.text) as {
        ok: boolean;
        note?: { author: string; text: string };
      };
      assert.equal(payload.ok, true);
      assert.equal(payload.note?.author, "task-123", "作者取自 env，参数伪造不了");
      assert.equal(payload.note?.text, "我看到 X 了");

      const read = tools.get("blackboard_read") as {
        execute: (id: string, args: unknown) => Promise<{ content: Array<{ text: string }> }>;
      };
      const readOut = await read.execute("call_2", {});
      const readPayload = JSON.parse(readOut.content[0]!.text) as {
        trust: string;
        notes: Array<{ text: string; author: string }>;
      };
      assert.equal(readPayload.trust, "unverified", "板上的话一律未核实");
      assert.equal(readPayload.notes[0]?.text, "我看到 X 了");
      assert.equal(readPayload.notes[0]?.author, "task-123");
    },
  );
});

test("黑板：空正文被拒时返回 ok:false（不能谎报成功）", async () => {
  const boardRoot = mkdtempSync(join(tmpdir(), "dispatch-board-"));
  const boardId = "11111111-2222-4333-8444-555555555555";
  await withChildTools(
    {
      PI_DISPATCH_DEPTH: "1",
      PI_DISPATCH_BLACKBOARD_DIR: join(boardRoot, boardId),
      PI_DISPATCH_BLACKBOARD_ID: boardId,
      PI_DISPATCH_TASK_ID: "task-123",
    },
    async (tools) => {
      const write = tools.get("blackboard_write") as {
        execute: (id: string, args: unknown) => Promise<{ content: Array<{ text: string }> }>;
      };
      const out = await write.execute("call_1", { text: "   " });
      const payload = JSON.parse(out.content[0]!.text) as { ok?: boolean; error?: string };
      assert.equal(payload.ok, false, "写失败时 ok 必须是 false");
      assert.match(payload.error ?? "", /空白/);
    },
  );
});

test("适配层：父方有 dispatch_blackboard 工具（只读）", async () => {
  const home = mkdtempSync(join(tmpdir(), "dispatch-adapter-bb2-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { pi, handlers, tools } = fakePi();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entry(pi as any);
    await [...(handlers.get("session_start") ?? [])][0]!(undefined, fakeCtx(home));
    assert.ok(tools.has("dispatch_blackboard"), "父方要能读黑板");
    const def = tools.get("dispatch_blackboard") as {
      execute: (id: string, args: unknown) => Promise<{ content: Array<{ text: string }> }>;
    };
    const out = await def.execute("call_1", {});
    const payload = JSON.parse(out.content[0]!.text) as { error?: string };
    assert.match(payload.error ?? "", /本会话还没有黑板/);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});

test("适配层：dispatch_list 对默认关记录的序列化与冻结基线逐字节相等（G14）", async () => {
  const home = mkdtempSync(join(tmpdir(), "dispatch-adapter-g14-"));
  const project = mkdtempSync(join(tmpdir(), "dispatch-proj-g14-"));
  mkdirSync(join(project, ".git"), { recursive: true });
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    // 默认关（没有 isolation / blackboard）的一条终态记录：先落盘，再让会话恢复它
    new Storage(`${home}/.pi/dispatch`, project).persistRecord({
      id: "default-off-0001",
      status: "succeeded",
      task: "干活",
      startedAt: 1700000000000,
      finishedAt: 1700000001234,
      outputPath: "/tmp/out.log",
      outputTruncated: false,
    });
    const { pi, handlers, tools } = fakePi();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entry(pi as any);
    await [...(handlers.get("session_start") ?? [])][0]!(undefined, fakeCtx(project));
    const def = tools.get("dispatch_list") as {
      execute: () => Promise<{ content: Array<{ text: string }> }>;
    };
    // 恢复是异步的（引擎的 #ready）；等它把记录装进 registry 再读
    let out = await def.execute();
    for (let i = 0; i < 20 && JSON.parse(out.content[0]!.text).total === 0; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      out = await def.execute();
    }
    // 冻结基线：键集合与值都与今天逐字节相等。新增三字段（isolation/worktree/blackboard）
    // 在默认关记录上是 undefined，JSON 里连键都不许出现。
    assert.equal(
      out.content[0]!.text,
      [
        "{",
        '  "total": 1,',
        '  "records": [',
        "    {",
        '      "id": "default-off-0001",',
        '      "status": "succeeded",',
        '      "startedAt": 1700000000000,',
        '      "finishedAt": 1700000001234,',
        '      "outputPath": "/tmp/out.log",',
        '      "outputTruncated": false',
        "    }",
        "  ]",
        "}",
      ].join("\n"),
    );
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});

test("适配层：坏记录被跳过时 dispatch_list 要明说条数", async () => {
  const home = mkdtempSync(join(tmpdir(), "dispatch-adapter-skip-"));
  const project = mkdtempSync(join(tmpdir(), "dispatch-proj-skip-"));
  mkdirSync(join(project, ".git"), { recursive: true });
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const storage = new Storage(`${home}/.pi/dispatch`, project);
    storage.persistRecord({
      id: "good-0001",
      status: "succeeded",
      task: "干活",
      startedAt: 1700000000000,
      finishedAt: 1700000001234,
      outputPath: "/tmp/out.log",
      outputTruncated: false,
    });
    // 一条形状不对的记录：恢复时被跳过，父方必须看得见少了几笔
    writeFileSync(
      storage.recordPath("bad").replace(/bad\.json$/, "bad.json"),
      JSON.stringify({ id: "bad", status: "done", task: "t" }),
      "utf8",
    );
    const { pi, handlers, tools } = fakePi();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entry(pi as any);
    await [...(handlers.get("session_start") ?? [])][0]!(undefined, fakeCtx(project));
    const def = tools.get("dispatch_list") as {
      execute: () => Promise<{ content: Array<{ text: string }> }>;
    };
    let out = await def.execute();
    for (let i = 0; i < 20 && JSON.parse(out.content[0]!.text).total === 0; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      out = await def.execute();
    }
    const payload = JSON.parse(out.content[0]!.text) as { skippedRecords?: number; total: number };
    assert.equal(payload.total, 1, "好记录照常进账");
    assert.equal(payload.skippedRecords, 1, "坏记录被跳过要明说条数");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});

test("适配层：dispatch_list 只回转向收据字段，缺正文、不 stale 不留键", async () => {
  const home = mkdtempSync(join(tmpdir(), "dispatch-adapter-steer-list-"));
  const project = mkdtempSync(join(tmpdir(), "dispatch-proj-steer-list-"));
  mkdirSync(join(project, ".git"), { recursive: true });
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const storage = new Storage(`${home}/.pi/dispatch`, project);
    // 报告早于最后一次送达（stale）：键要在，值恰好为 true
    storage.persistRecord({
      id: "steer-stale-01",
      status: "succeeded",
      task: "t",
      reportStale: true,
      steers: [
        {
          seq: 1,
          text: "正文不该进列表",
          at: 10,
          state: "seen",
          queuedAt: 11,
          deliveredAt: 12,
          seenAt: 13,
        },
        { seq: 2, text: "只写盘的一条", at: 20, state: "sent" },
      ],
    });
    // 报告晚于（或没有）转向：reportStale 为 false 时列表里不许出现这个键
    // 盘上写 false 是故意的：记录类型只允许 true / 缺席（引擎只写 true），
    // 但盘上可能有旧版或外来的 false —— 列表不许把它漏出来。
    storage.persistRecord({
      id: "steer-fresh-01",
      status: "succeeded",
      task: "t",
      reportStale: false,
      steers: [{ seq: 1, text: "另一段正文", at: 30, state: "queued", queuedAt: 31 }],
    } as unknown as TaskRecord);
    const { pi, handlers, tools } = fakePi();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entry(pi as any);
    await [...(handlers.get("session_start") ?? [])][0]!(undefined, fakeCtx(project));
    const def = tools.get("dispatch_list") as {
      execute: () => Promise<{ content: Array<{ text: string }> }>;
    };
    let out = await def.execute();
    // 恢复是逐条 await 的：等到两条都在，别停在第一条
    for (let i = 0; i < 40 && JSON.parse(out.content[0]!.text).total !== 2; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      out = await def.execute();
    }
    const records = (
      JSON.parse(out.content[0]!.text) as {
        records: Array<{ id: string; reportStale?: boolean; steers?: unknown[] }>;
      }
    ).records;
    const stale = records.find((r) => r.id === "steer-stale-01")!;
    assert.deepEqual(stale.steers, [
      { seq: 1, at: 10, state: "seen", queuedAt: 11, deliveredAt: 12, seenAt: 13 },
      { seq: 2, at: 20, state: "sent" },
    ]);
    assert.equal(stale.reportStale, true);
    assert.ok(!JSON.stringify(stale).includes("正文不该进列表"), "正文留在记录里，不进列表");
    const fresh = records.find((r) => r.id === "steer-fresh-01")!;
    assert.deepEqual(fresh.steers, [{ seq: 1, at: 30, state: "queued", queuedAt: 31 }]);
    assert.ok(!("reportStale" in fresh), "报告不早于转向时不留键（不写 false）");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});

test("适配层：dispatch_task 的 schema 有 blackboard", async () => {
  const home = mkdtempSync(join(tmpdir(), "dispatch-adapter-bb3-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { pi, handlers, tools } = fakePi();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entry(pi as any);
    await [...(handlers.get("session_start") ?? [])][0]!(undefined, fakeCtx(home));
    const def = tools.get("dispatch_task") as {
      parameters: { properties: Record<string, { type: string; description: string }> };
    };
    const blackboard = def.parameters.properties.blackboard!;
    assert.equal(blackboard.type, "boolean");
    assert.match(blackboard.description, /本会话/, "共享范围写清楚");
    assert.match(blackboard.description, /不可信/, "兄弟的话不可信");
    assert.match(blackboard.description, /strict/, "strict 例外写清楚");
    assert.match(blackboard.description, /策略/, "要不要开是父级策略");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});

test("适配层：dispatch_steer 的 schema 与描述钉住不打断/证据口径", async () => {
  const home = mkdtempSync(join(tmpdir(), "dispatch-adapter-steer-tool-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { pi, handlers, tools } = fakePi();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entry(pi as any);
    await [...(handlers.get("session_start") ?? [])][0]!(undefined, fakeCtx(home));
    const def = tools.get("dispatch_steer") as {
      description?: string;
      parameters?: { required?: string[]; properties?: Record<string, unknown> };
    };
    assert.match(def.description ?? "", /不打断在飞工具/, "先说明不抢占在飞工具");
    assert.match(def.description ?? "", /sent/, "sent 只表示写盘，不等于送达");
    assert.match(def.description ?? "", /dispatch_list/, "证据要从 dispatch_list 看");
    assert.deepEqual(def.parameters?.required, ["taskId", "message"]);
    assert.deepEqual(Object.keys(def.parameters?.properties ?? {}).sort(), ["message", "taskId"]);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});

test("适配层：孩子 turn_end 增量读信箱，失败不推进游标", async () => {
  const home = mkdtempSync(join(tmpdir(), "dispatch-adapter-steer-"));
  const oldHome = process.env.HOME;
  const oldDepth = process.env.PI_DISPATCH_DEPTH;
  const oldFile = process.env.PI_DISPATCH_STEER_FILE;
  const file = join(home, "steer.jsonl");
  process.env.HOME = home;
  process.env.PI_DISPATCH_DEPTH = "1";
  process.env.PI_DISPATCH_STEER_FILE = file;
  try {
    const { pi, handlers, sent } = fakePi({ failSends: 1 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entry(pi as any);
    await [...(handlers.get("session_start") ?? [])][0]!(undefined, fakeCtx(home));
    const turnEnd = [...(handlers.get("turn_end") ?? [])][0]!;
    writeFileSync(file, JSON.stringify({ seq: 1, text: "甲", at: 1 }) + "\n");

    await turnEnd();
    assert.equal(sent.length, 0, "第一次发送失败：游标不前进");
    await turnEnd();
    assert.equal(sent.length, 1, "下一轮重试同一条");
    assert.equal(
      sent[0]!.content,
      "[pi-dispatch-steer #1]\n父方在你运行期间调整了方向；这是对当前任务的补充/修正，不是新任务：\n甲",
    );
    assert.deepEqual(sent[0]!.options, { deliverAs: "steer" });

    await turnEnd();
    assert.equal(sent.length, 1, "已投过的不重投");

    // session_start 再来一次（new/fork）：只允许一个 turn_end handler，游标也不回零
    await [...(handlers.get("session_start") ?? [])][0]!(undefined, fakeCtx(home));
    assert.equal(handlers.get("turn_end")!.size, 1, "重复 session_start 不叠加收件箱");
    await [...(handlers.get("turn_end") ?? [])][0]!();
    assert.equal(sent.length, 1, "重装后游标照旧：同一条不重投");

    writeFileSync(
      file,
      [
        JSON.stringify({ seq: 1, text: "甲", at: 1 }),
        JSON.stringify({ seq: 2, text: "乙", at: 2 }),
      ].join("\n") + "\n",
    );
    await turnEnd();
    assert.equal(sent.length, 2);
    assert.equal(
      sent[1]!.content,
      "[pi-dispatch-steer #2]\n父方在你运行期间调整了方向；这是对当前任务的补充/修正，不是新任务：\n乙",
    );

    // 展开成数组是**必要的**：shutdown() 会退订（同一行下面断言 turn_end 的 size 归 0），
    // 直接迭代 Set 时改动它会让迭代器漏元素 ⇒ 先快照再调。lint 的 no-useless-spread 在这里是误报。
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const shutdown of [...(handlers.get("session_shutdown") ?? [])]) shutdown();
    assert.equal(handlers.get("turn_end")!.size, 0, "shutdown 后退订");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldDepth === undefined) delete process.env.PI_DISPATCH_DEPTH;
    else process.env.PI_DISPATCH_DEPTH = oldDepth;
    if (oldFile === undefined) delete process.env.PI_DISPATCH_STEER_FILE;
    else process.env.PI_DISPATCH_STEER_FILE = oldFile;
  }
});

test("适配层：旧 pi 没有 sendUserMessage 时孩子不装收件箱，也不崩", async () => {
  const home = mkdtempSync(join(tmpdir(), "dispatch-adapter-nosteer-"));
  const oldHome = process.env.HOME;
  const oldDepth = process.env.PI_DISPATCH_DEPTH;
  const oldFile = process.env.PI_DISPATCH_STEER_FILE;
  process.env.HOME = home;
  process.env.PI_DISPATCH_DEPTH = "1";
  process.env.PI_DISPATCH_STEER_FILE = join(home, "steer.jsonl");
  try {
    const { pi, handlers } = fakePi({ noSendUserMessage: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.doesNotThrow(() => entry(pi as any));
    await [...(handlers.get("session_start") ?? [])][0]!(undefined, fakeCtx(home));
    assert.equal(
      handlers.get("turn_end")?.size ?? 0,
      0,
      "没有能力就不装钩子（父方看到 undelivered）",
    );
    assert.ok(
      [...(handlers.get("session_shutdown") ?? [])].length === 0,
      "不装钩子也不留没人用的退订",
    );
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldDepth === undefined) delete process.env.PI_DISPATCH_DEPTH;
    else process.env.PI_DISPATCH_DEPTH = oldDepth;
    if (oldFile === undefined) delete process.env.PI_DISPATCH_STEER_FILE;
    else process.env.PI_DISPATCH_STEER_FILE = oldFile;
  }
});

test("steer 命令：工厂层只注册一次 /steer", async () => {
  const home = mkdtempSync(join(tmpdir(), "dispatch-adapter-steer-cmd-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { pi, handlers, commands, commandRegistrations } = fakePi();
    entry(pi as never);
    const start = [...(handlers.get("session_start") ?? [])][0]!;
    await start(undefined, fakeCtx(home));
    await start(undefined, fakeCtx(home)); // /new / resume 再触发
    assert.deepEqual([...commands.keys()], ["steer"]);
    assert.deepEqual(commandRegistrations, ["steer"], "注册调用只能 1 次；Map 覆盖会骗过 size");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});

test("steer 命令：depth>0 不注册（孩子进程里连命令都没有）", () => {
  const oldDepth = process.env.PI_DISPATCH_DEPTH;
  process.env.PI_DISPATCH_DEPTH = "1";
  try {
    const { pi, commands, commandRegistrations } = fakePi();
    entry(pi as never);
    assert.deepEqual([...commands.keys()], []);
    assert.deepEqual(commandRegistrations, []);
  } finally {
    if (oldDepth === undefined) delete process.env.PI_DISPATCH_DEPTH;
    else process.env.PI_DISPATCH_DEPTH = oldDepth;
  }
});

test("steer 命令：hasUI=false 时静默，不碰引擎", async () => {
  const { pi, commands } = fakePi();
  entry(pi as never);
  const notes: string[] = [];
  await commands.get("steer")!.handler("改", {
    hasUI: false,
    ui: { notify: (message: string) => notes.push(message) },
  });
  assert.deepEqual(notes, []);
});

test("steer 命令：没有活动会话时报错原文，不抛", async () => {
  const { pi, commands } = fakePi();
  entry(pi as never);
  const notes: Array<[string, string]> = [];
  await commands.get("steer")!.handler("改", {
    hasUI: true,
    ui: { notify: (message: string, level: string) => notes.push([message, level]) },
  });
  assert.deepEqual(notes, [["派单引擎未就绪", "error"]]);
});

// ── 适配层：预热钩子 / 预算 schema / 列表三列 / 终态通知 ────────────────

test("适配层：子代理进程（depth>0）注册 cache_warming_decision 并返回 stop", () => {
  const oldDepth = process.env.PI_DISPATCH_DEPTH;
  process.env.PI_DISPATCH_DEPTH = "1";
  try {
    const { pi, handlers } = fakePi();
    entry(pi as never);
    const hook = [...(handlers.get("cache_warming_decision") ?? [])][0];
    assert.ok(hook, "孩子进程要注册预热钩子");
    assert.deepEqual(hook({}, {}), { action: "stop" }, "孩子侧关掉预热");
  } finally {
    if (oldDepth === undefined) delete process.env.PI_DISPATCH_DEPTH;
    else process.env.PI_DISPATCH_DEPTH = oldDepth;
  }
});

test("适配层：父进程不注册 cache_warming_decision", () => {
  const oldDepth = process.env.PI_DISPATCH_DEPTH;
  process.env.PI_DISPATCH_DEPTH = "0";
  try {
    const { pi, handlers } = fakePi();
    entry(pi as never);
    assert.equal(handlers.get("cache_warming_decision"), undefined, "父会话预热照旧");
  } finally {
    if (oldDepth === undefined) delete process.env.PI_DISPATCH_DEPTH;
    else process.env.PI_DISPATCH_DEPTH = oldDepth;
  }
});

test("适配层：pi 不认识 cache_warming_decision 时不炸", () => {
  const oldDepth = process.env.PI_DISPATCH_DEPTH;
  process.env.PI_DISPATCH_DEPTH = "1";
  try {
    const { pi } = fakePi({ unknownEvents: ["cache_warming_decision"] });
    assert.doesNotThrow(() => entry(pi as never), "老版本 pi 注册未知事件不影响派发");
  } finally {
    if (oldDepth === undefined) delete process.env.PI_DISPATCH_DEPTH;
    else process.env.PI_DISPATCH_DEPTH = oldDepth;
  }
});

test("适配层：dispatch_task 的 schema 带 usageBudget", async () => {
  const home = mkdtempSync(join(tmpdir(), "dispatch-adapter-budget-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { pi, handlers, tools } = fakePi();
    entry(pi as never);
    await [...(handlers.get("session_start") ?? [])][0]!(undefined, fakeCtx(home));
    const def = tools.get("dispatch_task") as {
      parameters: {
        properties: Record<
          string,
          { type: string; description: string; properties?: Record<string, { type: string }> }
        >;
      };
    };
    const budget = def.parameters.properties.usageBudget!;
    assert.equal(budget.type, "object");
    assert.match(budget.description, /cacheRead/, "token 口径含缓存要说清");
    assert.deepEqual(Object.keys(budget.properties ?? {}).sort(), [
      "hardFactor",
      "hardGraceMs",
      "maxTokens",
      "maxUsd",
    ]);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});

test("适配层：dispatch_list 的行带 budget / thinking / budgetExhausted 三列", async () => {
  const home = mkdtempSync(join(tmpdir(), "dispatch-adapter-budget-list-"));
  const project = mkdtempSync(join(tmpdir(), "dispatch-proj-budget-list-"));
  mkdirSync(join(project, ".git"), { recursive: true });
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    new Storage(`${home}/.pi/dispatch`, project).persistRecord({
      id: "budget-0001",
      status: "succeeded",
      task: "干活",
      budget: { maxUsd: 1, spentUsd: 2, spentTokens: 300, exhausted: true },
      budgetExhausted: true,
      thinking: {
        requested: "medium",
        effective: "low",
        adjusted: true,
        modelKnown: true,
        reason: "该模型没有 medium 档",
      },
    });
    const { pi, handlers, tools } = fakePi();
    entry(pi as never);
    await [...(handlers.get("session_start") ?? [])][0]!(undefined, fakeCtx(project));
    const def = tools.get("dispatch_list") as {
      execute: () => Promise<{ content: Array<{ text: string }> }>;
    };
    let out = await def.execute();
    for (let i = 0; i < 20 && JSON.parse(out.content[0]!.text).total === 0; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      out = await def.execute();
    }
    const row = (
      JSON.parse(out.content[0]!.text) as {
        records: Array<{
          id: string;
          budget?: { maxUsd?: number; spentTokens?: number };
          thinking?: { requested?: string; effective?: string };
          budgetExhausted?: boolean;
        }>;
      }
    ).records.find((r) => r.id === "budget-0001")!;
    assert.equal(row.budget?.maxUsd, 1);
    assert.equal(row.budget?.spentTokens, 300);
    assert.equal(row.thinking?.requested, "medium");
    assert.equal(row.thinking?.effective, "low");
    assert.equal(row.budgetExhausted, true);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});

test("适配层：终态通知在预算到点时带「降级交付」、降档时带「high→low」", async () => {
  const registry = new TaskRegistry();
  const notifications = new NotificationCenter();
  notifications.attach(registry as never);
  await registry.submit({
    kind: "spawn",
    record: {
      id: "budget-notify-1",
      status: "succeeded",
      task: "t",
      finishedAt: 1700000000000,
      budgetExhausted: true,
      thinking: {
        requested: "high",
        effective: "low",
        adjusted: true,
        modelKnown: true,
      },
    },
  });
  const sent: Array<{ content?: string }> = [];
  deliver({ sendMessage: (m: { content?: string }) => sent.push(m) } as never, notifications);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.content!, /预算到点（降级交付）/);
  assert.match(sent[0]!.content!, /思考档位 high→low/);
});

// ── 适配层：TUI 接线 / 空 steers 收据 ───────────────────────────────────

test("适配层：TUI 常驻面只在 mode=tui 时挂（rpc 不碰 UI）", async () => {
  const home = mkdtempSync(join(tmpdir(), "dispatch-adapter-tui-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  /** 假 ctx.ui：只记调用，不渲染。 */
  const recorder = (): { calls: string[]; ui: unknown } => {
    const calls: string[] = [];
    return {
      calls,
      ui: {
        setWidget: (key: string) => calls.push(`widget:${key}`),
        setStatus: (key: string) => calls.push(`status:${key}`),
      },
    };
  };
  try {
    // tui：挂常驻面（挂载即推一次 widget + status）
    const tui = recorder();
    const tuiPi = fakePi();
    entry(tuiPi.pi as never);
    await [...(tuiPi.handlers.get("session_start") ?? [])][0]!(undefined, {
      mode: "tui",
      cwd: home,
      model: undefined,
      ui: tui.ui,
    });
    assert.ok(
      tui.calls.some((call) => call.startsWith("widget:")),
      "tui 模式要挂常驻面板",
    );

    // rpc：同一套装配，但不许碰常驻面板
    const rpc = recorder();
    const rpcPi = fakePi();
    entry(rpcPi.pi as never);
    await [...(rpcPi.handlers.get("session_start") ?? [])][0]!(undefined, {
      mode: "rpc",
      cwd: home,
      model: undefined,
      ui: rpc.ui,
    });
    assert.deepEqual(rpc.calls, [], "rpc 模式不挂常驻面板");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});

test("适配层：dispatch_list 的空 steers 数组不留键（空数组也不行）", async () => {
  const home = mkdtempSync(join(tmpdir(), "dispatch-adapter-empty-steers-"));
  const project = mkdtempSync(join(tmpdir(), "dispatch-proj-empty-steers-"));
  mkdirSync(join(project, ".git"), { recursive: true });
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    // 盘上可能有一条 steers 为空数组的旧记录：列表不许把这个空键漏出来
    new Storage(`${home}/.pi/dispatch`, project).persistRecord({
      id: "empty-steers-01",
      status: "succeeded",
      task: "t",
      steers: [],
    });
    const { pi, handlers, tools } = fakePi();
    entry(pi as never);
    await [...(handlers.get("session_start") ?? [])][0]!(undefined, fakeCtx(project));
    const def = tools.get("dispatch_list") as {
      execute: () => Promise<{ content: Array<{ text: string }> }>;
    };
    let out = await def.execute();
    for (let i = 0; i < 20 && JSON.parse(out.content[0]!.text).total === 0; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      out = await def.execute();
    }
    const rows = (
      JSON.parse(out.content[0]!.text) as {
        records: Array<{ id: string; steers?: unknown[] }>;
      }
    ).records;
    const row = rows.find((r) => r.id === "empty-steers-01")!;
    assert.ok(!("steers" in row), "空 steers 数组不许在列表里留键");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});
