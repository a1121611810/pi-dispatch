import {
  hasC0,
  type DispatchInput,
  type ReadOnlyTier,
  type TaskRejection,
  type UsageBudget,
} from "./types.ts";
import { buildUserMessage } from "./child.ts";

// 安检：纯函数。给输入，只回答「过」或「不过加理由」。
// 它不碰记录、不碰座位、不碰子代理——被拒了不留任何痕迹。
// 这是「先安检、后铸编号」的原因。

export type Gate = (input: DispatchInput) => TaskRejection | null;

export const rejection = (errorMessage: string): TaskRejection => ({
  status: "rejected",
  errorMessage,
});

/** 1 · 只读档位的值合法吗。写错值不要改成宽松值——那是把「只读」偷偷变成「可写」。 */
export const readOnlyGate: Gate = (input) =>
  input.readOnly !== undefined && input.readOnly !== "strict" && input.readOnly !== "lenient"
    ? rejection(
        `invalid readOnly value: ${String(input.readOnly)}（可用 strict / lenient，不 coerce）`,
      )
    : null;

/**
 * 深度解析：只认十进制数字串。
 * 坏值按 MAX_SAFE_INTEGER 算（fail-closed）：宁可当「太深」把派发拒掉，
 * 也不许当 0——「abc」当成 0 会让深度闸放行、子进程被当宿主装全套工具。
 */
export function parseDepth(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER;
}

/** 超时上限：Node 的定时器最大 2^31-1 毫秒，超了不是「很久」而是立刻溢出。 */
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * 进 argv / 附加块的单个文本字段上限（UTF-8 字节）。
 * 依据：Linux 单参数上限 MAX_ARG_STRLEN = 128 KiB；task 与 why 各占一个参数，
 * 64 KiB 留一半余量。超了是 E2BIG（spawn 抛 ⇒ 记 failed），不是 rejected——
 * 所以必须在闸上拦。
 */
export const MAX_TEXT_BYTES = 64 * 1024;

/**
 * 9 · allowScripts 是布尔吗。
 * 写成 "false" / 1 / {} 不猜：truthy 就当开了 codemode——那是把「不许写脚本」
 * 偷偷变成「能写脚本」（能力扩大）。
 */
export const allowScriptsGate: Gate = (input) =>
  input.allowScripts !== undefined && typeof input.allowScripts !== "boolean"
    ? rejection(
        `invalid allowScripts value: ${String(input.allowScripts)}（必须是 boolean，不 coerce）`,
      )
    : null;

/**
 * 10 · 会进 argv / 附加块的文本字段（model / thinkingLevel / why）。
 * 必须是字符串：非字符串会在铸编号之后 .trim/.replace 抛错 ⇒ 记成 failed 而不是 rejected，
 * 留下一条没用的记录。带 C0 控制字符的也不许进命令行。
 */
export const textFieldsGate: Gate = (input) => {
  for (const field of ["model", "thinkingLevel", "why"] as const) {
    const value = input[field];
    if (value === undefined) continue;
    if (typeof value !== "string")
      return rejection(`invalid ${field}: ${String(value)}（必须是字符串，不 coerce）`);
    if (hasC0(value)) return rejection(`invalid ${field}：含控制字符（\\n \\t \\r 之外的一律拒）`);
    if (Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES)
      return rejection(`invalid ${field}：超过 ${MAX_TEXT_BYTES} 字节上限`);
  }
  return null;
};

/**
 * 11 · 项目上下文档位的值合法吗。
 * 错值方向只是「多加载上下文」，不是扩权——但写错值也不该被悄悄当成 auto：
 * 父方写 "none" 想少加载上下文，拼错成了 "NON"，加载量就悄悄变多了。
 */
export const projectContextGate: Gate = (input) =>
  input.projectContext !== undefined &&
  input.projectContext !== "auto" &&
  input.projectContext !== "none"
    ? rejection(
        `invalid projectContext value: ${String(input.projectContext)}（可用 auto / none，不 coerce）`,
      )
    : null;

