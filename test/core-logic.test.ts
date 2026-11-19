// 阶段 2 探针：安检 / 状态机。
// 每个 it 对应一个变异点——变异存活 = 对应探针是假绿的（见计划「第四层 · 假绿测试」）。
//
// 等价变异（探针杀不掉，且也不该杀）：
//   src/core/registry.ts 的 evictTerminal 排序比较器有 5 个变异点在本仓不可达——
//   它们只在「两条记录 id 相同」时才有区别，而 registry 拒绝重复 id（duplicate task id）。
//   已用穷举脚本验证：192 组可达输入（id 互异 × 结束时刻 {缺失,0,1,100}）下，
//   原实现与这 5 个变异体的比较结果符号完全一致 ⇒ 等价，不需要补探针。
//   其余变异点全部被杀（变异杀死率 38/43）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  depthGate,
  dispatchEnabledGate,
  readOnlyGate,
  rejection,
  sessionEndingGate,
  taskTextGate,
  timeoutGate,
  defaultGates,
} from "../src/core/gates.ts";
import { TaskRegistry } from "../src/core/registry.ts";
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
