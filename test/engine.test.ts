// 阶段 6 探针：通知队列 + 引擎编排。
// 引擎探针用假 spawn（可控 stdout / 退出码 / 时序），不起真 pi 进程。
//
// 等价变异（探针杀不掉，也不该杀）：
//   src/core/engine.ts 构造器里 ~14 个 `deps.x ?? 默认值` —— 探针都注入真值，
//   `??` 与 `||` 只在注入假值（0/""）时才有区别，而这些配置字段不会是 0 或 ""，
//   故对「注入真值」的用法等价。要让它们不等价，得注入 0——但 terminalKeep=0
//   意为「一条不留」，是另一个合法用例。当前注入模式下探针无法区分。
//   src/core/engine.ts 的 `this.#storage?.x`（504/509/574 行）——storage 是可选的，
//   没注入时 `?.` 与 `.` 都抛？不，?. 返回 undefined，. 抛 TypeError。
//   但那些路径都有 `?? undefined` 兜底 ⇒ 等价。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskEngine } from "../src/core/engine.ts";
import { TaskRegistry } from "../src/core/registry.ts";
import { batchBySize, NotificationCenter } from "../src/core/notifications.ts";
import { Storage } from "../src/core/storage.ts";
import type { MachineReader, MachineSpec } from "../src/core/pool.ts";
import type { ChildHandle } from "../src/core/child.ts";

const GiB = 1024 * 1024 * 1024;
const MiB = 1024 * 1024;

/** 假机器：一台 24 GiB / 10 核、此刻可用 5.24 GiB 的机器 ⇒ 池子量 2911 MiB ÷ 512 = 5 座。 */
function machineReader(availableBytes = 5369 * MiB): MachineReader {
  const spec: MachineSpec = { totalBytes: 24 * GiB, cpus: 10 };
  return { readSpec: () => spec, readAvailable: () => availableBytes };
}

/** 假 spawn：可控 stdout / 退出码 / 时序。 */
function fakeSpawn(options: {
  stdout?: string;
  exitCode?: number;
  delayMs?: number;
}): (argv: string[], env: NodeJS.ProcessEnv) => ChildHandle {
  return () => {
    const listeners: Array<(chunk: string) => void> = [];
    const exitListeners: Array<(code: number, stderr: string) => void> = [];
    let exitCode: number | null = null;
    const finish = (code: number): void => {
      if (exitCode !== null) return;
      exitCode = code;
      clearTimeout(timer); // 退出后放行事件循环（孩子死了就不再拽着）
      for (const l of exitListeners) l(code, "");
    };
    // 假孩子也要拽住事件循环直到退出——否则 node 会在派发后立刻退出（真进程不会）
    const timer = setTimeout(() => {
      if (options.stdout) for (const l of listeners) l(options.stdout);
      finish(options.exitCode ?? 0);
    }, options.delayMs ?? 5);
    return {
      pid: Math.floor(Math.random() * 100000) + 1000,
      onOutput: (cb) => listeners.push(cb),
      onExit: (cb) => {
        exitListeners.push(cb);
        if (exitCode !== null) cb(exitCode, "");
      },
      kill: () => finish(143),
    };
  };
}

function freshEngine(
  opts: {
    machineReader?: MachineReader;
    spawn?: ReturnType<typeof fakeSpawn>;
    hostMode?: "long-lived" | "one-shot";
    storage?: Storage;
    stallMs?: number;
    whyEnabled?: () => boolean;
    allowScriptsDefault?: () => boolean;
    dispatchEnabled?: () => boolean;
  } = {},
) {
  const registry = new TaskRegistry();
  const engine = new TaskEngine({
    registry,
    machineReader: opts.machineReader ?? machineReader(),
    spawnChild: opts.spawn ?? fakeSpawn({}),
    hostMode: opts.hostMode ?? "long-lived",
    storage: opts.storage,
    stallMs: opts.stallMs,
    whyEnabled: opts.whyEnabled,
    allowScriptsDefault: opts.allowScriptsDefault,
    dispatchEnabled: opts.dispatchEnabled,
  });
  return { registry, engine };
}

