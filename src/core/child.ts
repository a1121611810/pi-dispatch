import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { BLACKBOARD_READ, BLACKBOARD_WRITE } from "./blackboard.ts";
import { steerSeqFromText, textOfContent, type SteerEvidence } from "./steer.ts";
import type { ChildDelivery, ChildReport, ChildUsage, Isolation, ReportChannel } from "./types.ts";

// 起子代理：拼命令 + spawn。
// 「子代理的话不可信，子代理的动作可信」——这里只负责让它跑起来并把原始输出接住。

/** stderr 只留尾巴：喷涌的输出会把主方的内存撑爆。 */
const STDERR_KEEP_CHARS = 64 * 1024;

/** 孩子 stdout 的内存上限，超了砍头留尾（报告和用量在最末尾）。 */
export const STDOUT_KEEP_CHARS = 16 * 1024 * 1024;

export interface ChildHandle {
  pid: number;
  onOutput(callback: (chunk: string) => void): void;
  onExit(callback: (exitCode: number, stderr: string) => void): void;
  kill(signal: NodeJS.Signals): void;
}

export type SpawnChild = (
  argv: string[],
  env: NodeJS.ProcessEnv,
  options?: { cwd?: string },
) => ChildHandle;

/**
 * 子进程以用户身份跑（信任姿态与所有 pi 扩展一致，无 OS 沙箱）。
 * 三条硬规矩：
 *   ① 听 close 不听 exit —— exit 会比管道里的数据先来，一来就收工，丢掉最后的报告和用量。
 *   ② 起不来要报错，不能崩 —— spawn 失败只发 error，不许抛未捕获异常把主方带走。
 *   ③ 退出可能早于你订阅 —— 晚订阅要补发一次退出码，否则会永远等不到。
 */
export function spawnChild(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  options?: { cwd?: string },
): ChildHandle {
  const child = spawn(argv[0]!, argv.slice(1), {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    // 不给 cwd 时**连键都不出现**：省掉一个假键，父方「共享目录」这件事就不被伪装成「指定了目录」。
    ...(options?.cwd ? { cwd: options.cwd } : {}),
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-STDERR_KEEP_CHARS);
  });
  // stdout 必须**无条件**排空：管道缓冲满了子进程会卡在写上面，永远不退出。
  // 订阅者只是「旁听」，没订阅时也不能让管道堵死（实测：不消费 stdout ⇒ close 事件不来）。
  const listeners: Array<(chunk: string) => void> = [];
  child.stdout.on("data", (chunk) => {
    const text = String(chunk);
    for (const listener of listeners) listener(text);
  });
  let exitCode: number | null = null;
  let onExit: ((code: number, stderr: string) => void) | undefined;
  // close 对「被信号杀死」的进程给 (null, signal)：按 POSIX 记 128+signo（SIGKILL=137、SIGTERM=143）；
  // 起不来（spawn error，code=-1）或信号不明才记 -1。
  const settle = (code: number | null, signal: NodeJS.Signals | null = null): void => {
    if (exitCode !== null) return;
    const signo = signal ? osConstants.signals[signal] : undefined;
    exitCode = code ?? (signo !== undefined ? 128 + signo : -1);
    onExit?.(exitCode, stderr);
  };
  // spawn 失败（ENOENT 等）只发 error 不发 exit：不监听会以未捕获异常崩掉宿主
  child.on("error", (error) => {
    stderr = `${stderr}spawn error: ${error.message}\n`.slice(-STDERR_KEEP_CHARS);
    settle(-1);
  });
  // close 等 stdio 流关闭后才触发；exit 可能早于管道尾部数据（报告/usage 会丢尾）
  child.on("close", (code, signal) => settle(code, signal));
  return {
    pid: child.pid ?? 0,
    onOutput: (callback) => {
      listeners.push(callback);
    },
    onExit: (callback) => {
      onExit = callback;
      if (exitCode !== null) callback(exitCode, stderr); // 订阅晚于退出：补发
    },
    kill: (signal) => {
      child.kill(signal);
    },
  };
}

/** 附加块：告诉子代理它是什么、交付物是什么。 */
export const SUBAGENT_CONTEXT_BLOCK = [
  "<pi-dispatch-context>",
  "你是被派出去的子代理：看不到父方的对话，你的最后一段话就是交付物。",
  "你的最终消息就是父方读到的东西——把结论写在正文里，不要只放在 JSON 块里。",
  "</pi-dispatch-context>",
].join("\n");

