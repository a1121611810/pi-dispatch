// TUI 常驻面：渲染纯函数 + registry 订阅接线。
//
// 等价变异（mutator 杀不掉，且在可达输入上确实等价）：
//   src/tui.ts 剩 10 个 ?? / ?. / 兜底字面量变异点——
//   · snippet（41 行）：split("\n", 1) 恒有 [0]（?. 无意义）；trim() 只回 string，
//     "" 时 ?? 与 || 都得 ""（?? -> || 等价）。
//   · byAge 排序（67 行）：(startedAt ?? 0) 对数字 ?? 与 || 等价；?? 1 只在 startedAt
//     缺失时有别，而排序集（running/stopping）经 registry 转 running 必盖 startedAt——
//     缺失输入只存在于手搓测试夹具，不经 registry 的可达路径。
//   · ACTIVE_TEXT（69 行）：值全非空串；未知 status 时 undefined ?? r.status
//     与 undefined || r.status 同值。
//   · attachTuiSurface（115/117 行）：opts.owner 类型上无 null（?? 与 || 等价）；
//     processStartMs 的 ps 失败兜底同理，且要触达需 mock 模块导入，非可达路径。
//   其余变异点全部被杀（49 个里 39 个，见 mutator 输出）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskRegistry } from "../src/core/registry.ts";
import type { TaskRecord, TaskStatus } from "../src/core/types.ts";
import {
  attachTuiSurface,
  isSessionRecord,
  renderStatusText,
  renderWidgetLines,
  TUI_STATUS_KEY,
  TUI_WIDGET_KEY,
  type TuiOwner,
} from "../src/tui.ts";

const OWNER: TuiOwner = { pid: 4242, startMs: 1000 };

function rec(partial: Partial<TaskRecord> & { id: string; status: TaskStatus; task: string }) {
  return { ownerPid: OWNER.pid, ownerStartMs: OWNER.startMs, ...partial } as TaskRecord;
}

/** 假 ui：记录调用序列（op 区分 widget/status——生产里两个槽同 key），可选全抛。 */
function fakeUi(throwing = false) {
  const calls: Array<{ op: string; key: string; value: string[] | string | undefined }> = [];
  const make =
    (op: string) =>
    (key: string, value: string[] | string | undefined): void => {
      if (throwing) throw new Error("ui gone");
      calls.push({ op, key, value });
    };
  return { calls, ui: { setWidget: make("widget"), setStatus: make("status") } };
}

test("tui：无记录不挂面板", () => {
  assert.equal(renderWidgetLines([], OWNER), undefined);
  assert.equal(renderStatusText([], OWNER), undefined);
});

test("tui：别家会话的记录不混进来", () => {
  // 模拟 restore 装回的别家记录：owner 戳对不上（或根本没有）
  const others: TaskRecord[] = [
    rec({ id: "aaaaaaaa", status: "running", task: "别家的活", ownerPid: 1, ownerStartMs: 2 }),
    rec({ id: "bbbbbbbb", status: "succeeded", task: "别家的历史", ownerPid: undefined }),
    rec({ id: "cccccccc", status: "queued", task: "无戳", ownerPid: undefined }),
  ];
  assert.equal(renderWidgetLines(others, OWNER), undefined);
  assert.equal(renderStatusText(others, OWNER), undefined);
});

test("tui：isSessionRecord 两个戳都要对", () => {
  assert.equal(isSessionRecord(rec({ id: "x", status: "queued", task: "t" }), OWNER), true);
  assert.equal(
    isSessionRecord(rec({ id: "x", status: "queued", task: "t", ownerPid: 1 }), OWNER),
    false,
  );
  assert.equal(
    isSessionRecord(rec({ id: "x", status: "queued", task: "t", ownerStartMs: 999 }), OWNER),
    false,
  );
});