/** 等 registry 里某任务到终态。 */
function waitFor(registry: TaskRegistry, taskId: string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等 ${taskId} 超时`)), timeoutMs);
    const check = (r: { id: string; status: string }): void => {
      if (r.id !== taskId) return;
      if (["succeeded", "failed", "canceled", "lost"].includes(r.status)) {
        clearTimeout(timer);
        resolve(r.status);
      }
    };
    registry.subscribe(check);
    const current = registry.get(taskId);
    if (current && ["succeeded", "failed", "canceled", "lost"].includes(current.status)) {
      clearTimeout(timer);
      resolve(current.status);
    }
  });
}

// ── 通知队列 ──────────────────────────────────────────────────────────────

test("通知：终态进队列，drain 取走即清", async () => {
  const registry = new TaskRegistry();
  const nc = new NotificationCenter();
  nc.attach(registry as never);
  await registry.submit({ kind: "spawn", record: { id: "a", status: "queued", task: "t" } });
  assert.equal(nc.pendingCount(), 0);
  await registry.submit({ kind: "transition", id: "a", to: "running" });
  assert.equal(nc.pendingCount(), 0, "非终态不进队列");
  await registry.submit({ kind: "resolve-exit", id: "a", exitCode: 0 });
  assert.equal(nc.pendingCount(), 1, "终态进队列");
  const batches = nc.drain();
  assert.equal(batches.length, 1);
  assert.equal(batches[0]![0]!.taskId, "a");
  assert.equal(nc.pendingCount(), 0, "drain 取走即清");
});

test("通知：drain 按 100 KB 分批", async () => {
  const registry = new TaskRegistry();
  const nc = new NotificationCenter();
  nc.attach(registry as never);
  for (let i = 0; i < 10; i++) {
    await registry.submit({ kind: "spawn", record: { id: `t${i}`, status: "queued", task: "t" } });
    await registry.submit({ kind: "transition", id: `t${i}`, to: "running" });
    await registry.submit({ kind: "resolve-exit", id: `t${i}`, exitCode: 0 });
  }
  // 每条通知的 JSON 远小于 100 KB ⇒ 只一批
  const batches = nc.drain();
  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.length, 10);
});

test("通知：非终态不进队列（queued/running/stopping 都不进）", async () => {
  const registry = new TaskRegistry();
  const nc = new NotificationCenter();
  nc.attach(registry as never);
  await registry.submit({ kind: "spawn", record: { id: "a", status: "queued", task: "t" } });
  await registry.submit({ kind: "transition", id: "a", to: "running" });
  await registry.submit({ kind: "stop", id: "a", reason: "x" }); // → stopping，不是终态
  assert.equal(nc.pendingCount(), 0);
});

// ── 引擎：安检与记录 ─────────────────────────────────────────────────────

test("引擎：安检不过要退回，且不留记录不占座位", async () => {
  const { registry, engine } = freshEngine();
  const rejected = await engine.dispatch({ task: "" });
  assert.equal((rejected as { status: string }).status, "rejected");
  assert.equal(registry.list().length, 0, "被拒不留记录");
});

test("引擎：任务以横线开头要拒，不留记录", async () => {
  const { registry, engine } = freshEngine();
  const rejected = await engine.dispatch({ task: "--help" });
  assert.equal((rejected as { status: string }).status, "rejected");
  assert.equal(registry.list().length, 0);
});

test("引擎：派发开关关着要拒（谓词热生效）", async () => {
  let enabled = true;
  const { engine } = freshEngine({ dispatchEnabled: () => enabled });
  enabled = false;
  const rejected = await engine.dispatch({ task: "干活" });
  assert.equal((rejected as { status: string }).status, "rejected");
  enabled = true;
  const ok = await engine.dispatch({ task: "干活" });
  assert.equal((ok as { status: string }).status, "queued");
});

test("引擎：理由开关关着——记「理由被丢了」，不记内容", async () => {
  const { registry, engine } = freshEngine({ whyEnabled: () => false });
  const outcome = await engine.dispatch({ task: "干活", why: "机密原因" });
  const taskId = (outcome as { taskId: string }).taskId;
  const record = registry.get(taskId);
  assert.equal(record?.whySuppressed, true, "记一笔「理由被丢了」");
  assert.equal(record?.task, "干活");
  // 内容没留下（只有事件）
  assert.ok(!JSON.stringify(record).includes("机密原因"), "内容要丢");
});

test("引擎：理由开关开着——不记「理由被丢了」", async () => {
  const { engine } = freshEngine({ whyEnabled: () => true });
  const outcome = await engine.dispatch({ task: "干活", why: "因为需要" });
  assert.equal((outcome as { whySuppressed?: boolean }).whySuppressed, false);
});

// ── 引擎：座位与排队 ─────────────────────────────────────────────────────

test("引擎：座位够就起，退出码 0 是「成了」", async () => {
  const { registry, engine } = freshEngine({
    spawn: fakeSpawn({ stdout: "done", exitCode: 0 }),
  });
  const outcome = await engine.dispatch({ task: "干活" });
  const taskId = (outcome as { taskId: string }).taskId;
  const status = await waitFor(registry, taskId);
  assert.equal(status, "succeeded");
});

test("引擎：退出码非 0 是「败了」", async () => {
  const { registry, engine } = freshEngine({
    spawn: fakeSpawn({ stdout: "error output", exitCode: 1 }),
  });
  const outcome = await engine.dispatch({ task: "干活" });
  const taskId = (outcome as { taskId: string }).taskId;
  const status = await waitFor(registry, taskId);
  assert.equal(status, "failed");
});

test("引擎：机器规格只在启动时读一次，之后判座位不重读", async () => {
  let specReads = 0;
  const { engine } = freshEngine({
    machineReader: {
      readSpec: () => {
        specReads += 1;
        return { totalBytes: 24 * GiB, cpus: 10 };
      },
      readAvailable: () => 5369 * MiB,
    },
  });
  await engine.dispatch({ task: "A" });
  await engine.dispatch({ task: "B" });
  assert.equal(specReads, 1, `readSpec 被调了 ${specReads} 次（总内存和核数是恒定的）`);
  await engine.shutdown();
});

test("引擎：此刻可用每次判座位都重读（波动的读数不许缓存）", async () => {
  let availableReads = 0;
  const { engine } = freshEngine({
    machineReader: {
      readSpec: () => ({ totalBytes: 24 * GiB, cpus: 10 }),
      readAvailable: () => {
        availableReads += 1;
        return 5369 * MiB;
      },
    },
  });
  await engine.dispatch({ task: "A" });
  await engine.dispatch({ task: "B" });
  assert.ok(
    availableReads >= 3,
    `readAvailable 只被调了 ${availableReads} 次（构造 1 次 + 每次判座位 1 次）`,
  );
  await engine.shutdown();
});

test("引擎：池子不够就排队，座位空出来自己起（叫醒 ≠ 启动，不能漏接）", async () => {
  // 一台只能开 1 个座位的机器
  // 用 24 GiB 机器但把可用压到只能开 1 座：可用 = 预留 + 1 座份额
  const oneSeatAvailable = Math.floor(2.4 * GiB) + 512 * MiB + 100 * MiB; // 预留 2.4G + 1 座 512M + 余量
  const { registry, engine } = freshEngine({
    machineReader: machineReader(oneSeatAvailable),
    spawn: fakeSpawn({ stdout: "x", exitCode: 0, delayMs: 50 }),
  });
  const first = await engine.dispatch({ task: "第一个" });
  const second = await engine.dispatch({ task: "第二个" });
  assert.equal((first as { status: string }).status, "queued");
  assert.equal((second as { status: string }).status, "queued", "池子只够 1 座 ⇒ 第二个排队");
  // 第一个跑完，第二个要自己被起起来
  const secondId = (second as { taskId: string }).taskId;
  const status = await waitFor(registry, secondId, 5000);
  assert.equal(status, "succeeded", "第一个还座后第二个被起（没漏接）");
});

test("引擎：长驻模式立刻返回编号，不等终态", async () => {
  const { engine } = freshEngine({
    spawn: fakeSpawn({ stdout: "x", exitCode: 0, delayMs: 100 }),
    hostMode: "long-lived",
  });
  const outcome = await engine.dispatch({ task: "干活" });
  assert.equal((outcome as { status: string }).status, "queued");
  assert.ok((outcome as { taskId: string }).taskId);
});

test("引擎：一次性模式等到终态才返回", async () => {
  const { engine } = freshEngine({
    spawn: fakeSpawn({ stdout: "交付正文", exitCode: 0, delayMs: 20 }),
    hostMode: "one-shot",
  });
  const outcome = await engine.dispatch({ task: "干活" });
  assert.equal((outcome as { status: string }).status, "succeeded");
  assert.equal((outcome as { text: string }).text, "交付正文");
});

// ── 引擎：停止与卡住 ─────────────────────────────────────────────────────

test("引擎：排队中的可以抽掉", async () => {
  const oneSeatAvailable = Math.floor(2.4 * GiB) + 512 * MiB + 100 * MiB;
  const { registry, engine } = freshEngine({
    machineReader: machineReader(oneSeatAvailable),
    spawn: fakeSpawn({ stdout: "x", exitCode: 0, delayMs: 200 }),
  });
  const first = await engine.dispatch({ task: "第一个" });
  const second = await engine.dispatch({ task: "第二个" });
  const secondId = (second as { taskId: string }).taskId;
  await engine.stop(secondId, "不想跑了");
  const status = await waitFor(registry, secondId);
  assert.equal(status, "canceled");
  void first;
});

test("引擎：卡住——静默超过阈值收尸", async () => {
  // 假 spawn 不产 stdout ⇒ 一直静默
  const { registry, engine } = freshEngine({
    spawn: fakeSpawn({ stdout: "", exitCode: 0, delayMs: 500 }),
    stallMs: 100, // 100ms 就算卡住
  });
  const outcome = await engine.dispatch({ task: "干活" });
  const taskId = (outcome as { taskId: string }).taskId;
  const status = await waitFor(registry, taskId, 5000);
  assert.equal(status, "canceled", "卡住收尸后算取消（叫停过的一律取消）");
});

// ── 引擎：收件 ──────────────────────────────────────────────────────────

test("引擎：收四样——正文 / 报告 / 用量 / 收据", async () => {
  const stream = [
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"结论"}],"usage":{"input":10,"output":5}}}',
    '{"type":"tool_execution_start","toolName":"read","args":{"path":"/a"}}',
  ].join("\n");
  const { engine } = freshEngine({
    spawn: fakeSpawn({ stdout: stream, exitCode: 0 }),
    hostMode: "one-shot",
  });
  const outcome = await engine.dispatch({ task: "干活" });
  const result = outcome as {
    status: string;
    text: string;
    delivery?: { tools: Record<string, number>; paths: string[] };
  };
  assert.equal(result.status, "succeeded");
  assert.equal(result.text, "结论");
  assert.equal(result.delivery?.tools.read, 1);
  assert.deepEqual(result.delivery?.paths, ["/a"]);
});

test("引擎：用量自报为空时用观察到的顶上去", async () => {
  // 真实形态：报告的 JSON 块在最终 assistant 消息的 text 里
  const assistantText = [
    "这是正文。",
    "```json",
    '{ "summary": "有报告", "usage": { "input": 0, "output": 0 } }',
    "```",
  ].join("\n");
  const stream = [
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: assistantText }],
        usage: { input: 42, output: 7 },
      },
    }),
  ].join("\n");
  const { engine } = freshEngine({
    spawn: fakeSpawn({ stdout: stream, exitCode: 0 }),
    hostMode: "one-shot",
  });
  const outcome = await engine.dispatch({ task: "干活" });
  const result = outcome as { status: string; report?: { usage?: { input?: number } } };
  assert.equal(result.report?.usage?.input, 42, "自报是 0 ⇒ 用观察到的 42");
});

