// 验收判断的夹具测试：正反两面各断言一次。
// 夹具字段照抄真机跑出来的记录（见 ~/.pi/dispatch/<桶>/records/*.json），不自己编形状。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  judgeAllowScripts,
  judgeBlackboardExchange,
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
  type WorktreeIsolationFacts,
} from "../scripts/verdicts.ts";
import type { TaskRecord } from "../src/core/types.ts";

const good: TaskRecord = {
  id: "9e7e6d16",
  status: "succeeded",
  task: "读 /etc/hosts 报行数",
  delivery: {
    tools: { read: 1, bash: 1 },
    paths: ["/etc/hosts"],
    commands: ["wc -l /etc/hosts"],
    errors: 0,
    textChars: 230,
  },
};

const failed: TaskRecord = { id: "b", status: "failed", task: "t" };

// ── 派发：成了且有正文才算数 ────────────────────────────────────────────

test("判断·派发：succeeded 且有正文 ⇒ 绿", () => {
  assert.equal(judgeDispatch(good).ok, true);
});

test("判断·派发：failed ⇒ 红（哪怕输出里有数字）", () => {
  assert.equal(judgeDispatch(failed).ok, false);
});

test("判断·派发：succeeded 但正文 0 字 ⇒ 红", () => {
  assert.equal(judgeDispatch({ ...good, delivery: { ...good.delivery!, textChars: 0 } }).ok, false);
});

test("判断·派发：没有记录 ⇒ 红", () => {
  assert.equal(judgeDispatch(undefined).ok, false);
});

// ── allowScripts：看工具声明 ─────────────────────────────────────────────

test("判断·allowScripts：声明里有 codemode ⇒ 绿", () => {
  assert.equal(
    judgeAllowScripts(good, "<tools>\n- read: ...\n- codemode: 跑脚本\n</tools>").ok,
    true,
  );
});

test("判断·allowScripts：声明里没有 codemode ⇒ 红", () => {
  assert.equal(judgeAllowScripts(good, "<tools>\n- read: ...\n- bash: ...\n</tools>").ok, false);
});

test("判断·allowScripts：没有记录 ⇒ 红（哪怕日志里有字样）", () => {
  assert.equal(judgeAllowScripts(undefined, "- codemode: 跑脚本").ok, false);
});

// ── 退回：一条记录都不该有 ───────────────────────────────────────────────

test("判断·退回：桶里空 ⇒ 绿", () => {
  assert.equal(judgeReject([]).ok, true);
});

test("判断·退回：桶里有记录 ⇒ 红", () => {
  assert.equal(judgeReject([good]).ok, false);
});

// ── JSON 事件流 ─────────────────────────────────────────────────────────

test("判断·事件流：能解析出工具调用 ⇒ 绿", () => {
  const stream = '{"type":"tool_execution_start","toolName":"dispatch_task","args":{}}';
  assert.equal(judgeJsonStream(stream).ok, true);
});

test("判断·事件流：没有任何事件 ⇒ 红", () => {
  assert.equal(judgeJsonStream("").ok, false);
});

test("判断·事件流：只有非工具事件 ⇒ 红", () => {
  assert.equal(judgeJsonStream('{"type":"agent_start"}').ok, false);
});

// ── rpc：两个都在 ───────────────────────────────────────────────────────

test("判断·rpc：工具往返 + 通知都在 ⇒ 绿", () => {
  assert.equal(judgeRpc(true, true).ok, true);
});

test("判断·rpc：通知没到 ⇒ 红", () => {
  assert.equal(judgeRpc(true, false).ok, false);
});

test("判断·rpc：工具往返没到 ⇒ 红", () => {
  assert.equal(judgeRpc(false, true).ok, false);
});

// ── 收据命令 / 对质（verified × commands 闭环） ─────────────────────────

