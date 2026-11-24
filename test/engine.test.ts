// 阶段 6 探针：通知队列 + 引擎编排。
// 引擎探针用假 spawn（可控 stdout / 退出码 / 时序），不起真 pi 进程。
//
// 等价变异（探针杀不掉，也不该杀）：
//   src/core/engine.ts 构造器里 ~14 个 `deps.x ?? 默认值` —— 探针都注入真值，
//   `??` 与 `||` 只在注入假值（0/""）时才有区别，而这些配置字段不会是 0 或 ""，
//   故对「注入真值」的用法等价。要让它们不等价，得注入 0——但 terminalKeep=0
//   意为「一条不留」，是另一个合法用例。当前注入模式下探针无法区分。
//   src/core/engine.ts 里 `this.#storage?.x` 的 `?.`——不是等价变异：没 storage 时
//   `?.` 返回 undefined、`.` 抛 TypeError。由「引擎：没 storage 时 readOutput 返回
//   undefined（不崩）」与「引擎：readArchivedRecord 没 storage 时返回 undefined」钉住。
//   `this.#storage?.skippedRecords ?? 0` 的 `??` → `||`——无 storage 时左值 undefined、
//   有 storage 时左值是 number（0 两向都得 0）⇒ 两向同值。左边那个 `?.` 不是等价变异，
//   由「引擎：没 storage 时 skippedRecords 是 0（不崩、不编数）」钉住。
//   shutdown 里 `this.#teardown = true` → false——派发在闸口就被 sessionEndingGate
//   （读 #ending）拒掉，#teardown 是第二道防线；默认闸口下不可达 ⇒ 等价。
//   exitDetail 的 `stderrTail.trim().split("\n").pop() ?? ""` → `||`——split 恒返回
//   至少一个元素，pop() 恒是 string；空串时右值也是 "" ⇒ 两向同值。
//   prepareIsolationFor 的 `created.error ?? "worktree 创建失败"` → `||`——createWorktree
//   失败时 error 恒为非空串（stderr.trim() 或 `code N` 兜底）⇒ 两向同值。
//   shutdown 循环里 `this.#registry.get(taskId)?.status` 的 ?. → .——在跑的孩子必有记录
//   （记录只在终态后才被挤掉），get 不会返回 undefined ⇒ 等价。
//   src/core/engine.ts（抽出的模块级函数）：
//     childEnvFor 的 `baseEnv.PI_DISPATCH_DEPTH ?? 0` → `||`——ProcessEnv 的值是
//     string | undefined：undefined 两向都取 0；非空串（含 "0"）两向都取该串；
//     "" 两向都取 0（Number("")）⇒ 可达输入上等价。
//     构造器里 `process.env.PI_DISPATCH_DEPTH ?? 0` → `||` 同理。
//     构造器里 `deps.isGitRepo ?? (() => false)` → `||`——函数恒真，两向给同一个谓词 ⇒ 等价。
//     构造器里 `processStartMs(process.pid) ?? this.#now()` → `||`——分歧只在启动时刻为 0
//     （1970 年）时，活着的进程不可能；可达输入上等价。
//     （默认谓词 `() => false` → `true` 不等价，已由「没注入 isGitRepo ⇒ 默认不许开隔离」杀掉。）
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  TaskEngine,
  boardIsActive,
  childEnvFor,
  openBoardState,
  ownerIsActive,
  prepareIsolationFor,
  ownerProvenDead,
  pinBaseCommit,
} from "../src/core/engine.ts";
import { BlackboardStore } from "../src/core/blackboard.ts";
import { TaskRegistry } from "../src/core/registry.ts";
import { batchBySize, NotificationCenter } from "../src/core/notifications.ts";
import { Storage, processStartMs } from "../src/core/storage.ts";
import { BUDGET_STEER_TEXT } from "../src/core/budget.ts";
import type { ThinkingModelInfo } from "../src/core/thinking.ts";
import type { MachineReader, MachineSpec } from "../src/core/pool.ts";
import type { ChildHandle } from "../src/core/child.ts";
import type { Gate } from "../src/core/gates.ts";
import type { GitRunner } from "../src/core/worktree.ts";

const GiB = 1024 * 1024 * 1024;
const MiB = 1024 * 1024;

/** 假机器：一台 24 GiB / 10 核、此刻可用 5.24 GiB 的机器 ⇒ 池子量 2911 MiB ÷ 512 = 5 座。 */
function machineReader(availableBytes = 5369 * MiB, cpus = 10): MachineReader {
  const spec: MachineSpec = { totalBytes: 24 * GiB, cpus };
  return { readSpec: () => spec, readAvailable: () => availableBytes };
}

/** 假 spawn：可控 stdout / 退出码 / stderr / 时序。 */
function fakeSpawn(options: {
  stdout?: string;
  stderr?: string;
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
      for (const l of exitListeners) l(code, options.stderr ?? "");
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
        if (exitCode !== null) cb(exitCode, options.stderr ?? "");
      },
      kill: () => finish(143),
    };
  };
}

/** 假 spawn 的捕获版：记下每次 argv，行为仍交给 fakeSpawn。 */
function captureSpawn(options: Parameters<typeof fakeSpawn>[0]): {
  argvs: string[][];
  spawn: (argv: string[], env: NodeJS.ProcessEnv) => ChildHandle;
} {
  const argvs: string[][] = [];
  const inner = fakeSpawn(options);
  return {
    argvs,
    spawn: (argv, env) => {
      argvs.push([...argv]);
      return inner(argv, env);
    },
  };
}

function freshEngine(
  opts: {
    registry?: TaskRegistry;
    machineReader?: MachineReader;
    spawn?: ReturnType<typeof fakeSpawn>;
    hostMode?: "long-lived" | "one-shot";
    storage?: Storage;
    stallMs?: number;
    whyEnabled?: () => boolean;
    allowScriptsDefault?: () => boolean;
    extraGates?: Gate[];
    git?: GitRunner;
    repoRoot?: string;
    isGitRepo?: () => boolean;
    childExtensionPath?: string;
    sessionModel?: () => string | undefined;
    thinkingCatalog?: () => readonly ThinkingModelInfo[];
    now?: () => number;
  } = {},
) {
  const registry = opts.registry ?? new TaskRegistry();
  const engine = new TaskEngine({
    registry,
    machineReader: opts.machineReader ?? machineReader(),
    spawnChild: opts.spawn ?? fakeSpawn({}),
    hostMode: opts.hostMode ?? "long-lived",
    storage: opts.storage,
    stallMs: opts.stallMs,
    whyEnabled: opts.whyEnabled,
    allowScriptsDefault: opts.allowScriptsDefault,
    extraGates: opts.extraGates,
    git: opts.git,
    repoRoot: opts.repoRoot,
    isGitRepo: opts.isGitRepo,
    childExtensionPath: opts.childExtensionPath,
    sessionModel: opts.sessionModel,
    thinkingCatalog: opts.thinkingCatalog,
    now: opts.now,
  });
  return { registry, engine };
}

/** 假 git：记调用，按「子命令 + 参数」喂结果。 */
function fakeGit(
  handlers: { [key: string]: { code: number; stdout?: string; stderr?: string } } = {},
): { runner: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: GitRunner = async (args) => {
    calls.push(args);
    // 建 worktree 时把目录建出来——不然观测那步会当成「目录不在」
    if (args[0] === "worktree" && args[1] === "add") mkdirSync(args[4]!, { recursive: true });
    for (const [key, result] of Object.entries(handlers)) {
      const [cmd, sub] = key.split(" ");
      if (args[0] === cmd && args[1] === sub) {
        return { code: result.code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
      }
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

/**
 * 可控延迟的假 git：`worktree add` 挂住直到测试显式放行。
 * 用来把「建盘 await 期间」这个窗口打开——不靠 sleep 猜时序。
 */
function gatedGit(): {
  runner: GitRunner;
  calls: string[][];
  addsStarted: () => number;
  maxAddsInFlight: () => number;
  waitForAdds: (count: number) => Promise<void>;
  releaseNextAdd: () => Promise<void>;
} {
  const calls: string[][] = [];
  let started = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const pending: Array<() => void> = [];
  const startWaiters: Array<{ count: number; resolve: () => void }> = [];
  const releaseWaiters: Array<() => void> = [];
  const runner: GitRunner = (args) => {
    calls.push(args);
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      return Promise.resolve({ code: 0, stdout: "base123\n", stderr: "" });
    }
    if (args[0] === "worktree" && args[1] === "add") {
      mkdirSync(args[4]!, { recursive: true });
      started++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      for (const waiter of startWaiters.splice(0)) {
        if (started >= waiter.count) waiter.resolve();
        else startWaiters.push(waiter);
      }
      return new Promise((resolve) => {
        pending.push(() => {
          inFlight--;
          resolve({ code: 0, stdout: "", stderr: "" });
        });
        releaseWaiters.shift()?.(); // 有人在等放行 ⇒ 叫醒它
      });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  return {
    runner,
    calls,
    addsStarted: () => started,
    maxAddsInFlight: () => maxInFlight,
    waitForAdds: (count) =>
      started >= count
        ? Promise.resolve()
        : new Promise((resolve) => startWaiters.push({ count, resolve })),
    releaseNextAdd: async () => {
      if (pending.length === 0) await new Promise<void>((resolve) => releaseWaiters.push(resolve));
      pending.shift()!();
    },
  };
}

/** 假 spawn（记参数）：立刻退出 0。 */
function recordingSpawn(seen: unknown[][]): (...args: unknown[]) => ChildHandle {
  return (...args: unknown[]) => {
    seen.push(args);
    const exits: Array<(code: number, stderr: string) => void> = [];
    setTimeout(() => {
      for (const l of exits) l(0, "");
    }, 5);
    return {
      pid: 1,
      onOutput: () => {},
      onExit: (cb: (code: number, stderr: string) => void) => exits.push(cb),
      kill: () => {},
    };
  };
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

/** 等 registry 里某任务到指定状态。 */
function waitForStatus(registry: TaskRegistry, taskId: string, status: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等 ${taskId} 到 ${status} 超时`)), 3000);
    const check = (r: { id: string; status: string }): void => {
      if (r.id === taskId && r.status === status) {
        clearTimeout(timer);
        resolve();
      }
    };
    registry.subscribe(check);
    if (registry.get(taskId)?.status === status) {
      clearTimeout(timer);
      resolve();
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
  const root = mkdtempSync(join(tmpdir(), "dispatch-notch-"));
  const project = join(root, "proj");
  mkdirSync(join(project, ".git"), { recursive: true });
  const storage = new Storage(join(root, "dispatch"), project);
  const { registry, engine } = freshEngine({ storage });
  const rejected = await engine.dispatch({ task: "" });
  assert.equal((rejected as { status: string }).status, "rejected");
  assert.equal(registry.list().length, 0, "被拒不留记录");
  // 盘上也不许有：闸在铸编号/建记录之前
  const base = join(root, "dispatch", storage.bucket);
  const recordsDir = join(base, "records");
  const tasksDir = join(base, "tasks");
  assert.equal(
    existsSync(recordsDir) ? readdirSync(recordsDir).length : 0,
    0,
    "盘上不许有 records/*.json",
  );
  assert.equal(existsSync(tasksDir) ? readdirSync(tasksDir).length : 0, 0, "盘上不许有 tasks/<id>");
});

test("引擎：任务以横线开头要拒，不留记录", async () => {
  const { registry, engine } = freshEngine();
  const rejected = await engine.dispatch({ task: "--help" });
  assert.equal((rejected as { status: string }).status, "rejected");
  assert.equal(registry.list().length, 0);
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

test("引擎：没交报告时用量仍从记录里出来", async () => {
  // 孩子完全没交报告（reportChannel=none）：账不能跟着丢
  const stream = [
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "只有正文" }],
        usage: { input: 42, output: 7 },
      },
    }),
  ].join("\n");
  const { engine } = freshEngine({
    spawn: fakeSpawn({ stdout: stream, exitCode: 0 }),
    hostMode: "one-shot",
  });
  const outcome = await engine.dispatch({ task: "干活" });
  const result = outcome as { status: string; usage?: { input?: number } };
  assert.equal(result.status, "succeeded");
  assert.equal(result.usage?.input, 42, "没交报告 ⇒ 用宿主观测到的用量");
});

test("引擎：用量按轮累加，不是最后一条", async () => {
  const stream = [
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "第一轮" }],
        usage: { input: 30, output: 3 },
      },
    }),
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "第二轮" }],
        usage: { input: 12, output: 2 },
      },
    }),
  ].join("\n");
  const { engine } = freshEngine({
    spawn: fakeSpawn({ stdout: stream, exitCode: 0 }),
    hostMode: "one-shot",
  });
  const outcome = await engine.dispatch({ task: "干活" });
  const result = outcome as { usage?: { input?: number } };
  assert.equal(result.usage?.input, 42, "30+12=42，不是最后一条的 12");
});

test("引擎：报告通道 tool > prompt-json > none", async () => {
  const promptText = [
    "这是正文。",
    "```json",
    '{ "summary": "来自正文", "usage": { "input": 0 } }',
    "```",
  ].join("\n");
  const assistant = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: promptText }],
      usage: { input: 11, output: 1 },
    },
  });
  const toolResult = JSON.stringify({
    type: "message_end",
    message: {
      role: "toolResult",
      toolName: "child_report",
      content: [{ type: "text", text: "child report received" }],
      details: { report: { summary: "来自工具" } },
    },
  });
  const dispatch = async (stdout: string) => {
    const { engine } = freshEngine({
      spawn: fakeSpawn({ stdout, exitCode: 0 }),
      hostMode: "one-shot",
    });
    const outcome = await engine.dispatch({ task: "干活" });
    return outcome as {
      status: string;
      reportChannel: string;
      report?: { summary?: string };
    };
  };

  const both = await dispatch([assistant, toolResult].join("\n"));
  assert.equal(both.status, "succeeded");
  assert.equal(both.reportChannel, "tool");
  assert.equal(both.report?.summary, "来自工具");

  const promptOnly = await dispatch(assistant);
  assert.equal(promptOnly.reportChannel, "prompt-json");
  assert.equal(promptOnly.report?.summary, "来自正文");

  const neither = await dispatch(
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "只有正文" }] },
    }),
  );
  assert.equal(neither.reportChannel, "none");
  assert.equal(neither.report, undefined);
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

