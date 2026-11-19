// 真机验收的判断。只做判断，不做 I/O——这样每条判断都能用夹具测，也能进破坏点表。
// 断言一律落在「任务记录」与「孩子的输出日志」上，不落在模型散文上。
import { parseChildStream } from "../src/core/child.ts";
import type { TaskRecord } from "../src/core/types.ts";

export type Verdict = { ok: boolean; detail: string };

/** 子代理跑完并交回正文。 */
export function judgeDispatch(record: TaskRecord | undefined): Verdict {
  const chars = record?.delivery?.textChars ?? 0;
  return {
    ok: record?.status === "succeeded" && chars > 0,
    detail: `status=${record?.status ?? "无记录"} 正文=${chars}`,
  };
}

/** 孩子看得见 codemode——看 pi 打的工具声明，不看它有没有真的用。 */
export function judgeAllowScripts(record: TaskRecord | undefined, childLog: string): Verdict {
  const declared = childLog.includes("- codemode");
  return { ok: Boolean(record) && declared, detail: `记录=${Boolean(record)} 声明=${declared}` };
}

/** 安检退回：桶里一条记录都不该有。 */
export function judgeReject(records: readonly TaskRecord[]): Verdict {
  return { ok: records.length === 0, detail: `记录数=${records.length}` };
}

/** JSON 事件流能被核心解析出工具调用。 */
export function judgeJsonStream(stdout: string): Verdict {
  const tools = Object.keys(parseChildStream(stdout).delivery.tools);
  return { ok: tools.length > 0, detail: `工具=${tools.join(",") || "无"}` };
}

/** rpc：工具往返与终态通知都到了。 */
export function judgeRpc(sawToolEnd: boolean, sawNotification: boolean): Verdict {
  return {
    ok: sawToolEnd && sawNotification,
    detail: `工具往返=${sawToolEnd} 通知=${sawNotification}`,
  };
}