/** 块内吞用户原文的地方做实体转义——未转义的 <> 会伪造标签、破坏块边界。 */
function escapeXmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 回执工具名——契约块与解析器共用，别写两处。 */
export const CHILD_REPORT_TOOL_NAME = "child_report";

/**
 * 报告契约。刻意零 import——这里是契约的唯一持有者。
 * 报告是摘要，**交付物是正文**——不能把正文藏进 JSON 块。
 */
export const REPORT_CONTRACT_BLOCK = [
  "<child-report-contract>",
  `Before finishing, deliver a child report — preferably by calling the ${CHILD_REPORT_TOOL_NAME} tool (its schema fixes the shape); if that tool is not available, put a fenced JSON block at the very end of your final message:`,
  "```json",
  '{ "summary": "one sentence conclusion", "why": "why you conclude so", "assessment": "how it actually went", "findings": [{ "what": "claim", "evidence": "where it comes from" }], "files_touched": ["relative/path"], "verified": [{ "command": "pnpm test", "exitCode": 0 }], "usage": { "input": 0, "output": 0, "cost": 0, "turns": 0 } }',
  "```",
  "Rules: the report is a SUMMARY — it is NOT the deliverable. The deliverable is your prose answer, in exactly the format the task asked for; never hide the deliverable inside the JSON block.",
  'The report judges in three sections. "summary" = what you concluded (one sentence). "why" = why you conclude so — if your instructions contained a <pi-dispatch-why> block, take it as input (answer the parent\'s actual motive); otherwise reason from the task text alone. "assessment" = how the work actually went — quality judgment, problems hit, deviations, what remains unverified; its main anchor is the same: the why block if you received one, else the task text.',
  'Goodhart pin: "assessment" must name at least one concrete problem, risk, limitation, or thing to recheck. If it is uniformly positive, the parent treats the whole report as not delivered.',
  '"files_touched", "verified" and "usage" are a receipt for the parent\'s machine cross-check, not prose — keep them exact: files you actually touched, checks you actually ran (commands exactly as run).',
  "Do NOT write report/summary .md files — your final message is what the parent reads.",
  "findings/files_touched/verified/usage may be omitted when empty.",
  "</child-report-contract>",
].join("\n");

/**
 * 工具通道的入参形状——与契约块里的 JSON 例子一一对应。
 * pi 按它校验孩子的调用；父方从 toolResult 的 details.report 读回。
 */
export const CHILD_REPORT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "one sentence conclusion" },
    why: {
      type: "string",
      description:
        "why you conclude so — take the <pi-dispatch-why> block as input if you received one, else reason from the task text",
    },
    assessment: {
      type: "string",
      description:
        "how it actually went: quality judgment, problems hit, deviations, what remains unverified; must name at least one concrete problem/risk/limitation/recheck — uniformly positive is treated as not delivered",
    },
    findings: {
      type: "array",
      description: "load-bearing evidence only; omit this field when empty",
      items: {
        type: "object",
        properties: { what: { type: "string" }, evidence: { type: "string" } },
        required: ["what"],
      },
    },
    files_touched: {
      type: "array",
      description: "relative paths you touched; omit this field when empty",
      items: { type: "string" },
    },
    verified: {
      type: "array",
      description:
        "self-checks you ran before delivering (tests, typecheck, build); commands exactly as run; omit when none",
      items: {
        type: "object",
        properties: {
          command: { type: "string" },
          exitCode: { type: "number" },
        },
        required: ["command"],
      },
    },
    usage: {
      type: "object",
      description: "omit this field when empty",
      properties: {
        input: { type: "number" },
        output: { type: "number" },
        cost: { type: "number" },
        turns: { type: "number" },
      },
    },
  },
  required: ["summary", "why", "assessment"],
} as const;

/**
 * 隔离契约：孩子在一个独立工作区（git worktree）里干活。
 * 分支名由引擎掌握、孩子看不到 ⇒ 只说「独立工作区」，不写具体分支名
 * （写了一个猜的分支名，孩子会去动它）。
 */