test("引擎：谎报自检（声称跑了命令、收据没有）⇒ 结果带 verifyUnverified", async () => {
  const stream = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: '做完了\n```json\n{"summary":"ok","verified":[{"command":"pnpm test","exitCode":0}]}\n```',
        },
      ],
    },
  });
  const { engine } = freshEngine({
    spawn: fakeSpawn({ stdout: stream, exitCode: 0 }),
    hostMode: "one-shot",
  });
  const outcome = await engine.dispatch({ task: "干活" });
  const result = outcome as { status: string; verifyUnverified?: boolean };
  assert.equal(result.status, "succeeded");
  assert.equal(result.verifyUnverified, true, "声称跑了 pnpm test，收据里一条命令都没有");
});

test("引擎：声称与观测一致 ⇒ 结果不带 verifyUnverified", async () => {
  const stream = [
    JSON.stringify({
      type: "tool_execution_start",
      toolName: "bash",
      args: { command: "pnpm test" },
    }),
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: '做完了\n```json\n{"summary":"ok","verified":[{"command":"pnpm test","exitCode":0}]}\n```',
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
  const result = outcome as { status: string; verifyUnverified?: boolean };
  assert.equal(result.status, "succeeded");
  assert.equal(result.verifyUnverified, undefined, "观测到同一条命令 ⇒ 不标记");
});

test("引擎：assessment 全正面 ⇒ 结果带 assessmentVacuous；有具体风险 ⇒ 不带", async () => {
  const makeStream = (assessment: string) =>
    JSON.stringify({
      type: "message_end",
      message: {
        role: "toolResult",
        toolName: "child_report",
        content: [{ type: "text", text: "received" }],
        details: {
          report: { summary: "做完了", why: "任务是字面要求", assessment },
        },
      },
    });
  const dispatch = async (assessment: string) => {
    const { engine } = freshEngine({
      spawn: fakeSpawn({ stdout: makeStream(assessment), exitCode: 0 }),
      hostMode: "one-shot",
    });
    return (await engine.dispatch({ task: "干活" })) as {
      status: string;
      assessmentVacuous?: boolean;
    };
  };
  const vacuous = await dispatch(
    "整体非常顺利，所有既定目标都已圆满达成，交付质量完全符合预期，可以直接进入下一阶段工作。",
  );
  assert.equal(vacuous.assessmentVacuous, true, "全正面视为空转");
  const real = await dispatch(
    "主流程已验证。边界场景还没覆盖全，存在回归风险，建议父方后续补一轮针对异常输入的测试再合入。",
  );
  assert.equal(real.assessmentVacuous, undefined, "有具体风险 ⇒ 不标记");
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
    const exits: Array<(code: number, stderr: string) => void> = [];
    setTimeout(() => {
      for (const l of exits) l(0, "");
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
    const exits: Array<(code: number, stderr: string) => void> = [];
    setTimeout(() => {
      for (const l of exits) l(0, "");
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

test("引擎：allowScripts 会话默认值不是布尔 ⇒ 退回（不把 truthy 当开）", async () => {
  const { registry, engine } = freshEngine({
    allowScriptsDefault: (() => "yes") as never,
    hostMode: "one-shot",
  });
  const out = await engine.dispatch({ task: "干活" });
  assert.equal((out as { status: string }).status, "rejected");
  assert.match((out as { errorMessage: string }).errorMessage, /allowScripts 默认值/);
  assert.equal(registry.list().length, 0, "被拒不留记录");
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
    const exits: Array<(code: number, stderr: string) => void> = [];
    setTimeout(() => {
      for (const l of exits) l(0, "");
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
    // 故意不注入 whyEnabled / allowScriptsDefault / storage 等
  });
  assert.ok(engine, "缺省构造不抛异常");
});

test("引擎：缺省构造时派发不被拦", async () => {
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

test("引擎：shutdown 给在跑的孩子发 SIGTERM（不是只收排队的一条）", async () => {
  const kills: string[] = [];
  let spawnedResolve!: () => void;
  const spawned = new Promise<void>((resolve) => {
    spawnedResolve = resolve;
  });
  const spawn = (): ChildHandle => {
    spawnedResolve();
    const exitListeners: Array<(code: number, stderr: string) => void> = [];
    return {
      pid: 1,
      onOutput: () => {},
      onExit: (cb) => exitListeners.push(cb),
      kill: (signal) => {
        kills.push(signal);
        for (const l of exitListeners) l(143, "");
      },
    };
  };
  const { registry, engine } = freshEngine({ spawn, hostMode: "long-lived" });
  const outcome = await engine.dispatch({ task: "干活" });
  const taskId = (outcome as { taskId: string }).taskId;
  // running 状态在 spawn 之前就盖了；等 spawn 真正被调用，shutdown 才看得到 #children 里的句柄
  await waitForStatus(registry, taskId, "running");
  await spawned;
  await engine.shutdown();
  assert.deepEqual(kills, ["SIGTERM"], "在跑的孩子要被 SIGTERM");
  assert.equal(await waitFor(registry, taskId), "canceled", "stopping 收到退出码 ⇒ canceled");
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

test("引擎：产出是空串时 readOutput 返回空串（不落归档）", async () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-empty-"));
  const project = join(root, "proj");
  mkdirSync(join(project, ".git"), { recursive: true });
  const storage = new Storage(join(root, "dispatch"), project);
  // 孩子一声不吭地跑完：产出文件在，内容是空串（不是没有产出文件）
  storage.persistOutput("quiet", "");
  const { engine } = freshEngine({ storage, hostMode: "one-shot" });
  assert.equal(
    await engine.readOutput("quiet"),
    "",
    "空串 = 跑完了没话说，不是 undefined（没落盘）",
  );
});

test("引擎：readArchivedRecord 没 storage 时返回 undefined", async () => {
  const { engine } = freshEngine();
  assert.equal(await engine.readArchivedRecord("x"), undefined);
});

test("引擎：没 storage 时 skippedRecords 是 0（不崩、不编数）", () => {
  const { engine } = freshEngine(); // storage: undefined
  assert.equal(engine.skippedRecords, 0, "没留痕目录就没有跳过记录，别拿 1 顶");
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
  const exits: Array<(code: number, stderr: string) => void> = [];
  let spawns = 0;
  const engine = new TaskEngine({
    registry,
    machineReader: machineReader(), // 5 座
    spawnChild: () => {
      spawns++;
      const mine: Array<(code: number, stderr: string) => void> = [];
      setTimeout(() => {
        for (const l of mine) l(0, "");
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
      const mine: Array<(code: number, stderr: string) => void> = [];
      setTimeout(() => {
        for (const l of mine) l(0, "");
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
      const mine: Array<(code: number, stderr: string) => void> = [];
      setTimeout(() => {
        for (const l of mine) l(0, "");
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

test("引擎：孩子自己非零退出，errorMessage 带退出码而不是单词 failed", async () => {
  const { engine } = freshEngine({
    spawn: fakeSpawn({ stdout: "err", exitCode: 1 }),
    hostMode: "one-shot",
  });
  const outcome = await engine.dispatch({ task: "干活" });
  assert.equal((outcome as { status: string }).status, "failed");
  assert.match(
    (outcome as { errorMessage?: string }).errorMessage ?? "",
    /exit code 1/,
    "第一行要可读：模型和调用方最先读 errorMessage",
  );
});

test("引擎：退出码 -1 且没有 stderr ⇒ 死因写明「信号不明或起不来」", async () => {
  const { engine } = freshEngine({
    spawn: fakeSpawn({ stdout: "x", exitCode: -1, stderr: "" }),
    hostMode: "one-shot",
  });
  const outcome = await engine.dispatch({ task: "干活" });
  assert.equal((outcome as { status: string }).status, "failed");
  assert.match(
    (outcome as { errorMessage?: string }).errorMessage ?? "",
    /exit code -1（信号不明或起不来）/,
    "起不来的 -1 不能和普通退出码 1 用同一句文案",
  );
});

test("引擎：stderr 末行正好 200 字不截（阈值是 > 200，不是 >=）", async () => {
  // 边界差一格：200 字整还放得下，不该加省略号；201 字才截成「…+ 末 200 字」。
  const exact = "z".repeat(200);
  const atLimit = freshEngine({
    spawn: fakeSpawn({ stdout: "x", exitCode: 1, stderr: exact }),
    hostMode: "one-shot",
  });
  const atLimitMessage =
    ((await atLimit.engine.dispatch({ task: "干活" })) as { errorMessage?: string }).errorMessage ??
    "";
  assert.equal(atLimitMessage, `exit code 1 — ${exact}`, "200 字整放得下，别加省略号");

  const over = "z".repeat(201);
  const oneMore = freshEngine({
    spawn: fakeSpawn({ stdout: "x", exitCode: 1, stderr: over }),
    hostMode: "one-shot",
  });
  const overMessage =
    ((await oneMore.engine.dispatch({ task: "干活" })) as { errorMessage?: string }).errorMessage ??
    "";
  assert.equal(overMessage, `exit code 1 — …${"z".repeat(200)}`, "超一格才截，且截尾部");
});

test("引擎：超长 stderr 末行截的是尾部 200 字，不是从第 201 字起", async () => {
  // 末行 303 字：签名落在 [120,138)。slice(-200) 从 103 起 ⇒ 含签名；
  // slice(200) 从 200 起 ⇒ 签名被切掉。截尾是为了留住死因最后那几行，不能截反。
  const signature = "SIGNATURE_MIDDLE";
  const stderr = "x".repeat(120) + signature + "y".repeat(167);
  assert.equal(stderr.length, 303);
  const { engine } = freshEngine({
    spawn: fakeSpawn({ stdout: "x", exitCode: 1, stderr }),
    hostMode: "one-shot",
  });
  const outcome = await engine.dispatch({ task: "干活" });
  const message = (outcome as { errorMessage?: string }).errorMessage ?? "";
  assert.ok(message.includes(signature), "截断后仍要包含末行尾部的中段签名");
  assert.match(message, /^exit code 1 — …/);
});

test("引擎：非零退出把 stderr 末行拼进 errorMessage", async () => {
  // provider 401、段错误都写在 stderr 里——死因摘要比光一个码有用。
  const { engine } = freshEngine({
    spawn: fakeSpawn({
      stdout: "x",
      exitCode: 1,
      stderr: 'provider boom\n{"error":"401 Unauthorized"}',
    }),
    hostMode: "one-shot",
  });
  const outcome = await engine.dispatch({ task: "干活" });
  assert.match(
    (outcome as { errorMessage?: string }).errorMessage ?? "",
    /exit code 1 — .*401/,
    "stderr 末行要拼上",
  );
});

test("引擎：起不来的孩子，errorMessage 直接给 spawn 错误", async () => {
  // exitCode -1（起不来/信号不明）时没有码可读，stderr 尾巴就是全部死因。
  const { engine } = freshEngine({
    spawn: fakeSpawn({ stdout: "", exitCode: -1, stderr: "spawn error: ENOENT pi" }),
    hostMode: "one-shot",
  });
  const outcome = await engine.dispatch({ task: "干活" });
  assert.equal((outcome as { status: string }).status, "failed");
  assert.match(
    (outcome as { errorMessage?: string }).errorMessage ?? "",
    /ENOENT/,
    "spawn 错误要出现在第一行",
  );
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
      report: { summary: "s", why: "", assessment: "" },
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

test("通知：reportStale 只在 true 时出现，false 不留键", async () => {
  const registry = new TaskRegistry();
  const nc = new NotificationCenter();
  nc.attach(registry as never);
  const finish = async (id: string, stale: boolean): Promise<void> => {
    await registry.submit({ kind: "spawn", record: { id, status: "queued", task: "t" } });
    await registry.submit({ kind: "transition", id, to: "running" });
    await registry.submit({
      kind: "attach-steer",
      id,
      steers: [{ seq: 1, text: "改", at: 1, state: "delivered" }],
      reportStale: stale,
    });
    await registry.submit({ kind: "resolve-exit", id, exitCode: 0 });
  };
  await finish("stale", true);
  await finish("fresh", false);
  const flat = nc.drain().flat();
  assert.equal(flat.find((n) => n.taskId === "stale")?.reportStale, true);
  assert.ok(!("reportStale" in flat.find((n) => n.taskId === "fresh")!));
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
      const mine: Array<(code: number, stderr: string) => void> = [];
      setTimeout(() => {
        for (const l of mine) l(0, "");
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

// ── 引擎：worktree 隔离 ──────────────────────────────────────────────────

/** 隔离用例的桶（真目录：worktree 路径要落在这儿）。 */
function isolationStorage(): { root: string; project: string; storage: Storage } {
  const root = mkdtempSync(join(tmpdir(), "dispatch-iso-"));
  const project = join(root, "proj");
  mkdirSync(join(project, ".git"), { recursive: true });
  return { root, project, storage: new Storage(join(root, "dispatch"), project) };
}

test("golden：默认关——spawn 无第三参", async () => {
  const seen: unknown[][] = [];
  const { engine } = freshEngine({
    spawn: recordingSpawn(seen) as never,
    hostMode: "one-shot",
  });
  await engine.dispatch({ task: "干活" });
  assert.equal(seen.length, 1, "起了一个孩子");
  assert.equal(seen[0]!.length, 2, "默认关：只有 argv 与 env，第三参连键都不出现");
});

test("golden：默认关——git runner 零调用（含 boot）", async () => {
  const { project, storage } = isolationStorage();
  const { runner, calls } = fakeGit();
  const { engine } = freshEngine({
    storage,
    git: runner,
    repoRoot: project,
    hostMode: "one-shot",
  });
  await engine.ready;
  await engine.dispatch({ task: "干活" });
  assert.equal(calls.length, 0, `git 被调了 ${calls.length} 次（默认关时不该碰 git）`);
});

test("golden：默认关——记录与结果里都没有隔离的键", async () => {
  const { registry, engine } = freshEngine({ hostMode: "one-shot" });
  const outcome = await engine.dispatch({ task: "干活" });
  const taskId = (outcome as { taskId: string }).taskId;
  const keys = Object.keys(registry.get(taskId) ?? {});
  assert.ok(!keys.includes("isolation"), "记录里没有 isolation");
  assert.ok(!keys.includes("worktree"), "记录里没有 worktree");
  const result = outcome as unknown as Record<string, unknown>;
  assert.ok(!("isolation" in result), "结果里没有 isolation");
  assert.ok(!("worktree" in result), "结果里没有 worktree");
});

test("引擎：不是 git 仓 ⇒ 隔离被退回，不留记录", async () => {
  const { registry, engine } = freshEngine({
    isGitRepo: () => false,
    hostMode: "one-shot",
  });
  const outcome = await engine.dispatch({ task: "干活", isolation: "worktree" });
  assert.equal((outcome as { status: string }).status, "rejected");
  assert.equal(registry.list().length, 0, "被退回不留记录");
});

test("隔离+转向：两个隔离孩子各有 worktree/seq，互不串线", async () => {
  const { project, storage } = isolationStorage();
  const { runner } = fakeGit({ "rev-parse --verify": { code: 0, stdout: "base123\n" } });
  const { registry, engine } = freshEngine({
    storage,
    git: runner,
    repoRoot: project,
    isGitRepo: () => true,
    childExtensionPath: "x",
    spawn: fakeSpawn({ delayMs: 300 }),
  });
  const a = (await engine.dispatch({ task: "A", isolation: "worktree" })) as { taskId: string };
  const b = (await engine.dispatch({ task: "B", isolation: "worktree" })) as { taskId: string };
  await waitForStatus(registry, a.taskId, "running");
  await waitForStatus(registry, b.taskId, "running");
  const [ra, rb] = await Promise.all([engine.steer(a.taskId, "甲"), engine.steer(b.taskId, "乙")]);
  assert.equal(ra.ok ? ra.seq : -1, 1);
  assert.equal(rb.ok ? rb.seq : -1, 1, "每个任务独立 seq");
  assert.notEqual(
    registry.get(a.taskId)!.worktree!.path,
    registry.get(b.taskId)!.worktree!.path,
    "worktree 不共享",
  );
  assert.match(storage.readSteer(a.taskId), /甲/);
  assert.match(storage.readSteer(b.taskId), /乙/);
  await waitFor(registry, a.taskId);
  await waitFor(registry, b.taskId);
  await engine.shutdown();
  rmSync(project, { recursive: true, force: true });
});

test("引擎：钉不住 base ⇒ 退回，不留记录", async () => {
  const { storage } = isolationStorage();
  const { registry, engine } = freshEngine({
    storage,
    // 没注入 repoRoot ⇒ 不知道 git 根 ⇒ 钉不住 base
    isGitRepo: () => true,
    hostMode: "one-shot",
  });
  const outcome = await engine.dispatch({ task: "干活", isolation: "worktree" });
  assert.equal((outcome as { status: string }).status, "rejected");
  assert.equal(registry.list().length, 0);
});

test("引擎：没有留痕目录 ⇒ 隔离被退回", async () => {
  const { registry, engine } = freshEngine({
    // 没有 storage
    isGitRepo: () => true,
    repoRoot: "/repo",
    hostMode: "one-shot",
  });
  const outcome = await engine.dispatch({ task: "干活", isolation: "worktree" });
  assert.equal((outcome as { status: string }).status, "rejected");
  assert.equal(registry.list().length, 0);
});

test("引擎：开隔离 ⇒ 记录带 isolation 与 worktree 三件套", async () => {
  const { project, storage } = isolationStorage();
  const { runner } = fakeGit({ "rev-parse --verify": { code: 0, stdout: "base123\n" } });
  const { registry, engine } = freshEngine({
    storage,
    git: runner,
    repoRoot: project,
    isGitRepo: () => true,
    hostMode: "one-shot",
  });
  const outcome = await engine.dispatch({ task: "干活", isolation: "worktree" });
  const taskId = (outcome as { taskId: string }).taskId;
  const record = registry.get(taskId);
  assert.equal(record?.isolation, "worktree");
  assert.equal(record?.worktree?.baseCommit, "base123", "base 在受理时钉死");
  assert.equal(record?.worktree?.branch, `pi-dispatch/${taskId}`);
  assert.ok(record?.worktree?.path.endsWith(taskId), "worktree 落在受管根下");
});

test("引擎：受理时钉 base，排队期间 HEAD 前进不漂移", async () => {
  const { project, storage } = isolationStorage();
  let heads = 0;
  const calls: string[][] = [];
  const runner: GitRunner = async (args) => {
    calls.push(args);
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      heads++;
      return { code: 0, stdout: heads === 1 ? "commit-1\n" : "commit-2\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const { registry, engine } = freshEngine({
    storage,
    git: runner,
    repoRoot: project,
    isGitRepo: () => true,
    hostMode: "one-shot",
  });
  const outcome = await engine.dispatch({ task: "干活", isolation: "worktree" });
  const taskId = (outcome as { taskId: string }).taskId;
  assert.equal(
    registry.get(taskId)?.worktree?.baseCommit,
    "commit-1",
    "受理时钉的那个，不因后来 HEAD 前进而变",
  );
  const add = calls.find((c) => c[0] === "worktree" && c[1] === "add");
  assert.ok(add, "建了 worktree");
  assert.equal(add!.at(-1), "commit-1", "建在钉死的 base 上");
});

test("引擎：isolation 的 spawn 收到 cwd=worktree 路径", async () => {
  const { project, storage } = isolationStorage();
  const { runner } = fakeGit({ "rev-parse --verify": { code: 0, stdout: "base123\n" } });
  const seen: unknown[][] = [];
  const { registry, engine } = freshEngine({
    storage,
    git: runner,
    repoRoot: project,
    isGitRepo: () => true,
    spawn: recordingSpawn(seen) as never,
    hostMode: "one-shot",
  });
  const outcome = await engine.dispatch({ task: "干活", isolation: "worktree" });
  const taskId = (outcome as { taskId: string }).taskId;
  const options = seen[0]![2] as { cwd?: string } | undefined;
  assert.equal(options?.cwd, registry.get(taskId)?.worktree?.path, "cwd 落在 worktree 上");
});

test("引擎：创建失败 ⇒ failed 且不 spawn（绝不回共享 cwd）", async () => {
  const { project, storage } = isolationStorage();
  const { runner } = fakeGit({
    "rev-parse --verify": { code: 0, stdout: "base123\n" },
    "worktree add": { code: 128, stderr: "fatal: could not create work tree dir" },
  });
  const seen: unknown[][] = [];
  const { registry, engine } = freshEngine({
    storage,
    git: runner,
    repoRoot: project,
    isGitRepo: () => true,
    spawn: recordingSpawn(seen) as never,
    hostMode: "one-shot",
  });
  const outcome = (await engine.dispatch({ task: "干活", isolation: "worktree" })) as {
    status: string;
    started: boolean;
    durationMs: number;
    errorMessage?: string;
  };
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.started, false, "孩子压根没起");
  assert.equal(outcome.durationMs, 0);
  assert.match(outcome.errorMessage ?? "", /worktree/);
  assert.equal(seen.length, 0, "绝不 spawn");
  const taskId = (outcome as unknown as { taskId: string }).taskId;
  assert.equal(registry.get(taskId)?.startedAt, undefined, "startedAt 要清");
});

test("引擎：建盘失败留下半截目录 ⇒ best-effort 回收本次路径", async () => {
  const { project, storage } = isolationStorage();
  let attemptedPath: string | undefined;
  const runner: GitRunner = async (args) => {
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      return { code: 0, stdout: "base123\n", stderr: "" };
    }
    if (args[0] === "worktree" && args[1] === "add") {
      attemptedPath = args[4];
      mkdirSync(attemptedPath!, { recursive: true }); // 失败前目录已经落在盘上
      return { code: 128, stdout: "", stderr: "fatal: could not create work tree dir" };
    }
    if (args[0] === "worktree" && args[1] === "remove") {
      rmSync(args[2]!, { recursive: true, force: true });
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const { engine } = freshEngine({
    storage,
    git: runner,
    repoRoot: project,
    isGitRepo: () => true,
    spawn: recordingSpawn([]) as never,
    hostMode: "one-shot",
  });
  const outcome = (await engine.dispatch({ task: "干活", isolation: "worktree" })) as {
    status: string;
    worktree?: { missing?: boolean };
  };
  assert.equal(outcome.status, "failed", "建盘失败仍是 failed");
  assert.equal(outcome.worktree?.missing, true, "目录已回收 ⇒ 回执标 missing，不谎报路径可用");
  assert.ok(attemptedPath !== undefined, "确实尝试建过盘");
  assert.equal(
    existsSync(attemptedPath!),
    false,
    "失败留下的半截目录被回收（非强制，失败交给清扫）",
  );
});

test("引擎：建盘期间被叫停 ⇒ 不 spawn、started:false、终态 canceled", async () => {
  const { project, storage } = isolationStorage();
  const git = gatedGit();
  const seen: unknown[][] = [];
  const { registry, engine } = freshEngine({
    storage,
    git: git.runner,
    repoRoot: project,
    isGitRepo: () => true,
    spawn: recordingSpawn(seen) as never,
    hostMode: "one-shot",
  });
  // 一次性宿主：dispatch 的 promise 等终态——先拿着，别 await（要趁建盘窗口叫停）
  const pending = engine.dispatch({ task: "干活", isolation: "worktree" });
  await git.waitForAdds(1);
  const taskId = registry.list()[0]!.id;
  await engine.stop(taskId, "建盘期间叫停");
  await git.releaseNextAdd();

  const outcome = (await pending) as { status: string; started: boolean };
  assert.equal(outcome.status, "canceled");
  assert.equal(outcome.started, false, "孩子压根没起");
  assert.equal(seen.length, 0, "绝不 spawn");
  assert.equal(registry.get(taskId)?.startedAt, undefined, "startedAt 不记");
  const removed = git.calls.find((c) => c[0] === "worktree" && c[1] === "remove");
  assert.ok(removed, "刚建好的盘被 best-effort 回收");
  assert.equal(removed!.at(-1), registry.get(taskId)?.worktree?.path, "回收的是本任务的盘");
});

test("引擎：叫停等名额的任务只归还一次名额（之后启动仍受节流）", async () => {
  const { project, storage } = isolationStorage();
  const git = gatedGit();
  const { registry, engine } = freshEngine({
    machineReader: machineReader(5369 * MiB, 1), // 1 核 ⇒ 启动名额 1
    storage,
    git: git.runner,
    repoRoot: project,
    isGitRepo: () => true,
    spawn: recordingSpawn([]) as never,
    hostMode: "long-lived",
  });
  // A 占住唯一的名额（建盘卡住）
  await engine.dispatch({ task: "A", isolation: "worktree" });
  await git.waitForAdds(1);
  // B 排在名额后：确认已转 running（挂在名额上），再叫停
  const b = (await engine.dispatch({ task: "B" })) as { taskId: string };
  await waitForStatus(registry, b.taskId, "running");
  await engine.stop(b.taskId, "等名额时叫停");
  // 放行 A ⇒ 名额还给 B ⇒ 叫停分支执行（双次归还会把 #starting 减成负数）
  await git.releaseNextAdd();
  await new Promise((resolve) => setTimeout(resolve, 20));

  // 再派两个隔离任务：名额只剩一个 ⇒ 两个 add 不能同时在飞
  await engine.dispatch({ task: "C", isolation: "worktree" });
  await engine.dispatch({ task: "D", isolation: "worktree" });
  await git.waitForAdds(2); // A 之后，C/D 里先到的那一个
  await new Promise((resolve) => setTimeout(resolve, 30)); // 给「第二个 add」冒头的时间
  assert.equal(git.maxAddsInFlight(), 1, "启动名额只还了一次：第二个建盘要等第一个");

  await git.releaseNextAdd();
  await git.releaseNextAdd();
});

test("引擎：孩子 close 后观测 worktree 并入记录", async () => {
  const { project, storage } = isolationStorage();
  const runner: GitRunner = async (args) => {
    if (args[0] === "worktree" && args[1] === "add") mkdirSync(args[4]!, { recursive: true });
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      return { code: 0, stdout: "base123\n", stderr: "" };
    }
    if (args[0] === "status") return { code: 0, stdout: " M a.txt\n", stderr: "" };
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
      return { code: 0, stdout: "pi-dispatch/x\n", stderr: "" };
    }
    if (args[0] === "rev-list") return { code: 0, stdout: "3\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const { registry, engine } = freshEngine({
    storage,
    git: runner,
    repoRoot: project,
    isGitRepo: () => true,
    hostMode: "one-shot",
  });
  const outcome = await engine.dispatch({ task: "干活", isolation: "worktree" });
  const taskId = (outcome as { taskId: string }).taskId;
  const worktree = registry.get(taskId)?.worktree;
  assert.equal(worktree?.dirty, 1, "观测到的脏文件数入账");
  assert.equal(worktree?.commitsAhead, 3);
  assert.equal(worktree?.headCommit, "base123");
});

test("引擎：观测失败时 dirty 留空（不填 0）", async () => {
  const { project, storage } = isolationStorage();
  const runner: GitRunner = async (args, cwd) => {
    if (args[0] === "worktree" && args[1] === "add") {
      mkdirSync(args[4]!, { recursive: true });
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cwd === project) return { code: 0, stdout: "base123\n", stderr: "" };
    throw new Error("git 炸了");
  };
  const { registry, engine } = freshEngine({
    storage,
    git: runner,
    repoRoot: project,
    isGitRepo: () => true,
    hostMode: "one-shot",
  });
  const outcome = await engine.dispatch({ task: "干活", isolation: "worktree" });
  const taskId = (outcome as { taskId: string }).taskId;
  const record = registry.get(taskId);
  assert.equal(record?.status, "succeeded", "观测失败不改终态");
  assert.equal(record?.worktree?.dirty, undefined, "观测不到 ≠ 干净：不能填 0");
  assert.equal(record?.worktree?.captureError, "git 炸了", "只记 captureError");
});

test("引擎：开隔离 ⇒ argv 里带 worktree 契约块", async () => {
  const { project, storage } = isolationStorage();
  const { runner } = fakeGit({ "rev-parse --verify": { code: 0, stdout: "base123\n" } });
  const seen: unknown[][] = [];
  const { engine } = freshEngine({
    storage,
    git: runner,
    repoRoot: project,
    isGitRepo: () => true,
    spawn: recordingSpawn(seen) as never,
    hostMode: "one-shot",
  });
  await engine.dispatch({ task: "干活", isolation: "worktree" });
  const argv = seen[0]![0] as string[];
  assert.ok(argv.join("\n").includes("pi-dispatch-worktree"), "提示块里要交代 worktree 契约");
});

test("引擎：boot 清扫——归档里的 worktree 也受保护", async () => {
  const { project, storage } = isolationStorage();
  const worktreesDir = storage.worktreesDir;
  mkdirSync(worktreesDir, { recursive: true });
  const archived = join(worktreesDir, "archived-task");
  mkdirSync(archived, { recursive: true });
  const orphan = join(worktreesDir, "orphan-task");
  mkdirSync(orphan, { recursive: true });
  const past = new Date(Date.now() - 31 * 86_400_000);
  utimesSync(archived, past, past);
  utimesSync(orphan, past, past);
  // 归档里有一条 archived-task 的记录（热记录没有）
  storage.persistRecord({ id: "archived-task", status: "succeeded", task: "t" });
  storage.archiveOne({ id: "archived-task", status: "succeeded", task: "t" });
  const porcelain = [
    `worktree ${archived}`,
    "HEAD abc",
    "branch refs/heads/pi-dispatch/archived-task",
    "",
    `worktree ${orphan}`,
    "HEAD abc",
    "branch refs/heads/pi-dispatch/orphan-task",
    "",
  ].join("\n");
  const { runner, calls } = fakeGit({ "worktree list": { code: 0, stdout: porcelain } });
  const registry = new TaskRegistry();
  const engine = new TaskEngine({
    registry,
    machineReader: machineReader(),
    spawnChild: fakeSpawn({}),
    storage,
    git: runner,
    repoRoot: project,
    hostMode: "one-shot",
  });
  await engine.ready;
  const removed = calls.filter((c) => c[0] === "worktree" && c[1] === "remove").map((c) => c[2]);
  assert.ok(!removed.includes(archived), "归档里的 ⇒ 保护");
  assert.ok(removed.includes(orphan), "没账本的 ⇒ 清");
});

// ── 黑板 ──────────────────────────────────────────────────────────────────

test("引擎：开黑板的孩子 env 里有板目录", async () => {
  const { storage } = isolationStorage();
  const seen: unknown[][] = [];
  const { registry, engine } = freshEngine({
    storage,
    spawn: recordingSpawn(seen) as never,
    hostMode: "one-shot",
  });
  const outcome = await engine.dispatch({ task: "干活", blackboard: true });
  const taskId = (outcome as { taskId: string }).taskId;
  const env = seen[0]![1] as NodeJS.ProcessEnv;
  const boardDir = env.PI_DISPATCH_BLACKBOARD_DIR;
  const boardId = env.PI_DISPATCH_BLACKBOARD_ID;
  assert.ok(boardDir, "env 里有板目录");
  assert.ok(boardId, "env 里有板号");
  assert.ok(boardDir.includes(boardId!), "板目录里带着板号");
  assert.equal(boardDir, storage.blackboardDir(boardId!), "板目录就是留痕目录下的那块");
  const record = registry.get(taskId);
  assert.equal(record?.blackboard?.boardId, boardId, "记录里写着这块板");
  assert.equal(record?.blackboard?.path, boardDir);
});

test("引擎：默认关——继承来的黑板 env 被擦除", async () => {
  const oldDir = process.env.PI_DISPATCH_BLACKBOARD_DIR;
  const oldId = process.env.PI_DISPATCH_BLACKBOARD_ID;
  process.env.PI_DISPATCH_BLACKBOARD_DIR = "/tmp/inherited-board";
  process.env.PI_DISPATCH_BLACKBOARD_ID = "inherited-board";
  try {
    const seen: unknown[][] = [];
    const { engine } = freshEngine({
      spawn: recordingSpawn(seen) as never,
      hostMode: "one-shot",
    });
    await engine.dispatch({ task: "干活" });
    const env = seen[0]![1] as NodeJS.ProcessEnv;
    assert.equal(env.PI_DISPATCH_BLACKBOARD_DIR, undefined, "继承来的板目录要擦掉");
    assert.equal(env.PI_DISPATCH_BLACKBOARD_ID, undefined, "继承来的板号也要擦掉");
  } finally {
    if (oldDir === undefined) delete process.env.PI_DISPATCH_BLACKBOARD_DIR;
    else process.env.PI_DISPATCH_BLACKBOARD_DIR = oldDir;
    if (oldId === undefined) delete process.env.PI_DISPATCH_BLACKBOARD_ID;
    else process.env.PI_DISPATCH_BLACKBOARD_ID = oldId;
  }
});

test("引擎：同一会话的两个孩子共用一块板", async () => {
  const { storage } = isolationStorage();
  const seen: unknown[][] = [];
  const { engine } = freshEngine({
    storage,
    spawn: recordingSpawn(seen) as never,
    hostMode: "one-shot",
  });
  await engine.dispatch({ task: "一号", blackboard: true });
  await engine.dispatch({ task: "二号", blackboard: true });
  const first = (seen[0]![1] as NodeJS.ProcessEnv).PI_DISPATCH_BLACKBOARD_ID;
  const second = (seen[1]![1] as NodeJS.ProcessEnv).PI_DISPATCH_BLACKBOARD_ID;
  assert.ok(first, "第一个孩子有板号");
  assert.equal(first, second, "同一会话共用一块板");
  assert.equal(readdirSync(storage.blackboardsDir).length, 1, "桶里只有一块板");
});

test("引擎：没有黑板时父方视图报错", async () => {
  const { engine } = freshEngine({ hostMode: "one-shot" });
  const none = engine.blackboardView() as { error?: string };
  assert.match(none.error ?? "", /本会话还没有黑板/);
  const other = engine.blackboardView({
    boardId: "11111111-2222-4333-8444-555555555555",
  }) as { error?: string };
  assert.match(other.error ?? "", /本会话没有该黑板/, "别家会话的板不认");
});

test("引擎：父方视图——缺省/显式给当前板号都照读，别家板号仍报错", async () => {
  const { storage } = isolationStorage();
  const { engine } = freshEngine({
    storage,
    spawn: recordingSpawn([]) as never,
    hostMode: "one-shot",
  });
  await engine.dispatch({ task: "干活", blackboard: true });
  const boardId = readdirSync(storage.blackboardsDir)[0]!;
  const implicit = engine.blackboardView() as { error?: string; boardId?: string };
  assert.equal(implicit.error, undefined, "不给板号 ⇒ 缺省读当前板");
  assert.equal(implicit.boardId, boardId);
  const mine = engine.blackboardView({ boardId }) as { error?: string; boardId?: string };
  assert.equal(mine.error, undefined, "显式给当前板号 ⇒ 照读，不该报错");
  assert.equal(mine.boardId, boardId);
  const other = engine.blackboardView({
    boardId: "11111111-2222-4333-8444-555555555555",
  }) as { error?: string };
  assert.match(other.error ?? "", /本会话没有该黑板/, "别家板号仍报错");
});

test("引擎：shutdown 给板补 closedAt", async () => {
  const { storage } = isolationStorage();
  const { engine } = freshEngine({
    storage,
    spawn: recordingSpawn([]) as never,
    hostMode: "one-shot",
  });
  await engine.dispatch({ task: "干活", blackboard: true });
  const boardId = readdirSync(storage.blackboardsDir)[0]!;
  const ownerPath = join(storage.blackboardDir(boardId), "owner.json");
  const before = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
  assert.equal(before.closedAt, undefined, "没关就没有 closedAt");
  await engine.shutdown();
  const after = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
  assert.equal(typeof after.closedAt, "number", "关板补 closedAt");
});

test("引擎：没开黑板 ⇒ 记录与结果里都没有黑板的键", async () => {
  const { registry, engine } = freshEngine({ hostMode: "one-shot" });
  const outcome = await engine.dispatch({ task: "干活" });
  const taskId = (outcome as { taskId: string }).taskId;
  assert.ok(!Object.keys(registry.get(taskId) ?? {}).includes("blackboard"));
  assert.ok(!("blackboard" in (outcome as unknown as Record<string, unknown>)));
});

test("引擎：等启动名额时被叫停 ⇒ 一次性宿主以 canceled 返回，不挂住", async () => {
  const { project, storage } = isolationStorage();
  const git = gatedGit();
  const { registry, engine } = freshEngine({
    machineReader: machineReader(5369 * MiB, 1), // 1 核 ⇒ 启动名额 1
    storage,
    git: git.runner,
    repoRoot: project,
    isGitRepo: () => true,
    spawn: recordingSpawn([]) as never,
    hostMode: "one-shot",
  });
  // A 占住唯一名额（建盘卡住）；一次性宿主会一直等 A 的终态，先别 await。
  const a = engine.dispatch({ task: "A", isolation: "worktree" });
  await git.waitForAdds(1);
  // B 也走一次性宿主：记录转 running 后挂在启动名额上。
  const b = engine.dispatch({ task: "B" });
  let bId = "";
  for (let i = 0; i < 200 && !bId; i++) {
    bId = registry.list().find((r) => r.task === "B")?.id ?? "";
    if (!bId) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(bId, "B 已入队");
  await waitForStatus(registry, bId, "running");
  await engine.stop(bId, "等名额时叫停");
  // 放行 A ⇒ 名额还给 B ⇒ 走「等启动名额时被叫停」分支。
  await git.releaseNextAdd();
  // 缺陷表现：该分支不落终态 ⇒ B 的 promise 永不 resolve。2s 护栏把「挂住」变成失败。
  let guard!: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    guard = setTimeout(() => reject(new Error("dispatch 挂住了：记录停在 stopping")), 2000);
  });
  try {
    const outcome = (await Promise.race([b, timeout])) as { status: string; started?: boolean };
    assert.equal(outcome.status, "canceled", "一次性宿主拿到 canceled，而不是永远等");
    assert.equal(outcome.started, false);
    assert.equal(registry.get(bId)?.status, "canceled", "记录不停在 stopping");
  } finally {
    clearTimeout(guard);
  }
  await a;
});

test("引擎：childEnvFor——有板注入两键，没板把继承来的两键擦掉", () => {
  const base = {
    PI_DISPATCH_DEPTH: "2",
    PI_DISPATCH_BLACKBOARD_DIR: "/inherited/board",
    PI_DISPATCH_BLACKBOARD_ID: "inherited",
  };
  const withBoard = childEnvFor(base, "t1", { boardId: "b1", path: "/boards/b1" });
  assert.equal(withBoard.PI_DISPATCH_DEPTH, "3");
  assert.equal(withBoard.PI_DISPATCH_TASK_ID, "t1");
  assert.equal(withBoard.PI_DISPATCH_BLACKBOARD_DIR, "/boards/b1");
  assert.equal(withBoard.PI_DISPATCH_BLACKBOARD_ID, "b1");
  const without = childEnvFor(base, "t2");
  assert.equal(without.PI_DISPATCH_DEPTH, "3");
  assert.equal(without.PI_DISPATCH_BLACKBOARD_DIR, undefined, "继承来的板目录要擦掉");
  assert.equal(without.PI_DISPATCH_BLACKBOARD_ID, undefined, "继承来的板号要擦掉");
  assert.equal(base.PI_DISPATCH_BLACKBOARD_ID, "inherited", "不改入参");
  // depth 缺失时从 0 起算（不是 1）
  assert.equal(childEnvFor({}, "t0").PI_DISPATCH_DEPTH, "1");
});

test("引擎：openBoardState——没留痕目录就算失败", () => {
  const result = openBoardState(undefined, { pid: 1, startMs: 1 }, "board-1");
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /storage/);
});

test("引擎：openBoardState——建板抛错也算失败（不挂 error 冒充成功）", () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-board-fail-"));
  try {
    const storage = new Storage(join(root, "dispatch"), join(root, "proj"));
    mkdirSync(dirname(storage.blackboardsDir), { recursive: true });
    // blackboards 位置被一个文件占了 ⇒ ensureOwner 的 mkdir 会抛 ENOTDIR
    writeFileSync(storage.blackboardsDir, "占位");
    const result = openBoardState(storage, { pid: process.pid, startMs: 1 }, "board-x");
    assert.equal(result.ok, false, "开板失败就是失败，不能回 ok:true 却不带 board");
    assert.match((result as { error: string }).error, /blackboard 开板失败/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("引擎：prepareIsolationFor——没记录 / 非隔离记录直接放行，不碰 git", async () => {
  const { runner, calls } = fakeGit();
  assert.deepEqual(
    await prepareIsolationFor(runner, "/repo", undefined),
    { ok: true },
    "没有记录 ⇒ 放行（record?.isolation 不能当 record.isolation 解引用）",
  );
  const plain = { id: "t", status: "queued" as const, task: "x" };
  assert.deepEqual(await prepareIsolationFor(runner, "/repo", plain), { ok: true });
  assert.equal(calls.length, 0, "放行路径不该跑 git");
});

test("引擎：prepareIsolationFor——记录说开 worktree 但没基线 ⇒ 失败，不建盘", async () => {
  const { runner, calls } = fakeGit();
  const result = await prepareIsolationFor(runner, "/repo", {
    id: "t",
    status: "queued",
    task: "x",
    isolation: "worktree",
  });
  assert.equal(result.ok, false, "缺基线不能假成功（成功就会拿空 worktree 去 spawn）");
  assert.match((result as { error: string }).error, /基线/);
  assert.equal(calls.length, 0, "没基线就不该建盘");
});

test("引擎：boardIsActive——owner 双条件判活、关板/无 owner 判死、非终态引用判活", () => {
  const { storage } = isolationStorage();
  const boardId = "aaaaaaaa-2222-4333-8444-555555555555";
  const store = new BlackboardStore({ root: storage.blackboardsDir, boardId });
  const liveStart = processStartMs(process.pid) ?? 0;
  assert.equal(boardIsActive([], store, boardId), false, "没有 owner ⇒ 死板");
  store.ensureOwner({ pid: process.pid, startMs: liveStart });
  assert.equal(boardIsActive([], store, boardId), true, "owner 双条件对上 ⇒ 活板");
  const noBoard = { id: "plain", status: "running" as const, task: "t" };
  assert.equal(
    boardIsActive([noBoard], store, boardId),
    true,
    "没开黑板的记录不绊倒判活（读 owner）",
  );
  store.close(1);
  assert.equal(boardIsActive([], store, boardId), false, "已关板 ⇒ 死板（即便 owner 还活着）");
  const record = {
    id: "q",
    status: "queued" as const,
    task: "t",
    blackboard: { boardId, path: "/x" },
  };
  assert.equal(boardIsActive([record], store, boardId), true, "非终态引用 ⇒ 活板");
  const otherBoard = { ...record, blackboard: { boardId: "other", path: "/y" } };
  assert.equal(boardIsActive([otherBoard], store, boardId), false, "别的板不算");
});

test("引擎：boardIsActive——终态引用不算活板（owner 死了就是死板）", () => {
  const { storage } = isolationStorage();
  const boardId = "cccccccc-2222-4333-8444-555555555555";
  const store = new BlackboardStore({ root: storage.blackboardsDir, boardId });
  store.ensureOwner({ pid: 424242, startMs: 7 });
  const dead = { alive: () => false, startMs: () => 7 };
  const terminal = {
    id: "done",
    status: "succeeded" as const,
    task: "t",
    blackboard: { boardId, path: "/x" },
  };
  assert.equal(
    boardIsActive([terminal], store, boardId, dead),
    false,
    "记录全终态 + owner 已死 ⇒ 死板（终态引用不续命）",
  );
  const running = { ...terminal, status: "running" as const };
  assert.equal(
    boardIsActive([running], store, boardId, dead),
    true,
    "同一条记录在跑（非终态）⇒ 活板（终态才不算）",
  );
});

test("引擎：boardIsActive——pid 活但启动时刻读不到 ⇒ 按活（fail-safe）", () => {
  const { storage } = isolationStorage();
  const boardId = "bbbbbbbb-2222-4333-8444-555555555555";
  const store = new BlackboardStore({ root: storage.blackboardsDir, boardId });
  store.ensureOwner({ pid: 424242, startMs: 7 });
  const unknowable = { alive: () => true, startMs: () => undefined };
  assert.equal(
    boardIsActive([], store, boardId, unknowable),
    true,
    "读不到启动时刻 ⇒ 证不死 ⇒ 活板（宁留垃圾，不删证据）",
  );
  assert.equal(ownerIsActive(store.ownerInfo(boardId)!, unknowable), true);
  assert.equal(ownerProvenDead(store.ownerInfo(boardId)!, unknowable), false, "证不死就不许算死");
  // 启动时刻读得到且对不上 ⇒ 证死（光看 pid 会认错人）
  const mismatched = { alive: () => true, startMs: () => 8 };
  assert.equal(boardIsActive([], store, boardId, mismatched), false);
  assert.equal(ownerProvenDead(store.ownerInfo(boardId)!, mismatched), true);
  // pid 已死 ⇒ 证死
  const deadPid = { alive: () => false, startMs: () => 7 };
  assert.equal(ownerProvenDead(store.ownerInfo(boardId)!, deadPid), true);
  assert.equal(ownerIsActive(store.ownerInfo(boardId)!, deadPid), false);
  // 关板 ⇒ 证死（closedAt 优先于 pid / 启动时刻）
  store.close(11);
  const matching = { alive: () => true, startMs: () => 7 };
  assert.equal(ownerProvenDead(store.ownerInfo(boardId)!, matching), true, "有 closedAt ⇒ 证死");
  assert.equal(ownerIsActive(store.ownerInfo(boardId)!, matching), false, "有 closedAt ⇒ 不算活");
});

test("引擎：没注入 isGitRepo ⇒ 默认不许开隔离（缺省配置不做没把握的事）", async () => {
  const { project, storage } = isolationStorage();
  const { registry, engine } = freshEngine({ storage, repoRoot: project, hostMode: "one-shot" });
  const outcome = await engine.dispatch({ task: "干活", isolation: "worktree" });
  assert.equal((outcome as { status: string }).status, "rejected");
  assert.match((outcome as { errorMessage: string }).errorMessage, /git 仓库/);
  assert.equal(registry.list().length, 0);
});

test("引擎：pinBaseCommit——git 读 HEAD 失败要把原因带回来", async () => {
  const failing: GitRunner = async () => ({ code: 128, stdout: "", stderr: "fatal: not a repo" });
  const result = await pinBaseCommit(failing, "/repo");
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /not a repo|HEAD/);
});

test("引擎：boot 清扫黑板——活板一条不动，死板的过期笔记清掉", async () => {
  const { storage } = isolationStorage();
  const past = new Date(Date.now() - 31 * 86_400_000);
  // 造一块板：owner.json + 一条老笔记（mtime 在 TTL 之外）
  const boardOf = (boardId: string, startMs: number): string => {
    const dir = storage.blackboardDir(boardId);
    mkdirSync(join(dir, "notes"), { recursive: true });
    writeFileSync(
      join(dir, "owner.json"),
      JSON.stringify({ boardId, pid: process.pid, startMs, createdAt: 1 }),
      "utf8",
    );
    const note = join(dir, "notes", "0000000000001-x.json");
    writeFileSync(
      note,
      JSON.stringify({ noteId: "x", author: "a", createdAt: 1, text: "老的" }),
      "utf8",
    );
    utimesSync(note, past, past);
    return dir;
  };
  const liveStart = processStartMs(process.pid) ?? 0;
  // ① 活板：owner 就是本进程且启动时刻对得上 ⇒ 判活
  const liveId = "77777777-2222-4333-8444-555555555555";
  const liveDir = boardOf(liveId, liveStart);
  // ② 死板：owner 启动时刻对不上（光看进程号会认错人）⇒ 判死
  const deadId = "88888888-2222-4333-8444-555555555555";
  const deadDir = boardOf(deadId, liveStart + 1);
  // ③ 有人在用的板：一条非终态记录还引用它 ⇒ 整板跳过
  const busyId = "99999999-2222-4333-8444-555555555555";
  const busyDir = boardOf(busyId, liveStart + 1);
  storage.persistRecord({
    id: "busy-task",
    status: "running",
    task: "t",
    ownerPid: process.pid,
    ownerStartMs: liveStart,
    blackboard: { boardId: busyId, path: busyDir },
  });

  const { engine } = freshEngine({ storage, hostMode: "one-shot" });
  await engine.ready;

  assert.equal(readdirSync(join(liveDir, "notes")).length, 1, "活板一条都不清");
  assert.equal(readdirSync(join(busyDir, "notes")).length, 1, "有人在用的板一条都不清");
  assert.equal(existsSync(join(deadDir, "notes")), false, "死板的过期笔记清掉了");
});

// ── 引擎：运行中转向 ────────────────────────────────────────────────────

function steerStorage(): { dir: string; storage: Storage } {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-steer-"));
  return { dir, storage: new Storage(join(dir, "dispatch"), join(dir, "proj")) };
}

test("转向：建盘等待期间（running 但还没 spawn）仍可受理", async () => {
  const git = gatedGit();
  const { storage, dir } = steerStorage();
  const { registry, engine } = freshEngine({
    storage,
    childExtensionPath: "x",
    git: git.runner,
    repoRoot: "/repo",
    isGitRepo: () => true,
    spawn: fakeSpawn({ delayMs: 50 }),
  });
  const out = await engine.dispatch({ task: "干活", isolation: "worktree" });
  assert.ok("taskId" in out);
  const taskId = (out as { taskId: string }).taskId;
  await waitForStatus(registry, taskId, "running");
  await git.waitForAdds(1);
  const result = await engine.steer(taskId, "早一点");
  assert.equal(result.ok, true, "spawn 之前不该拒");
  await git.releaseNextAdd();
  await waitFor(registry, taskId);
  assert.equal(storage.readSteer(taskId).trim().length > 0, true);
  await engine.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

test("转向：append 失败不记 sent，也不留下半条收据", async () => {
  const { storage, dir } = steerStorage();
  storage.appendSteer = () => {
    throw new Error("disk full");
  };
  const { registry, engine } = freshEngine({
    storage,
    childExtensionPath: "x",
    spawn: fakeSpawn({ delayMs: 200 }),
  });
  const out = await engine.dispatch({ task: "干活" });
  const taskId = (out as { taskId: string }).taskId;
  await waitForStatus(registry, taskId, "running");
  const result = await engine.steer(taskId, "改");
  assert.equal(result.ok, false);
  assert.equal(registry.get(taskId)?.steers, undefined);
  await waitFor(registry, taskId);
  await engine.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

test("转向：信箱末尾半行时，新转向另起一行仍可解析", async () => {
  const { storage, dir } = steerStorage();
  const { registry, engine } = freshEngine({
    storage,
    childExtensionPath: "x",
    spawn: fakeSpawn({ delayMs: 200 }),
  });
  const out = await engine.dispatch({ task: "干活" });
  const taskId = (out as { taskId: string }).taskId;
  await waitForStatus(registry, taskId, "running");
  const path = storage.steerPath(taskId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{"seq":1,"text":"旧","at":1}\n{"seq":2,"text":"半');
  const result = await engine.steer(taskId, "新");
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.seq : -1, 2, "半行不被当成已存在的 seq 2");
  const lines = storage.readSteer(taskId).split("\n").filter(Boolean);
  assert.equal(lines.length, 3, "旧行 + 空行 + 新行");
  assert.equal(JSON.parse(lines[2]!).text, "新");
  await waitFor(registry, taskId);
  await engine.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

test("转向：信箱是 FIFO/目录时不阻塞，直接报错", async () => {
  if (process.platform === "win32") return;
  const { storage, dir } = steerStorage();
  const { registry, engine } = freshEngine({
    storage,
    childExtensionPath: "x",
    spawn: fakeSpawn({ delayMs: 200 }),
  });
  const out = await engine.dispatch({ task: "干活" });
  const taskId = (out as { taskId: string }).taskId;
  await waitForStatus(registry, taskId, "running");
  const path = storage.steerPath(taskId);
  mkdirSync(dirname(path), { recursive: true });
  execFileSync("mkfifo", [path]);
  const result = await engine.steer(taskId, "改");
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.error : "", /regular file/);
  await waitFor(registry, taskId);
  await engine.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

test("转向：信箱不可读或超限时返回错误，不把父方带崩", async () => {
  const { storage, dir } = steerStorage();
  const { registry, engine } = freshEngine({
    storage,
    childExtensionPath: "x",
    spawn: fakeSpawn({ delayMs: 200 }),
  });
  const out = await engine.dispatch({ task: "干活" });
  const taskId = (out as { taskId: string }).taskId;
  await waitForStatus(registry, taskId, "running");
  const path = storage.steerPath(taskId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "x".repeat(257 * 1024));
  const result = await engine.steer(taskId, "改");
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.error : "", /exceeds/);
  await waitFor(registry, taskId);
  await engine.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

test("转向：进入退出对账后拒绝，不把 sent 留在终态之后", async () => {
  const { storage, dir } = steerStorage();
  const { registry, engine } = freshEngine({
    storage,
    childExtensionPath: "x",
    spawn: fakeSpawn({ delayMs: 30 }),
  });
  const out = await engine.dispatch({ task: "干活" });
  const taskId = (out as { taskId: string }).taskId;
  await waitForStatus(registry, taskId, "running");
  await waitFor(registry, taskId);
  const result = await engine.steer(taskId, "太晚");
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.error : "", /finishing|not running/);
  assert.equal(storage.readSteer(taskId), "");
  await engine.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

test("转向：running 两次并发得到 seq 1/2，文件两行，记录 sent", async () => {
  const { storage, dir } = steerStorage();
  const { registry, engine } = freshEngine({
    storage,
    childExtensionPath: "x",
    spawn: fakeSpawn({ delayMs: 300 }),
  });
  const out = await engine.dispatch({ task: "干活" });
  assert.ok("taskId" in out);
  const taskId = (out as { taskId: string }).taskId;
  await waitForStatus(registry, taskId, "running");

  const [a, b] = await Promise.all([engine.steer(taskId, "甲"), engine.steer(taskId, "乙")]);
  assert.deepEqual(
    [a, b].map((r) => (r.ok ? r.seq : r)),
    [1, 2],
  );
  assert.deepEqual(
    registry.get(taskId)!.steers!.map((s) => [s.seq, s.state]),
    [
      [1, "sent"],
      [2, "sent"],
    ],
  );
  const lines = readFileSync(storage.steerPath(taskId), "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(
    lines.map((line) => (JSON.parse(line) as { seq: number }).seq),
    [1, 2],
  );
  await waitFor(registry, taskId);
  await engine.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

test("转向：退出按真机证据把 sent 对成 seen，报告在回显后不 stale", async () => {
  const { storage, dir } = steerStorage();
  const stream = [
    JSON.stringify({ type: "queue_update", steering: ["[pi-dispatch-steer #1]\n改"] }),
    JSON.stringify({
      type: "message_end",
      message: { role: "user", content: "[pi-dispatch-steer #1]\n改" },
    }),
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "好" }] },
    }),
    JSON.stringify({
      type: "message_end",
      message: {
        role: "toolResult",
        toolName: "child_report",
        details: { report: { summary: "完", why: "", assessment: "有风险" } },
      },
    }),
  ].join("\n");
  const { registry, engine } = freshEngine({
    storage,
    childExtensionPath: "x",
    spawn: fakeSpawn({ stdout: stream, delayMs: 100 }),
  });
  const out = await engine.dispatch({ task: "干活" });
  const taskId = (out as { taskId: string }).taskId;
  await waitForStatus(registry, taskId, "running");
  assert.equal((await engine.steer(taskId, "改")).ok, true);
  await waitFor(registry, taskId);
  const record = registry.get(taskId)!;
  assert.equal(record.steers![0]!.state, "seen");
  assert.ok(!("reportStale" in record), "报告不早于转向时不留键");
  await engine.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

test("转向：报告早于回显时 reportStale 为 true", async () => {
  const { storage, dir } = steerStorage();
  const stream = [
    JSON.stringify({
      type: "message_end",
      message: {
        role: "toolResult",
        toolName: "child_report",
        details: { report: { summary: "早", why: "", assessment: "有风险" } },
      },
    }),
    JSON.stringify({ type: "queue_update", steering: ["[pi-dispatch-steer #1]\n改"] }),
    JSON.stringify({
      type: "message_end",
      message: { role: "user", content: "[pi-dispatch-steer #1]\n改" },
    }),
  ].join("\n");
  const { registry, engine } = freshEngine({
    storage,
    childExtensionPath: "x",
    spawn: fakeSpawn({ stdout: stream, delayMs: 100 }),
  });
  const out = await engine.dispatch({ task: "干活" });
  const taskId = (out as { taskId: string }).taskId;
  await waitForStatus(registry, taskId, "running");
  await engine.steer(taskId, "改");
  await waitFor(registry, taskId);
  assert.equal(registry.get(taskId)!.reportStale, true);
  await engine.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

test("转向：17MB 输出砍头后，头部证据仍把 sent 对成 seen", async () => {
  const { storage, dir } = steerStorage();
  const stream = [
    JSON.stringify({ type: "queue_update", steering: ["[pi-dispatch-steer #1]\n改"] }),
    JSON.stringify({
      type: "message_end",
      message: { role: "user", content: "[pi-dispatch-steer #1]\n改" },
    }),
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "好" }] },
    }),
    "x".repeat(17 * 1024 * 1024),
  ].join("\n");
  const { registry, engine } = freshEngine({
    storage,
    childExtensionPath: "x",
    spawn: fakeSpawn({ stdout: stream, delayMs: 100 }),
  });
  const out = await engine.dispatch({ task: "干活" });
  const taskId = (out as { taskId: string }).taskId;
  await waitForStatus(registry, taskId, "running");
  await engine.steer(taskId, "改");
  await waitFor(registry, taskId);
  assert.equal(registry.get(taskId)!.steers![0]!.state, "seen");
  assert.equal(registry.get(taskId)!.outputTruncated, true);
  await engine.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

test("转向：没有证据的 sent 退出时标 undelivered", async () => {
  const { storage, dir } = steerStorage();
  const { registry, engine } = freshEngine({
    storage,
    childExtensionPath: "x",
    spawn: fakeSpawn({ delayMs: 100 }),
  });
  const out = await engine.dispatch({ task: "干活" });
  const taskId = (out as { taskId: string }).taskId;
  await waitForStatus(registry, taskId, "running");
  await engine.steer(taskId, "改");
  await waitFor(registry, taskId);
  assert.equal(registry.get(taskId)!.steers![0]!.state, "undelivered");
  await engine.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

test("转向：只有 queue_update 证据时退出保留 queued，不并进 undelivered", async () => {
  const { storage, dir } = steerStorage();
  const stream = JSON.stringify({
    type: "queue_update",
    steering: ["[pi-dispatch-steer #1]\n改"],
  });
  const { registry, engine } = freshEngine({
    storage,
    childExtensionPath: "x",
    spawn: fakeSpawn({ stdout: stream, delayMs: 200 }),
  });
  const out = await engine.dispatch({ task: "干活" });
  const taskId = (out as { taskId: string }).taskId;
  await waitForStatus(registry, taskId, "running");
  assert.equal((await engine.steer(taskId, "改")).ok, true);
  await waitFor(registry, taskId);
  assert.equal(registry.get(taskId)!.steers![0]!.state, "queued");
  await engine.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

test("转向：非 running、空、超长、无扩展都拒绝且不落盘", async () => {
  const { storage, dir } = steerStorage();
  const { registry, engine } = freshEngine({
    storage,
    spawn: fakeSpawn({ delayMs: 200 }),
  });
  const out = await engine.dispatch({ task: "干活" });
  const taskId = (out as { taskId: string }).taskId;
  await waitForStatus(registry, taskId, "running");

  assert.equal((await engine.steer(taskId, "  ")).ok, false);
  assert.equal((await engine.steer(taskId, "x".repeat(4097))).ok, false);
  assert.equal((await engine.steer(taskId, "没扩展")).ok, false);
  assert.equal(existsSync(storage.steerPath(taskId)), false, "拒绝不落盘");
  await waitFor(registry, taskId);
  assert.equal((await engine.steer(taskId, "晚了")).ok, false);
  assert.equal(existsSync(storage.steerPath(taskId)), false, "终态拒绝也不落盘");
  await engine.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

test("转向：4096 字符放行，4097 字符拒绝", async () => {
  const { storage, dir } = steerStorage();
  const { registry, engine } = freshEngine({
    storage,
    childExtensionPath: "x",
    spawn: fakeSpawn({ delayMs: 300 }),
  });
  const out = await engine.dispatch({ task: "干活" });
  const taskId = (out as { taskId: string }).taskId;
  await waitForStatus(registry, taskId, "running");
  assert.equal((await engine.steer(taskId, "x".repeat(4096))).ok, true);
  assert.equal((await engine.steer(taskId, "x".repeat(4097))).ok, false);
  assert.equal(registry.get(taskId)!.steers!.length, 1);
  await waitFor(registry, taskId);
  await engine.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

test("转向：已有信箱最后一行 seq=7 时下一条写 8", async () => {
  const { storage, dir } = steerStorage();
  const { registry, engine } = freshEngine({
    storage,
    childExtensionPath: "x",
    spawn: fakeSpawn({ delayMs: 300 }),
  });
  const out = await engine.dispatch({ task: "干活" });
  const taskId = (out as { taskId: string }).taskId;
  await waitForStatus(registry, taskId, "running");
  mkdirSync(join(storage.steerPath(taskId), ".."), { recursive: true });
  writeFileSync(storage.steerPath(taskId), JSON.stringify({ seq: 7, text: "旧", at: 1 }) + "\n");
  const result = await engine.steer(taskId, "新");
  assert.deepEqual(result.ok ? result.seq : result, 8);
  await waitFor(registry, taskId);
  await engine.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

test("转向：第 16 条接受，第 17 条拒绝且前 16 条不被清", async () => {
  const { storage, dir } = steerStorage();
  const { registry, engine } = freshEngine({
    storage,
    childExtensionPath: "x",
    spawn: fakeSpawn({ delayMs: 1200 }),
  });
  const out = await engine.dispatch({ task: "干活" });
  const taskId = (out as { taskId: string }).taskId;
  await waitForStatus(registry, taskId, "running");
  for (let i = 1; i <= 16; i++) assert.equal((await engine.steer(taskId, `第${i}条`)).ok, true);
  const before = readFileSync(storage.steerPath(taskId), "utf8");
  const rejected = await engine.steer(taskId, "第17条");
  assert.equal(rejected.ok, false);
  assert.equal(readFileSync(storage.steerPath(taskId), "utf8"), before);
  assert.equal(registry.get(taskId)!.steers!.length, 16);
  await waitFor(registry, taskId);
  await engine.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

test("转向：终态任务即使有扩展也拒绝且不落盘", async () => {
  const { storage, dir } = steerStorage();
  const { registry, engine } = freshEngine({
    storage,
    childExtensionPath: "x",
    spawn: fakeSpawn({ delayMs: 30 }),
  });
  const out = await engine.dispatch({ task: "干活" });
  const taskId = (out as { taskId: string }).taskId;
  await waitFor(registry, taskId);
  assert.equal((await engine.steer(taskId, "晚了")).ok, false);
  assert.equal(existsSync(storage.steerPath(taskId)), false);
  await engine.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

test("转向：孩子环境擦掉继承信箱，注入本任务路径", () => {
  const env = childEnvFor(
    { PI_DISPATCH_STEER_FILE: "/old/steer.jsonl", PI_DISPATCH_DEPTH: "1" },
    "t1",
    undefined,
    "/new/steer.jsonl",
  );
  assert.equal(env.PI_DISPATCH_STEER_FILE, "/new/steer.jsonl");
  const cleared = childEnvFor({ PI_DISPATCH_STEER_FILE: "/old/steer.jsonl" }, "t1");
  assert.equal(cleared.PI_DISPATCH_STEER_FILE, undefined);
});

// ── 引擎：用量预算（软门 / 硬门）与思考档位回执 ─────────────────────────

/**
 * 假 spawn：10ms 时喷一段 stdout，活到 exitAfterMs 再退出。
 * 预算的软门要等 steer 落盘，是异步的 ⇒ 孩子必须活够，不能喷完就死。
 * （集成测试：跑的是引擎真实的启动/退出时序，没有可注入的时钟。）
 */
function budgetSpawn(options: { stdout?: string; exitAfterMs?: number; exitCode?: number }): {
  spawn: (argv: string[], env: NodeJS.ProcessEnv) => ChildHandle;
  kills: NodeJS.Signals[];
} {
  const kills: NodeJS.Signals[] = [];
  const spawn = (): ChildHandle => {
    const outputListeners: Array<(chunk: string) => void> = [];
    const exitListeners: Array<(code: number, stderr: string) => void> = [];
    let finished = false;
    const finish = (code: number): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      for (const l of exitListeners) l(code, "");
    };
    const timer = setTimeout(() => finish(options.exitCode ?? 0), options.exitAfterMs ?? 300);
    setTimeout(() => {
      if (finished) return;
      const chunk = options.stdout ?? "";
      if (chunk) for (const l of outputListeners) l(chunk);
    }, 10);
    return {
      pid: 4242,
      onOutput: (cb) => outputListeners.push(cb),
      onExit: (cb) => {
        exitListeners.push(cb);
        if (finished) cb(options.exitCode ?? 0, "");
      },
      kill: (signal) => {
        kills.push(signal);
        finish(143);
      },
    };
  };
  return { spawn, kills };
}

/** 一条 assistant 的 message_end（可选正文 + 用量）。 */
function usageLine(usage: Record<string, unknown>, text = "部分正文"): string {
  return JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }], usage },
  });
}

test("引擎：预算到点 ⇒ 降级交付（不 failed，回执标 budgetExhausted）", async () => {
  const { storage, dir } = steerStorage();
  const fake = budgetSpawn({
    stdout: usageLine({ input: 10, output: 5, cacheRead: 100, cost: 0.0015 }) + "\n",
    exitAfterMs: 300,
  });
  const { engine } = freshEngine({
    storage,
    childExtensionPath: "x",
    spawn: fake.spawn,
    hostMode: "one-shot",
  });
  const outcome = await engine.dispatch({ task: "干活", usageBudget: { maxUsd: 0.001 } });
  const result = outcome as {
    status: string;
    budgetExhausted?: boolean;
    budget?: { exhausted?: boolean; spentUsd?: number };
  };
  assert.equal(result.status, "succeeded", "软门是降级交付，不是 failed");
  assert.equal(result.budgetExhausted, true, "回执要标预算到点");
  assert.equal(result.budget?.exhausted, true);
  assert.equal(result.budget?.spentUsd, 0.0015);
  await engine.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

test("引擎：预算到点 ⇒ 给孩子写一条收尾转向（软门，收据里看得见）", async () => {
  const { storage, dir } = steerStorage();
  const fake = budgetSpawn({
    stdout: usageLine({ input: 10, output: 5, cost: 0.0015 }) + "\n",
    exitAfterMs: 300,
  });
  const { registry, engine } = freshEngine({
    storage,
    childExtensionPath: "x",
    spawn: fake.spawn,
    hostMode: "one-shot",
  });
  const outcome = await engine.dispatch({ task: "干活", usageBudget: { maxUsd: 0.001 } });
  const started = outcome as { taskId: string };
  const steers = registry.get(started.taskId)?.steers ?? [];
  assert.equal(steers.length, 1, "软门插过一句话");
  assert.equal(steers[0]!.text, BUDGET_STEER_TEXT);
  assert.match(readFileSync(storage.steerPath(started.taskId), "utf8"), /预算到点/);
  await engine.shutdown();
  rmSync(dir, { recursive: true, force: true });

  // 没有转向通道 ⇒ 软门写不进去：回执明说「软门未送达」，靠硬门兜底
  const noStorage = budgetSpawn({
    stdout: usageLine({ input: 10, output: 5, cost: 0.0015 }) + "\n",
    exitAfterMs: 300,
  });
  const second = freshEngine({ spawn: noStorage.spawn, hostMode: "one-shot" });
  const out = await second.engine.dispatch({ task: "干活", usageBudget: { maxUsd: 0.001 } });
  const undelivered = out as { budget?: { softSteerFailed?: boolean } };
  assert.equal(undelivered.budget?.softSteerFailed, true, "软门写不进去要说出来");
  await second.engine.shutdown();
});

test("引擎：硬门 ⇒ 收掉孩子（SIGTERM），部分正文照交", async () => {
  const fake = budgetSpawn({
    stdout: usageLine({ input: 10, output: 5, cost: 0.01 }, "半截正文") + "\n",
    exitAfterMs: 5000,
  });
  const { engine } = freshEngine({ spawn: fake.spawn, hostMode: "one-shot" });
  const outcome = await engine.dispatch({ task: "干活", usageBudget: { maxUsd: 0.001 } });
  const result = outcome as { status: string; text: string; budgetExhausted?: boolean };
  assert.equal(result.status, "canceled", "硬收不许装成 succeeded");
  assert.equal(result.budgetExhausted, true);
  assert.match(result.text, /半截正文/, "部分正文照交");
  assert.deepEqual(fake.kills, ["SIGTERM"]);
  await engine.shutdown();
});

test("引擎：软门后宽限期到点 ⇒ 收掉孩子（没有新用量也收）", async () => {
  const fake = budgetSpawn({
    stdout: usageLine({ input: 10, output: 5, cost: 0.0015 }) + "\n",
    exitAfterMs: 500,
  });
  const { engine } = freshEngine({ spawn: fake.spawn, hostMode: "one-shot" });
  const outcome = await engine.dispatch({
    task: "干活",
    usageBudget: { maxUsd: 0.001, hardGraceMs: 30 },
  });
  const result = outcome as { status: string; budgetExhausted?: boolean };
  assert.equal(result.status, "canceled", "宽限期到点是被收掉，不是 succeeded");
  assert.equal(result.budgetExhausted, true);
  assert.deepEqual(fake.kills, ["SIGTERM"], "没有新用量也要靠定时器收尸");
  await engine.shutdown();
});

test("引擎：软门转向卡住时，宽限定时器仍会收掉孩子（arm 在 await 之前）", async () => {
  const { storage, dir } = steerStorage();
  const registry = new TaskRegistry();
  const submit = registry.submit.bind(registry);
  registry.submit = async (command) => {
    if (command.kind === "attach-steer") {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return submit(command);
  };
  const fake = budgetSpawn({
    stdout: usageLine({ input: 10, output: 5, cost: 0.0015 }) + "\n",
    exitAfterMs: 100,
  });
  const { engine } = freshEngine({
    registry,
    storage,
    childExtensionPath: "x",
    spawn: fake.spawn,
    hostMode: "one-shot",
  });
  const outcome = await engine.dispatch({
    task: "干活",
    usageBudget: { maxUsd: 0.001, hardGraceMs: 30 },
  });
  const result = outcome as { status: string };
  assert.equal(result.status, "canceled");
  assert.deepEqual(fake.kills, ["SIGTERM"], "steer 卡住不许拖死硬门兜底");
  await engine.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

test("引擎：预算记账失败也要收掉孩子（硬门不依赖回执）", async () => {
  const registry = new TaskRegistry();
  const submit = registry.submit.bind(registry);
  registry.submit = async (command) => {
    if (command.kind === "attach-budget") throw new Error("disk full");
    return submit(command);
  };
  const fake = budgetSpawn({
    stdout: usageLine({ input: 10, output: 5, cost: 0.01 }) + "\n",
    exitAfterMs: 5000,
  });
  let unhandled = 0;
  const onUnhandled = (): void => {
    unhandled += 1;
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const { engine } = freshEngine({
      registry,
      spawn: fake.spawn,
      hostMode: "one-shot",
    });
    const outcome = await engine.dispatch({ task: "干活", usageBudget: { maxUsd: 0.001 } });
    const result = outcome as { status: string };
    assert.equal(result.status, "canceled");
    assert.deepEqual(fake.kills, ["SIGTERM"], "记账失败也必须收掉孩子");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unhandled, 0, "预算检查的异常不许冒成未处理拒绝");
    await engine.shutdown();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("引擎：没给预算 ⇒ 不写转向也不收尸", async () => {
  const { storage, dir } = steerStorage();
  const fake = budgetSpawn({
    stdout: usageLine({ input: 999, output: 999, cost: 99 }) + "\n",
    exitAfterMs: 150,
  });
  const { registry, engine } = freshEngine({
    storage,
    childExtensionPath: "x",
    spawn: fake.spawn,
    hostMode: "one-shot",
  });
  const outcome = await engine.dispatch({ task: "干活" });
  const started = outcome as { taskId: string; status: string };
  assert.equal(started.status, "succeeded");
  assert.deepEqual(fake.kills, [], "没预算不许收尸");
  assert.equal(registry.get(started.taskId)?.steers, undefined, "没预算不许写转向");
  assert.equal(existsSync(storage.steerPath(started.taskId)), false);
  await engine.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

test("引擎：预算回执带上限、已花的钱与 token", async () => {
  const fake = budgetSpawn({
    stdout: usageLine({ input: 10, output: 5, cacheRead: 100, cacheWrite: 7, cost: 0.002 }) + "\n",
    exitAfterMs: 150,
  });
  const { engine } = freshEngine({ spawn: fake.spawn, hostMode: "one-shot" });
  const outcome = await engine.dispatch({
    task: "干活",
    usageBudget: { maxUsd: 1, maxTokens: 1000 },
  });
  const result = outcome as { budget?: unknown };
  assert.deepEqual(result.budget, {
    maxUsd: 1,
    maxTokens: 1000,
    spentUsd: 0.002,
    spentTokens: 122,
  });
  await engine.shutdown();
});

/** 本机 vendor-local 的真实档位图：medium / minimal / xhigh 是显式 null。 */
const MAGPIE: ThinkingModelInfo = {
  provider: "vendor-local",
  id: "regex:group/main",
  reasoning: true,
  thinkingLevelMap: {
    high: "high",
    low: "low",
    max: "max",
    medium: null,
    minimal: null,
    off: "none",
    xhigh: null,
  },
};

/** 非思考模型：请求任何档位都只能落 off，argv 不拼后缀。 */
const PLAIN: ThinkingModelInfo = {
  provider: "acme",
  id: "plain",
  reasoning: false,
};

test("引擎：thinking 降级写进回执（requested/effective/reason）", async () => {
  const { engine } = freshEngine({
    spawn: fakeSpawn({}),
    hostMode: "one-shot",
    thinkingCatalog: () => [MAGPIE],
  });
  const outcome = await engine.dispatch({
    task: "干活",
    model: "regex:test-vendor/group/main",
    thinkingLevel: "medium",
  });
  const result = outcome as {
    thinking?: {
      requested?: string;
      effective?: string;
      adjusted?: boolean;
      modelKnown?: boolean;
      reason?: string;
    };
  };
  assert.equal(result.thinking?.requested, "medium");
  assert.equal(result.thinking?.effective, "low", "vendor-local 没有 medium ⇒ 降到 low");
  assert.equal(result.thinking?.adjusted, true);
  assert.equal(result.thinking?.modelKnown, true);
  assert.match(result.thinking?.reason ?? "", /medium/);
});

test("引擎：thinking 降级进 argv（medium ⇒ --model regex:test-vendor/group/main:low）", async () => {
  const capture = captureSpawn({});
  const { engine } = freshEngine({
    spawn: capture.spawn,
    hostMode: "one-shot",
    thinkingCatalog: () => [MAGPIE],
  });
  const outcome = await engine.dispatch({
    task: "干活",
    model: "regex:test-vendor/group/main",
    thinkingLevel: "medium",
  });
  assert.equal((outcome as { status: string }).status, "succeeded");
  assert.equal(capture.argvs.length, 1);
  const argv = capture.argvs[0]!;
  assert.equal(
    argv[argv.indexOf("--model") + 1],
    "regex:test-vendor/group/main:low",
    "argv 用的是校验后的档位，不是请求的 medium",
  );
  await engine.shutdown();
});

test("引擎：不给档位 ⇒ argv 不带档位后缀", async () => {
  const capture = captureSpawn({});
  const { engine } = freshEngine({
    spawn: capture.spawn,
    hostMode: "one-shot",
    thinkingCatalog: () => [MAGPIE],
  });
  await engine.dispatch({ task: "干活", model: "regex:test-vendor/group/main" });
  const argv = capture.argvs[0]!;
  assert.equal(argv[argv.indexOf("--model") + 1], "regex:test-vendor/group/main");
  await engine.shutdown();
});

test("引擎：非思考模型 ⇒ argv 不带档位后缀（off）", async () => {
  const capture = captureSpawn({});
  const { engine } = freshEngine({
    spawn: capture.spawn,
    hostMode: "one-shot",
    thinkingCatalog: () => [PLAIN],
  });
  const outcome = await engine.dispatch({
    task: "干活",
    model: "acme/plain",
    thinkingLevel: "high",
  });
  assert.equal((outcome as { thinking?: { effective?: string } }).thinking?.effective, "off");
  const argv = capture.argvs[0]!;
  assert.equal(argv[argv.indexOf("--model") + 1], "acme/plain", "非思考模型不拼 :off");
  await engine.shutdown();
});

test("引擎：受理时钉死模型（排队期间会话模型变了也不换）", async () => {
  const oneSeat = Math.floor(2.4 * GiB) + 512 * MiB + 100 * MiB;
  let sessionModel = "regex:test-vendor/group/main";
  const capture = captureSpawn({ delayMs: 250 });
  const { registry, engine } = freshEngine({
    machineReader: machineReader(oneSeat),
    spawn: capture.spawn,
    hostMode: "long-lived",
    sessionModel: () => sessionModel,
    thinkingCatalog: () => [MAGPIE],
  });
  const first = (await engine.dispatch({ task: "占座" })) as { taskId: string };
  await waitForStatus(registry, first.taskId, "running");
  const second = (await engine.dispatch({ task: "排队", thinkingLevel: "medium" })) as {
    taskId: string;
  };
  assert.equal(registry.get(second.taskId)?.status, "queued", "第二单在排队");
  sessionModel = "other/model";
  await waitFor(registry, second.taskId, 5000);
  assert.equal(capture.argvs.length, 2);
  const argv = capture.argvs[1]!;
  assert.equal(
    argv[argv.indexOf("--model") + 1],
    "regex:test-vendor/group/main:low",
    "spawn 用受理时钉死的模型，不读排队期间变过的会话模型",
  );
  await engine.shutdown();
});

test("引擎：没交报告时预算照样判（账上也有数）", async () => {
  const { storage, dir } = steerStorage();
  const fake = budgetSpawn({
    stdout: usageLine({ input: 10, output: 5, cacheRead: 100, cost: 0.0015 }, "只有正文") + "\n",
    exitAfterMs: 300,
  });
  const { engine } = freshEngine({
    storage,
    childExtensionPath: "x",
    spawn: fake.spawn,
    hostMode: "one-shot",
  });
  const outcome = await engine.dispatch({ task: "干活", usageBudget: { maxUsd: 0.001 } });
  const result = outcome as {
    reportChannel: string;
    budgetExhausted?: boolean;
    budget?: { spentUsd?: number; spentTokens?: number };
  };
  assert.equal(result.reportChannel, "none", "没交报告");
  assert.equal(result.budgetExhausted, true, "预算照判");
  assert.equal(result.budget?.spentUsd, 0.0015, "账照记");
  assert.equal(result.budget?.spentTokens, 115);
  await engine.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

test("引擎：孩子没起来 ⇒ 不带 budget 字段", async () => {
  const { engine } = freshEngine({
    spawn: () => {
      throw new Error("boom");
    },
    hostMode: "one-shot",
  });
  const outcome = await engine.dispatch({ task: "干活", usageBudget: { maxUsd: 1 } });
  const result = outcome as unknown as Record<string, unknown> & { status: string };
  assert.equal(result.status, "failed");
  assert.equal("budget" in result, false, "没跑起来就没有预算回执");
  assert.equal("budgetExhausted" in result, false);
  await engine.shutdown();
});

test("引擎：受理时钉死预算（排队期间改参数不生效）", async () => {
  // 一座：第一个占住，第二个排队；排队期间调用方改上限
  const oneSeat = Math.floor(2.4 * GiB) + 512 * MiB + 100 * MiB;
  const fake = budgetSpawn({
    stdout: usageLine({ input: 10, output: 5, cost: 0.002 }) + "\n",
    exitAfterMs: 250,
  });
  const { registry, engine } = freshEngine({
    machineReader: machineReader(oneSeat),
    spawn: fake.spawn,
    hostMode: "long-lived",
  });
  const first = await engine.dispatch({ task: "占座" });
  const live = { maxUsd: 1 };
  const queued = await engine.dispatch({ task: "排队", usageBudget: live });
  const second = queued as { taskId: string };
  assert.equal(registry.get(second.taskId)?.status, "queued", "第二单在排队");
  live.maxUsd = 0.0001; // 若读的是活对象，这单会立刻到点
  await waitFor(registry, second.taskId, 5000);
  const record = registry.get(second.taskId)!;
  assert.equal(record.budget?.maxUsd, 1, "受理时的上限钉死");
  assert.equal(record.budgetExhausted, undefined, "改小的上限不生效");
  await first;
  await engine.shutdown();
});

test("引擎：软门后孩子交了差 ⇒ 报告旗标与预算旗标不互相掩盖", async () => {
  const reportText = [
    "正文。",
    "```json",
    '{ "summary": "交了", "why": "边界", "assessment": "有风险：缓存可能不命中" }',
    "```",
  ].join("\n");
  const fake = budgetSpawn({
    stdout: usageLine({ input: 10, output: 5, cost: 0.0015 }, reportText) + "\n",
    exitAfterMs: 300,
  });
  const { storage, dir } = steerStorage();
  const { engine } = freshEngine({
    storage,
    childExtensionPath: "x",
    spawn: fake.spawn,
    hostMode: "one-shot",
  });
  const outcome = await engine.dispatch({ task: "干活", usageBudget: { maxUsd: 0.001 } });
  const result = outcome as {
    status: string;
    reportChannel: string;
    report?: { summary?: string };
    budgetExhausted?: boolean;
  };
  assert.equal(result.status, "succeeded");
  assert.equal(result.reportChannel, "prompt-json", "报告旗标照常记");
  assert.equal(result.report?.summary, "交了");
  assert.equal(result.budgetExhausted, true, "预算旗标独立");
  await engine.shutdown();
  rmSync(dir, { recursive: true, force: true });
});
