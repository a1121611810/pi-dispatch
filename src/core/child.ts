import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { BLACKBOARD_READ, BLACKBOARD_WRITE } from "./blackboard.ts";
import { steerSeqFromText, textOfContent, type SteerEvidence } from "./steer.ts";
import type {
  ChildDelivery,
  ChildReport,
  ChildUsage,
  ClaimCoverage,
  Deliverable,
  Isolation,
  ReportChannel,
} from "./types.ts";

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

/**
 * 恒定契约块：上下文块 + 报告契约。每次派发逐字节相同。
 * 变的部分（why / 隔离契约）全在 user message 里——系统提示词恒定 ⇒ 跨子代理共享同一段前缀。
 */
export const CONTRACT_BLOCK = [SUBAGENT_CONTEXT_BLOCK, REPORT_CONTRACT_BLOCK].join("\n");

/**
 * 给孩子的 user message：任务正文 +（可选）理由块 +（可选）隔离契约块。
 * 顺序固定：任务 → why → 隔离契约（why 解释动机，隔离契约讲环境与交付，靠近交付）。
 * 没有 why、没有隔离时逐字节等于任务原文 ⇒ argv 与今天相同。
 */
export function buildUserMessage(options: {
  task: string;
  why?: string;
  isolation?: Isolation;
}): string {
  return [
    options.task,
    options.why ? `<pi-dispatch-why>${escapeXmlText(options.why)}</pi-dispatch-why>` : "",
    options.isolation === "worktree" ? WORKTREE_CONTRACT_BLOCK : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** 只读档位的读集。 */
export const READ_ONLY_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];

/**
 * 会改文件的工具（pi 内置只有这两个）。收据只认白名单——
 * 黑名单会把「任何带 path 参数的调用」都当改文件，`child_report` 多传个 path 就能伪造收据。
 */
export const WRITE_TOOLS: readonly string[] = ["edit", "write"];

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
 *   --append-system-prompt       挂恒定契约块（上下文 + 报告契约）——逐字节相同 ⇒ 前缀可共享
 *   --no-extensions --no-skills  减重：砍掉自动发现带进孩子的散文与技能
 *   -e builtin:codemode          allowScripts 时把写程序的能力显式带进来
 *   --tools 名单                 只读档位收窄；带 codemode 才不会被名单砍掉
 *   user message 放最后          任务 + why + 隔离契约（变的内容不进系统提示词）
 */
export function buildPiArgv(options: BuildArgvOptions): string[] {
  const argv = [nonEmpty(options.piPath) ?? "pi", "-p", "--no-session", "--mode", "json"];
  argv.push("--append-system-prompt", CONTRACT_BLOCK);
  // 减量：砍自动发现带进孩子的宿主面散文与技能
  argv.push("--no-extensions", "--no-skills");
  // 回执工具：把本扩展自己装进孩子（显式 -e 不受 --no-extensions 影响）
  if (options.childExtensionPath) argv.push("-e", options.childExtensionPath);
  // 孩子的固定税一大块：项目上下文（AGENTS.md/CLAUDE.md）
  if (options.projectContext === "none") argv.push("--no-context-files");
  if (supportsNoMcp(options.piVersion)) argv.push("--no-mcp");
  // 解析序：调用参数 → 会话当前模型；思考档位挂 :<thinking> 后缀
  // 空串是坏值（会变成 --model ""），当没给处理
  const model = effectiveModel({ model: options.model, sessionModel: options.sessionModel });
  if (model) {
    const thinking = nonEmpty(options.thinkingLevel);
    const modelArg = thinking ? `${model}:${thinking}` : model;
    argv.push("--model", modelArg);
  }
  argv.push(...strictToolsArgv(options));
  // allowScripts：命令行显式给的扩展不受 --no-extensions 影响 ⇒ 减量效果不丢
  if (options.allowScripts) argv.push("-e", "builtin:codemode");
  // `--` 分隔符：任务后面的一切都是位置参数，不许被当旗标
  // （pi 的 args.js 有 `--` 分支：1.0.0 起就有，见 node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js）
  argv.push("--", buildUserMessage(options));
  return argv;
}

/**
 * 模型解析序：调用给的 → 会话当前模型。空串是坏值，当没给处理。
 * 抽成一处是因为 buildPiArgv 与引擎都要它（引擎要用它查模型目录）。
 */
export function effectiveModel(options: {
  model?: string;
  sessionModel?: string;
}): string | undefined {
  const model = nonEmpty(options.model) ?? nonEmpty(options.sessionModel);
  return model;
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
  /** 逐轮用量明细（缓存复用分析要它；累计 == observedUsageTotal） */
  observedTurns: TurnUsage[];
  /** 流里实测到的孩子模型/provider */
  observedModel: string | null;
  observedProvider: string | null;
  /** 孩子的真实工具轨迹——父核对结论用，不靠模型自述 */
  delivery: ChildDelivery;
  /** pi 在 system 消息里给孩子声明的工具名（父方事实，不是模型自述） */
  declaredTools: string[];
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
  /** 逐轮用量明细（缓存复用分析要它；累计 == usageTotal） */
  turns: TurnUsage[];
  observedModel: string | null;
  observedProvider: string | null;
  tools: Record<string, number>;
  paths: string[];
  commands: string[];
  /** 其中跑挂了的（与 commands 同受上限） */
  failedCommands: string[];
  /** 有收据但配不上 toolCallId 的维度：结局未知，按「证据丢了」处理 */
  lostPath: boolean;
  lostCommand: boolean;
  /** 收据撞到上限丢过条目：截断是丢了证据，判「对不上」时要放行 */
  pathsTruncated: boolean;
  commandsTruncated: boolean;
  errors: number;
  /** 畸形事件行数（不是合法事件）：好行照留，坏行计数。 */
  malformed: number;
  /** pi 给孩子声明的工具名（system 消息的 sections.tools） */
  declaredTools: string[];
  queuedSteers: Array<{ seq: number; line: number }>;
  deliveredSteers: Array<{ seq: number; line: number }>;
  seenSteers: Array<{ seq: number; line: number }>;
  /** user 回显后还没等到 assistant 的 seq */
  pendingSeen: number[];
  reportLine?: number;
  /**
   * 已发起但还没收到 end 的工具调用：toolCallId → 这次调用要记的收据。
   * 失败的调用不算「碰过」——不然 5 次全失败的 edit、跑挂的 `pnpm test` 都能凑出自述对上。
   * end 事件带 toolCallId 但不带 args，所以收据只能在 start 时暂存、end 时再定去留。
   */
  pendingWrites: Map<string, { path?: string; command?: string }>;
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
    /** system 消息的段落（sections.tools = 声明的工具清单） */
    sections?: unknown;
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
  result?: { isError?: boolean; structuredContent?: { exit_code?: unknown } };
  /** 工具调用 id：start 与 end 带同一个值，用来把「发起」和「成败」配成一对 */
  toolCallId?: string;
  steering?: unknown;
}

function emptyStreamAcc(): StreamAcc {
  return {
    text: "",
    toolReport: null,
    observedUsage: null,
    usageTotal: null,
    turns: [],
    observedModel: null,
    observedProvider: null,
    // 无原型对象：工具名 "__proto__" / "constructor" 也能正常计数
    tools: Object.create(null) as Record<string, number>,
    paths: [],
    commands: [],
    failedCommands: [],
    lostPath: false,
    lostCommand: false,
    pathsTruncated: false,
    commandsTruncated: false,
    errors: 0,
    malformed: 0,
    declaredTools: [],
    queuedSteers: [],
    deliveredSteers: [],
    seenSteers: [],
    pendingSeen: [],
    pendingWrites: new Map(),
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

/**
 * pi 给孩子声明的工具名（system 消息的 sections.tools，形如 "- codemode: 跑脚本"）。
 * 这是父方观测到的事实：codemode 在不在声明里，看的是 pi 打的工具清单，
 * 不是孩子正文里复述的字符串。
 */
export function declaredToolNames(sections: unknown): string[] {
  if (!sections || typeof sections !== "object" || !("tools" in sections)) return [];
  const tools = sections.tools;
  if (typeof tools !== "string") return [];
  const names: string[] = [];
  for (const line of tools.split("\n")) {
    const match = /^\s*-\s+([A-Za-z0-9_.-]+)\s*:/.exec(line);
    if (match && !names.includes(match[1]!)) names.push(match[1]!);
  }
  return names;
}

/**
 * 这是一次写类工具调用要记的路径（读类工具与 bash 不给路径）。
 * 读类工具（read/grep/find/ls）不算——读过不等于改过，否则「自述改了 N 个文件」
 * 只要把那 N 个文件读一遍就能对上（实测可洗白）。
 */
function writablePath(toolName: string, args: { path?: unknown } | undefined): string | undefined {
  // 白名单而不是黑名单。黑名单只排读类工具，于是**任何**带 `path` 参数的工具调用成功
  // 都会被当成「改过文件」——`child_report` 多传一个 `path` 就能凭空造一条收据换到
  // 「已核对」（实测可达）。pi 内置的写类工具只有 edit / write。
  if (!WRITE_TOOLS.includes(toolName)) return undefined;
  const path = args?.path;
  if (typeof path !== "string" || !path) return undefined;
  return path;
}

/**
 * 记一条改过的路径。到上限就丢并置 truncated。
 * 只在工具调用**成功**后才调（见 takeToolEvent）：失败的不算碰过。
 */
function recordPath(path: string, acc: StreamAcc): void {
  if (acc.paths.includes(path)) return;
  if (acc.paths.length >= MAX_PATHS) {
    acc.pathsTruncated = true;
    return;
  }
  acc.paths.push(path);
}

/**
 * 这次调用要记的命令串（只有 bash——它的效果就是命令行，codemode 最终也走 bash 执行）。
 * 与 `writablePath` 对称：只回答「要记什么」，不落账（落账时机由 takeToolEvent 定）。
 */
function commandOf(toolName: string, args: { command?: unknown } | undefined): string | undefined {
  if (toolName !== "bash") return undefined;
  const command = args?.command;
  if (typeof command !== "string" || !command) return undefined;
  return command.length > COMMAND_KEEP_CHARS ? `${command.slice(0, COMMAND_KEEP_CHARS)}…` : command;
}

/**
 * 记一条跑过的命令。原样记串不解析；保最近 N 条（交付前的验证命令在尾部）。
 * 成功失败都记——跑过就是出勤。是不是「兑现」看 failedCommands（见 claimSatisfied）：
 * 声称 exitCode:0 的自述不能拿一条失败观测顶过去。
 */
function recordCommandText(command: string, acc: StreamAcc): void {
  if (acc.commands.includes(command)) return;
  acc.commands.push(command);
  if (acc.commands.length > MAX_COMMANDS) {
    acc.commands.shift();
    acc.commandsTruncated = true;
  }
}

/** 记一条跑挂的命令（与 commands 同受上限：被挤掉就当没观测到成功过）。 */
function recordFailedCommand(command: string, acc: StreamAcc): void {
  if (acc.failedCommands.includes(command)) return;
  acc.failedCommands.push(command);
  if (acc.failedCommands.length > MAX_COMMANDS) acc.failedCommands.shift();
}

/**
 * 工具轨迹：start 计次并把收据**暂存**，end 计错并决定去留。
 *
 * 为什么要等 end：`isError` 只在 end 上，start 时不知道这次调用成没成。
 * 之前 start 就落账，于是两条洗白通道（都实测可达）：
 *   - 5 次全失败的 edit 也算「碰过 5 个文件」⇒ 照着自述写一遍就换到「已核对」
 *   - 跑挂的 `pnpm test` 也算「跑过」⇒ 声称 `exitCode: 0` 照样「已核对」
 * 路径和命令都按同一套走：**成了才算兑现**。
 */
function takeToolEvent(event: StreamEvent, acc: StreamAcc): void {
  if (event.type === "tool_execution_start") {
    const name = typeof event.toolName === "string" ? event.toolName : "unknown";
    acc.tools[name] = (acc.tools[name] ?? 0) + 1;
    const callId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
    const path = writablePath(name, event.args);
    const command = commandOf(name, event.args);
    // 没有 toolCallId 就配不上 end，不知道这次调用成没成 ⇒ 不落账；
    // 但要记下「这一维有东西没核到」，否则收据凭空变少、判词会把诚实孩子判成没支撑。
    if (callId === undefined) {
      if (path !== undefined) acc.lostPath = true;
      if (command !== undefined) acc.lostCommand = true;
    }
    if (callId !== undefined && (path !== undefined || command !== undefined)) {
      acc.pendingWrites.set(callId, {
        ...(path !== undefined ? { path } : {}),
        ...(command !== undefined ? { command } : {}),
      });
    }
  } else if (event.type === "tool_execution_end") {
    const failed = event.isError === true || event.result?.isError === true;
    if (failed) acc.errors++;
    const callId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
    if (callId === undefined) return;
    const pending = acc.pendingWrites.get(callId);
    if (pending === undefined) return;
    acc.pendingWrites.delete(callId);
    // 路径：失败的那次没改到东西，不记。
    if (pending.path !== undefined && !failed) recordPath(pending.path, acc);
    // 命令：跑过就是跑过——失败也记账，但要带上结局。
    // 整条丢掉的话，诚实报告「我跑了 pnpm test，它 exit 1」的孩子会被判成谎报；
    // 而「声称 exitCode:0」的自述又要靠这个结局才能被拆穿。
    if (pending.command !== undefined) {
      recordCommandText(pending.command, acc);
      if (failed) recordFailedCommand(pending.command, acc);
    }
  }
}

/** 用量：自报的 cacheRead/cacheWrite/cost 缺省就不出键。逐字段 finite——NaN 会污染账。 */
function takeUsage(usage: NonNullable<NonNullable<StreamEvent["message"]>["usage"]>): ChildUsage {
  const cost = typeof usage.cost === "number" ? usage.cost : usage.cost?.total;
  return {
    input: finiteNumber(usage.input),
    output: finiteNumber(usage.output),
    ...(usage.cacheRead !== undefined ? { cacheRead: finiteNumber(usage.cacheRead) } : {}),
    ...(usage.cacheWrite !== undefined ? { cacheWrite: finiteNumber(usage.cacheWrite) } : {}),
    ...(cost !== undefined ? { cost: finiteNumber(cost) } : {}),
  };
}

/** 一轮 assistant 回合的用量明细：缓存复用分析要它（首轮 = 数组第 0 个）。 */
export interface TurnUsage {
  /** 本轮 prompt 的未命中 token */
  input: number;
  output: number;
  /** 本轮命中缓存的 token */
  cacheRead: number;
  cacheWrite: number;
  /** 本轮 prompt 总 token（input + cacheRead + cacheWrite） */
  promptTokens: number;
}

/** ChildUsage → TurnUsage：缺席字段按 0（与 addUsage 的口径一致），promptTokens 当场钉死。 */
function turnUsageOf(usage: ChildUsage): TurnUsage {
  const input = usage.input ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  return {
    input,
    output: usage.output ?? 0,
    cacheRead,
    cacheWrite,
    promptTokens: input + cacheRead + cacheWrite,
  };
}

/** 有限数才留（NaN / Infinity 一律当没给）。 */
function finiteNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** assistant 消息：正文「最后一段胜出」，顺带记模型与用量。 */
function takeAssistant(message: NonNullable<StreamEvent["message"]>, acc: StreamAcc): void {
  // 工具回执的文本不能当正文——交付物只从 assistant 消息取
  if (message.role !== "assistant") return;
  if (typeof message.model === "string") acc.observedModel = message.model;
  if (typeof message.provider === "string") acc.observedProvider = message.provider;
  // content 形状随 pi 版本变：非数组按「没有文本」跳过；元素不是对象也跳过（content:[null] 不许炸）
  const parts = Array.isArray(message.content) ? message.content : [];
  acc.text = parts
    .filter(
      (part): part is { type?: string; text?: string } =>
        Boolean(part) && typeof part === "object" && part.type === "text",
    )
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("\n");
  if (message.usage) {
    const usage = takeUsage(message.usage);
    acc.observedUsage = usage;
    // 逐轮明细：首轮复用率要从第 0 轮算，只有总额时分不出「首轮」与「全程」
    acc.turns.push(turnUsageOf(usage));
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

/**
 * 运行中用量追踪：边喂 stdout 边累计用量。
 * 口径与 parseChildStream **完全一致**（复用 takeUsage / addUsage / parseLine）——
 * tracker.snapshot().usage 必须等于 parseChildStream(同一段流).observedUsageTotal。
 * 这是「运行中判预算」与「退出后记账」不打架的唯一保证。
 */
export interface UsageTracker {
  /** 喂一段 stdout；跨 chunk 的半行自己留着。 */
  push(chunk: string): void;
  /** 冲刷末尾的半行（流结束时调一次）。 */
  finish(): void;
  /** 累计用量 + assistant 回合数。 */
  snapshot(): { usage: ChildUsage | null; turns: number };
  /** 逐轮明细——缓存命中分析要它。turns.length 恒等于 snapshot().turns。 */
  turns: TurnUsage[];
}

export function createUsageTracker(): UsageTracker {
  let usage: ChildUsage | null = null;
  const turns: TurnUsage[] = [];
  let buffer = "";
  const consume = (line: string): void => {
    const event = parseLine(line);
    if (!event || event.type !== "message_end" || !event.message) return;
    const message = event.message;
    if (message.role !== "assistant") return;
    if (!message.usage) return;
    turns.push(turnUsageOf(takeUsage(message.usage)));
    usage = addUsage(usage, takeUsage(message.usage));
  };
  const drain = (final: boolean): void => {
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      consume(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
    if (final && buffer) {
      consume(buffer);
      buffer = "";
    }
  };
  return {
    push(chunk) {
      buffer += chunk;
      drain(false);
    },
    finish() {
      drain(true);
    },
    snapshot() {
      return { usage, turns: turns.length };
    },
    turns,
  };
}

/**
 * 一行 JSON 变成一个事件；畸形行返回 undefined（不许毒化整次解析）。
 * `type` 必须是字符串：`{"type":5}` 不是事件，是坏数据。
 */
function parseLine(line: string): StreamEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const event = parsed as StreamEvent;
    if (event.type !== undefined && typeof event.type !== "string") return undefined;
    return event;
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
    if (!event) {
      // 坏行计数：不是坏 JSON（那是半行/噪声）也算——「这一行不是事件」就是畸形
      if (line.trim() !== "") acc.malformed += 1;
      continue;
    }
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
    // system 消息里的 sections.tools = pi 给孩子声明的工具清单（父方事实）
    if (event.message.role === "system") {
      for (const name of declaredToolNames(event.message.sections)) {
        if (!acc.declaredTools.includes(name)) acc.declaredTools.push(name);
      }
      continue;
    }
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
  // 收尾时有 start 没 end ⇒ 那次调用的结局不知道（子代理被杀、日志被切）。
  // 这是**证据丢了**，不是「没做过」：按维度置截断位，让判词按「没法对质」处理。
  // 只置真的悬着的那一维——一条悬空的 bash 不该把路径那一维也标成不可信。
  let danglingPath = false;
  let danglingCommand = false;
  for (const pending of acc.pendingWrites.values()) {
    if (pending.path !== undefined) danglingPath = true;
    if (pending.command !== undefined) danglingCommand = true;
  }
  return {
    text: acc.text,
    toolReport: acc.toolReport,
    observedUsage: acc.observedUsage,
    observedUsageTotal: acc.usageTotal,
    observedTurns: acc.turns,
    observedModel: acc.observedModel,
    observedProvider: acc.observedProvider,
    delivery: {
      tools: acc.tools,
      paths: acc.paths,
      commands: acc.commands,
      ...(acc.failedCommands.length > 0 ? { failedCommands: [...acc.failedCommands] } : {}),
      errors: acc.errors,
      textChars: acc.text.length,
      ...(acc.malformed > 0 ? { malformed: acc.malformed } : {}),
      ...(acc.pathsTruncated || danglingPath || acc.lostPath
        ? { pathsTruncated: true as const }
        : {}),
      ...(acc.commandsTruncated || danglingCommand || acc.lostCommand
        ? { commandsTruncated: true as const }
        : {}),
    },
    declaredTools: acc.declaredTools,
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

export function normalizeReport(parsed: ChildReport): ChildReport {
  return {
    summary: clipReportProse(parsed.summary),
    why: typeof parsed.why === "string" ? clipReportProse(parsed.why) : "",
    assessment: typeof parsed.assessment === "string" ? clipReportProse(parsed.assessment) : "",
    findings: Array.isArray(parsed.findings)
      ? parsed.findings.filter((f) => typeof f?.what === "string").slice(0, MAX_REPORT_ITEMS)
      : undefined,
    files_touched: Array.isArray(parsed.files_touched)
      ? parsed.files_touched
          .filter((f): f is string => typeof f === "string")
          .slice(0, MAX_REPORT_ITEMS)
      : undefined,
    verified: Array.isArray(parsed.verified)
      ? parsed.verified
          .filter((v) => typeof v?.command === "string")
          .slice(0, MAX_REPORT_ITEMS)
          .map((v) => ({
            command:
              v.command.length > VERIFIED_COMMAND_MAX_CHARS
                ? `${v.command.slice(0, VERIFIED_COMMAND_MAX_CHARS)}…`
                : v.command,
            // 退出码只认 0..255 的整数：别的形状当没给（-1 / 999 / NaN 不是进程退出码）
            ...(typeof v.exitCode === "number" &&
            Number.isInteger(v.exitCode) &&
            v.exitCode >= 0 &&
            v.exitCode <= 255
              ? { exitCode: v.exitCode }
              : {}),
          }))
      : undefined,
    usage: normalizeUsage(parsed.usage),
  };
}

/** 报告里清单类字段的条数上限：孩子自报一万条也不许撑爆父方的内存与列表。 */
const MAX_REPORT_ITEMS = 50;

/** 自报用量逐字段必须是有限数：NaN / Infinity 会污染账。 */
function normalizeUsage(usage: ChildUsage | undefined): ChildUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const out: ChildUsage = {};
  for (const field of ["input", "output", "cost", "turns", "cacheRead", "cacheWrite"] as const) {
    const value = usage[field];
    if (typeof value === "number" && Number.isFinite(value)) out[field] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * assessment 是否空转——小窗资格粗筛，不是判词。判词只走 deliverableOf（零命中=unverified，
 * 部分命中=partial）：仓里没有分数/倒扣那套记账，谁也别照着注释想象它存在。
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
  const claims = pathClaims(report);
  // 截断过就不判：丢的是收据条目，不是「没改过」的证据
  if (claims.length === 0 || !delivery || delivery.pathsTruncated) return false;
  return !claims.some((claim) => delivery.paths.some((path) => pathMatches(claim, path)));
}

/**
 * 自检自述里的命令（去空白）。对质与覆盖度共用同一口径——
 * 分成两处复制的话，一处改了另一处不变，硬旗和覆盖度就会对同一份自述给出不同答案。
 */
function commandClaims(
  report: ChildReport | undefined,
): Array<{ command: string; exitCode?: number }> {
  return (report?.verified ?? []).filter((claim) => claim.command.trim().length > 0);
}

/**
 * 改动自述里的路径（去空白）。与 commandClaims 同构——判词、硬旗、覆盖度、
 * 截断判定都得数「可核对的条数」，口径必须只有一处。
 * 之前路径侧完全没过滤：`files_touched: ["  "]` 也能换到「已核对」，
 * 与命令侧 `verified: [{command: "   "}]` 是同一个洞的两个入口。
 */
function pathClaims(report: ChildReport | undefined): string[] {
  // 与命令侧同构：命令走 normalizeCommand（会 trim），路径侧原来不 trim，
  // 于是 `files_touched: [" /a.ts "]` 配收据 `/a.ts` 会永远对不上（冤枉诚实孩子）。
  return (report?.files_touched ?? []).map((path) => path.trim()).filter((path) => path.length > 0);
}

/**
 * 一条自述命令是否被观测到。
 *
 * 复合命令（`ls && pnpm test && pnpm lint`）的**每一段**都要被观测到才算兑现。
 * 之前用的是「任一段命中即算整条对上」——那孩子只要跑过 `ls` 就能拿一条
 * 声称三个命令都跑过的自述换到「已核对」（实测可达）。
 * 段内仍用 `segmentsMatch`（token 级 + 参数交错容忍）；段间要求每一段各自有出处，
 * 但不要求来自同一条 bash（真机常常拆成多次调用）。
 */
function claimSatisfied(
  claim: { command: string; exitCode?: number },
  observed: string[],
  failed: string[],
): boolean {
  const segments = commandSegments(claim.command, true);
  if (segments.length === 0) return false;
  // 明确声称「exitCode:0」的自述，不能拿一条跑挂的观测顶过去。
  // 没写 exitCode 的就当「跑过即可」——诚实报告「跑了但挂了」不该被判成谎报。
  const wantOk = claim.exitCode === 0;
  return segments.every((claimSeg) =>
    observed.some(
      (command) =>
        !(wantOk && (failed.includes(command) || hasMaskingSeparator(command))) &&
        commandSegments(command).some((observedSeg) => segmentsMatch(claimSeg, observedSeg)),
    ),
  );
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
  const claims = commandClaims(report);
  // 截断过就不判：观测只留最近 N 条，旧命令被挤掉不是「没跑过」
  if (claims.length === 0 || !delivery || delivery.commandsTruncated) return false;
  const failed = delivery.failedCommands ?? [];
  return !claims.some((claim) => claimSatisfied(claim, delivery.commands, failed));
}

/**
 * 改动自述的覆盖度：声称几条、对上几条。只在「部分对上」时返回（全对上/零对上都不返回）。
 * 与 deliveryUnverified 同一套匹配（路径结尾对齐分隔符）；截断过就不算——
 * 丢的是证据，不是罪证，这时候判「对不上」是冤枉真干活的孩子。
 */
export function deliveryCoverage(
  report: ChildReport | undefined,
  delivery: ChildDelivery | undefined,
): ClaimCoverage | undefined {
  const claims = pathClaims(report);
  if (!delivery || delivery.pathsTruncated) return undefined;
  const hit = claims.filter((claim) => delivery.paths.some((path) => pathMatches(claim, path)));
  return hit.length > 0 && hit.length < claims.length
    ? { claimed: claims.length, matched: hit.length }
    : undefined;
}

/** 自检自述的覆盖度。同构于 deliveryCoverage，匹配走段级 × token 级。 */
export function verifyCoverage(
  report: ChildReport | undefined,
  delivery: ChildDelivery | undefined,
): ClaimCoverage | undefined {
  const claims = commandClaims(report);
  if (!delivery || delivery.commandsTruncated) return undefined;
  const failed = delivery.failedCommands ?? [];
  const seen = claims.filter((claim) => claimSatisfied(claim, delivery.commands, failed));
  return seen.length > 0 && seen.length < claims.length
    ? { claimed: claims.length, matched: seen.length }
    : undefined;
}

/** deliverableOf 的入参：TaskRecord 结构上就满足它，所以 registry 直接丢记录进来。 */
export interface DeliverableInput {
  report?: ChildReport | undefined;
  delivery?: ChildDelivery | undefined;
  deliveryUnverified?: boolean;
  verifyUnverified?: boolean;
  assessmentVacuous?: boolean;
  reportStale?: true | undefined;
  deliveryPartial?: ClaimCoverage;
  verifyPartial?: ClaimCoverage;
}

/**
 * 收据缺口：被截断的那一维**有可核对的自述**，于是那一维没法对质。
 *
 * 判词、引擎、通知三处都用这一份口径——分开算的话，通知会说错降级原因
 * （实测：没交报告 + 命令收据截断 ⇒ 判词因「没报告」而 unverified，
 * 通知却说「收据超出上限」，而那一维根本没有自述要核）。
 */
export function receiptGap(
  report: ChildReport | undefined,
  delivery: ChildDelivery | undefined,
): boolean {
  if (!delivery) return false;
  // 「缺口」＝截断过**且确实有条自述在保留的收据里找不到**。
  // 只按「有自述 + 截断过」算的话，21 条命令之后声称最后一条（它就留在收据里、
  // 也确实对得上）也会被判「没法核对」——那是冤枉，不是保守。
  const paths = delivery.paths ?? [];
  const commands = delivery.commands ?? [];
  const failed = delivery.failedCommands ?? [];
  const pathGap =
    delivery.pathsTruncated === true &&
    pathClaims(report).some((claim) => !paths.some((path) => pathMatches(claim, path)));
  const commandGap =
    delivery.commandsTruncated === true &&
    commandClaims(report).some((claim) => !claimSatisfied(claim, commands, failed));
  return pathGap || commandGap;
}

/**
 * 交付判词。退出码只说进程怎么了，这一列说交付有没有实测支撑——两条轴分开记。
 * 只在定终态时算一次（registry 是唯一合法写入者），永不改 status。
 *   absent     没交报告、正文空的、也没改过文件（空跑：跑了个寂寞）
 *   unverified 有正文没报告，或自述零命中，或 assessment 空转，或报告早于转向，或收据没法对质
 *   partial    有自述，只对上一部分
 *   unclaimed  有报告但没有可核对的自述——只读分析任务的诚实形态，不罚
 *   verified   有自述且全对上
 */
export function deliverableOf(record: DeliverableInput): Deliverable {
  // absent 量的是「父方收到什么」：没报告、没正文、也没改过任何文件。
  // 只看正文会把「改了文件但没写正文」的孩子误判成空跑——它明明动过手，worktree 层面有痕迹。
  // 但**只看 paths 不看 commands**：跑一句 `ls` 不代表有交付，拿 commands 当豁免会让
  // 「跑了个 ls 就啥也没交」也失去空跑信号（实测过这个滑档）。
  // 收据被截断时不下「空跑」结论：证据丢了不等于什么都没做，那是两条不同的话。
  // 用可选链读数组：恢复出来的旧记录可能只有 `delivery: {}`，裸 `.length` 会抛错堵死队列。
  if (
    !record.report &&
    (record.delivery?.textChars ?? 0) === 0 &&
    (record.delivery?.paths?.length ?? 0) === 0 &&
    record.delivery?.pathsTruncated !== true &&
    record.delivery?.commandsTruncated !== true
  ) {
    return "absent";
  }
  if (!record.report) return "unverified";
  // 没有收据就没法对质——导出函数要自己兜住，别指望调用方一定传（引擎路径总有，但这是公开 API）。
  if (!record.delivery) return "unverified";
  if (
    record.deliveryUnverified ||
    record.verifyUnverified ||
    record.assessmentVacuous ||
    record.reportStale
  ) {
    return record.deliveryPartial || record.verifyPartial ? "partial" : "unverified";
  }
  if (record.deliveryPartial || record.verifyPartial) return "partial";
  // 收据被上限截断、那一维又有自述 ⇒ 没法对质。不点指控旗（丢的是证据不是罪证），
  // 但也绝不盖章——否则「先攒满 20 条收据，再随便写」就是一条洗白通道（实测可达）。
  if (receiptGap(record.report, record.delivery)) return "unverified";
  // 声称数按过滤后的口径数：空白自述（`files_touched: ["  "]` 或
  // `verified: [{command: "   "}]`）不是可核对的项，不能换到「已核对」。
  const claims = pathClaims(record.report).length + commandClaims(record.report).length;
  return claims === 0 ? "unclaimed" : "verified";
}

/** 空白归一 + 去截尾省略号：截断产生的 … 在 token 化前当通配抹掉。 */
function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ").replace(/…$/, "");
}

/**
 * 按 shell 分隔符切成「命令段」，每段成 token 表；段首 VAR=value 剥掉。
 * 不按换行切——heredoc 正文留在 cat 段内，段首不是声称命令就不算跑过。
 */
function commandSegments(command: string, splitNewlines = false): string[][] {
  // 引号里的分隔符不切：`echo "x && pnpm test"` 是一段，不是「跑了 pnpm test」。
  // 换行当分隔符：声称「pnpm test\npnpm lint」是两条命令，不能折成一段靠前缀蒙混。
  const text = command.trim();
  const raw: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\n") {
      // 观测侧不按换行切：heredoc 正文留在 cat 那一段里，段首是 cat 就匹配不上声称的命令。
      // 声称侧要切：`pnpm test\npnpm lint` 是两条命令，折成一段会被前缀蒙混过去。
      if (splitNewlines) {
        raw.push(current);
        current = "";
      } else {
        current += " ";
      }
      continue;
    }
    const pair = text.slice(i, i + 2);
    if (pair === "&&" || pair === "||") {
      raw.push(current);
      current = "";
      i++;
      continue;
    }
    if (ch === ";" || ch === "|") {
      raw.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  raw.push(current);
  return raw
    .map((segment) => {
      const tokens = segment.trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
      while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) tokens.shift();
      return tokens;
    })
    .filter((tokens) => tokens.length > 0);
}

/** a 是 b 的 token 前缀；最后一个 token 允许前缀（截断/半词宽容）。 */
function tokensPrefix(a: string[], b: string[]): boolean {
  if (a.length === 0 || a.length > b.length) return false;
  for (let i = 0; i < a.length - 1; i++) if (a[i] !== b[i]) return false;
  const lastA = a[a.length - 1]!;
  const lastB = b[a.length - 1]!;
  // 末 token 允许前缀，但只在观测确实被截断（… 结尾）时。
  // 无条件前缀会让 `pnpm test` 被 `pnpm test:unit` 满足——跑了单测就宣称跑过全量。
  return lastA === lastB || (lastB.endsWith("…") && lastB.slice(0, -1).startsWith(lastA));
}

/** 同一条基础命令、参数交错：a 的 token 按序出现在 b 里（首 token 必须相同）。 */

/**
 * 两个 token 是否算同一个：完全相等，或某一侧被截断（带 …）时按前缀认。
 * 截断信息留在 token 上（不整串剥掉），所以「pnpm test」不会被「pnpm test:unit」满足。
 */
function tokensEquivalent(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.endsWith("…")) return b.startsWith(a.slice(0, -1));
  if (b.endsWith("…")) return a.startsWith(b.slice(0, -1));
  return false;
}

/**
 * 命令里有没有**会掩码失败**的分隔符（`||`、`;`、`|`、单个 `&`）。
 * pi 只给整条命令一个成败：`pnpm test || true` 整体成功，但 `pnpm test` 到底过没过不知道。
 * 所以这类观测不能拿来当「exitCode:0 已被证实」。`&&` 是安全的（全跑完才算成功）。
 */
function hasMaskingSeparator(command: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ";") return true;
    if (ch === "|") return true; // | 和 || 都掩码（后一条的成败不代表前一条）
    if (ch === "&") {
      if (command[i + 1] === "&") i++; // && 安全
      else return true;
    }
  }
  return false;
}

function segmentsMatch(claim: string[], observed: string[]): boolean {
  // 自述的 token 要按序在观测里出现，中间只许夹**旗标及其值**。
  // 之前是「任意乱序命中」：`pnpm exec echo test` 也算跑过 `pnpm test`（实测可换 verified），
  // `pnpm test:unit` 也能顶 `pnpm test`。现在非旗标的多余 token 一律不认。
  // 观测被截断（末 token 带 …）时放宽末 token 为前缀——那是真丢了字，不是宽容。
  if (claim.length === 0) return false;
  let j = 0;
  let afterFlag = false;
  for (let i = 0; i < observed.length && j < claim.length; i++) {
    const token = observed[i]!;
    if (tokensEquivalent(claim[j]!, token)) {
      j++;
      afterFlag = false;
      continue;
    }
    // 旗标本身、以及紧跟在旗标后面的那个值（`--filter core`），算装饰放过
    if (token.startsWith("-")) {
      afterFlag = true;
      continue;
    }
    if (afterFlag) {
      afterFlag = false;
      continue;
    }
    return false;
  }
  return j === claim.length;
}