test("判断·命令收据：canary 命中 ⇒ 绿，没命中或无记录 ⇒ 红", () => {
  assert.equal(judgeCommandReceipt(good, "wc -l").ok, true);
  assert.equal(judgeCommandReceipt(good, "canary-zzz").ok, false);
  assert.equal(judgeCommandReceipt(undefined, "wc -l").ok, false);
});

test("判断·对质：谎称被标 ⇒ 绿；没声称（服从变体）⇒ 绿；声称了没被标 ⇒ 红", () => {
  const lying: TaskRecord = {
    ...good,
    verifyUnverified: true,
    report: { summary: "s", why: "w", assessment: "a", verified: [{ command: "pnpm test" }] },
  };
  assert.equal(judgeVerifyAudit(lying).ok, true);
  const obedientNoClaim: TaskRecord = {
    ...good,
    report: { summary: "s", why: "w", assessment: "a" },
  };
  assert.equal(judgeVerifyAudit(obedientNoClaim).ok, true, "没声称不判——只读档孩子的正常形态");
  const disobeyed: TaskRecord = {
    ...good,
    report: { summary: "s", why: "w", assessment: "a", verified: [{ command: "pnpm test" }] },
  };
  assert.equal(
    judgeVerifyAudit(disobeyed).ok,
    false,
    "声称了但没被标 = 孩子真跑了命令（服从失败），按设计转红",
  );
});

// ── 隔离：账与磁盘两侧都对得上 ───────────────────────────────────────────
// 夹具照抄真机腿采集到的形状（record 来自 records/*.json，facts 来自 git/磁盘）。

const isolated: TaskRecord = {
  id: "0f8e2c41",
  status: "succeeded",
  task: "建 canary 并提交",
  isolation: "worktree",
  worktree: {
    path: "/tmp/bucket/worktrees/0f8e2c41",
    branch: "pi-dispatch/0f8e2c41",
    baseCommit: "1111111111111111111111111111111111111111",
    headCommit: "2222222222222222222222222222222222222222",
    dirty: 0,
    onExpectedBranch: true,
    commitsAhead: 1,
  },
  delivery: {
    tools: { bash: 2 },
    paths: ["canary.txt"],
    commands: ["git add canary.txt && git commit -m canary"],
    errors: 0,
    textChars: 4,
  },
};

const isolationFacts: WorktreeIsolationFacts = {
  base: "1111111111111111111111111111111111111111",
  worktreeDirExists: true,
  worktreeGitIsFile: true,
  canaryInWorktree: true,
  canaryInParent: false,
  parentHead: "1111111111111111111111111111111111111111",
  parentStatus: "",
  mergeOk: true,
  mergedCanary: true,
};

test("判断·隔离：账与磁盘都对得上 ⇒ 绿", () => {
  assert.equal(judgeWorktreeIsolation(isolated, isolationFacts).ok, true);
});