/** 4 · 会话要收尾了吗。 */
export const sessionEndingGate =
  (isEnding: () => boolean): Gate =>
  () =>
    isEnding() ? rejection("session is ending：这次派发不被接受") : null;

/** 5 · 递归太深了吗。子代理再派子代理，层数有上限。 */
export const depthGate =
  (depth: () => number, maxDepth: number): Gate =>
  () =>
    depth() + 1 > maxDepth ? rejection(`dispatch depth limit reached（max ${maxDepth}）`) : null;

/**
 * 2 · 任务的正文能安全进命令行吗。四种都退回：
 *   空的；
 *   以横线开头——纵深防御：孩子的 argv 里任务在 `--` 之后，pi 现在不会把它当选项
 *     （buildPiArgv）；留着是为了宿主参数解析变化时不至于把任务当旗标。
 *   以 @ 开头——pi 把**原始位置参数**当文件路径读：任务正文被丢弃，文件内容变成孩子的指令
 *     （`~` 会展开，绝对路径无白名单）；
 *   含 C0 控制字符——NUL 进 argv 会让 Node 的 spawn 同步抛，那会绕过「拒绝不留痕」变成「铸了编号再记 failed」。
 */
export const taskTextGate: Gate = (input) =>
  typeof input.task !== "string" || input.task.trim() === ""
    ? rejection("task 必须是非空字符串")
    : input.task.trimStart().startsWith("-")
      ? rejection("task 不能以 - 开头：当前 -- 分隔符已挡住旗标，这条是纵深防御")
      : input.task.startsWith("@")
        ? rejection("task 不能以 @ 开头：pi 会把它当文件读，任务正文被丢弃")
        : hasC0(input.task)
          ? rejection("task 不能含控制字符（\\n \\t \\r 之外的一律拒）")
          : Buffer.byteLength(input.task, "utf8") > MAX_TEXT_BYTES
            ? rejection(`task 超过 ${MAX_TEXT_BYTES} 字节上限（argv 装不下）`)
            : null;

/** 超时必须是正整数毫秒，且不超过 Node 定时器的上限——给了就计时，不给 = 不设限。 */
export const timeoutGate: Gate = (input) =>
  input.timeoutMs !== undefined &&
  (typeof input.timeoutMs !== "number" ||
    !Number.isFinite(input.timeoutMs) ||
    !Number.isInteger(input.timeoutMs) ||
    input.timeoutMs <= 0 ||
    input.timeoutMs > MAX_TIMEOUT_MS)
    ? rejection(
        `invalid timeoutMs: ${String(input.timeoutMs)}（必须是 1..${MAX_TIMEOUT_MS} 的整数毫秒）`,
      )
    : null;

/**
 * 6 · 隔离档位的值合法吗。
 * 写错值不要改成别的档——那是把「隔离」偷偷变成「共享」。
 */
export const isolationGate: Gate = (input) =>
  input.isolation !== undefined && input.isolation !== "worktree"
    ? rejection(`invalid isolation value: ${String(input.isolation)}（可用 worktree，不 coerce）`)
    : null;

/**
 * 7 · 黑板开关是布尔吗。
 * 写成 "true" / 1 不猜：拒掉。猜出来的开关会写错父方的意图。
 */
export const blackboardGate: Gate = (input) =>
  input.blackboard !== undefined && typeof input.blackboard !== "boolean"
    ? rejection(
        `invalid blackboard value: ${String(input.blackboard)}（必须是 boolean，不 coerce）`,
      )
    : null;

/**
 * 8 · 要隔离就得有 git 仓。
 * 谓词：探测由适配层注入（真探测），没注入就当没有——不许在非 git 目录里开隔离。
 */
export const worktreeNeedsGit =
  (isGitRepo: () => boolean): Gate =>
  (input) =>
    input.isolation === "worktree" && !isGitRepo()
      ? rejection("isolation=worktree 需要一个 git 仓库：当前目录不是 git 仓库（或没有可用的 git）")
      : null;

