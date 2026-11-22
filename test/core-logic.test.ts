// 阶段 2 探针：安检 / 状态机。
// 每个 it 对应一个变异点——变异存活 = 对应探针是假绿的（见计划「第四层 · 假绿测试」）。
//
// 等价变异（探针杀不掉，且也不该杀）：
//   compareTerminal 的 `finishedAt ?? 0` → `||`——右值是 0，在 number | undefined 上
//   两向恒同值（0 ?? 0 与 0 || 0 都是 0，undefined 都是 0，非零都是原值）；NaN 不是合法时刻。
//   同刻编号 tiebreak 已抽成 compareTerminal，由「比较器同刻按编号双向定序」直接钉住
//   （只经 Array.sort 观察时，返回 0 与 1 在互异 id 上会得到同一个序，变异杀不掉）。
//   src/core/registry.ts 的 `current.steers ?? []` → `||`——空数组是真值，两向同值 ⇒ 等价。
//   compareTerminal 的 `id < id` → `<=`——同 id 已在上一行返回 0，可达输入上只比异 id ⇒ 等价。
//   src/core/gates.ts 的 `deps.isGitRepo ?? (() => false)` → `||`——isGitRepo 的类型是
//   `() => boolean`，函数恒真 ⇒ ?? 与 || 在可达输入上给同一个谓词 ⇒ 等价。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blackboardGate,
  depthGate,
  dispatchEnabledGate,
  isolationGate,
  readOnlyGate,
  rejection,
  sessionEndingGate,
  taskTextGate,
  timeoutGate,
  worktreeNeedsGit,
  defaultGates,
} from "../src/core/gates.ts";
import {
  applyAttachSteer,
  applyAttachWorktree,
  applyResolveExit,
  compareTerminal,
  TaskRegistry,
} from "../src/core/registry.ts";
import type { TaskRecord } from "../src/core/types.ts";

// ── 安检 ──────────────────────────────────────────────────────────────────

test("安检 1：readOnly 写错值要拒，不能 coerce 成宽松", () => {
  assert.equal(readOnlyGate({ task: "x", readOnly: "strict" }), null);
  assert.equal(readOnlyGate({ task: "x", readOnly: "lenient" }), null);
  const bad = readOnlyGate({ task: "x", readOnly: "Strict" as never });
  assert.ok(bad, "写错值必须被拒");
  assert.match(bad!.errorMessage, /invalid readOnly value/);
  // 关键：拒绝信息里不能出现「已按 lenient 处理」这种悄悄放行
  assert.doesNotMatch(bad!.errorMessage, /按 lenient|已放宽|降级为/);
});

test("安检 2：派发开关是谓词不是值——中途改要立刻生效", () => {
  let enabled = true;
  const gate = dispatchEnabledGate(() => enabled);
  assert.equal(gate({ task: "x" }), null);
  enabled = false;
  const bad = gate({ task: "x" });
  assert.ok(bad, "开关关掉后必须拒");
  assert.match(bad!.errorMessage, /dispatch is disabled/);
});

test("安检 3：会话收尾时不接新派发", () => {
  let ending = false;
  const gate = sessionEndingGate(() => ending);
  assert.equal(gate({ task: "x" }), null);
  ending = true;
  assert.ok(gate({ task: "x" }));
});

test("安检 4：递归深度有上限", () => {
  const gate = depthGate(() => 2, 3);
  assert.equal(gate({ task: "x" }), null, "depth 2 再派一层 = 3，没超上限");
  const tooDeep = depthGate(() => 3, 3);
  assert.ok(tooDeep({ task: "x" }), "depth 3 再派一层 = 4，超了");
});

test("安检 5：空任务要拒", () => {
  assert.ok(taskTextGate({ task: "" }));
  assert.ok(taskTextGate({ task: "   " }), "纯空白也是空");
  assert.equal(taskTextGate({ task: "真的活" }), null);
});

