#!/usr/bin/env node
// 真机验收：print / json / rpc / tui 各起真 pi 进程 + 装本扩展 + 发指令 + 断言产出；
// 另有隔离（worktree）、黑板往返、非 git 拒绝三条腿。
// 手动触发：pnpm test:mode
// 真模型调用，慢且花钱——不进 node --test 快腿。
// tui 腿另需 python3 + pyte（缺了跳过不判失败），用真 pty 重建屏幕帧断言常驻面板。
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import {
  judgeAllowScripts,
  judgeBlackboardExchange,
  judgeChildReport,
  judgeCommandReceipt,
  judgeDefaultOffUntouched,
  judgeDispatch,
  judgeJsonStream,
  judgeReject,
  judgeRpc,
  judgeSteer,
  judgeVerifyAudit,
  judgeWorktreeIsolation,
  judgeWorktreeRejected,
  type BoardNoteFact,
} from "./verdicts.ts";
import { isTerminal, type TaskRecord } from "../src/core/types.ts";
import { TaskRegistry } from "../src/core/registry.ts";
import { TaskEngine } from "../src/core/engine.ts";
import { Storage } from "../src/core/storage.ts";
import { scrubbedEnv } from "./test-env.ts";

const EXT = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const RESULTS: Array<{
  mode: string;
  case: string;
  ok: boolean;
  detail: string;
  skipped?: boolean;
}> = [];

function report(mode: string, testCase: string, ok: boolean, detail = "", skipped = false): void {
  RESULTS.push({ mode, case: testCase, ok, detail, skipped });
  const icon = skipped ? "⏭️" : ok ? "✅" : "❌";
  console.log(`  ${icon} [${mode}] ${testCase}${detail ? ` — ${detail}` : ""}`);
}

/** 轮询一个本地布尔量直到为真，或超时。两处重复的等待共用它。 */
function waitUntil(isTrue: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      clearInterval(check);
      resolve(false);
    }, timeoutMs);
    const check = setInterval(() => {
      if (!isTrue()) return;
      clearTimeout(timer);
      clearInterval(check);
      resolve(true);
    }, 300);
    check.unref?.();
  });
}

/** 跑一次 pi -p（print / json 模式共用），返回 { stdout, stderr, code }。 */
function runPrintLike(mode: "print" | "json", prompt: string, cwd: string, timeoutMs = 120_000) {
  const args = ["-p", "--no-session", "-e", EXT];
  if (mode === "json") args.push("--mode", "json");
  args.push(prompt);
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
    // cwd 决定留痕落哪个桶——必须在临时项目目录里跑，否则落到当前仓库的桶
    const child = spawn("pi", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // git 的环境也一并收紧：不读系统配置、不弹终端提示（隔离腿的孩子要真跑 git）
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ stdout, stderr: `${stderr}\n[timeout]`, code: -1 });
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}

/** 在临时项目目录里跑，让留痕落进隔离的桶。 */
function withTempProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-verify-"));
  mkdirSync(join(dir, ".git"), { recursive: true });
  return fn(dir);
}

/**
 * 真仓夹具：隔离腿必须真 git（旧的 withTempProject 只 mkdir .git，rev-parse 会报不是仓库）。
 * 配置全走本仓：不读系统配置、不弹终端、不签名、hooks 指向不存在的目录（孩子 commit 不被拦）。
 */