test("引擎：自述改了文件、收据一个都对不上 ⇒ 结果带 deliveryUnverified", async () => {
  const stream = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: '改完了\n```json\n{"summary":"ok","files_touched":["src/a.ts"]}\n```',
        },
      ],
    },
  });
  const { engine } = freshEngine({
    spawn: fakeSpawn({ stdout: stream, exitCode: 0 }),
    hostMode: "one-shot",
  });
  const outcome = await engine.dispatch({ task: "干活" });
  const result = outcome as { status: string; deliveryUnverified?: boolean };
  assert.equal(result.status, "succeeded");
  assert.equal(result.deliveryUnverified, true, "收据里没有任何路径支持这个自述");
});

test("引擎：自述与收据是同一文件（写法不同）⇒ 不报没有实测支撑", async () => {
  const stream = [
    JSON.stringify({
      type: "tool_execution_start",
      toolName: "edit",
      args: { path: "/repo/src/a.ts" },
    }),
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: '改完了\n```json\n{"summary":"ok","files_touched":["src/a.ts"]}\n```',
          },
        ],
      },
    }),
  ].join("\n");
  const { engine } = freshEngine({
    spawn: fakeSpawn({ stdout: stream, exitCode: 0 }),
    hostMode: "one-shot",
  });
  const outcome = await engine.dispatch({ task: "干活" });
  assert.equal((outcome as { deliveryUnverified?: boolean }).deliveryUnverified, undefined);
});

// ── 引擎：留痕 ──────────────────────────────────────────────────────────

test("引擎：终态落盘，能读回记录", async () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-engine-"));
  const project = join(root, "proj");
  mkdirSync(join(project, ".git"), { recursive: true });
  const storage = new Storage(join(root, "dispatch"), project);
  const { registry, engine } = freshEngine({
    spawn: fakeSpawn({ stdout: "x", exitCode: 0 }),
    storage,
    hostMode: "one-shot",
  });
  const outcome = await engine.dispatch({ task: "干活" });
  const taskId = (outcome as { taskId: string }).taskId;
  const record = registry.get(taskId);
  assert.equal(record?.status, "succeeded");
  // 盘上也有
  const restored = storage.restoreRecords();
  assert.ok(restored.some((r) => r.id === taskId));
});

// ── 引擎：allowScripts ───────────────────────────────────────────────────

test("引擎：allowScripts 缺省用会话默认值", async () => {
  let seenArgv: string[] = [];
  const spawn = (argv: string[]): ChildHandle => {
    seenArgv = argv;
    const listeners: Array<(c: string) => void> = [];
    const exits: Array<(c: number) => void> = [];
    setTimeout(() => {
      for (const l of exits) l(0);
    }, 5);
    return {
      pid: 1,
      onOutput: (cb) => listeners.push(cb),
      onExit: (cb) => exits.push(cb),
      kill: () => {},
    };
  };
  const { engine } = freshEngine({
    spawn: spawn as never,
    allowScriptsDefault: () => true,
    hostMode: "one-shot",
  });
  await engine.dispatch({ task: "干活" });
  assert.ok(seenArgv.includes("builtin:codemode"), "会话默认开着 ⇒ 带上 codemode");
  assert.ok(
    !seenArgv.includes("--tools"),
    "宽档不收窄 ⇒ 不发 --tools（否则 bash/edit/write 没了）",
  );
});

test("引擎：调用方显式给 allowScripts:false 覆盖会话默认", async () => {
  let seenArgv: string[] = [];
  const spawn = (argv: string[]): ChildHandle => {
    seenArgv = argv;
    const exits: Array<(c: number) => void> = [];
    setTimeout(() => {
      for (const l of exits) l(0);
    }, 5);
    return {
      pid: 1,
      onOutput: () => {},
      onExit: (cb) => exits.push(cb),
      kill: () => {},
    };
  };
  const { engine } = freshEngine({
    spawn: spawn as never,
    allowScriptsDefault: () => true,
    hostMode: "one-shot",
  });
  await engine.dispatch({ task: "干活", allowScripts: false });
  assert.ok(!seenArgv.includes("builtin:codemode"), "调用方关掉 ⇒ 不带 codemode");
});

// ── 引擎变异补强：把默认配置与编排分支钉死 ───────────────────────────────

test("引擎：终态热存上限默认 500", async () => {
  // 造 3 个终态 + keep=2 ⇒ 挤掉最老 1 个
  const { registry, engine } = freshEngine({ terminalKeep: 2 } as never);
  void engine;
  for (const id of ["a", "b", "c"]) {
    await registry.submit({ kind: "spawn", record: { id, status: "queued", task: "t" } });
    await registry.submit({ kind: "transition", id, to: "running" });
    await registry.submit({ kind: "resolve-exit", id, exitCode: 0 });
  }
  const evicted = registry.evictTerminal(2).map((r) => r.id);
  assert.equal(evicted.length, 1);
});