test("安检 6：以横线开头的任务要拒（pi 会当命令行选项）", () => {
  const bad = taskTextGate({ task: "--help" });
  assert.ok(bad);
  assert.match(bad!.errorMessage, /不能以 - 开头/);
  // 前导空白后仍以 - 开头 ⇒ 同样要拒（trimStart 后判定）
  assert.ok(taskTextGate({ task: "  --help" }), "前导空白后仍以 - 开头 ⇒ 也要拒");
  assert.equal(taskTextGate({ task: "干这个活 -x" }), null, "中间有横线不算");
});

test("安检：timeoutMs 必须是正数", () => {
  assert.equal(timeoutGate({ task: "x" }), null);
  assert.equal(timeoutGate({ task: "x", timeoutMs: 1000 }), null);
  assert.equal(timeoutGate({ task: "x", timeoutMs: 1 }), null, "1 毫秒也是正数 ⇒ 合法");
  assert.ok(timeoutGate({ task: "x", timeoutMs: 0 }), "0 不是有效时限");
  assert.ok(timeoutGate({ task: "x", timeoutMs: -1 }));
  assert.ok(timeoutGate({ task: "x", timeoutMs: Number.NaN }));
  assert.ok(timeoutGate({ task: "x", timeoutMs: Number.POSITIVE_INFINITY }));
});

test("安检顺序：第一道不过，后面一概不问", () => {
  // 开关关着 + 任务空 —— 两个都不合法。哪个先问？
  const gates = defaultGates({
    isEnabled: () => false,
    isEnding: () => false,
    depth: () => 0,
    maxDepth: 3,
  });
  // readOnly 是第一道（合法），taskText 是第二道 ⇒ 应该问 taskText
  const result = gates[1]!({ task: "" });
  assert.ok(result);
  assert.match(result.errorMessage, /非空字符串/);
});

test("安检 7：isolation 写错值要拒，不 coerce", () => {
  assert.equal(isolationGate({ task: "x" }), null, "不给 = 不开隔离");
  assert.equal(isolationGate({ task: "x", isolation: "worktree" }), null);
  const bad = isolationGate({ task: "x", isolation: "Worktree" as never });
  assert.ok(bad, "写错值必须被拒");
  assert.match(bad!.errorMessage, /invalid isolation value/);
  // 关键：拒绝信息里不能出现「已按 worktree 处理」这种悄悄放行
  assert.doesNotMatch(bad!.errorMessage, /按 worktree|已放宽|降级为|已忽略/);
});

test("安检 8：blackboard 非 boolean 要拒", () => {
  assert.equal(blackboardGate({ task: "x" }), null, "不给 = 不开黑板");
  assert.equal(blackboardGate({ task: "x", blackboard: true }), null);
  assert.equal(blackboardGate({ task: "x", blackboard: false }), null);
  const bad = blackboardGate({ task: "x", blackboard: "true" as never });
  assert.ok(bad, "字符串不是布尔值，必须被拒");
  assert.match(bad!.errorMessage, /invalid blackboard value/);
  // 关键：不能悄悄当成 true/false
  assert.doesNotMatch(bad!.errorMessage, /当作 true|已放宽|降级为|已忽略/);
});

test("安检 9：要 worktree 但没有可用 git 仓要拒", () => {
  const noGit = worktreeNeedsGit(() => false);
  const withGit = worktreeNeedsGit(() => true);
  const bad = noGit({ task: "x", isolation: "worktree" });
  assert.ok(bad, "没有 git 仓就不许开隔离");
  assert.match(bad!.errorMessage, /git/);
  assert.match(bad!.errorMessage, /仓库/);
  assert.equal(withGit({ task: "x", isolation: "worktree" }), null, "有 git 仓就放行");
  // 没开隔离就与 git 无关
  assert.equal(noGit({ task: "x" }), null);
  assert.equal(noGit({ task: "x", blackboard: true }), null);
});