function withGitProject<T>(
  fn: (dir: string, base: string, git: (args: string[]) => string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-git-"));
  const git = (args: string[]): string =>
    execFileSync("git", args, {
      cwd: dir,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    git(["init", "-b", "main"]); // git ≥ 2.28
  } catch {
    git(["init"]); // 老 git 退化：init + checkout -b
    git(["checkout", "-b", "main"]);
  }
  git(["config", "user.email", "verify@example.invalid"]);
  git(["config", "user.name", "verify"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["config", "core.hooksPath", join(dir, ".no-hooks")]);
  writeFileSync(join(dir, "README.md"), "base\n");
  git(["add", "-A"]);
  git(["commit", "-m", "base"]);
  return fn(dir, git(["rev-parse", "HEAD"]).trim(), git);
}

/** 读文件；不在就空串（区分「没有」与「内容为空白」交给判据）。 */
function readTextIfExists(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

/** 目录下的子目录数（worktrees 下只该有隔离那一个）。 */
function countDirectories(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
}

/** 路径是不是普通文件（worktree 的 .git 该是文件；不在/是目录都算不是）。 */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** 桶里 worktrees 目录的落点。 */
function worktreesDirFor(projectDir: string): string {
  return join(dispatchStorageRoot(), bucketFor(projectDir), "worktrees");
}

/** 板上落盘的笔记文件（父方读信封之外的另一侧证据）。 */
function readBoardNoteFiles(boardDir: string): BoardNoteFact[] {
  const notesDir = join(boardDir, "notes");
  if (!existsSync(notesDir)) return [];
  return readdirSync(notesDir)
    .filter((file) => file.endsWith(".json"))
    .flatMap((file) => {
      try {
        const parsed = JSON.parse(readFileSync(join(notesDir, file), "utf8")) as BoardNoteFact;
        return [{ author: parsed.author, text: parsed.text }];
      } catch {
        return [];
      }
    });
}

/**
 * 父方 JSONL 里 dispatch_blackboard 的工具结果（信封 + 笔记）。
 * trust 来自信封——文件里自报的 trust 不作数。
 */
function parentBoardNotes(stdout: string): BoardNoteFact[] {
  for (const line of stdout.split("\n")) {
    if (!line.includes("tool_execution_end")) continue;
    let event: {
      toolName?: string;
      result?: { content?: Array<{ type?: string; text?: string }> };
    };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    if (event.toolName !== "dispatch_blackboard") continue;
    const text = event.result?.content?.[0]?.text;
    if (typeof text !== "string") continue;
    try {
      const parsed = JSON.parse(text) as { trust?: string; notes?: BoardNoteFact[] };
      if (!Array.isArray(parsed.notes)) continue;
      return parsed.notes.map((note) => ({
        author: note.author,
        text: note.text,
        trust: parsed.trust,
      }));
    } catch {
      // 不是我们的信封——继续找下一条
    }
  }
  return [];
}

function dispatchStorageRoot(): string {
  return (process.env.HOME ?? "~") + "/.pi/dispatch";
}

function bucketFor(projectDir: string): string {
  // macOS 的 /var 是 /private/var 的符号链接——node 的 realpath 会解析成 /private/...，
  // 与 pi 拼桶名时用同一条 resolved 路径才一致
  const resolved = projectDir.startsWith("/var/") ? `/private${projectDir}` : projectDir;
  return `--${resolved.replace(/^\//, "").replace(/[\\/:\s]+/g, "-")}--`;
}

/** 读桶里全部任务记录；没有就是空数组（退回时正好应为空）。 */
function readRecords(projectDir: string): TaskRecord[] {
  const dir = join(dispatchStorageRoot(), bucketFor(projectDir), "records");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => {
      try {
        return [JSON.parse(readFileSync(join(dir, f), "utf8")) as TaskRecord];
      } catch {
        return [];
      }
    });
}

/** 孩子的输出日志（工具声明在里面）；读不到给空串。 */
function readChildLog(record: TaskRecord | undefined): string {
  if (!record?.outputPath || !existsSync(record.outputPath)) return "";
  try {
    return readFileSync(record.outputPath, "utf8");
  } catch {
    return "";
  }
}

async function caseDispatch(mode: "print" | "json"): Promise<void> {
  await withTempProject(async (dir) => {
    const prompt =
      "Use the dispatch_task tool to dispatch a subagent with taskDescription " +
      '"Read the file /etc/hosts and report how many lines it has, just the number". ' +
      "The dispatch_task tool returns a result; report exactly what it says.";
    await runPrintLike(mode, prompt, dir);
    const records = readRecords(dir);
    const record = records[0];
    const v = judgeDispatch(record);
    report(mode, "子代理跑完并交回正文", v.ok, v.detail);
    report(mode, "记录落盘", records.length === 1, `记录数=${records.length}`);
  });
}

async function caseReject(mode: "print" | "json"): Promise<void> {
  await withTempProject(async (dir) => {
    const prompt =
      'Use the dispatch_task tool with taskDescription "--help". ' +
      "Report whether it was rejected (status rejected) or accepted.";
    await runPrintLike(mode, prompt, dir);
    const v = judgeReject(readRecords(dir));
    report(mode, "任务以横线开头被退回（不留记录）", v.ok, v.detail);
  });
}

async function caseAllowScripts(mode: "print" | "json"): Promise<void> {
  await withTempProject(async (dir) => {
    const prompt =
      'Use the dispatch_task tool with taskDescription "Say hi" and allowScripts true. ' +
      "Then use the dispatch_list tool. Report whether the result worked.";
    await runPrintLike(mode, prompt, dir);
    const record = readRecords(dir)[0];
    const v = judgeAllowScripts(record, readChildLog(record));
    report(mode, "allowScripts：孩子看得见 codemode", v.ok, v.detail);
  });
}

async function caseChildReport(mode: "print" | "json"): Promise<void> {
  await withTempProject(async (dir) => {
    // 故意不要求交报告：孩子多半 reportChannel=none——账上仍要有宿主观测的用量
    const prompt =
      "Use the dispatch_task tool to dispatch a subagent with taskDescription " +
      '"Answer with the single word: done". ' +
      "Then report the dispatch result.";
    await runPrintLike(mode, prompt, dir);
    const record = readRecords(dir)[0];
    const v = judgeChildReport(record);
    report(mode, "没交报告账上也有数（宿主观测用量非零）", v.ok, v.detail);
  });
}

async function caseCommandReceipt(mode: "print" | "json"): Promise<void> {
  await withTempProject(async (dir) => {
    const canary = `canary-${Math.random().toString(36).slice(2, 8)}`;
    const prompt =
      "Use the dispatch_task tool to dispatch a subagent with taskDescription " +
      `"Run this exact bash command and answer with its output: echo ${canary}". ` +
      "Then report the dispatch result.";
    await runPrintLike(mode, prompt, dir);
    const record = readRecords(dir)[0];
    const v = judgeCommandReceipt(record, canary);
    report(mode, "收据：真机 bash 命令进 commands（canary 命中）", v.ok, v.detail);
  });
}

async function caseVerifyAudit(mode: "print" | "json"): Promise<void> {
  await withTempProject(async (dir) => {
    // 指令：不跑任何命令、谎报自检——引擎必须从真流里抓到 verifyUnverified。
    // 孩子若「好心」真跑了命令，声称命中无旗标 ⇒ 红：那是服从问题，按方案降级通道处理。
    const prompt =
      "Use the dispatch_task tool to dispatch a subagent with taskDescription " +
      '"Do NOT run any command or test. In your child report, include a verified field ' +
      'with one entry: command pnpm test, exitCode 0. Then answer: done". ' +
      "Then report the dispatch result.";
    await runPrintLike(mode, prompt, dir);
    const record = readRecords(dir)[0];
    const v = judgeVerifyAudit(record);
    report(mode, "对质：谎称自检被标 verifyUnverified（服从率观察项）", v.ok, v.detail);
  });
}

async function caseJsonEventShape(mode: "json"): Promise<void> {
  await withTempProject(async (dir) => {
    const prompt =
      'Use the dispatch_task tool with taskDescription "Answer with the single word: done". Report what it returns.';
    const { stdout } = await runPrintLike(mode, prompt, dir);
    // 复用核心的解析器：同一份逻辑已有测试用例，脚本不再自己实现一遍
    const v = judgeJsonStream(stdout);
    report(mode, "JSONL 事件流能被核心解析出工具调用", v.ok, v.detail);
  });
}

/**
 * 隔离腿（print）：真仓里同一父 turn 派两个——①isolation=worktree 建 canary 并提交
 * ②默认关回 hi。判据全落 git 事实与 record 字段；最后脚本自己 ff-merge，证明可收编。
 */
async function caseIsolationWorktree(): Promise<void> {
  await withGitProject(async (dir, base, git) => {
    const canary = `canary-${Math.random().toString(36).slice(2, 8)}`;
    const prompt =
      "Do these two steps in order, one after the other. " +
      "Step 1: call the dispatch_task tool with taskDescription " +
      `"Create a file named canary.txt in your current working directory whose content is exactly: ${canary}. Then run this bash command: git add canary.txt && git commit -m canary. Answer with the single word: done" ` +
      'and isolation "worktree". ' +
      'Step 2: call the dispatch_task tool with taskDescription "Answer with the single word: hi". ' +
      "Then report both results briefly.";
    const { stdout } = await runPrintLike("print", prompt, dir, 300_000);
    const records = readRecords(dir);
    const isolated = records.find((record) => record.isolation === "worktree");
    const plain = records.find((record) => record.isolation === undefined);
    const worktreePath = isolated?.worktree?.path ?? "";

    const worktreeDirExists = worktreePath !== "" && existsSync(worktreePath);
    const worktreeGitIsFile = worktreeDirExists && isFile(join(worktreePath, ".git"));
    const canaryInWorktree = readTextIfExists(join(worktreePath, "canary.txt")).includes(canary);
    const canaryInParent = readTextIfExists(join(dir, "canary.txt")).includes(canary);
    // 先取父仓事实，再做 ff-merge（merge 会把父 HEAD 往前推）
    const parentHead = git(["rev-parse", "HEAD"]).trim();
    const parentStatus = git(["status", "--porcelain"]);
    let mergeOk = false;
    let mergedCanary = false;
    if (isolated?.worktree?.branch) {
      try {
        git(["merge", "--ff-only", isolated.worktree.branch]);
        mergeOk = true;
      } catch {
        mergeOk = false;
      }
      mergedCanary = readTextIfExists(join(dir, "canary.txt")).includes(canary);
    }

    const v = judgeWorktreeIsolation(isolated, {
      base,
      worktreeDirExists,
      worktreeGitIsFile,
      canaryInWorktree,
      canaryInParent,
      parentHead,
      parentStatus,
      mergeOk,
      mergedCanary,
    });
    report(
      "isolation",
      "隔离：独立 worktree / 分支 / 观测 / 父仓不动 / ff-merge 可收编",
      v.ok,
      v.detail,
    );
    const d = judgeDefaultOffUntouched(plain, countDirectories(worktreesDirFor(dir)));
    report("isolation", "默认关：记录无新键、worktrees 下只含隔离那一个", d.ok, d.detail);
    if (!v.ok || !d.ok) console.log(`    父方输出尾部：${stdout.slice(-400)}`);
  });
}

/**
 * 黑板腿（json）：同一父会话依次派 A（写 canary）与 B（读并复述），父方自己再读一次。
 * 判据看两块 record 的板号、读写收据、板上署名的 canary，以及父方工具结果的 trust 信封。
 */
async function caseBlackboardExchange(): Promise<void> {
  await withGitProject(async (dir) => {
    const canary = `board-${Math.random().toString(36).slice(2, 8)}`;
    const prompt =
      "Do these three steps in order, one after the other. " +
      "Step 1: call the dispatch_task tool with taskDescription " +
      `"Call the blackboard_write tool with exactly this text: ${canary}. Then answer: posted" ` +
      "and blackboard true. " +
      "Step 2: call the dispatch_task tool with taskDescription " +
      '"Call the blackboard_read tool to read the shared blackboard. Reply quoting the message text you read and its author." ' +
      "and blackboard true. " +
      "Step 3: call the dispatch_blackboard tool yourself, then report the trust value you saw and the notes.";
    const { stdout } = await runPrintLike("json", prompt, dir, 300_000);
    const records = readRecords(dir);
    const writer = records.find((record) => (record.delivery?.tools?.blackboard_write ?? 0) >= 1);
    const reader = records.find(
      (record) => record.id !== writer?.id && (record.delivery?.tools?.blackboard_read ?? 0) >= 1,
    );
    const boardDir = writer?.blackboard?.path ?? reader?.blackboard?.path ?? "";
    const diskNotes = boardDir === "" ? [] : readBoardNoteFiles(boardDir);
    const v = judgeBlackboardExchange(writer, reader, parentBoardNotes(stdout), canary);
    report(
      "blackboard",
      "黑板往返：同板号 / 署名 canary / trust 未核实 / 读写收据",
      v.ok,
      `${v.detail}；落盘笔记=${diskNotes.length}`,
    );
    if (!v.ok) console.log(`    父方输出尾部：${stdout.slice(-400)}`);
  });
}

/** 非 git 拒绝腿（print）：假 .git 目录（旧夹具）派 isolation ⇒ 闸在铸 id 前退回，零记录。 */
async function caseIsolationRejected(): Promise<void> {
  await withTempProject(async (dir) => {
    const prompt =
      'Use the dispatch_task tool with taskDescription "Say hi" and isolation "worktree". ' +
      "Report whether it was rejected, and why.";
    await runPrintLike("print", prompt, dir);
    const v = judgeWorktreeRejected(readRecords(dir));
    report("isolation", "非 git 仓：isolation 被拒（零记录）", v.ok, v.detail);
  });
}

/** RPC 模式：长驻进程，stdin 发 prompt，等终态通知。 */
async function caseRpcDispatch(): Promise<void> {
  await withTempProject(async (dir) => {
    const child = spawn("pi", ["--mode", "rpc", "--no-session", "-e", EXT], {
      cwd: dir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let sawToolEnd = false;
    child.stdout.on("data", (c) => {
      const text = String(c);
      stdout += text;
      if (text.includes('"type":"tool_execution_end"')) sawToolEnd = true;
    });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += String(c)));

    // 发 prompt 让宿主调 dispatch_task（子代理任务要轻——读 /etc/hosts 要数行、慢，
    // 第一个 turn 的工具往返会先回，子代理后台跑；终态通知在下一个 turn 边界投递）
    const prompt = JSON.stringify({
      id: "v1",
      type: "prompt",
      message:
        'Use the dispatch_task tool with taskDescription "Say hi". Report the taskId it returned.',
    });
    child.stdin.write(prompt + "\n");

    // 等父方首个 run 与孩子终态，再开 drain run；固定 sleep 会低估真模型的排队与工具时间。
    await waitUntil(() => sawToolEnd, 60_000);
    await waitUntil(() => stdout.includes('"type":"agent_end"'), 60_000);
    await waitUntil(() => readRecords(dir).some((record) => isTerminal(record.status)), 90_000);
    child.stdin.write(
      JSON.stringify({ id: "v2", type: "prompt", message: "Now just reply with the word: ok" }) +
        "\n",
    );
    await waitUntil(() => (stdout.match(/"type":"agent_end"/g)?.length ?? 0) >= 2, 60_000);

    // 正常只需 v2：孩子已在它开始前终态。若通知仍未到，再用下一回合诊断性 drain 一次。
    if (!stdout.includes("dispatch-notifications")) {
      child.stdin.write(
        JSON.stringify({
          id: "v3",
          type: "prompt",
          message: "Now just reply with the word: done",
        }) + "\n",
      );
    }

    // 等终态通知（dispatch-notifications custom 消息）；跨 chunk 到达也能看见。
    const done = await waitUntil(() => stdout.includes("dispatch-notifications"), 60_000);
    child.kill("SIGKILL");
    const v = judgeRpc(sawToolEnd, done);
    report("rpc", "异步派发 + 工具往返 + 终态通知送达", v.ok, v.detail);
  });
}

/** 引擎腿：真 pi 孩子 sleep 时直接调 engine.steer，证据走真实 stdout 对账。 */
async function caseEngineSteer(): Promise<void> {
  await withTempProject(async (dir) => {
    const storage = new Storage(join(dir, ".pi-dispatch"), dir);
    const registry = new TaskRegistry();
    const engine = new TaskEngine({
      registry,
      storage,
      childExtensionPath: EXT,
      hostMode: "long-lived",
    });
    const handle = await engine.dispatch({
      task: "Run the bash command `sleep 12`, then reply with exactly the word DONE",
    });
    if (!("taskId" in handle)) {
      report("steer", "引擎腿拿到任务", false, "派发被拒");
      return;
    }
    const taskId = handle.taskId;
    const running = await waitUntil(() => registry.get(taskId)?.status === "running", 30_000);
    report("steer", "引擎腿任务进入 running", running, taskId);
    const planned = await engine.steer(
      taskId,
      "After the sleep finishes, reply exactly STEERED instead of DONE.",
    );
    report(
      "steer",
      "引擎腿受理转向",
      planned.ok,
      planned.ok ? `seq=${planned.seq}` : planned.error,
    );
    await waitUntil(() => {
      const status = registry.get(taskId)?.status;
      return status === "succeeded" || status === "failed" || status === "lost";
    }, 90_000);
    const record = registry.get(taskId);
    const v = judgeSteer(record, readChildLog(record));
    report("steer", "引擎腿转向送达并生效", v.ok, v.detail);
    await engine.shutdown();
  });
}

/** 隔离 + 转向：真 worktree 孩子的 sleep 中途 steer，父仓保持干净。 */
async function caseSteerIsolated(): Promise<void> {
  await withGitProject(async (dir, _base, git) => {
    // 留痕放仓外：父仓必须保持干净，否则隔离腿自己把父仓弄脏。
    const store = join(dir, "..", `${dir.split("/").pop()}-store`);
    const storage = new Storage(store, dir);
    const registry = new TaskRegistry();
    const engine = new TaskEngine({
      registry,
      storage,
      childExtensionPath: EXT,
      hostMode: "long-lived",
      repoRoot: dir,
      isGitRepo: () => true,
    });
    const handle = await engine.dispatch({
      task: "Run the bash command `sleep 12`, then reply with exactly the word DONE",
      isolation: "worktree",
    });
    if (!("taskId" in handle)) {
      report("steer-iso", "隔离腿拿到任务", false, "派发被拒");
      return;
    }
    const taskId = handle.taskId;
    const running = await waitUntil(() => registry.get(taskId)?.status === "running", 30_000);
    report("steer-iso", "隔离腿任务进入 running", running, taskId);
    const planned = await engine.steer(
      taskId,
      "After the sleep finishes, reply exactly STEERED instead of DONE.",
    );
    report(
      "steer-iso",
      "隔离腿受理转向",
      planned.ok,
      planned.ok ? `seq=${planned.seq}` : planned.error,
    );
    await waitUntil(() => {
      const status = registry.get(taskId)?.status;
      return status === "succeeded" || status === "failed" || status === "lost";
    }, 120_000);
    const record = registry.get(taskId);
    const steer = judgeSteer(record, readChildLog(record));
    const worktreePath = record?.worktree?.path ?? "";
    const worktreeOk = worktreePath !== "" && existsSync(worktreePath);
    const parentClean = git(["status", "--porcelain"]).trim() === "";
    report(
      "steer-iso",
      "隔离腿转向送达且父仓干净",
      steer.ok && worktreeOk && parentClean,
      `${steer.detail}; worktree=${worktreeOk} parentClean=${parentClean}`,
    );
    await engine.shutdown();
  });
}

/**
 * TUI 腿的 pty+pyte 驱动：真 pty 起 pi TUI，管道喂 prompt + 显式 \r 提交（管道换行不提交），
 * pyte 重建屏幕帧，轮询断言常驻面板出现过（sawWidget）且跑完清掉（sawClear）。
 * 程序与证据见 ai-memory procedures/real-pi-tui-verification-via-pty。
 */
const TUI_DRIVER = String.raw`import fcntl, json, os, pty, select, struct, subprocess, sys, termios, time

import pyte

ext, cwd, prompt = sys.argv[1], sys.argv[2], sys.argv[3]
ROWS, COLS = 40, 120
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
proc = subprocess.Popen(
    ["pi", "--no-session", "-ne", "-e", ext],
    cwd=cwd, stdin=slave, stdout=slave, stderr=slave, close_fds=True,
)
os.close(slave)
screen = pyte.Screen(COLS, ROWS)
stream = pyte.Stream(screen)
saw_widget = False
saw_clear = False
clear_streak = 0
sent_prompt = False
sent_cr = False
tail = b""
start = time.time()
while time.time() - start < 150:
    r, _, _ = select.select([master], [], [], 0.5)
    if r:
        try:
            data = os.read(master, 65536)
        except OSError:
            break
        if not data:
            break
        tail = (tail + data)[-65536:]
        stream.feed(data.decode("utf-8", "ignore"))
    elapsed = time.time() - start
    if not sent_prompt and elapsed >= 3:
        os.write(master, prompt.encode("utf-8"))
        sent_prompt = True
    if not sent_cr and elapsed >= 5:
        os.write(master, b"\r")
        sent_cr = True
    text = "\n".join(screen.display)
    if "派单" in text and "在飞" in text:
        saw_widget = True
    if saw_widget:
        clear_streak = clear_streak + 1 if "派单" not in text else 0
        if clear_streak >= 3:
            saw_clear = True
            break
try:
    proc.terminate()
    proc.wait(timeout=3)
except Exception:
    try:
        proc.kill()
    except Exception:
        pass
try:
    os.close(master)
except Exception:
    pass
print(json.dumps({"sawWidget": saw_widget, "sawClear": saw_clear, "tail": tail.decode("utf-8", "ignore")[-2000:]}))
`;

function runTuiDriver(
  cwd: string,
  prompt: string,
): Promise<{ sawWidget: boolean; sawClear: boolean; tail: string }> {
  return new Promise((resolve) => {
    const child = spawn("python3", ["-c", TUI_DRIVER, EXT, cwd, prompt], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ sawWidget: false, sawClear: false, tail: `[driver 超时] ${stderr.slice(-400)}` });
    }, 180_000);
    child.on("close", () => {
      clearTimeout(timer);
      const line = stdout.trim().split("\n").at(-1) ?? "";
      try {
        const parsed = JSON.parse(line) as { sawWidget: boolean; sawClear: boolean; tail: string };
        resolve({ ...parsed, tail: `${parsed.tail}${stderr.slice(-400)}` });
      } catch {
        resolve({
          sawWidget: false,
          sawClear: false,
          tail: `${stdout.slice(-800)}${stderr.slice(-400)}`,
        });
      }
    });
  });
}

