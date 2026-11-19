import type { DispatchInput, ReadOnlyTier, TaskRejection } from "./types.ts";

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
 * 2 · 派发开关开着吗。
 * 谓词不是值：开关写成值会被装配时的拷贝冻住，主方中途改不生效。
 */
export const dispatchEnabledGate =
  (isEnabled: () => boolean): Gate =>
  () =>
    isEnabled() ? null : rejection("dispatch is disabled：不再收新的派发，在飞任务不受影响");

/** 3 · 会话要收尾了吗。 */
export const sessionEndingGate =
  (isEnding: () => boolean): Gate =>
  () =>
    isEnding() ? rejection("session is ending：这次派发不被接受") : null;

/** 4 · 递归太深了吗。子代理再派子代理，层数有上限。 */
export const depthGate =
  (depth: () => number, maxDepth: number): Gate =>
  () =>
    depth() + 1 > maxDepth ? rejection(`dispatch depth limit reached（max ${maxDepth}）`) : null;

/**
 * 5 · 任务是空的吗。
 * 6 · 任务以横线开头吗——pi 会把以 - 开头的任务当命令行选项（"--help" 会以 0 退出成假成功）。
 */
export const taskTextGate: Gate = (input) =>
  typeof input.task !== "string" || input.task.trim() === ""
    ? rejection("task 必须是非空字符串")
    : input.task.trimStart().startsWith("-")
      ? rejection("task 不能以 - 开头：pi 会把它当命令行选项")
      : null;

/** 超时必须是正数——给了就计时，不给 = 不设限。 */
export const timeoutGate: Gate = (input) =>
  input.timeoutMs !== undefined &&
  (typeof input.timeoutMs !== "number" || !Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0)
    ? rejection(`invalid timeoutMs: ${String(input.timeoutMs)}（必须是正数毫秒）`)
    : null;

/** 安检的默认顺序。第一道不过就退回，后面的一概不问。 */
export function defaultGates(deps: {
  isEnabled: () => boolean;
  isEnding: () => boolean;
  depth: () => number;
  maxDepth: number;
}): Gate[] {
  return [
    readOnlyGate,
    taskTextGate,
    timeoutGate,
    dispatchEnabledGate(deps.isEnabled),
    sessionEndingGate(deps.isEnding),
    depthGate(deps.depth, deps.maxDepth),
  ];
}

export type { ReadOnlyTier };