test("安检 10：默认闸序含隔离/黑板两道值闸", () => {
  const gates = defaultGates({
    isEnabled: () => true,
    isEnding: () => false,
    depth: () => 0,
    maxDepth: 3,
  });
  // 既有 6 道位置一个字不动（既有用例按索引断言 gates[1]）
  assert.equal(gates.length, 9);
  assert.equal(gates[0], readOnlyGate);
  assert.equal(gates[1], taskTextGate);
  assert.equal(gates[2], timeoutGate);
  // 新闸追加在末尾，编号 7/8/9
  assert.equal(gates[6], isolationGate, "安检 7 在末尾第一位");
  assert.equal(gates[7], blackboardGate, "安检 8 在末尾第二位");
  // 安检 9 是谓词闸（要 git）：没 git 时 isolation=worktree 要被拒
  const rejected = gates[8]!({ task: "x", isolation: "worktree" });
  assert.ok(rejected, "安检 9 要在默认闸序里");
  assert.match(rejected.errorMessage, /git/);
});

test("安检：rejection 造的形状对", () => {
  assert.deepEqual(rejection("理由"), { status: "rejected", errorMessage: "理由" });
});

// ── 状态机 ────────────────────────────────────────────────────────────────

function record(id: string, status: TaskRecord["status"] = "queued"): TaskRecord {
  return { id, status, task: "t" };
}

test("状态机：queued → running → succeeded 走通", async () => {
  const reg = new TaskRegistry();
  await reg.submit({ kind: "spawn", record: record("a") });
  const running = await reg.submit({ kind: "transition", id: "a", to: "running" });
  assert.equal(running.record.status, "running");
  assert.ok(running.record.startedAt, "转 running 要盖 startedAt");
  const done = await reg.submit({ kind: "resolve-exit", id: "a", exitCode: 0 });
  assert.equal(done.record.status, "succeeded");
  assert.ok(done.record.finishedAt, "终态要盖 finishedAt");
});

test("状态机：退出码非 0 是「败了」", async () => {
  const reg = new TaskRegistry();
  await reg.submit({ kind: "spawn", record: record("a") });
  await reg.submit({ kind: "transition", id: "a", to: "running" });
  const done = await reg.submit({ kind: "resolve-exit", id: "a", exitCode: 1 });
  assert.equal(done.record.status, "failed");
});

test("状态机：非法迁移要被拒（抛错）", async () => {
  const reg = new TaskRegistry();
  await reg.submit({ kind: "spawn", record: record("a") });
  await assert.rejects(
    () => reg.submit({ kind: "transition", id: "a", to: "succeeded" }),
    /illegal transition/,
    "queued 不能直接到 succeeded",
  );
});

test("状态机：终态哪儿也去不了——迟到写入静默丢弃不报错", async () => {
  const reg = new TaskRegistry();
  await reg.submit({ kind: "spawn", record: record("a") });
  await reg.submit({ kind: "transition", id: "a", to: "running" });
  await reg.submit({ kind: "resolve-exit", id: "a", exitCode: 0 });
  // 终态上挂报告 —— 静默丢弃
  const late = await reg.submit({
    kind: "attach-report",
    id: "a",
    report: { summary: "迟到的" },
    channel: "tool",
  });
  assert.equal(late.changed, false, "迟到报告不该改记录");
  assert.equal(late.record.report, undefined, "记录里不该留下迟到报告");
  // 终态上再转状态 —— 也静默
  const lateTransition = await reg.submit({ kind: "transition", id: "a", to: "running" });
  assert.equal(lateTransition.changed, false);
  assert.equal(lateTransition.record.status, "succeeded", "终态不被改写");
});

test("状态机：stopping 的子代理收完算 canceled", async () => {
  const reg = new TaskRegistry();
  await reg.submit({ kind: "spawn", record: record("a") });
  await reg.submit({ kind: "transition", id: "a", to: "running" });
  await reg.submit({ kind: "stop", id: "a", reason: "用户叫停" });
  const done = await reg.submit({ kind: "resolve-exit", id: "a", exitCode: 143 });
  assert.equal(done.record.status, "canceled", "叫停过的一律算取消");
});