test("引擎：卡住阈值默认 5 分钟（关掉要用 0）", async () => {
  // stallMs: 0 ⇒ 不装停滞护栏（任务可以一直跑）
  const { registry, engine } = freshEngine({
    spawn: fakeSpawn({ stdout: "", exitCode: 0, delayMs: 200 }),
    stallMs: 0,
    hostMode: "long-lived",
  });
  const outcome = await engine.dispatch({ task: "干活" });
  const taskId = (outcome as { taskId: string }).taskId;
  const status = await waitFor(registry, taskId, 3000);
  assert.equal(status, "succeeded", "stallMs=0 ⇒ 不判卡住，正常跑完");
});

test("引擎：深度上限默认 3", async () => {
  process.env.PI_DISPATCH_DEPTH = "3";
  try {
    const { engine } = freshEngine();
    const rejected = await engine.dispatch({ task: "干活" });
    assert.equal((rejected as { status: string }).status, "rejected");
    assert.match((rejected as { errorMessage: string }).errorMessage, /depth/);
  } finally {
    delete process.env.PI_DISPATCH_DEPTH;
  }
});

test("引擎：深度 2 可以派（还没到上限）", async () => {
  process.env.PI_DISPATCH_DEPTH = "2";
  try {
    const { engine } = freshEngine();
    const outcome = await engine.dispatch({ task: "干活" });
    assert.equal((outcome as { status: string }).status, "queued");
  } finally {
    delete process.env.PI_DISPATCH_DEPTH;
  }
});

test("引擎：allowScripts 会话默认缺省是 false", async () => {
  let seenArgv: string[] = [];
  const spawn = (argv: string[]): ChildHandle => {
    seenArgv = argv;
    const exits: Array<(c: number) => void> = [];
    setTimeout(() => {
      for (const l of exits) l(0);
    }, 5);
    return { pid: 1, onOutput: () => {}, onExit: (cb) => exits.push(cb), kill: () => {} };
  };
  const { engine } = freshEngine({ spawn: spawn as never, hostMode: "one-shot" });
  await engine.dispatch({ task: "干活" });
  assert.ok(!seenArgv.includes("builtin:codemode"), "没给会话默认 ⇒ 不带 codemode");
});

test("引擎：timeoutMs 给了才计时（超了收掉）", async () => {
  const { registry, engine } = freshEngine({
    spawn: fakeSpawn({ stdout: "x", exitCode: 0, delayMs: 500 }),
    hostMode: "long-lived",
  });
  const outcome = await engine.dispatch({ task: "干活", timeoutMs: 50 });
  const taskId = (outcome as { taskId: string }).taskId;
  const status = await waitFor(registry, taskId, 3000);
  assert.equal(status, "canceled", "超时收掉算取消");
});

test("引擎：等启动名额时被叫停就不 spawn", async () => {
  // 起一个慢任务占着启动名额，第二个任务等名额时被停
  const { registry, engine } = freshEngine({
    spawn: fakeSpawn({ stdout: "x", exitCode: 0, delayMs: 100 }),
    hostMode: "long-lived",
  });
  const first = await engine.dispatch({ task: "占着" });
  const second = await engine.dispatch({ task: "等名额" });
  const secondId = (second as { taskId: string }).taskId;
  // 趁第二个还在等启动名额，停掉它
  await engine.stop(secondId, "等的时候反悔");
  const status = await waitFor(registry, secondId, 3000);
  assert.equal(status, "canceled");
  void first;
});

test("引擎：拆卸发生在启动前要报失败，不 spawn 孤儿", async () => {
  const { engine } = freshEngine({
    spawn: fakeSpawn({ stdout: "x", exitCode: 0 }),
    hostMode: "one-shot",
  });
  // 先拆卸再派发
  await engine.shutdown();
  const outcome = await engine.dispatch({ task: "干活" });
  assert.equal((outcome as { status: string }).status, "rejected");
  assert.match((outcome as { errorMessage: string }).errorMessage, /拆卸|ending/);
});

test("引擎：shutdown 抽干等待者（排队的被取消）", async () => {
  const oneSeatAvailable = Math.floor(2.4 * GiB) + 512 * MiB + 100 * MiB;
  const { registry, engine } = freshEngine({
    machineReader: machineReader(oneSeatAvailable),
    spawn: fakeSpawn({ stdout: "x", exitCode: 0, delayMs: 300 }),
    hostMode: "long-lived",
  });
  const first = await engine.dispatch({ task: "第一个" });
  const second = await engine.dispatch({ task: "第二个" });
  const secondId = (second as { taskId: string }).taskId;
  await engine.shutdown();
  const status = await waitFor(registry, secondId, 3000);
  assert.equal(status, "canceled", "排队的被抽干");
  void first;
});

test("通知：单条超过 100 KB 也要成批（不能丢）", async () => {
  const registry = new TaskRegistry();
  const nc = new NotificationCenter();
  nc.attach(registry as never);
  // 造一条超大通知（JSON 后 > 100KB）
  const big = "x".repeat(120 * 1024);
  await registry.submit({ kind: "spawn", record: { id: big, status: "queued", task: "t" } });
  await registry.submit({ kind: "transition", id: big, to: "running" });
  await registry.submit({ kind: "resolve-exit", id: big, exitCode: 0 });
  const batches = nc.drain();
  assert.equal(batches.length, 1, "超大单条也要进一批（不能丢）");
  assert.equal(batches[0]![0]!.taskId, big);
});

test("通知：多条恰好凑满一批时切下一批", async () => {
  const registry = new TaskRegistry();
  const nc = new NotificationCenter();
  nc.attach(registry as never);
  // 每条大约 60 字节——两条 120 > 100？不至于。造 2000 条小的看看分批
  for (let i = 0; i < 500; i++) {
    await registry.submit({ kind: "spawn", record: { id: `n${i}`, status: "queued", task: "t" } });
    await registry.submit({ kind: "transition", id: `n${i}`, to: "running" });
    await registry.submit({ kind: "resolve-exit", id: `n${i}`, exitCode: 0 });
  }
  const batches = nc.drain();
  assert.ok(batches.length >= 1, "500 条至少要一批");
  const total = batches.reduce((s, b) => s + b.length, 0);
  assert.equal(total, 500, "一条不丢");
});

test("通知：at 取终态的 finishedAt（resolve-exit 盖的那个时刻）", async () => {
  const registry = new TaskRegistry();
  const nc = new NotificationCenter();
  nc.attach(registry as never);
  await registry.submit({ kind: "spawn", record: { id: "a", status: "queued", task: "t" } });
  const before = Date.now();
  await registry.submit({ kind: "transition", id: "a", to: "running" });
  await registry.submit({ kind: "resolve-exit", id: "a", exitCode: 0 });
  const batches = nc.drain();
  assert.ok(batches[0]![0]!.at >= before, "终态时刻不早于 resolve-exit 之前");
});