/** TUI /steer 腿：真 pty 里跑斜杠命令，屏幕出现回执后再看真实收据。 */
const TUI_STEER_DRIVER = String.raw`import fcntl, json, os, pty, select, struct, subprocess, sys, termios, time

import pyte

ext, cwd = sys.argv[1], sys.argv[2]
ROWS, COLS = 40, 120
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
proc = subprocess.Popen(
    ["pi", "--no-session", "-ne", "-e", ext],
    cwd=cwd, stdin=slave, stdout=slave, stderr=slave, close_fds=True,
)
os.close(slave)
screen = pyte.Screen(COLS, ROWS)
stream = pyte.Stream(screen)
saw_accepted = False
tail = b""
sent_prompt = sent_cr = sent_steer = sent_steer_cr = False
start = time.time()
while time.time() - start < 180:
    r, _, _ = select.select([master], [], [], 0.5)
    if r:
        try:
            data = os.read(master, 65536)
        except OSError:
            break
        if not data:
            break
        tail = (tail + data)[-65536:]
        stream.feed(data.decode("utf-8", "ignore"))
    elapsed = time.time() - start
    if not sent_prompt and elapsed >= 3:
        text = 'Use the dispatch_task tool with taskDescription "Run the bash command sleep 12, then reply with exactly the word DONE". Report the taskId it returned.'
        os.write(master, text.encode("utf-8")); sent_prompt = True
    if not sent_cr and elapsed >= 5:
        os.write(master, b"\r"); sent_cr = True
    if not sent_steer and elapsed >= 9:
        os.write(master, b"/steer After the sleep finishes, reply exactly STEERED instead of DONE.")
        sent_steer = True
    if not sent_steer_cr and elapsed >= 10:
        os.write(master, b"\r"); sent_steer_cr = True
    screen_text = "\n".join(screen.display)
    if "已受理" in screen_text:
        saw_accepted = True
    if saw_accepted and elapsed >= 30:
        break
try:
    proc.terminate(); proc.wait(timeout=3)
except Exception:
    try: proc.kill()
    except Exception: pass
try: os.close(master)
except Exception: pass
print(json.dumps({"sawAccepted": saw_accepted, "tail": tail.decode("utf-8", "ignore")[-2000:]}))
`;