test("判断·隔离：缺字段/脏/漂移/父仓被动过 ⇒ 红", () => {
  assert.equal(judgeWorktreeIsolation(undefined, isolationFacts).ok, false, "没有记录");
  assert.equal(
    judgeWorktreeIsolation({ ...isolated, worktree: undefined }, isolationFacts).ok,
    false,
    "记录缺 worktree 字段",
  );
  assert.equal(judgeWorktreeIsolation(failed, isolationFacts).ok, false, "终态不是 succeeded");
  assert.equal(
    judgeWorktreeIsolation(
      { ...isolated, worktree: { ...isolated.worktree!, baseCommit: "deadbeef" } },
      isolationFacts,
    ).ok,
    false,
    "baseCommit 不是受理时钉的那个",
  );
  assert.equal(
    judgeWorktreeIsolation(
      { ...isolated, worktree: { ...isolated.worktree!, branch: "main" } },
      isolationFacts,
    ).ok,
    false,
    "分支名不是 pi-dispatch/<id>",
  );
  assert.equal(
    judgeWorktreeIsolation(
      { ...isolated, worktree: { ...isolated.worktree!, onExpectedBranch: false } },
      isolationFacts,
    ).ok,
    false,
    "孩子跑去了别的分支",
  );
  assert.equal(
    judgeWorktreeIsolation(
      { ...isolated, worktree: { ...isolated.worktree!, dirty: 1 } },
      isolationFacts,
    ).ok,
    false,
    "留了未提交的改动",
  );
  assert.equal(
    judgeWorktreeIsolation(
      { ...isolated, worktree: { ...isolated.worktree!, commitsAhead: 0 } },
      isolationFacts,
    ).ok,
    false,
    "没有提交",
  );
  assert.equal(
    judgeWorktreeIsolation(isolated, { ...isolationFacts, worktreeDirExists: false }).ok,
    false,
    "worktree 目录不在",
  );
  assert.equal(
    judgeWorktreeIsolation(isolated, { ...isolationFacts, worktreeGitIsFile: false }).ok,
    false,
    "worktree/.git 不是文件（不是真 worktree）",
  );
  assert.equal(
    judgeWorktreeIsolation(isolated, { ...isolationFacts, canaryInWorktree: false }).ok,
    false,
    "canary 不在 worktree",
  );
  assert.equal(
    judgeWorktreeIsolation(isolated, { ...isolationFacts, canaryInParent: true }).ok,
    false,
    "canary 漏进父仓——隔离失效",
  );
  assert.equal(
    judgeWorktreeIsolation(isolated, { ...isolationFacts, parentHead: "3333" }).ok,
    false,
    "父 HEAD 被动了",
  );
  assert.equal(
    judgeWorktreeIsolation(isolated, { ...isolationFacts, parentStatus: "?? canary.txt\n" }).ok,
    false,
    "父工作区不干净",
  );
  assert.equal(
    judgeWorktreeIsolation(isolated, { ...isolationFacts, mergeOk: false }).ok,
    false,
    "ff-merge 失败",
  );
  assert.equal(
    judgeWorktreeIsolation(isolated, { ...isolationFacts, mergedCanary: false }).ok,
    false,
    "merge 后父仓没有 canary",
  );
});

// ── 默认关：记录无新键、worktrees 目录只有隔离那一个 ─────────────────────

test("判断·默认关：无新键且 worktrees 只一个 ⇒ 绿", () => {
  assert.equal(judgeDefaultOffUntouched(good, 1).ok, true);
});

test("判断·默认关：出现新键、多了目录或缺记录 ⇒ 红", () => {
  assert.equal(judgeDefaultOffUntouched(undefined, 1).ok, false, "没有对照孩子的记录");
  assert.equal(judgeDefaultOffUntouched({ ...good, isolation: "worktree" }, 1).ok, false);
  assert.equal(
    judgeDefaultOffUntouched({ ...good, blackboard: { boardId: "b", path: "/p" } }, 1).ok,
    false,
  );
  assert.equal(judgeDefaultOffUntouched(good, 2).ok, false, "默认关也建了 worktree");
  assert.equal(judgeDefaultOffUntouched(good, 0).ok, false, "隔离那一个也没建出来");
});

// ── 黑板：同板、署名、trust 未核实、读写收据 ─────────────────────────────

const board = {
  boardId: "5b0f6d0a-1f0e-4d7c-9f1a-2b3c4d5e6f70",
  path: "/tmp/bucket/blackboards/x",
};
const writer: TaskRecord = {
  id: "aaaa1111",
  status: "succeeded",
  task: "写黑板",
  blackboard: board,
  delivery: {
    tools: { blackboard_write: 1 },
    paths: [],
    commands: [],
    errors: 0,
    textChars: 6,
  },
};
const reader: TaskRecord = {
  id: "bbbb2222",
  status: "succeeded",
  task: "读黑板",
  blackboard: board,
  delivery: {
    tools: { blackboard_read: 1 },
    paths: [],
    commands: [],
    errors: 0,
    textChars: 20,
  },
};
const notes: BoardNoteFact[] = [
  { author: "aaaa1111", text: "board-canary-xyz", trust: "unverified" },
];