export const WORKTREE_CONTRACT_BLOCK = [
  "<pi-dispatch-worktree>",
  "你在一个独立工作区（git worktree）里干活：当前目录不是父方的仓库目录，你的改动不会踩到父方的工作区。",
  "分支由父方掌握，你只管在当前分支上干活：交付前自己把改动 commit 在这个工作区里——父方靠提交收编你的产出。",
  "不要 push、不要 rebase、不要切分支、不要动父方的主分支：合并归父方。",
  "</pi-dispatch-worktree>",
].join("\n");

/** 拼附加块：上下文 +（可选）理由 +（可选）隔离契约 + 报告契约。 */
export function buildAppendBlock(options: { why?: string; isolation?: Isolation }): string {
  return [
    SUBAGENT_CONTEXT_BLOCK,
    options.why ? `<pi-dispatch-why>${escapeXmlText(options.why)}</pi-dispatch-why>` : "",
    options.isolation === "worktree" ? WORKTREE_CONTRACT_BLOCK : "",
    REPORT_CONTRACT_BLOCK,
  ]
    .filter(Boolean)
    .join("\n");
}

/** 只读档位的读集。 */
export const READ_ONLY_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];

export interface BuildArgvOptions {
  task: string;
  why?: string;
  model?: string;
  thinkingLevel?: string;
  readOnly?: "strict" | "lenient";
  projectContext?: "auto" | "none";
  /** 子代理能不能写脚本批量调工具。 */
  allowScripts?: boolean;
  /** 隔离档位。给了 worktree 就追加隔离契约段（cwd 由引擎用 spawn 第三参给）。 */
  isolation?: Isolation;
  /** 要不要开共享黑板。开了 strict 档也放行黑板那两个工具（唯一的白名单例外）。 */
  blackboard?: boolean;
  /** 孩子自己的扩展文件路径——用 -e 装进孩子，回执工具才在。 */
  childExtensionPath?: string;
  /** 会话当前模型（调用没给时的回落）。 */
  sessionModel?: string;
  /** pi 版本——--no-mcp 只在 1.1.0 之后有。 */
  piVersion?: string;
  /** pi 可执行文件。默认走 PATH 里的 pi。 */
  piPath?: string;
}

/** 空串是坏值（会变成 `--model ""`），当没给处理。 */
function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim() !== "" ? value : undefined;
}

/**
 * --no-mcp 出现于 pi 1.1.0；解不出版本按不支持处理（发了会报错）。
 */
export function supportsNoMcp(piVersion?: string): boolean {
  if (!piVersion) return false;
  const [major = "0", minor = "0"] = piVersion.trim().replace(/^v/, "").split(".");
  const M = Number.parseInt(major, 10);
  const m = Number.parseInt(minor, 10);
  if (Number.isNaN(M) || Number.isNaN(m)) return false;
  return M > 1 || (M === 1 && m >= 1);
}
/**
 * 拼子代理的命令行。
 * 每一段都有理由（规格第 10 节）：
 *   -p --no-session --mode json  不留磁盘状态；输出是机器能读的事件流
 *   --append-system-prompt       挂附加块，告诉孩子它是什么、交付物是什么
 *   --no-extensions --no-skills  减重：砍掉自动发现带进孩子的散文与技能
 *   -e builtin:codemode          allowScripts 时把写程序的能力显式带进来
 *   --tools 名单                 只读档位收窄；带 codemode 才不会被名单砍掉
 *   任务放最后                   任务不能以横线开头（安检已经拦过）
 */
export function buildPiArgv(options: BuildArgvOptions): string[] {
  const argv = [nonEmpty(options.piPath) ?? "pi", "-p", "--no-session", "--mode", "json"];
  argv.push("--append-system-prompt", buildAppendBlock(options));
  // 减量：砍自动发现带进孩子的宿主面散文与技能
  argv.push("--no-extensions", "--no-skills");
  // 回执工具：把本扩展自己装进孩子（显式 -e 不受 --no-extensions 影响）
  if (options.childExtensionPath) argv.push("-e", options.childExtensionPath);
  // 孩子的固定税一大块：项目上下文（AGENTS.md/CLAUDE.md）
  if (options.projectContext === "none") argv.push("--no-context-files");
  if (supportsNoMcp(options.piVersion)) argv.push("--no-mcp");
  // 解析序：调用参数 → 会话当前模型；思考档位挂 :<thinking> 后缀
  // 空串是坏值（会变成 --model ""），当没给处理
  const model = nonEmpty(options.model) ?? nonEmpty(options.sessionModel);
  if (model) {
    const thinking = nonEmpty(options.thinkingLevel);
    argv.push("--model", thinking ? `${model}:${thinking}` : model);
  }
  argv.push(...strictToolsArgv(options));
  // allowScripts：命令行显式给的扩展不受 --no-extensions 影响 ⇒ 减量效果不丢
  if (options.allowScripts) argv.push("-e", "builtin:codemode");
  argv.push(options.task);
  return argv;
}