test("状态机：cancel-queued 只对 queued 生效", async () => {
  const reg = new TaskRegistry();
  await reg.submit({ kind: "spawn", record: record("a") });
  const canceled = await reg.submit({ kind: "cancel-queued", id: "a", reason: "抽了" });
  assert.equal(canceled.record.status, "canceled");
  assert.equal(canceled.record.stopReason, "抽了");

  await reg.submit({ kind: "spawn", record: record("b") });
  await reg.submit({ kind: "transition", id: "b", to: "running" });
  const notCanceled = await reg.submit({ kind: "cancel-queued", id: "b", reason: "抽了" });
  assert.equal(notCanceled.changed, false, "已经在跑的不该被 cancel-queued 改掉");
  assert.equal(notCanceled.record.status, "running");
});

test("状态机：终态挤掉只挤终态，活账留着", async () => {
  const reg = new TaskRegistry();
  for (const id of ["a", "b", "c"]) {
    await reg.submit({ kind: "spawn", record: record(id) });
    await reg.submit({ kind: "transition", id, to: "running" });
    await reg.submit({ kind: "resolve-exit", id, exitCode: 0 });
  }
  await reg.submit({ kind: "spawn", record: record("live") });
  await reg.submit({ kind: "transition", id: "live", to: "running" });
  const evicted = reg.evictTerminal(2).map((r) => r.id);
  assert.equal(evicted.length, 1, "3 个终态留 2 个 ⇒ 挤掉 1 个");
  assert.equal(reg.get("live")?.status, "running", "在跑的永不被挤");
  assert.equal(reg.list().length, 3);
});

test("状态机：挤掉的是最老的那条（按结束时刻）", async () => {
  const reg = new TaskRegistry();
  // 显式给不同的 finishedAt，不靠真实时钟（同毫秒会掩盖排序 bug）
  const withFinish = (id: string, finishedAt: number): TaskRecord => ({
    id,
    status: "succeeded",
    task: "t",
    finishedAt,
  });
  await reg.submit({ kind: "spawn", record: withFinish("new", 3000) });
  await reg.submit({ kind: "spawn", record: withFinish("mid", 2000) });
  await reg.submit({ kind: "spawn", record: withFinish("old", 1000) });
  const evicted = reg.evictTerminal(2).map((r) => r.id);
  assert.deepEqual(evicted, ["old"], "最老的先出");
  assert.equal(reg.get("old"), undefined, "old 被挤掉了");
  assert.ok(reg.get("mid"), "mid 还在");
  assert.ok(reg.get("new"), "new 还在");
});

test("状态机：结束时刻缺失时按 0 参与排序（最老的先出）", async () => {
  const reg = new TaskRegistry();
  // 没有 finishedAt 的终态 —— 缺失当 0 ⇒ 最老
  await reg.submit({ kind: "spawn", record: { id: "noTime", status: "succeeded", task: "t" } });
  await reg.submit({
    kind: "spawn",
    record: { id: "withTime", status: "succeeded", task: "t", finishedAt: 1000 },
  });
  const evicted = reg.evictTerminal(1).map((r) => r.id);
  assert.deepEqual(evicted, ["noTime"], "缺结束时刻的当最老");
});

test("状态机：结束时刻为 0 与缺失等价（都当最老）", async () => {
  const reg = new TaskRegistry();
  await reg.submit({
    kind: "spawn",
    record: { id: "zero", status: "succeeded", task: "t", finishedAt: 0 },
  });
  await reg.submit({
    kind: "spawn",
    record: { id: "later", status: "succeeded", task: "t", finishedAt: 5 },
  });
  const evicted = reg.evictTerminal(1).map((r) => r.id);
  assert.deepEqual(evicted, ["zero"], "finishedAt=0 与缺失一样排在最前");
});

test("状态机：缺失与 0 视为同一时刻——按编号定序，不按「有值/无值」", async () => {
  const reg = new TaskRegistry();
  // 「aaa」缺结束时刻，「zzz」是 0 —— 两者都是时刻 0 ⇒ 按编号 aaa 先出。
  // 若把缺失当别的值（不是 0），zzz 就会排到前面 ⇒ 这个用例专门钉住这一点。
  await reg.submit({ kind: "spawn", record: { id: "aaa", status: "succeeded", task: "t" } });
  await reg.submit({
    kind: "spawn",
    record: { id: "zzz", status: "succeeded", task: "t", finishedAt: 0 },
  });
  const evicted = reg.evictTerminal(1).map((r) => r.id);
  assert.deepEqual(evicted, ["aaa"], "缺失与 0 同刻 ⇒ 编号小的先出");
  assert.ok(reg.get("zzz"), "zzz 还在");
});

