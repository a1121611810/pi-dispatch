// 真机验收的判断。只做判断，不做 I/O——这样每条判断都能用夹具测，也能进破坏点表。
// 断言一律落在「任务记录」与「孩子的输出日志」上，不落在模型散文上。
import { BLACKBOARD_READ, BLACKBOARD_WRITE, TRUST } from "../src/core/blackboard.ts";
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

/** 账上有数：无论孩子交没交报告，宿主观测的用量都要非零。 */
export function judgeChildReport(record: TaskRecord | undefined): Verdict {
  const channel = record?.reportChannel;
  const usage = record?.usage ?? record?.report?.usage;
  const ok = typeof usage?.input === "number" && usage.input > 0;
  return {
    ok,
    detail: `通道=${channel ?? "无"} 用量=${usage?.input ?? 0}`,
  };
}

/** 收据链路：真机孩子跑了 canary 命令，commands 里必须捞得到（不落在模型散文上）。 */
export function judgeCommandReceipt(record: TaskRecord | undefined, canary: string): Verdict {
  const commands = record?.delivery?.commands ?? [];
  const ok = commands.some((c) => c.includes(canary));
  return { ok, detail: `命令数=${commands.length} canary=${canary}` };
}

/**
 * 对质真触发：孩子按指令没跑命令却谎报自检 ⇒ 必被标 verifyUnverified。
 * 孩子不服从、真去跑了命令 ⇒ 声称命中、无旗标 ⇒ 红——那是模型服从问题不是代码问题，
 * 真机首跑看服从率，连续翻车按方案降级成观察项。
 */
export function judgeVerifyAudit(record: TaskRecord | undefined): Verdict {
  const claimed = record?.report?.verified?.length ?? 0;
  const flagged = record?.verifyUnverified === true;
  const note = flagged ? "" : "（抓捕未演练）";
  return { ok: flagged || claimed === 0, detail: `声称=${claimed} 旗标=${flagged}${note}` };
}

/** rpc：工具往返与终态通知都到了。 */
export function judgeRpc(sawToolEnd: boolean, sawNotification: boolean): Verdict {
  return {
    ok: sawToolEnd && sawNotification,
    detail: `工具往返=${sawToolEnd} 通知=${sawNotification}`,
  };
}

// ── 隔离与黑板（阶段 4 的真机腿） ───────────────────────────────────────────
// 判据只吃已采集的事实：record 是账，facts 是磁盘/git 观测，notes 是父方读回的信封。
// 采集在 scripts/verify-modes.ts；这里不做任何 I/O。

/** 隔离腿的已采集事实（全部来自 git 与磁盘观测）。 */
export interface WorktreeIsolationFacts {
  /** 夹具仓的基线提交 */
  base: string;
  /** worktree 目录还在吗 */
  worktreeDirExists: boolean;
  /** worktree 里的 .git 是文件吗（真 worktree 的标志） */
  worktreeGitIsFile: boolean;
  /** canary 文件在 worktree 里且内容对 */
  canaryInWorktree: boolean;
  /** canary 漏进父仓了吗（应该没有） */
  canaryInParent: boolean;
  /** 孩子跑完后父仓的 HEAD */
  parentHead: string;
  /** 孩子跑完后父仓的 status --porcelain */
  parentStatus: string;
  /** 脚本执行 git merge --ff-only <branch> 成功了吗 */
  mergeOk: boolean;
  /** merge 后父仓里有 canary 吗 */
  mergedCanary: boolean;
}