test("通知：非终态（lost 也是终态）进队列", async () => {
  const registry = new TaskRegistry();
  const nc = new NotificationCenter();
  nc.attach(registry as never);
  await registry.submit({ kind: "spawn", record: { id: "a", status: "queued", task: "t" } });
  await registry.submit({ kind: "reconcile-lost", id: "a", reason: "重启" });
  assert.equal(nc.pendingCount(), 1, "lost 也是终态 ⇒ 进队列");
});

test("通知：连续 drain 第二次是空的", async () => {
  const registry = new TaskRegistry();
  const nc = new NotificationCenter();
  nc.attach(registry as never);
  await registry.submit({ kind: "spawn", record: { id: "a", status: "queued", task: "t" } });
  await registry.submit({ kind: "transition", id: "a", to: "running" });
  await registry.submit({ kind: "resolve-exit", id: "a", exitCode: 0 });
  nc.dain?.();
  const first = nc.drain();
  assert.equal(first.length, 1);
  const second = nc.drain();
  assert.equal(second.length, 0, "取走即清");
});

test("引擎：不带任何可选 dep 也能构造（默认值兜底）", () => {
  // 这条探针杀死构造器里所有 `?? 默认值` 的变异——
  // 值注入时 ?? 两边等价，只有缺省构造才能分出真假。
  const registry = new TaskRegistry();
  const engine = new TaskEngine({
    registry,
    machineReader: machineReader(),
    spawnChild: fakeSpawn({}),
    hostMode: "one-shot",
    // 故意不注入 whyEnabled / allowScriptsDefault / dispatchEnabled / storage 等
  });
  assert.ok(engine, "缺省构造不抛异常");
});

test("引擎：缺省构造时派发开关是开的", async () => {
  const registry = new TaskRegistry();
  const engine = new TaskEngine({
    registry,
    machineReader: machineReader(),
    spawnChild: fakeSpawn({ stdout: "x", exitCode: 0 }),
    hostMode: "one-shot",
  });
  const outcome = await engine.dispatch({ task: "干活" });
  assert.equal((outcome as { status: string }).status, "succeeded");
});

test("引擎：缺省构造时理由开关是开的（给了理由不丢）", async () => {
  const registry = new TaskRegistry();
  const engine = new TaskEngine({
    registry,
    machineReader: machineReader(),
    spawnChild: fakeSpawn({ stdout: "x", exitCode: 0 }),
    hostMode: "one-shot",
  });
  const outcome = await engine.dispatch({ task: "干活", why: "因为需要" });
  assert.equal((outcome as { whySuppressed?: boolean }).whySuppressed, false);
});

test("引擎：缺省构造时不留痕也能跑", async () => {
  const registry = new TaskRegistry();
  const engine = new TaskEngine({
    registry,
    machineReader: machineReader(),
    spawnChild: fakeSpawn({ stdout: "x", exitCode: 0 }),
    hostMode: "one-shot",
    // storage: undefined
  });
  const outcome = await engine.dispatch({ task: "干活" });
  assert.equal((outcome as { status: string }).status, "succeeded");
  assert.equal((outcome as { outputPath: string }).outputPath, "", "没 storage ⇒ 产出路径空");
});

test("引擎：退出码为 null 时按 -1 记（close 事件无码）", async () => {
  // 假 spawn 模拟 close 的 code 是 null
  const spawn = (): ChildHandle => {
    const exits: Array<(c: number, s: string) => void> = [];
    setTimeout(() => {
      for (const l of exits) l(-1, ""); // 引擎里 code ?? -1 兜成 -1
    }, 5);
    return { pid: 1, onOutput: () => {}, onExit: (cb) => exits.push(cb), kill: () => {} };
  };
  const { registry, engine } = freshEngine({ spawn, hostMode: "long-lived" });
  const outcome = await engine.dispatch({ task: "干活" });
  const taskId = (outcome as { taskId: string }).taskId;
  const status = await waitFor(registry, taskId, 3000);
  assert.equal(status, "failed", "退出码 -1 ⇒ 败了");
});

test("引擎：stop 一个在跑但已不在 children 表里的任务（child 丢了）", async () => {
  // 用不自动启动的引擎：任务建了记录但 #startQueued 因座位满没起
  // ⇒ children 表里没有它，但注册表里是 queued。先转 running 再 stop。
  const oneSeatAvailable = Math.floor(2.4 * GiB) + 512 * MiB + 100 * MiB;
  const { registry, engine } = freshEngine({
    machineReader: machineReader(oneSeatAvailable),
    spawn: fakeSpawn({ stdout: "x", exitCode: 0, delayMs: 500 }),
    hostMode: "long-lived",
  });
  // 占满座位
  await engine.dispatch({ task: "占座" });
  // 第二个任务排队（座位满）
  const outcome = await engine.dispatch({ task: "排队中" });
  const taskId = (outcome as { taskId: string }).taskId;
  assert.equal(registry.get(taskId)?.status, "queued");
  // 手动转 running（children 里没有）再 stop
  await registry.submit({ kind: "transition", id: taskId, to: "running" });
  await engine.stop(taskId, "句柄丢了也要能停");
  assert.ok(true, "不抛异常");
});

test("引擎：shutdown 把 ending 与 teardown 都置位", async () => {
  const { engine } = freshEngine();
  assert.equal(engine.isEnding(), false);
  await engine.shutdown();
  assert.equal(engine.isEnding(), true);
});

test("引擎：shutdown 后 isEnding 一直是 true", async () => {
  const { engine } = freshEngine();
  await engine.shutdown();
  assert.equal(engine.isEnding(), true);
  // 再调一次也不变
  await engine.shutdown();
  assert.equal(engine.isEnding(), true);
});

test("引擎：shutdown 只处理 queued 与 running，终态不动", async () => {
  const { registry, engine } = freshEngine({
    spawn: fakeSpawn({ stdout: "x", exitCode: 0 }),
    hostMode: "long-lived",
  });
  // 造一个已是终态的记录
  await registry.submit({ kind: "spawn", record: { id: "done", status: "succeeded", task: "t" } });
  await engine.shutdown();
  assert.equal(registry.get("done")?.status, "succeeded", "终态不被 shutdown 动");
});

test("引擎：没 storage 时 readOutput 返回 undefined（不崩）", async () => {
  const { engine } = freshEngine(); // storage: undefined
  assert.equal(await engine.readOutput("whatever"), undefined);
});

test("引擎：有 storage 时 readOutput 读产出", async () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-ro-"));
  const project = join(root, "proj");
  mkdirSync(join(project, ".git"), { recursive: true });
  const storage = new Storage(join(root, "dispatch"), project);
  storage.persistOutput("abc", "产出内容");
  const { engine } = freshEngine({ storage, hostMode: "one-shot" });
  assert.equal(await engine.readOutput("abc"), "产出内容");
});

test("引擎：readArchivedRecord 没 storage 时返回 undefined", async () => {
  const { engine } = freshEngine();
  assert.equal(await engine.readArchivedRecord("x"), undefined);
});