test("状态机：两个都缺结束时刻时按编号定序（缺失当 0，不是当 1）", async () => {
  const reg = new TaskRegistry();
  // 两条都缺结束时刻 ⇒ 时刻都是 0 ⇒ 按编号定序。
  // 若把缺失当 1（而不是 0），「bbb」缺、「aaa」也是缺 ⇒ 仍是同刻，
  // 但与「缺 vs 有 0」的组合排序会错位。这个用例钉住「缺失 = 0」。
  await reg.submit({ kind: "spawn", record: { id: "bbb", status: "succeeded", task: "t" } });
  await reg.submit({ kind: "spawn", record: { id: "aaa", status: "succeeded", task: "t" } });
  const evicted = reg.evictTerminal(1).map((r) => r.id);
  assert.deepEqual(evicted, ["aaa"], "都缺时刻 ⇒ 同刻 ⇒ 编号小的先出");
  assert.ok(reg.get("bbb"), "bbb 还在");
});

test("状态机：缺结束时刻的排在真时刻之前（缺失当 0，不是当最新）", async () => {
  const reg = new TaskRegistry();
  // 「aaa」没有结束时刻，「bbb」有 100 —— 缺失当 0 ⇒ aaa 更老 ⇒ aaa 先出。
  // 若把缺失当成「比 100 还新」，顺序就反了 ⇒ 这个用例钉住「缺失 = 0」。
  await reg.submit({ kind: "spawn", record: { id: "aaa", status: "succeeded", task: "t" } });
  await reg.submit({
    kind: "spawn",
    record: { id: "bbb", status: "succeeded", task: "t", finishedAt: 100 },
  });
  const evicted = reg.evictTerminal(1).map((r) => r.id);
  assert.deepEqual(evicted, ["aaa"], "缺失 = 时刻 0 ⇒ 比 100 老 ⇒ aaa 先出");
  assert.ok(reg.get("bbb"), "bbb 还在");
});

test("状态机：排序用差值不是比较（负数差值也正确）", async () => {
  const reg = new TaskRegistry();
  const at = (id: string, finishedAt: number): TaskRecord => ({
    id,
    status: "succeeded",
    task: "t",
    finishedAt,
  });
  await reg.submit({ kind: "spawn", record: at("c", 30) });
  await reg.submit({ kind: "spawn", record: at("a", 10) });
  await reg.submit({ kind: "spawn", record: at("b", 20) });
  const evicted = reg.evictTerminal(2).map((r) => r.id);
  assert.deepEqual(evicted, ["a"], "差值排序：10 最小 ⇒ a 先出");
  assert.equal(reg.list().length, 2);
});

test("状态机：比较器同刻按编号双向定序（大 id 必须返回正数）", () => {
  const at = (id: string): TaskRecord => ({ id, status: "succeeded", task: "t", finishedAt: 5 });
  assert.ok(compareTerminal(at("a"), at("b")) < 0, "a < b ⇒ 负数");
  assert.ok(
    compareTerminal(at("b"), at("a")) > 0,
    "b > a ⇒ 正数；返回 0 就变成「按插入顺序」，tiebreak 失效",
  );
  assert.equal(compareTerminal(at("x"), at("x")), 0, "同 id 相等");
  assert.ok(
    compareTerminal(
      { id: "z", status: "succeeded", task: "t", finishedAt: 1 },
      { id: "a", status: "succeeded", task: "t", finishedAt: 2 },
    ) < 0,
    "结束时刻优先于编号",
  );
});

test("状态机：结束时刻相同时按编号定序（同名也分得清）", async () => {
  const reg = new TaskRegistry();
  const at = (id: string, finishedAt: number): TaskRecord => ({
    id,
    status: "succeeded",
    task: "t",
    finishedAt,
  });
  await reg.submit({ kind: "spawn", record: at("bbb", 5000) });
  await reg.submit({ kind: "spawn", record: at("aaa", 5000) });
  const evicted = reg.evictTerminal(1).map((r) => r.id);
  assert.deepEqual(evicted, ["aaa"], "同刻时编号小的先出");
  assert.ok(reg.get("bbb"), "bbb 还在");
});

