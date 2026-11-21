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
    assert.deepEqual([...tools.keys()].sort(), [
      "dispatch_blackboard",
      "dispatch_list",
      "dispatch_read",
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
    }) as never,
  );
  assert.ok(out.text.includes("摘要见 report"));
  assert.ok(out.text.length < 12 * 1024, "8KB 窗 + 标记");
});

test("归约：回执空转或核对挂了 ⇒ 落回大窗", () => {
  const vacuous = excerptDeliverable(
    resultWith({
      report: { summary: "s", why: "w", assessment: "整体非常顺利圆满达成。" },
      reportChannel: "tool",
      assessmentVacuous: true,
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
    }) as never,
  );
  assert.ok(!unverified.text.includes("摘要见 report"), "核对挂了失去小窗资格");
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