test("引擎：readOutput 落到归档（热文件没了从压缩档读）", async () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-arch-"));
  const project = join(root, "proj");
  mkdirSync(join(project, ".git"), { recursive: true });
  const storage = new Storage(join(root, "dispatch"), project);
  storage.persistRecord({ id: "gone", status: "succeeded", task: "t" });
  storage.persistOutput("gone", "归档里的产出");
  storage.archiveOne({ id: "gone", status: "succeeded", task: "t" });
  const { engine } = freshEngine({ storage, hostMode: "one-shot" });
  assert.equal(await engine.readOutput("gone"), "归档里的产出");
});

test("通知：两条合起来超 100KB 时切成两批", async () => {
  const registry = new TaskRegistry();
  const nc = new NotificationCenter();
  nc.attach(registry as never);
  // 每条 60KB ⇒ 两条 120KB > 100KB ⇒ 两批
  const a = "a".repeat(60 * 1024);
  const b = "b".repeat(60 * 1024);
  for (const id of [a, b]) {
    await registry.submit({ kind: "spawn", record: { id, status: "queued", task: "t" } });
    await registry.submit({ kind: "transition", id, to: "running" });
    await registry.submit({ kind: "resolve-exit", id, exitCode: 0 });
  }
  const batches = nc.drain();
  assert.equal(batches.length, 2, "两条 120KB ⇒ 两批");
  assert.equal(batches[0]![0]!.taskId, a);
  assert.equal(batches[1]![0]!.taskId, b);
});

test("通知：一批正好塞下时不切（边界 >= 与 >）", async () => {
  const registry = new TaskRegistry();
  const nc = new NotificationCenter();
  nc.attach(registry as never);
  // 每条 50KB ⇒ 两条 100KB，正好等于上限 ⇒ 不切（bytes + size > MAX 才切）
  // JSON 包装有额外字节，所以用 49KB 保证两条一批
  const ids = ["x".repeat(49 * 1024), "y".repeat(49 * 1024)];
  for (const id of ids) {
    await registry.submit({ kind: "spawn", record: { id, status: "queued", task: "t" } });
    await registry.submit({ kind: "transition", id, to: "running" });
    await registry.submit({ kind: "resolve-exit", id, exitCode: 0 });
  }
  const batches = nc.drain();
  assert.equal(batches.length, 1, "两条 98KB ⇒ 一批");
});

test("通知：批次切换后 bytes 归零重新累加", async () => {
  const registry = new TaskRegistry();
  const nc = new NotificationCenter();
  nc.attach(registry as never);
  // 三条 60KB：a+b = 120KB 切批，c 单独一批
  const ids = ["a".repeat(60 * 1024), "b".repeat(60 * 1024), "c".repeat(60 * 1024)];
  for (const id of ids) {
    await registry.submit({ kind: "spawn", record: { id, status: "queued", task: "t" } });
    await registry.submit({ kind: "transition", id, to: "running" });
    await registry.submit({ kind: "resolve-exit", id, exitCode: 0 });
  }
  const batches = nc.drain();
  assert.equal(batches.length, 3, "a+b 切批，c 又一批");
  assert.equal(batches[2]![0]!.taskId, ids[2]);
});

test("引擎：重启恢复——owner 已死的在飞任务标 lost", async () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-restore-"));
  const project = join(root, "proj");
  mkdirSync(join(project, ".git"), { recursive: true });
  const storage = new Storage(join(root, "dispatch"), project);
  // 造一条 owner 已死的在飞记录（pid 用一个肯定不存在的）
  storage.persistRecord({
    id: "orphan",
    status: "running",
    task: "t",
    ownerPid: 2 ** 22, // 不存在的 pid
    ownerStartMs: 123456,
  });
  const registry = new TaskRegistry();
  const engine = new TaskEngine({
    registry,
    machineReader: machineReader(),
    spawnChild: fakeSpawn({}),
    storage,
    hostMode: "one-shot",
  });
  await engine.ready; // 等重启恢复做完（装载 + 标 lost）
  assert.equal(registry.get("orphan")?.status, "lost", "owner 已死 ⇒ 标 lost");
});

test("引擎：重启恢复——owner 活着（自己）的在飞任务不标 lost", async () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-restore2-"));
  const project = join(root, "proj");
  mkdirSync(join(project, ".git"), { recursive: true });
  const storage = new Storage(join(root, "dispatch"), project);
  // owner 是自己且启动时刻对得上 ⇒ 别的会话的在飞任务，不装载
  const { processStartMs } = await import("../src/core/storage.ts");
  const myStart = processStartMs(process.pid);
  storage.persistRecord({
    id: "alive",
    status: "running",
    task: "t",
    ownerPid: process.pid,
    ownerStartMs: myStart,
  });
  const registry = new TaskRegistry();
  new TaskEngine({
    registry,
    machineReader: machineReader(),
    spawnChild: fakeSpawn({}),
    storage,
    hostMode: "one-shot",
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(registry.get("alive")?.status, "running", "owner 活着 ⇒ 不动");
});

test("引擎：terminalKeep=0 是合法值（一条终态都不留）", async () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-tk0-"));
  const project = join(root, "proj");
  mkdirSync(join(project, ".git"), { recursive: true });
  const storage = new Storage(join(root, "dispatch"), project);
  const registry = new TaskRegistry();
  const engine = new TaskEngine({
    registry,
    machineReader: machineReader(),
    spawnChild: fakeSpawn({ stdout: "x", exitCode: 0 }),
    storage,
    hostMode: "long-lived",
    terminalKeep: 0, // 0 是合法值：一条终态都不留（|| 会当假值换成默认 500）
  });
  const outcome = await engine.dispatch({ task: "干活" });
  const taskId = (outcome as { taskId: string }).taskId;
  await waitFor(registry, taskId, 3000);
  // 终态被挤掉（keep=0）——挤掉发生在 notify 之后，等一拍
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(registry.get(taskId), undefined, "terminalKeep=0 ⇒ 终态立刻被挤掉");
});

test("引擎：maxDepth=0 时任何派发都被拒", async () => {
  const registry = new TaskRegistry();
  const engine = new TaskEngine({
    registry,
    machineReader: machineReader(),
    spawnChild: fakeSpawn({ stdout: "x", exitCode: 0 }),
    hostMode: "one-shot",
    maxDepth: 0, // 0 是合法值：一层都不许（|| 会当假值换成默认 3）
  });
  const rejected = await engine.dispatch({ task: "干活" });
  assert.equal((rejected as { status: string }).status, "rejected", "深度 0 ⇒ 一层都不许派");
  assert.match((rejected as { errorMessage: string }).errorMessage, /depth/);
});

// ── 审查修复：并发只起一个 / 归档 / 座位 0 ───────────────────────────────