/**
 * 只读档位的工具名单；非 strict 不收窄——收窄会把 bash/edit/write 全砍掉。
 * allowScripts 时读集里必须含 codemode，否则「能力进来了也调不到」
 * （实测：--tools 白名单会砍掉没列进去的扩展工具）。
 * 黑板是唯一的例外：strict 档也放行黑板那两个工具——只读子代理要能跟兄弟交换信息。
 */
function strictToolsArgv(options: BuildArgvOptions): string[] {
  if (options.readOnly !== "strict") return [];
  const tools = [
    ...READ_ONLY_TOOLS,
    CHILD_REPORT_TOOL_NAME,
    ...(options.allowScripts ? ["codemode"] : []),
    ...(options.blackboard ? [BLACKBOARD_READ, BLACKBOARD_WRITE] : []),
  ];
  return ["--tools", tools.join(",")];
}

/** 从 pi 的事件流里抽出来的东西。 */
export interface ParsedChildStream {
  /** 最后一条 assistant 消息的文本部分（「最后一段胜出」） */
  text: string;
  /** 工具通道读到的报告 */
  toolReport: ChildReport | null;
  /** 宿主侧 message_end 上报的 usage */
  observedUsage: ChildUsage | null;
  /** 所有轮次的用量合计（每轮 usage 是单次请求量，账要按累计算） */
  observedUsageTotal: ChildUsage | null;
  /** 流里实测到的孩子模型/provider */
  observedModel: string | null;
  observedProvider: string | null;
  /** 孩子的真实工具轨迹——父核对结论用，不靠模型自述 */
  delivery: ChildDelivery;
  /** 运行中转向的投递证据（queue_update → user 回显 → assistant） */
  steerEvidence: SteerEvidence;
}

/** 路径清单上限：父面只看前几条，超出部分不记。 */
const MAX_PATHS = 20;

/** 命令清单上限：留最近 N 条——对质关心的是交付前跑没跑。 */
const MAX_COMMANDS = 20;
/** 单条命令保留长度：超长截尾。匹配方向是「声称 ⊆ 观测」，截观测的尾不伤命中。 */
const COMMAND_KEEP_CHARS = 500;

/** 事件流的累积器。解析分四个小家，各自只碰自己那部分。 */
interface StreamAcc {
  text: string;
  toolReport: ChildReport | null;
  observedUsage: ChildUsage | null;
  /** 所有轮次的用量合计（每轮 usage 是单次请求量，账要按累计算） */
  usageTotal: ChildUsage | null;
  observedModel: string | null;
  observedProvider: string | null;
  tools: Record<string, number>;
  paths: string[];
  commands: string[];
  errors: number;
  queuedSteers: Array<{ seq: number; line: number }>;
  deliveredSteers: Array<{ seq: number; line: number }>;
  seenSteers: Array<{ seq: number; line: number }>;
  /** user 回显后还没等到 assistant 的 seq */
  pendingSeen: number[];
  reportLine?: number;
}

/** 事件流里只关心这几种形状。 */
interface StreamEvent {
  type?: string;
  message?: {
    role?: string;
    toolName?: string;
    model?: string;
    provider?: string;
    content?: Array<{ type?: string; text?: string }>;
    usage?: {
      input?: number;
      output?: number;
      cost?: { total?: number } | number;
      cacheRead?: number;
      cacheWrite?: number;
    };
    structuredContent?: unknown;
    details?: unknown;
  };
  toolName?: string;
  args?: { path?: unknown; command?: unknown };
  isError?: boolean;
  result?: { isError?: boolean };
  steering?: unknown;
}