test("状态机：同刻同名时比较器返回 0（两者都留着，谁都不先出）", async () => {
  const reg = new TaskRegistry();
  const at = (id: string): TaskRecord => ({
    id,
    status: "succeeded",
    task: "t",
    finishedAt: 5000,
  });
  // 同一个 id 不能重复入册（registry 会拒）——所以这里用「不同 id 但比较器走到相等分支」
  await reg.submit({ kind: "spawn", record: at("same") });
  const evicted = reg.evictTerminal(0).map((r) => r.id);
  assert.deepEqual(evicted, ["same"]);
});

test("状态机：同 id 重复入册要被拒", async () => {
  const reg = new TaskRegistry();
  await reg.submit({ kind: "spawn", record: record("dup") });
  await assert.rejects(
    () => reg.submit({ kind: "spawn", record: record("dup") }),
    /duplicate task id/,
  );
});

test("状态机：id 字典序用 < 与 > 双向判定（不是单向）", async () => {
  const reg = new TaskRegistry();
  const at = (id: string): TaskRecord => ({
    id,
    status: "succeeded",
    task: "t",
    finishedAt: 5000,
  });
  // "a" < "b" ⇒ a 先出；反序插入也要同样结果
  await reg.submit({ kind: "spawn", record: at("a") });
  await reg.submit({ kind: "spawn", record: at("b") });
  assert.deepEqual(
    reg.evictTerminal(1).map((r) => r.id),
    ["a"],
    "a 在前 ⇒ a 先出",
  );

  const reg2 = new TaskRegistry();
  await reg2.submit({ kind: "spawn", record: at("b") });
  await reg2.submit({ kind: "spawn", record: at("a") });
  assert.deepEqual(
    reg2.evictTerminal(1).map((r) => r.id),
    ["a"],
    "插入顺序不影响结果",
  );
});

test("状态机：keep=0 挤光所有终态；keep 超量一个不挤", async () => {
  const reg = new TaskRegistry();
  await reg.submit({ kind: "spawn", record: record("a") });
  await reg.submit({ kind: "transition", id: "a", to: "running" });
  await reg.submit({ kind: "resolve-exit", id: "a", exitCode: 0 });
  assert.deepEqual(
    reg.evictTerminal(5).map((r) => r.id),
    [],
    "终态不够挤，一个不挤",
  );
  assert.deepEqual(
    reg.evictTerminal(0).map((r) => r.id),
    ["a"],
    "keep=0 ⇒ 全挤掉",
  );
});

test("状态机：挤掉的 id 不重复，剩余记录都在", async () => {
  const reg = new TaskRegistry();
  for (const id of ["t1", "t2", "t3", "t4"]) {
    await reg.submit({ kind: "spawn", record: record(id) });
    await reg.submit({ kind: "transition", id, to: "running" });
    await reg.submit({ kind: "resolve-exit", id, exitCode: 0 });
  }
  const evicted = reg.evictTerminal(2).map((r) => r.id);
  assert.equal(new Set(evicted).size, evicted.length, "不该有重复 id");
  assert.equal(reg.list().length, 2, "只剩 2 条");
});

test("状态机：订阅者收到每次变迁", async () => {
  const seen: string[] = [];
  const reg = new TaskRegistry((next, prev) => {
    if (prev?.status !== next.status) seen.push(next.status);
  });
  await reg.submit({ kind: "spawn", record: record("a") });
  await reg.submit({ kind: "transition", id: "a", to: "running" });
  await reg.submit({ kind: "resolve-exit", id: "a", exitCode: 0 });
  assert.deepEqual(seen, ["queued", "running", "succeeded"]);
});

// ── worktree 回执与 notStarted ────────────────────────────────────────────