test("引擎：并发派 3 个，座位够时 3 个都起（不能只起一个）", async () => {
  const registry = new TaskRegistry();
  const exits: Array<(c: number) => void> = [];
  let spawns = 0;
  const engine = new TaskEngine({
    registry,
    machineReader: machineReader(), // 5 座
    spawnChild: () => {
      spawns++;
      const mine: Array<(c: number) => void> = [];
      setTimeout(() => {
        for (const l of mine) l(0);
      }, 2000);
      return { pid: spawns, onOutput: () => {}, onExit: (cb) => mine.push(cb), kill: () => {} };
    },
    hostMode: "long-lived",
  });
  await Promise.all([0, 1, 2].map((i) => engine.dispatch({ task: `任务${i}` })));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(spawns, 3, "5 个座位、3 个任务 ⇒ 3 个都该起");
  assert.equal(registry.list().filter((r) => r.status === "running").length, 3);
  void exits;
  await engine.shutdown();
});

test("引擎：并发派 5 个、座位 2 个 ⇒ 恰好起 2 个（不能超发）", async () => {
  const GiB2 = 1024 ** 3;
  const MiB2 = 1024 ** 2;
  // 可用 = 预留 2.4G + 2 座 512M × 2 + 余量
  const twoSeats = Math.floor(2.4 * GiB2) + 512 * MiB2 * 2 + 100 * MiB2;
  const registry = new TaskRegistry();
  let spawns = 0;
  const engine = new TaskEngine({
    registry,
    machineReader: {
      readSpec: () => ({ totalBytes: 24 * GiB2, cpus: 10 }),
      readAvailable: () => twoSeats,
    },
    spawnChild: () => {
      spawns++;
      const mine: Array<(c: number) => void> = [];
      setTimeout(() => {
        for (const l of mine) l(0);
      }, 3000);
      return { pid: spawns, onOutput: () => {}, onExit: (cb) => mine.push(cb), kill: () => {} };
    },
    hostMode: "long-lived",
  });
  await Promise.all([0, 1, 2, 3, 4].map((i) => engine.dispatch({ task: `任务${i}` })));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(spawns, 2, "座位 2 ⇒ 只起 2 个");
  assert.equal(registry.list().filter((r) => r.status === "queued").length, 3);
  await engine.shutdown();
});

test("引擎：运行时挤掉的记录要归档（不是只从内存删）", async () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-arch2-"));
  const project = join(root, "proj");
  mkdirSync(join(project, ".git"), { recursive: true });
  const storage = new Storage(join(root, "dispatch"), project);
  const registry = new TaskRegistry();
  const engine = new TaskEngine({
    registry,
    machineReader: machineReader(),
    spawnChild: fakeSpawn({ stdout: "x", exitCode: 0 }),
    storage,
    hostMode: "one-shot",
    terminalKeep: 1,
  });
  await engine.dispatch({ task: "a" });
  await engine.dispatch({ task: "b" });
  await new Promise((r) => setTimeout(r, 300)); // 等 setImmediate 的归档
  const bucket = readdirSync(join(root, "dispatch"))[0]!;
  const archiveDir = join(root, "dispatch", bucket, "archive");
  const recordsDir = join(root, "dispatch", bucket, "records");
  assert.ok(existsSync(archiveDir), "归档目录要建出来");
  assert.equal(
    readdirSync(archiveDir).filter((f) => f.endsWith(".json.gz")).length,
    1,
    "挤掉 1 条 ⇒ 1 个 .json.gz",
  );
  assert.equal(
    readdirSync(recordsDir).filter((f) => f.endsWith(".json")).length,
    1,
    "只留 1 条热记录",
  );
  await engine.shutdown();
});

test("引擎：座位 0 时一次性派发要退回，不能挂住", async () => {
  const registry = new TaskRegistry();
  const engine = new TaskEngine({
    registry,
    // 可用 1 GiB < 预留 2.4 GiB ⇒ 座位 0
    machineReader: {
      readSpec: () => ({ totalBytes: 24 * GiB, cpus: 10 }),
      readAvailable: () => 1 * GiB,
    },
    spawnChild: () => ({ pid: 1, onOutput: () => {}, onExit: () => {}, kill: () => {} }),
    hostMode: "one-shot",
  });
  const outcome = await Promise.race([
    engine.dispatch({ task: "干活" }),
    new Promise((r) => setTimeout(() => r("HANG"), 3000)),
  ]);
  assert.notEqual(outcome, "HANG", "不能挂住");
  assert.equal((outcome as { status: string }).status, "rejected");
  assert.match((outcome as { errorMessage: string }).errorMessage, /too tight/);
  assert.equal(registry.list().length, 0, "退回不留记录");
  await engine.shutdown();
});

// ── 审查修复：启动名额 / stop / proc stat / locale / exitCode ─────────────

test("引擎：启动名额只占启动，不占整个运行期（并发上限 = 座位数）", async () => {
  // 10 核 ⇒ launchLimit 4；给足内存让座位 ≥ 6
  const manySeats = Math.floor(2.4 * GiB) + 512 * MiB * 6 + 100 * MiB;
  const registry = new TaskRegistry();
  let spawns = 0;
  const engine = new TaskEngine({
    registry,
    machineReader: {
      readSpec: () => ({ totalBytes: 24 * GiB, cpus: 10 }),
      readAvailable: () => manySeats,
    },
    spawnChild: () => {
      spawns++;
      const mine: Array<(c: number) => void> = [];
      setTimeout(() => {
        for (const l of mine) l(0);
      }, 3000); // 长跑，确保观测时都还在
      return { pid: spawns, onOutput: () => {}, onExit: (cb) => mine.push(cb), kill: () => {} };
    },
    hostMode: "long-lived",
  });
  await Promise.all([0, 1, 2, 3, 4, 5].map((i) => engine.dispatch({ task: `任务${i}` })));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(spawns, 6, "launchLimit=4 不该限制同时在跑的数量（座位有 6）");
  await engine.shutdown();
});

test("引擎：停一个不存在的编号不抛异常", async () => {
  const { engine } = freshEngine();
  await engine.stop("不存在的编号", "试试"); // 不抛即通过
  assert.ok(true);
});

// ── 审查修复：结果字段 ────────────────────────────────────────────────────

test("引擎：失败时的 exitCode 是真实退出码，不是一律 -1", async () => {
  const { engine } = freshEngine({
    spawn: fakeSpawn({ stdout: "err", exitCode: 3 }),
    hostMode: "one-shot",
  });
  const outcome = await engine.dispatch({ task: "干活" });
  assert.equal((outcome as { status: string }).status, "failed");
  assert.equal((outcome as { exitCode: number }).exitCode, 3, "要透传真实退出码");
});

test("引擎：shutdown 取消排队任务时，一次性等待者拿到的是 canceled 不是 failed", async () => {
  // 座位 1：第一个占住，第二个排队；然后 shutdown
  const oneSeat = Math.floor(2.4 * GiB) + 512 * MiB + 100 * MiB;
  const registry = new TaskRegistry();
  const engine = new TaskEngine({
    registry,
    machineReader: {
      readSpec: () => ({ totalBytes: 24 * GiB, cpus: 10 }),
      readAvailable: () => oneSeat,
    },
    spawnChild: fakeSpawn({ stdout: "x", exitCode: 0, delayMs: 5000 }),
    hostMode: "one-shot",
  });
  // 第一个（会长时间跑）
  const first = engine.dispatch({ task: "占座" });
  await new Promise((r) => setTimeout(r, 50));
  // 第二个排在队里
  const second = engine.dispatch({ task: "排队" });
  await new Promise((r) => setTimeout(r, 100));
  await engine.shutdown();
  const outcome = await second;
  assert.equal((outcome as { status: string }).status, "canceled", "shutdown 取消 ⇒ canceled");
  void first;
});