function emptyStreamAcc(): StreamAcc {
  return {
    text: "",
    toolReport: null,
    observedUsage: null,
    usageTotal: null,
    observedModel: null,
    observedProvider: null,
    tools: {},
    paths: [],
    commands: [],
    errors: 0,
    queuedSteers: [],
    deliveredSteers: [],
    seenSteers: [],
    pendingSeen: [],
  };
}

function evidenceOf(acc: StreamAcc): SteerEvidence {
  return {
    queued: acc.queuedSteers,
    delivered: acc.deliveredSteers,
    seen: acc.seenSteers,
    ...(acc.reportLine !== undefined ? { reportLine: acc.reportLine } : {}),
  };
}

/** 记一条碰过的路径：只收文件类工具给的 args.path，去重、有上限。 */
function recordPath(args: { path?: unknown } | undefined, paths: string[]): void {
  const path = args?.path;
  if (typeof path !== "string" || !path) return;
  if (paths.includes(path) || paths.length >= MAX_PATHS) return;
  paths.push(path);
}

/** 记一条跑过的命令：只收 bash——只有它的效果就是命令行（codemode 最终也走 bash 执行）。原样记串不解析；保最近 N 条（交付前的验证命令在尾部）。 */
function recordCommand(
  toolName: string,
  args: { command?: unknown } | undefined,
  commands: string[],
): void {
  if (toolName !== "bash") return;
  const command = args?.command;
  if (typeof command !== "string" || !command) return;
  const kept =
    command.length > COMMAND_KEEP_CHARS ? `${command.slice(0, COMMAND_KEEP_CHARS)}…` : command;
  if (commands.includes(kept)) return;
  commands.push(kept);
  if (commands.length > MAX_COMMANDS) commands.shift();
}

/** 工具轨迹：start 计次并记路径/命令，end 计错。 */
function takeToolEvent(event: StreamEvent, acc: StreamAcc): void {
  if (event.type === "tool_execution_start") {
    const name = typeof event.toolName === "string" ? event.toolName : "unknown";
    acc.tools[name] = (acc.tools[name] ?? 0) + 1;
    // 路径只收文件类工具的 args.path（bash 的 args 没有 path）；命令串走 recordCommand
    recordPath(event.args, acc.paths);
    recordCommand(name, event.args, acc.commands);
  } else if (event.type === "tool_execution_end") {
    if (event.isError === true || event.result?.isError === true) acc.errors++;
  }
}

/** 用量：自报的 cacheRead/cacheWrite/cost 缺省就不出键。 */
function takeUsage(usage: NonNullable<NonNullable<StreamEvent["message"]>["usage"]>): ChildUsage {
  const cost = typeof usage.cost === "number" ? usage.cost : usage.cost?.total;
  return {
    input: usage.input,
    output: usage.output,
    ...(usage.cacheRead !== undefined ? { cacheRead: usage.cacheRead } : {}),
    ...(usage.cacheWrite !== undefined ? { cacheWrite: usage.cacheWrite } : {}),
    ...(cost !== undefined ? { cost } : {}),
  };
}

/** assistant 消息：正文「最后一段胜出」，顺带记模型与用量。 */
function takeAssistant(message: NonNullable<StreamEvent["message"]>, acc: StreamAcc): void {
  // 工具回执的文本不能当正文——交付物只从 assistant 消息取
  if (message.role !== "assistant") return;
  if (typeof message.model === "string") acc.observedModel = message.model;
  if (typeof message.provider === "string") acc.observedProvider = message.provider;
  // content 形状随 pi 版本变：非数组按「没有文本」跳过
  const parts = Array.isArray(message.content) ? message.content : [];
  acc.text = parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text!)
    .join("\n");
  if (message.usage) {
    const usage = takeUsage(message.usage);
    acc.observedUsage = usage;
    // 正文取最后一条，用量要累加——每一轮都花了钱
    acc.usageTotal = addUsage(acc.usageTotal, usage);
  }
}

/** 用量累加：逐轮相加（每轮 usage 是单次请求量，不是累计值）。 */
function addUsage(total: ChildUsage | null, next: ChildUsage): ChildUsage {
  const sum = (a: number | undefined, b: number | undefined): number => (a ?? 0) + (b ?? 0);
  return {
    input: sum(total?.input, next.input),
    output: sum(total?.output, next.output),
    cacheRead: sum(total?.cacheRead, next.cacheRead),
    cacheWrite: sum(total?.cacheWrite, next.cacheWrite),
    cost: sum(total?.cost, next.cost),
  };
}