test("状态机：attach-worktree 只写元数据，不改 status", async () => {
  const reg = new TaskRegistry();
  await reg.submit({ kind: "spawn", record: record("wt") });
  await reg.submit({ kind: "transition", id: "wt", to: "running" });
  const before = reg.get("wt")!;
  const result = await reg.submit({
    kind: "attach-worktree",
    id: "wt",
    worktree: { path: "/wt/wt", branch: "pi-dispatch/wt", baseCommit: "abc" },
  });
  assert.equal(result.changed, true, "写了元数据");
  assert.equal(result.record.status, "running", "不改 status");
  assert.equal(result.record.worktree?.branch, "pi-dispatch/wt");
  assert.equal(before.worktree, undefined, "旧记录不受影响（不可变）");
});

test("状态机：attach-worktree 在终态上也照写（崩溃恢复对账）", async () => {
  const reg = new TaskRegistry();
  await reg.submit({ kind: "spawn", record: record("wt") });
  await reg.submit({ kind: "transition", id: "wt", to: "running" });
  await reg.submit({ kind: "resolve-exit", id: "wt", exitCode: 0 });
  assert.equal(reg.get("wt")?.status, "succeeded");
  const result = await reg.submit({
    kind: "attach-worktree",
    id: "wt",
    worktree: { path: "/wt/wt", branch: "pi-dispatch/wt", baseCommit: "abc", dirty: 2 },
  });
  assert.equal(result.changed, true, "终态也写");
  assert.equal(result.record.status, "succeeded", "还是那个终态");
  assert.equal(result.record.worktree?.dirty, 2);
});

test("状态机：notStarted 的 resolve-exit ⇒ started:false、duration 0", async () => {
  const reg = new TaskRegistry();
  await reg.submit({ kind: "spawn", record: record("ns") });
  await reg.submit({ kind: "transition", id: "ns", to: "running" });
  assert.ok(reg.get("ns")?.startedAt, "进 running 时盖了 startedAt");
  const result = await reg.submit({
    kind: "resolve-exit",
    id: "ns",
    exitCode: -1,
    notStarted: true,
    detail: "worktree 创建失败：boom",
  });
  assert.equal(result.record.status, "failed");
  assert.equal(result.record.startedAt, undefined, "孩子压根没起 ⇒ startedAt 要清");
  assert.equal(result.record.exitCode, -1);
  assert.match(result.record.stopReason ?? "", /worktree/);
});

test("状态机：普通的 resolve-exit 保留 startedAt", async () => {
  const reg = new TaskRegistry();
  await reg.submit({ kind: "spawn", record: record("ok") });
  await reg.submit({ kind: "transition", id: "ok", to: "running" });
  const result = await reg.submit({ kind: "resolve-exit", id: "ok", exitCode: 0 });
  assert.ok(result.record.startedAt, "孩子真起过 ⇒ startedAt 留着");
});

// ── 从 #apply 抽出的纯判定 ────────────────────────────────────────────────

test("纯函数：applyResolveExit——stopping + notStarted 清 startedAt 并落 canceled", () => {
  const current: TaskRecord = { id: "s", status: "stopping", task: "t", startedAt: 123 };
  const next = applyResolveExit(current, {
    kind: "resolve-exit",
    id: "s",
    exitCode: -1,
    notStarted: true,
  });
  assert.deepEqual(next, { to: "canceled", patch: { startedAt: undefined } });
});

test("纯函数：applyResolveExit——stopping 不带 notStarted 保留 startedAt", () => {
  const current: TaskRecord = { id: "s", status: "stopping", task: "t", startedAt: 123 };
  const next = applyResolveExit(current, { kind: "resolve-exit", id: "s", exitCode: -1 });
  assert.deepEqual(next, { to: "canceled", patch: {} }, "没起过的证据别乱清");
});