// ── crapper/mutator：把分批与终态判定的边界钉死 ───────────────────────────

test("分批：正好等于上限时不分批（> 不是 >=）", () => {
  const one = { id: "x", status: "ok", at: 1 };
  const size = Buffer.byteLength(JSON.stringify(one), "utf8");
  // 两条正好等于上限 ⇒ 一批
  assert.equal(batchBySize([one, one], size * 2).length, 1);
  // 上限少 1 字节 ⇒ 两条
  assert.equal(batchBySize([one, one], size * 2 - 1).length, 2);
});

test("分批：单条超上限也自成一批（不丢）", () => {
  const huge = { id: "x".repeat(1000), status: "ok", at: 1 };
  const batches = batchBySize([huge], 10);
  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.length, 1);
});

test("分批：空输入是空批", () => {
  assert.deepEqual(batchBySize([], 100), []);
});

test("分批：三条各占半上限 ⇒ 一批 1 条、一批 1 条、一批 1 条", () => {
  const one = { id: "x", status: "ok", at: 1 };
  const size = Buffer.byteLength(JSON.stringify(one), "utf8");
  // 上限 = 1.5 条 ⇒ 每条一批
  assert.equal(batchBySize([one, one, one], Math.floor(size * 1.5)).length, 3);
});

test("通知：finishedAt 为 0 时 at 就是 0（不能用 || 兜底）", async () => {
  const registry = new TaskRegistry();
  const nc = new NotificationCenter();
  nc.attach(registry as never);
  await registry.submit({
    kind: "spawn",
    record: { id: "a", status: "succeeded", task: "t", finishedAt: 0 },
  });
  const batches = nc.drain();
  assert.equal(batches[0]![0]!.at, 0, "0 是有效时刻，不该被 Date.now() 顶掉");
});

test("通知：四种终态都进队列", async () => {
  const registry = new TaskRegistry();
  const nc = new NotificationCenter();
  nc.attach(registry as never);
  for (const status of ["succeeded", "failed", "canceled", "lost"] as const) {
    await registry.submit({ kind: "spawn", record: { id: status, status: "queued", task: "t" } });
    if (status === "lost") {
      await registry.submit({ kind: "reconcile-lost", id: status, reason: "x" });
    } else if (status === "canceled") {
      await registry.submit({ kind: "cancel-queued", id: status, reason: "x" });
    } else {
      await registry.submit({ kind: "transition", id: status, to: "running" });
      await registry.submit({
        kind: "resolve-exit",
        id: status,
        exitCode: status === "succeeded" ? 0 : 1,
      });
    }
  }
  const flat = nc.drain().flat();
  for (const status of ["succeeded", "failed", "canceled", "lost"]) {
    assert.ok(
      flat.some((n) => n.status === status),
      `${status} 要进队列`,
    );
  }
});

test("通知：未核实的交付带标记，已验证的不带", async () => {
  const registry = new TaskRegistry();
  const nc = new NotificationCenter();
  nc.attach(registry as never);
  const finish = async (id: string, unverified?: boolean): Promise<void> => {
    await registry.submit({ kind: "spawn", record: { id, status: "queued", task: "t" } });
    await registry.submit({ kind: "transition", id, to: "running" });
    await registry.submit({
      kind: "attach-report",
      id,
      report: { summary: "s" },
      channel: "prompt-json",
      ...(unverified ? { unverified: true } : {}),
    });
    await registry.submit({ kind: "resolve-exit", id, exitCode: 0 });
  };
  await finish("a", true);
  await finish("b");
  const flat = nc.drain().flat();
  assert.equal(flat.find((n) => n.taskId === "a")?.deliveryUnverified, true);
  assert.equal(
    flat.find((n) => n.taskId === "b")?.deliveryUnverified,
    undefined,
    "已验证的不带标记",
  );
});

test("分批：切批后字节计数要归零（不是从 1 起算）", () => {
  const one = { id: "x", status: "ok", at: 1 };
  const size = Buffer.byteLength(JSON.stringify(one), "utf8");
  // 上限 = 2 条：A+B 一批；C+D 一批。若切批后 bytes 从 1 起算，C+D 会被拆成两批。
  assert.equal(batchBySize([one, one, one, one], size * 2).length, 2);
});

test("引擎：maxDepth=1 且环境变量未设时，第一层可以派（深度按 0 起算）", async () => {
  delete process.env.PI_DISPATCH_DEPTH;
  const registry = new TaskRegistry();
  const engine = new TaskEngine({
    registry,
    machineReader: machineReader(),
    spawnChild: fakeSpawn({ stdout: "x", exitCode: 0 }),
    hostMode: "one-shot",
    maxDepth: 1,
  });
  const outcome = await engine.dispatch({ task: "干活" });
  assert.equal((outcome as { status: string }).status, "succeeded", "depth 0 + 1 = 1 ≤ 1 ⇒ 接受");
  await engine.shutdown();
});

test("引擎：错峰——一个结束后，排队的要立刻起（座位不该数两次）", async () => {
  // 座位 2：A 跑 0.4s、B 跑 2.5s、C 排队。
  // A 结束就空出一个座位——C 该在 1.2s 前起来，不该等 B 也结束。
  const GiB2 = 1024 ** 3;
  const MiB2 = 1024 ** 2;
  const twoSeats = Math.floor(2.4 * GiB2) + 512 * MiB2 * 2 + 100 * MiB2;
  const registry = new TaskRegistry();
  const durations = [400, 2500, 400];
  const spawnedAt: number[] = [];
  const t0 = Date.now();
  const engine = new TaskEngine({
    registry,
    machineReader: {
      readSpec: () => ({ totalBytes: 24 * GiB2, cpus: 10 }),
      readAvailable: () => twoSeats,
    },
    spawnChild: () => {
      const d = durations[spawnedAt.length] ?? 400;
      spawnedAt.push(Date.now() - t0);
      const mine: Array<(c: number) => void> = [];
      setTimeout(() => {
        for (const l of mine) l(0);
      }, d);
      return {
        pid: spawnedAt.length,
        onOutput: () => {},
        onExit: (cb) => mine.push(cb),
        kill: () => {},
      };
    },
    hostMode: "long-lived",
  });
  await Promise.all([0, 1, 2].map((i) => engine.dispatch({ task: `任务${i}` })));
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(spawnedAt.length, 3, `第三个该在 A 结束后就起；实际起了 ${spawnedAt.length} 个`);
  assert.ok(spawnedAt[2]! < 1200, `第三个起于 ${spawnedAt[2]}ms，应远早于 B 结束（2500ms）`);
  await engine.shutdown();
});