/** queue_update / steering 元素：字符串或 {text}；其余形状忽略。 */
function steerText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as { text?: unknown }).text === "string")
    return (value as { text: string }).text;
  return textOfContent(value);
}

/** queue_update：只记带标记的 seq；空队列不清已有证据。 */
function takeQueueUpdate(event: StreamEvent, acc: StreamAcc, line: number): void {
  const items = Array.isArray(event.steering) ? event.steering : [];
  for (const item of items) {
    const seq = steerSeqFromText(steerText(item));
    if (seq === undefined) continue;
    if (!acc.queuedSteers.some((entry) => entry.seq === seq)) acc.queuedSteers.push({ seq, line });
  }
}

/** user 回显：首行精确标记 + 该 seq 已进过 steering 队列才算送达（初始 prompt 伪造不算）。 */
function takeUserSteer(
  message: NonNullable<StreamEvent["message"]>,
  acc: StreamAcc,
  line: number,
): void {
  const seq = steerSeqFromText(textOfContent(message.content));
  if (seq === undefined) return;
  if (!acc.queuedSteers.some((entry) => entry.seq === seq)) return;
  if (!acc.deliveredSteers.some((entry) => entry.seq === seq)) {
    acc.deliveredSteers.push({ seq, line });
    acc.pendingSeen.push(seq);
  }
}

/** assistant 回合：回显后的第一条 assistant 记 seen；再后面的不重复记。 */
function takeAssistantSeen(acc: StreamAcc, line: number): void {
  for (const seq of acc.pendingSeen) {
    if (!acc.seenSteers.some((entry) => entry.seq === seq)) acc.seenSteers.push({ seq, line });
  }
  acc.pendingSeen = [];
}

/** 工具通道的报告：structuredContent > details.report > details 本体。 */
function takeToolReport(
  message: NonNullable<StreamEvent["message"]>,
  acc: StreamAcc,
  line: number,
): void {
  if (message.role !== "toolResult" || message.toolName !== CHILD_REPORT_TOOL_NAME) return;
  const candidate = (message.structuredContent ??
    (message.details as { report?: unknown })?.report ??
    message.details) as ChildReport | undefined;
  if (candidate && typeof candidate.summary === "string") {
    acc.toolReport = normalizeReport(candidate);
    acc.reportLine = line;
  }
}

/** 只处理转向证据；返回是否已消费该事件。 */
function takeSteerEvent(event: StreamEvent, acc: StreamAcc, line: number): boolean {
  if (event.type === "queue_update") {
    takeQueueUpdate(event, acc, line);
    return true;
  }
  if (event.type !== "message_end" || !event.message) return false;
  if (event.message.role === "user") {
    takeUserSteer(event.message, acc, line);
    return true;
  }
  if (event.message.role === "assistant") {
    takeAssistantSeen(acc, line);
    return true;
  }
  return false;
}

/** 增量证据追踪：长任务 stdout 会被 #pump 砍头，证据必须在流式阶段先留下。 */
export interface SteerEvidenceTracker {
  push(chunk: string): void;
  finish(): SteerEvidence;
}

export function createSteerEvidenceTracker(): SteerEvidenceTracker {
  const acc = emptyStreamAcc();
  let buffer = "";
  let lineNo = 0;
  const consume = (line: string): void => {
    const event = parseLine(line);
    if (!event) return;
    takeSteerEvent(event, acc, lineNo);
    if (event.type === "message_end" && event.message) takeToolReport(event.message, acc, lineNo);
  };
  return {
    push(chunk) {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        lineNo += 1;
        consume(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    },
    finish() {
      if (buffer) {
        lineNo += 1;
        consume(buffer);
        buffer = "";
      }
      return evidenceOf(acc);
    },
  };
}

/** 一行 JSON 变成一个事件；畸形行返回 undefined（不许毒化整次解析）。 */
function parseLine(line: string): StreamEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    return JSON.parse(trimmed) as StreamEvent;
  } catch {
    return undefined;
  }
}

/**
 * 解析 pi --mode json 的事件流（JSONL，一行一个 JSON 对象）。
 * 单个畸形事件不许毒化整次解析——content 形状随 pi 版本变。
 */