/** 安检的默认顺序。第一道不过就退回，后面的一概不问。 */
export function defaultGates(deps: {
  isEnding: () => boolean;
  depth: () => number;
  maxDepth: number;
  /** 是不是真 git 仓（适配层注入的探测）。不给 = 不是 ⇒ 不许开隔离。 */
  isGitRepo?: () => boolean;
}): Gate[] {
  return [
    readOnlyGate,
    taskTextGate,
    timeoutGate,
    sessionEndingGate(deps.isEnding),
    depthGate(deps.depth, deps.maxDepth),
    isolationGate,
    blackboardGate,
    worktreeNeedsGit(deps.isGitRepo ?? (() => false)),
    allowScriptsGate,
    textFieldsGate,
    projectContextGate,
    usageBudgetGate,
    messageBytesGate,
  ];
}

export type { ReadOnlyTier };

/**
 * 12 · usageBudget 的上限合法吗。
 * 至少要给一个上限（两个都没给 = 没设预算，不如不设）。
 * 上限必须是正的有限数——错值方向是「多花钱」，不 coerce。
 * hardFactor 必须是 ≥ 1 的有限数（<1 会让硬门早于软门）。
 * = 1 是合法值：硬门与软门同线、硬门先判 ⇒ 到点直接收掉（跳过降级交付）。
 * hardGraceMs 必须是正的有限数，且不超过 Node 定时器上限——超了会被夹成 1ms，
 * 变成「软门后立刻收尸」，不是「等很久」。
 */
export const usageBudgetGate: Gate = (input) => {
  const raw = input.usageBudget as unknown;
  if (raw === undefined) return null;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return rejection(`invalid usageBudget: ${String(raw)}（必须是对象）`);
  const budget = raw as UsageBudget;
  if (budget.maxUsd === undefined && budget.maxTokens === undefined)
    return rejection("usageBudget 至少要给一个上限（maxUsd / maxTokens）");
  if (budget.maxUsd !== undefined && (!Number.isFinite(budget.maxUsd) || budget.maxUsd <= 0))
    return rejection(`invalid usageBudget.maxUsd: ${String(budget.maxUsd)}（必须是正的有限数）`);
  if (
    budget.maxTokens !== undefined &&
    (!Number.isFinite(budget.maxTokens) || budget.maxTokens <= 0)
  )
    return rejection(
      `invalid usageBudget.maxTokens: ${String(budget.maxTokens)}（必须是正的有限数）`,
    );
  if (
    budget.hardFactor !== undefined &&
    (!Number.isFinite(budget.hardFactor) || budget.hardFactor < 1)
  )
    return rejection(
      `invalid usageBudget.hardFactor: ${String(budget.hardFactor)}（必须是 ≥ 1 的有限数，否则硬门早于软门）`,
    );
  if (
    budget.hardGraceMs !== undefined &&
    (!Number.isFinite(budget.hardGraceMs) ||
      budget.hardGraceMs <= 0 ||
      budget.hardGraceMs > MAX_TIMEOUT_MS)
  )
    return rejection(
      `invalid usageBudget.hardGraceMs: ${String(budget.hardGraceMs)}（必须是 1..${MAX_TIMEOUT_MS} 的有限数）`,
    );
  return null;
};

/**
 * 13 · user message 的体积与首字符合法吗。
 * 任务与理由现在合并进**同一个 argv 参数**：两个各 ≤64 KiB 合并后可能撞上 Linux 的
 * MAX_ARG_STRLEN（128 KiB）⇒ spawn 抛 E2BIG ⇒ 记 failed 而不是 rejected ⇒ 必须在闸上拦。
 * 首字符是 @ 的位置参数被 pi 当文件路径读（正文被丢弃）——message 的首字符恒等于 task 的首字符，
 * 这里再钉一道，防止将来有人在 task 前加前缀。
 */
export const messageBytesGate: Gate = (input) => {
  const message = buildUserMessage({
    task: input.task,
    why: input.why,
    isolation: input.isolation,
  });
  if (message.startsWith("@"))
    return rejection("user message 不能以 @ 开头：pi 会把它当文件读，正文被丢弃");
  if (Buffer.byteLength(message, "utf8") > MAX_TEXT_BYTES)
    return rejection(`user message 超过 ${MAX_TEXT_BYTES} 字节上限（argv 装不下）`);
  return null;
};