test("判断·黑板：同板号 + 署名 canary + trust 未核实 + 读写收据 ⇒ 绿", () => {
  assert.equal(judgeBlackboardExchange(writer, reader, notes, "board-canary-xyz").ok, true);
});

test("判断·黑板：板号不同 / trust 被改 / canary 缺失 / 收据为 0 ⇒ 红", () => {
  assert.equal(judgeBlackboardExchange(undefined, reader, notes, "board-canary-xyz").ok, false);
  assert.equal(
    judgeBlackboardExchange(
      writer,
      { ...reader, blackboard: { ...board, boardId: "other" } },
      notes,
      "board-canary-xyz",
    ).ok,
    false,
    "两块板号不同",
  );
  assert.equal(
    judgeBlackboardExchange(
      writer,
      reader,
      [{ ...notes[0]!, trust: "verified" }],
      "board-canary-xyz",
    ).ok,
    false,
    "trust 被改成已核实",
  );
  assert.equal(
    judgeBlackboardExchange(
      writer,
      reader,
      [{ ...notes[0]!, author: "someone-else" }],
      "board-canary-xyz",
    ).ok,
    false,
    "作者不是 writer",
  );
  assert.equal(
    judgeBlackboardExchange(writer, reader, notes, "another-canary").ok,
    false,
    "板上没有这条 canary",
  );
  assert.equal(
    judgeBlackboardExchange(writer, reader, [], "board-canary-xyz").ok,
    false,
    "板是空的",
  );
  assert.equal(
    judgeBlackboardExchange({ ...writer, delivery: undefined }, reader, notes, "board-canary-xyz")
      .ok,
    false,
    "writer 没有写收据",
  );
  assert.equal(
    judgeBlackboardExchange(writer, { ...reader, delivery: undefined }, notes, "board-canary-xyz")
      .ok,
    false,
    "reader 没有读收据",
  );
});

// ── 非 git 仓里的隔离：零记录 ────────────────────────────────────────────

test("判断·隔离退回：零记录 ⇒ 绿，有记录 ⇒ 红", () => {
  assert.equal(judgeWorktreeRejected([]).ok, true);
  assert.equal(judgeWorktreeRejected([isolated]).ok, false);
});

test("判断·转向：seen 且最后一条 assistant 正文出现 STEERED ⇒ 绿", () => {
  const record: TaskRecord = {
    id: "task_steer_ok",
    status: "succeeded",
    task: "t",
    steers: [{ seq: 1, text: "改", at: 1, state: "seen" }],
  };
  const log = [
    { type: "message_end", message: { role: "user", content: "请回答 STEERED" } },
    {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "STEERED" }] },
    },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
  assert.equal(judgeSteer(record, log).ok, true);
});

test("判断·转向：sent/undelivered 或正文没改 ⇒ 红", () => {
  const base: TaskRecord = { id: "task_steer_bad", status: "succeeded", task: "t" };
  assert.equal(judgeSteer(undefined, "STEERED").ok, false, "没有记录不崩");
  assert.equal(judgeSteer({ ...base }, "STEERED").ok, false, "没有 steers 键不崩");
  assert.equal(judgeSteer({ ...base, steers: [] }, "STEERED").ok, false);
  const spoken = JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "STEERED" }] },
  });
  assert.equal(
    judgeSteer({ ...base, steers: [{ seq: 1, text: "改", at: 1, state: "undelivered" }] }, spoken)
      .ok,
    false,
  );
  assert.equal(
    judgeSteer({ ...base, steers: [{ seq: 1, text: "改", at: 1, state: "seen" }] }, "DONE").ok,
    false,
  );
  const echoOnly = [
    { type: "message_end", message: { role: "user", content: "请回答 STEERED" } },
    {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "DONE" }] },
    },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
  assert.equal(
    judgeSteer({ ...base, steers: [{ seq: 1, text: "改", at: 1, state: "seen" }] }, echoOnly).ok,
    false,
    "user 回显里的 STEERED 不能冒充孩子改向",
  );
});