export function parseChildStream(stdout: string): ParsedChildStream {
  const acc = emptyStreamAcc();
  for (const [index, line] of stdout.split("\n").entries()) {
    const event = parseLine(line);
    if (!event) continue;
    const lineNo = index + 1;
    if (event.type === "queue_update") {
      takeSteerEvent(event, acc, lineNo);
      continue;
    }
    if (event.type?.startsWith("tool_execution_")) {
      takeToolEvent(event, acc);
      continue;
    }
    if (event.type !== "message_end" || !event.message) continue;
    if (event.message.role === "user") {
      takeSteerEvent(event, acc, lineNo);
      continue;
    }
    if (event.message.role === "assistant") {
      takeAssistant(event.message, acc);
      takeSteerEvent(event, acc, lineNo);
    }
    takeToolReport(event.message, acc, lineNo);
  }
  return {
    text: acc.text,
    toolReport: acc.toolReport,
    observedUsage: acc.observedUsage,
    observedUsageTotal: acc.usageTotal,
    observedModel: acc.observedModel,
    observedProvider: acc.observedProvider,
    delivery: {
      tools: acc.tools,
      paths: acc.paths,
      commands: acc.commands,
      errors: acc.errors,
      textChars: acc.text.length,
    },
    steerEvidence: evidenceOf(acc),
  };
}

/**
 * prompt 通道：从最终文本抠最后一个 fenced JSON 块；解析失败或没有 = none。
 * 三种通道：tool / prompt-json / none——不要合并。
 */
export function extractReportFromText(text: string): {
  report: ChildReport | null;
  channel: ReportChannel;
} {
  const blocks = [...text.matchAll(/```(?:json)?[ \t]*\n([\s\S]*?)```/g)];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const raw = blocks[i]![1]!.trim();
    if (!raw.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(raw) as ChildReport;
      if (typeof parsed.summary === "string" && parsed.summary.length > 0) {
        return { report: normalizeReport(parsed), channel: "prompt-json" };
      }
    } catch {
      // 不是合法 JSON 的报告块：继续往前找；都没有就是 none
    }
  }
  return { report: null, channel: "none" };
}

/** 报告散文段的上限：summary/why/assessment 各 2KB——report 本身是限字摘要，这是「有回执优先」档的前提。 */
const REPORT_PROSE_MAX_CHARS = 2048;

/** 自称命令的保留长度：声称要短，截尾只伤奇葩不构成误报。 */
const VERIFIED_COMMAND_MAX_CHARS = 200;

function clipReportProse(text: string): string {
  return text.length > REPORT_PROSE_MAX_CHARS ? `${text.slice(0, REPORT_PROSE_MAX_CHARS)}…` : text;
}

function normalizeReport(parsed: ChildReport): ChildReport {
  return {
    summary: clipReportProse(parsed.summary),
    why: typeof parsed.why === "string" ? clipReportProse(parsed.why) : "",
    assessment: typeof parsed.assessment === "string" ? clipReportProse(parsed.assessment) : "",
    findings: Array.isArray(parsed.findings)
      ? parsed.findings.filter((f) => typeof f?.what === "string")
      : undefined,
    files_touched: Array.isArray(parsed.files_touched)
      ? parsed.files_touched.filter((f): f is string => typeof f === "string")
      : undefined,
    verified: Array.isArray(parsed.verified)
      ? parsed.verified
          .filter((v) => typeof v?.command === "string")
          .map((v) => ({
            command:
              v.command.length > VERIFIED_COMMAND_MAX_CHARS
                ? `${v.command.slice(0, VERIFIED_COMMAND_MAX_CHARS)}…`
                : v.command,
            ...(typeof v.exitCode === "number" ? { exitCode: v.exitCode } : {}),
          }))
      : undefined,
    usage: parsed.usage && typeof parsed.usage === "object" ? parsed.usage : undefined,
  };
}

/**
 * assessment 是否空转——小窗资格粗筛，不是信任判官（信任只走记账：可核对不上倒扣，对上得分）。
 * 启发式三判据：缺/空、过短（<40 字符）、负面清单信号词零命中。伪问题骗得过词表也进不了正分，无妨。
 */
const ASSESSMENT_SIGNALS = [
  "problem",
  "risk",
  "issue",
  "limitation",
  "deviation",
  "concern",
  "caveat",
  "recheck",
  "fail",
  "wrong",
  "missing",
  "bug",
  "debt",
  "担心",
  "问题",
  "风险",
  "不足",
  "局限",
  "偏差",
  "遗留",
  "待复核",
  "缺陷",
  "坑",
  "错误",
  "没做",
  "未完成",
];

