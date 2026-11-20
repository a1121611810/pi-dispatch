#!/usr/bin/env node
// 四模式真机验收：print / json / rpc / tui 各起真 pi 进程 + 装本扩展 + 发指令 + 断言产出。
// 手动触发：pnpm test:mode
// 真模型调用，慢且花钱——不进 node --test 快腿。
// tui 腿另需 python3 + pyte（缺了跳过不判失败），用真 pty 重建屏幕帧断言常驻面板。
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import {
  judgeAllowScripts,
  judgeChildReport,
  judgeCommandReceipt,
  judgeDispatch,
  judgeJsonStream,
  judgeReject,
  judgeRpc,
  judgeVerifyAudit,
} from "./verdicts.ts";
import type { TaskRecord } from "../src/core/types.ts";

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
    const child = spawn("pi", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
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

/** RPC 模式：长驻进程，stdin 发 prompt，等终态通知。 */
async function caseRpcDispatch(): Promise<void> {
  await withTempProject(async (dir) => {
    const child = spawn("pi", ["--mode", "rpc", "--no-session", "-e", EXT], {
      cwd: dir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let sawToolEnd = false;
    let sawNotification = false;
    child.stdout.on("data", (c) => {
      const text = String(c);
      stdout += text;
      if (text.includes('"type":"tool_execution_end"')) sawToolEnd = true;
      if (text.includes("dispatch-notifications")) sawNotification = true;
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

    // 等父方工具往返（dispatch_task 返回，子代理已起）
    await waitUntil(() => sawToolEnd, 60_000);

    // 子代理在后台跑（"Say hi" 约 8 秒）。等它真的进终态——
    // 终态通知那时才进队列。给足时间，别在子代理没跑完时发 drain prompt。
    await new Promise((r) => setTimeout(r, 25_000));

    // 子代理在后台跑（"Say hi" 约 2 秒）。它可能在第二个 prompt 的 turn 里才结束——
    // 终态通知那时进队列，要在**再下一个** turn 边界才被 drain。
    // 实测：两个 prompt 不够（通知在 turn 2 结束才进队列，turn 2 的 turn_end 已过了），
    // 三个 prompt 稳。多发一个确保通知被投递。
    child.stdin.write(
      JSON.stringify({ id: "v2", type: "prompt", message: "Now just reply with the word: ok" }) +
        "\n",
    );
    await new Promise((r) => setTimeout(r, 12_000));
    child.stdin.write(
      JSON.stringify({ id: "v3", type: "prompt", message: "Now just reply with the word: done" }) +
        "\n",
    );

    // 等终态通知（dispatch-notifications custom 消息）
    const done = await waitUntil(() => sawNotification, 60_000);
    child.kill("SIGKILL");
    const v = judgeRpc(sawToolEnd, done);
    report("rpc", "异步派发 + 工具往返 + 终态通知送达", v.ok, v.detail);
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
  console.log("pi-dispatch 四模式真机验收\n");
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
  await caseRpcDispatch();
  console.log();
  await caseTuiDispatch();
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