function runTuiSteerDriver(cwd: string): Promise<{ sawAccepted: boolean; tail: string }> {
  return new Promise((resolve) => {
    const child = spawn("python3", ["-c", TUI_STEER_DRIVER, EXT, cwd], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ sawAccepted: false, tail: `[driver 超时] ${stderr.slice(-400)}` });
    }, 240_000);
    child.on("close", () => {
      clearTimeout(timer);
      const line = stdout.trim().split("\n").at(-1) ?? "";
      try {
        const parsed = JSON.parse(line) as { sawAccepted: boolean; tail: string };
        resolve({ ...parsed, tail: `${parsed.tail}${stderr.slice(-400)}` });
      } catch {
        resolve({ sawAccepted: false, tail: `${stdout.slice(-800)}${stderr.slice(-400)}` });
      }
    });
  });
}

async function caseTuiSteer(): Promise<void> {
  await withTempProject(async (dir) => {
    try {
      execFileSync("python3", ["-c", "import pyte"], { stdio: "ignore" });
    } catch {
      report("tui-steer", "TUI /steer 真机腿", true, "跳过：python3 缺 pyte", true);
      return;
    }
    const result = await runTuiSteerDriver(dir);
    report(
      "tui-steer",
      "斜杠命令回执上屏",
      result.sawAccepted,
      result.sawAccepted ? "" : result.tail.slice(-400),
    );
    const record = readRecords(dir)
      .filter((item) => item.task.includes("sleep 12"))
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
    if (!record) {
      report("tui-steer", "真机转向收据", false, "没找到任务记录");
      return;
    }
    await waitUntil(() => {
      const status = readRecords(dir).find((item) => item.id === record.id)?.status;
      return status === "succeeded" || status === "failed" || status === "lost";
    }, 90_000);
    const latest = readRecords(dir).find((item) => item.id === record.id);
    const verdict = judgeSteer(latest, readChildLog(latest));
    report("tui-steer", "真机转向收据", verdict.ok, verdict.detail);
  });
}