/** 隔离腿：账与磁盘两侧都必须对得上。 */
export function judgeWorktreeIsolation(
  record: TaskRecord | undefined,
  facts: WorktreeIsolationFacts,
): Verdict {
  const failures: string[] = [];
  const wt = record?.worktree;
  if (record?.status !== "succeeded") failures.push(`status=${record?.status ?? "无记录"}`);
  if (wt?.baseCommit !== facts.base) failures.push(`baseCommit=${wt?.baseCommit ?? "无"}`);
  if (!record || wt?.branch !== `pi-dispatch/${record.id}`)
    failures.push(`branch=${wt?.branch ?? "无"}`);
  if (!facts.worktreeDirExists) failures.push("worktree 目录不在");
  if (!facts.worktreeGitIsFile) failures.push("worktree/.git 不是文件");
  if (wt?.onExpectedBranch !== true)
    failures.push(`onExpectedBranch=${String(wt?.onExpectedBranch)}`);
  if (wt?.dirty !== 0) failures.push(`dirty=${String(wt?.dirty)}`);
  if (wt?.commitsAhead !== 1) failures.push(`commitsAhead=${String(wt?.commitsAhead)}`);
  if (!facts.canaryInWorktree) failures.push("canary 不在 worktree");
  if (facts.canaryInParent) failures.push("canary 漏进父仓");
  if (facts.parentHead !== facts.base) failures.push("父 HEAD 变了");
  if (facts.parentStatus.trim() !== "") failures.push("父工作区不干净");
  if (!facts.mergeOk) failures.push("ff-merge 失败");
  if (!facts.mergedCanary) failures.push("merge 后父仓没有 canary");
  return {
    ok: failures.length === 0,
    detail: failures.length ? failures.join("；") : "隔离判据全部符合",
  };
}

/** 默认关的对照孩子：记录里不许出现任何新键，worktrees 下只该有隔离那一个目录。 */
export function judgeDefaultOffUntouched(
  record: TaskRecord | undefined,
  worktreeDirCount: number,
): Verdict {
  const failures: string[] = [];
  if (record?.status !== "succeeded") failures.push(`status=${record?.status ?? "无记录"}`);
  if (record && ("isolation" in record || "worktree" in record || "blackboard" in record)) {
    failures.push("记录里出现了隔离/黑板键");
  }
  if (worktreeDirCount !== 1) failures.push(`worktrees 目录数=${worktreeDirCount}`);
  return {
    ok: failures.length === 0,
    detail: failures.length ? failures.join("；") : "默认关：记录无新键、worktrees 只含隔离那一个",
  };
}

/** 父方读回的一条笔记（trust 来自读信封，不来自文件）。 */
export interface BoardNoteFact {
  author: string;
  text: string;
  trust?: string;
}

/** 黑板腿：两块记录引用同一块板，板上找得到 writer 署名的 canary，读写各有收据。 */
export function judgeBlackboardExchange(
  writer: TaskRecord | undefined,
  reader: TaskRecord | undefined,
  notes: readonly BoardNoteFact[],
  canary: string,
): Verdict {
  const failures: string[] = [];
  const writerBoard = writer?.blackboard?.boardId;
  const readerBoard = reader?.blackboard?.boardId;
  if (!writerBoard) failures.push("writer 没有 boardId");
  if (!readerBoard) failures.push("reader 没有 boardId");
  if (writerBoard && readerBoard && writerBoard !== readerBoard) failures.push("两块板号不同");
  const hit = notes.find((note) => note.text.includes(canary) && note.author === writer?.id);
  if (!hit) failures.push("板上没有 writer 署名的 canary 笔记");
  if (hit && hit.trust !== TRUST) failures.push(`命中笔记 trust=${hit.trust ?? "无"}`);
  if (!notes.every((note) => note.trust === TRUST)) failures.push("读信封不是 trust=unverified");
  const writes = writer?.delivery?.tools?.[BLACKBOARD_WRITE] ?? 0;
  const reads = reader?.delivery?.tools?.[BLACKBOARD_READ] ?? 0;
  if (writes < 1) failures.push(`${BLACKBOARD_WRITE}=${writes}`);
  if (reads < 1) failures.push(`${BLACKBOARD_READ}=${reads}`);
  return {
    ok: failures.length === 0,
    detail: failures.length ? failures.join("；") : `黑板判据全部符合（笔记=${notes.length}）`,
  };
}

/** 非 git 仓里要隔离 ⇒ 闸在铸 id 前退回：桶里一条记录都不该有。 */
export function judgeWorktreeRejected(records: readonly TaskRecord[]): Verdict {
  return {
    ok: records.length === 0,
    detail: `隔离退回后记录数=${records.length}`,
  };
}