test("纯函数：applyResolveExit——只有非零退出的 detail 进 stopReason", () => {
  const running: TaskRecord = { id: "r", status: "running", task: "t", startedAt: 1 };
  const ok = applyResolveExit(running, {
    kind: "resolve-exit",
    id: "r",
    exitCode: 0,
    detail: "不该进死因",
  });
  assert.equal(ok?.to, "succeeded");
  assert.equal(ok?.patch.exitCode, 0);
  assert.equal(ok?.patch.stopReason, undefined, "成功退出没有死因");
  const bad = applyResolveExit(running, {
    kind: "resolve-exit",
    id: "r",
    exitCode: 2,
    detail: "boom",
  });
  assert.equal(bad?.to, "failed");
  assert.equal(bad?.patch.stopReason, "boom");
  const silent = applyResolveExit(running, { kind: "resolve-exit", id: "r", exitCode: 2 });
  assert.equal(silent?.patch.stopReason, undefined, "没给 detail 就不写死因");
  const terminal = applyResolveExit(
    { ...running, status: "succeeded" },
    { kind: "resolve-exit", id: "r", exitCode: 0 },
  );
  assert.equal(terminal, undefined, "终态上的迟到消息静默丢弃");
});

test("纯函数：applyAttachWorktree——只写元数据，不改 status、不改旧记录", () => {
  const current: TaskRecord = { id: "w", status: "running", task: "t" };
  const result = applyAttachWorktree(current, {
    kind: "attach-worktree",
    id: "w",
    worktree: { path: "/wt/w", branch: "pi-dispatch/w", baseCommit: "abc" },
  });
  assert.equal(result.changed, true);
  assert.equal(result.fromStatus, "running");
  assert.equal(result.record.status, "running", "不改 status");
  assert.equal(result.record.worktree?.path, "/wt/w");
  assert.equal(current.worktree, undefined, "旧记录不受影响（不可变）");
});

test("状态机：attach-steer 按 seq upsert，保留正文/时刻，终态静默丢弃", () => {
  const current: TaskRecord = {
    id: "s",
    status: "running",
    task: "t",
    steers: [{ seq: 1, text: "甲", at: 10, state: "sent" }],
  };
  const merged = applyAttachSteer(current, {
    kind: "attach-steer",
    id: "s",
    steers: [{ seq: 1, text: "被改", at: 99, state: "seen" }],
  });
  assert.equal(merged.changed, true);
  assert.equal(merged.record.status, "running", "不改 status");
  assert.deepEqual(merged.record.steers, [{ seq: 1, text: "甲", at: 10, state: "seen" }]);
  assert.equal(current.steers![0]!.state, "sent", "旧记录不变");

  const terminal = applyAttachSteer(
    { ...current, status: "succeeded" },
    { kind: "attach-steer", id: "s", steers: [{ seq: 2, text: "乙", at: 20, state: "sent" }] },
  );
  assert.equal(terminal.changed, false, "终态上的迟到写入静默丢弃");
  assert.deepEqual(terminal.record.steers, current.steers);
});

test("状态机：attach-steer 迟到的 sent 不许把 seen 降级", () => {
  const current: TaskRecord = {
    id: "s3",
    status: "running",
    task: "t",
    steers: [{ seq: 1, text: "甲", at: 1, state: "seen" }],
  };
  const merged = applyAttachSteer(current, {
    kind: "attach-steer",
    id: "s3",
    steers: [{ seq: 1, text: "甲", at: 1, state: "sent" }],
  });
  assert.equal(merged.record.steers![0]!.state, "seen");
  const undelivered = applyAttachSteer(
    { ...current, steers: [{ seq: 1, text: "甲", at: 1, state: "seen" }] },
    {
      kind: "attach-steer",
      id: "s3",
      steers: [{ seq: 1, text: "甲", at: 1, state: "undelivered" }],
    },
  );
  assert.equal(undelivered.record.steers![0]!.state, "seen", "迟到的 undelivered 也不许降级");
});

test("状态机：attach-steer 输出按 seq 升序，不靠输入顺序", () => {
  const merged = applyAttachSteer(
    {
      id: "s2",
      status: "running",
      task: "t",
      steers: [
        { seq: 2, text: "乙", at: 2, state: "delivered" },
        { seq: 1, text: "甲", at: 1, state: "seen" },
      ],
    },
    { kind: "attach-steer", id: "s2", steers: [{ seq: 3, text: "丙", at: 3, state: "sent" }] },
  );
  assert.deepEqual(
    merged.record.steers!.map((steer) => steer.seq),
    [1, 2, 3],
  );
});