export function assessmentVacuous(report: ChildReport | undefined): boolean {
  const text = report?.assessment?.trim() ?? "";
  if (text.length < 40) return true;
  return !ASSESSMENT_SIGNALS.some((signal) => text.includes(signal));
}

/**
 * 交付核对：自述的路径和收据里的路径是不是同一个文件。
 * 两边写法常不同（相对 vs 绝对），所以比结尾；但按分隔符对齐，
 * 否则 a.ts 会命中 xa.ts。
 */
export function pathMatches(claim: string, path: string): boolean {
  return claim === path || path.endsWith(`/${claim}`) || claim.endsWith(`/${path}`);
}

/** 自述改了文件、收据里一个都对不上 ⇒ 没有实测支撑。没自述或没收据时不判。 */
export function deliveryUnverified(
  report: ChildReport | undefined,
  delivery: ChildDelivery | undefined,
): boolean {
  const claims = report?.files_touched ?? [];
  if (claims.length === 0 || !delivery) return false;
  return !claims.some((claim) => delivery.paths.some((path) => pathMatches(claim, path)));
}

/**
 * 自检对质：报告声称跑过的命令，收据里一条都没观测到 ⇒ 声称没有实测支撑。
 * 没声称就不判（只读档孩子没有 bash，契约允许 omit 此字段）。
 * 段级 × token 级：命令必须「是」观测里跑过的一条命令，不能只是别人嘴里的词
 * （echo/grep 正文里的同名字符串不算跑过）。参数交错与环境变量前缀容忍；
 * 方向仍是宁漏勿冤：标了由父方复核，和 deliveryUnverified 一个哲学。
 * shortcut: 不认 time/sudo/npx 等 wrapper 前缀（会误标未跑），也不拆换行（heredoc 由段首挡住）；
 * 误报出现再补 wrapper 白名单。
 */
export function verifyUnverified(
  report: ChildReport | undefined,
  delivery: ChildDelivery | undefined,
): boolean {
  const claims = (report?.verified ?? []).filter((c) => c.command.trim().length > 0);
  if (claims.length === 0 || !delivery) return false;
  return !claims.some((claim) =>
    commandSegments(claim.command).some((claimSeg) =>
      delivery.commands.some((command) =>
        commandSegments(command).some((observedSeg) => segmentsMatch(claimSeg, observedSeg)),
      ),
    ),
  );
}

/** 空白归一 + 去截尾省略号：截断产生的 … 在 token 化前当通配抹掉。 */
function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ").replace(/…$/, "");
}

/**
 * 按 shell 分隔符切成「命令段」，每段成 token 表；段首 VAR=value 剥掉。
 * 不按换行切——heredoc 正文留在 cat 段内，段首不是声称命令就不算跑过。
 */
function commandSegments(command: string): string[][] {
  return normalizeCommand(command)
    .split(/&&|\|\||;|\|/)
    .map((segment) => {
      const tokens = segment.trim().split(/\s+/).filter(Boolean);
      while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) tokens.shift();
      return tokens;
    })
    .filter((tokens) => tokens.length > 0);
}

/** a 是 b 的 token 前缀；最后一个 token 允许前缀（截断/半词宽容）。 */
function tokensPrefix(a: string[], b: string[]): boolean {
  if (a.length === 0 || a.length > b.length) return false;
  for (let i = 0; i < a.length - 1; i++) if (a[i] !== b[i]) return false;
  return b[a.length - 1]!.startsWith(a[a.length - 1]!);
}

/** 同一条基础命令、参数交错：a 的 token 按序出现在 b 里（首 token 必须相同）。 */
function tokensRunInOrder(a: string[], b: string[]): boolean {
  if (a.length === 0 || a[0] !== b[0]) return false;
  let j = 1;
  for (let i = 1; i < b.length && j < a.length; i++) if (b[i] === a[j]) j++;
  return j === a.length;
}

function segmentsMatch(a: string[], b: string[]): boolean {
  return (
    tokensPrefix(a, b) || tokensPrefix(b, a) || tokensRunInOrder(a, b) || tokensRunInOrder(b, a)
  );
}