test("tui：在飞与排队给出汇总行和逐条行", () => {
  const records = [
    rec({ id: "1111aaaa", status: "running", task: "读日志", startedAt: 20 }),
    rec({ id: "2222bbbb", status: "stopping", task: "收一半的活", startedAt: 10 }),
    rec({ id: "3333cccc", status: "queued", task: "写报告" }),
    rec({ id: "4444dddd", status: "succeeded", task: "干完的活", startedAt: 5, finishedAt: 8 }),
  ];
  const lines = renderWidgetLines(records, OWNER);
  assert.ok(lines);
  assert.equal(lines.length, 4);
  // 在飞 = running + stopping，两个都要在场（差一个总数就错）
  assert.match(lines[0], /在飞 2 · 排队 1/);
  assert.match(lines[0], /成功 1 · 失败 0 · 取消 0 · 丢失 0/);
  // 在飞按开始时刻升序：先派的在上
  assert.match(lines[1], /#2222bbbb 收队 收一半的活/);
  assert.match(lines[2], /#1111aaaa 在飞 读日志/);
  assert.match(lines[3], /#3333cccc 排队 写报告/);
  // 没有败/丢时 footer 是干净形态（不带败/丢后缀）
  assert.equal(renderStatusText(records, OWNER), "派单 在飞2 · 排队1");
  // 在飞 == 排队 时：和为 2（非零要显示），差为 0（漏了就当空闲清掉）
  const oneEach = [
    rec({ id: "5555eeee", status: "running", task: "一个", startedAt: 30 }),
    rec({ id: "6666ffff", status: "queued", task: "一个" }),
  ];
  assert.equal(renderStatusText(oneEach, OWNER), "派单 在飞1 · 排队1");
});

test("tui：任务描述取首行并截断", () => {
  const long = "一".repeat(60);
  const records = [
    rec({ id: "1111aaaa", status: "running", task: `${long}\n第二行`, startedAt: 10 }),
  ];
  const lines = renderWidgetLines(records, OWNER);
  assert.ok(lines);
  // 整行等值：首行取第一行、36 字处截断砍尾不砍头
  assert.equal(lines[1], `#1111aaaa 在飞 ${"一".repeat(36)}…`);
  // # + 8 位 id + 空格 + 状态两字 + 空格 + 截断片段（36 字 + …）
  assert.ok(lines[1].length <= 1 + 8 + 1 + 2 + 1 + 36 + 1);
});

test("tui：行预算 10 行——超了汇总打头、尾行报还有几个", () => {
  const records = Array.from({ length: 13 }, (_, i) =>
    rec({ id: `${i}`.repeat(8), status: "running", task: `任务${i}`, startedAt: i }),
  );
  const lines = renderWidgetLines(records, OWNER);
  assert.ok(lines);
  assert.equal(lines.length, 10);
  assert.match(lines[9], /还有 5 个/);
  assert.match(lines[0], /在飞 13/);
});

test("tui：行预算边界——9 个任务不触发还有行", () => {
  const records = Array.from({ length: 9 }, (_, i) =>
    rec({ id: `${i}`.repeat(8), status: "running", task: `任务${i}`, startedAt: i }),
  );
  const lines = renderWidgetLines(records, OWNER);
  assert.ok(lines);
  assert.equal(lines.length, 10); // 汇总 1 + 任务 9
  assert.ok(!lines.at(-1)?.includes("还有"));
  assert.match(lines.at(-1) ?? "", /#88888888 在飞 任务8/);
});

test("tui：全部终态即清", () => {
  const records = [
    rec({ id: "1111aaaa", status: "failed", task: "翻车的活", startedAt: 5, finishedAt: 8 }),
  ];
  assert.equal(renderWidgetLines(records, OWNER), undefined);
  assert.equal(renderStatusText(records, OWNER), undefined);
});

test("tui：footer 报败/丢合计", () => {
  const records = [
    rec({ id: "1111aaaa", status: "running", task: "在飞", startedAt: 10 }),
    rec({ id: "2222bbbb", status: "stopping", task: "收", startedAt: 12 }),
    rec({ id: "3333cccc", status: "failed", task: "翻", startedAt: 5, finishedAt: 8 }),
  ];
  // 1 running + 1 stopping = 在飞2；单个 failed 也要报（>0 不是 >1）
  assert.equal(renderStatusText(records, OWNER), "派单 在飞2 · 排队0 · 败/丢1");
});

test("tui：attach 订阅 registry——spawn 上面板，终态清面板", async () => {
  const registry = new TaskRegistry();
  const { calls, ui } = fakeUi();
  attachTuiSurface({ registry, ui, owner: OWNER });

  await registry.submit({
    kind: "spawn",
    record: rec({ id: "1111aaaa", status: "queued", task: "排着的活" }),
  });
  const widgetAfter = calls.filter((c) => c.op === "widget").at(-1);
  assert.ok(Array.isArray(widgetAfter?.value));

  await registry.submit({ kind: "transition", id: "1111aaaa", to: "running" });
  await registry.submit({ kind: "resolve-exit", id: "1111aaaa", exitCode: 0 });
  const widgetFinal = calls.filter((c) => c.op === "widget").at(-1);
  assert.equal(widgetFinal?.value, undefined);
  const statusFinal = calls.filter((c) => c.op === "status").at(-1);
  assert.equal(statusFinal?.value, undefined);
});

test("tui：attach 挂载即推一次当前状态", async () => {
  const registry = new TaskRegistry();
  const { calls, ui } = fakeUi();
  await registry.submit({
    kind: "spawn",
    record: rec({ id: "1111aaaa", status: "running", task: "在飞", startedAt: 10 }),
  });
  calls.length = 0;
  attachTuiSurface({ registry, ui, owner: OWNER });
  assert.equal(calls.length, 2); // widget + status 各一
  assert.ok(Array.isArray(calls.find((c) => c.op === "widget")?.value));
});

test("tui：cleanup 清面板", async () => {
  const registry = new TaskRegistry();
  const { calls, ui } = fakeUi();
  const detach = attachTuiSurface({ registry, ui, owner: OWNER });
  await registry.submit({
    kind: "spawn",
    record: rec({ id: "1111aaaa", status: "running", task: "在飞", startedAt: 10 }),
  });
  calls.length = 0;
  detach();
  assert.deepEqual(
    calls.map((c) => [c.op, c.key, c.value]),
    [
      ["widget", TUI_WIDGET_KEY, undefined],
      ["status", TUI_STATUS_KEY, undefined],
    ],
  );
});

test("tui：ui 抛错不冒泡（best-effort）", async () => {
  const registry = new TaskRegistry();
  const { ui } = fakeUi(true);
  attachTuiSurface({ registry, ui, owner: OWNER }); // 挂载时的首次推送就抛
  await registry.submit({
    kind: "spawn",
    record: rec({ id: "1111aaaa", status: "running", task: "在飞", startedAt: 10 }),
  });
});