/** TUI 模式：真 pty 起 pi TUI，pyte 重建屏幕帧，断言常驻面板「出现过、跑完清掉」。 */
async function caseTuiDispatch(): Promise<void> {
  await withTempProject(async (dir) => {
    try {
      execFileSync("python3", ["-c", "import pyte"], { stdio: "ignore" });
    } catch {
      report("tui", "在飞状态上过屏", true, "跳过：python3 缺 pyte（pip3 install pyte）", true);
      report("tui", "跑完面板即清", true, "跳过：python3 缺 pyte（pip3 install pyte）", true);
      return;
    }
    const prompt =
      'Use the dispatch_task tool with taskDescription "Say hi". Report the taskId it returned.';
    const result = await runTuiDriver(dir, prompt);
    report(
      "tui",
      "在飞状态上过屏",
      result.sawWidget,
      result.sawWidget ? "" : `屏幕帧里没见面板；回放尾流：${result.tail.slice(-400)}`,
    );
    report(
      "tui",
      "跑完面板即清",
      result.sawClear,
      result.sawClear ? "" : `面板没清或没等全；回放尾流：${result.tail.slice(-400)}`,
    );
  });
}

async function main(): Promise<void> {
  // 从派发子代理里启动时，继承深度会把所有父 pi 误装成孩子，全部只留下“无记录”。
  const env = scrubbedEnv();
  for (const key of Object.keys(process.env)) {
    if (!(key in env)) delete process.env[key];
  }
  Object.assign(process.env, env);
  console.log("pi-dispatch 真机验收（print/json/rpc/tui + 隔离/黑板/非 git 拒绝）\n");
  // 确认扩展已构建
  if (!existsSync(EXT)) {
    console.error(`扩展产物不存在：${EXT}\n先跑 pnpm build`);
    process.exit(2);
  }
  // 确认 pi 可用
  try {
    execFileSync("pi", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    console.error("pi 不在 PATH 上");
    process.exit(2);
  }

  if (process.argv.includes("--tui-steer-only")) {
    await caseTuiSteer();
    const failed = RESULTS.filter((r) => !r.ok);
    if (failed.length > 0) process.exit(3);
    return;
  }

  if (process.argv.includes("--steer-iso-only")) {
    await caseSteerIsolated();
    const failed = RESULTS.filter((r) => !r.ok);
    if (failed.length > 0) process.exit(3);
    return;
  }

  if (process.argv.includes("--steer-only")) {
    await caseEngineSteer();
    const failed = RESULTS.filter((r) => !r.ok);
    if (failed.length > 0) process.exit(3);
    return;
  }

  if (process.argv.includes("--rpc-only")) {
    await caseRpcDispatch();
    const failed = RESULTS.filter((r) => !r.ok);
    if (failed.length > 0) process.exit(3);
    return;
  }

  await caseDispatch("print");
  await caseReject("print");
  await caseAllowScripts("print");
  await caseChildReport("print");
  await caseCommandReceipt("print");
  await caseVerifyAudit("print");
  console.log();
  await caseDispatch("json");
  await caseJsonEventShape("json");
  await caseReject("json");
  await caseCommandReceipt("json");
  await caseVerifyAudit("json");
  console.log();
  await caseIsolationWorktree();
  console.log();
  await caseBlackboardExchange();
  console.log();
  await caseIsolationRejected();
  console.log();
  await caseEngineSteer();
  console.log();
  await caseSteerIsolated();
  console.log();
  await caseRpcDispatch();
  console.log();
  await caseTuiDispatch();
  console.log();
  await caseTuiSteer();
  console.log();

  const failed = RESULTS.filter((r) => !r.ok);
  const skipped = RESULTS.filter((r) => r.skipped);
  console.log(
    `\n${RESULTS.length - failed.length - skipped.length}/${RESULTS.length - skipped.length} 通过` +
      (skipped.length ? `，${skipped.length} 跳过` : ""),
  );
  if (failed.length > 0) {
    console.log("失败：");
    for (const f of failed) console.log(`  ❌ [${f.mode}] ${f.case} — ${f.detail}`);
    process.exit(3);
  }
}

await main();
