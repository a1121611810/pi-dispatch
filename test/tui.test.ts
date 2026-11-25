// TUI 常驻面：渲染纯函数 + registry 订阅接线。
//
// 等价变异（mutator 杀不掉，且在可达输入上确实等价）：
//   src/tui.ts 剩 14 个 ?? / ?. / 兜底字面量变异点：
//   · snippet（41 行）：split("\n", 1) 恒有 [0]（?. 无意义）；trim() 只回 string，
//     "" 时 ?? 与 || 都得 ""（?? -> || 等价）。
//   · byAge 排序（67 行）：(startedAt ?? 0) 对数字 ?? 与 || 等价；?? 1 只在 startedAt
//     缺失时有别，而排序集（running/stopping）经 registry 转 running 必盖 startedAt——
//     缺失输入只存在于手搓测试夹具，不经 registry 的可达路径。
//   · ACTIVE_TEXT（69 行）：值全非空串；未知 status 时 undefined ?? r.status
//     与 undefined || r.status 同值。
//   · currentOwner（100 行）：processStartMs 对活进程返回毫秒时间戳（非 0），
//     ?? 与 || 同值；兜底 0 -> 1 只在 ps 失败时可达，要 mock 模块导入，非可达路径。
//   · attachTuiSurface（204 行）：opts.owner 类型上无 null（?? 与 || 等价）；
//     processStartMs 的 ps 失败兜底同上，非可达路径。
//   其余变异点全部被杀（74 个里 14 个存活；runSteerCommand 13/13，见 mutator 输出）。
//   · costHint（49 行）：**全部杀掉**（`?.` → `.`、`&&` → `||`、`> 0` → `>= 0`、
//     `> 0` → `> 1`）——由「tui：行内带预算到点与档位降级提示」守：它同时覆盖
//     「thinking 键不存在」（`?.` 那条）、「只降档没到点」与「什么都没发生」两种输入。
import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskRegistry } from "../src/core/registry.ts";
import type { SteerOutcome, TaskRecord, TaskStatus } from "../src/core/types.ts";
import {
  attachTuiSurface,
  isSessionRecord,
  renderStatusText,
  renderSteerOptions,
  renderWidgetLines,
  runSteerCommand,
  runningSteerTargets,
  steerReceipt,
  TUI_STATUS_KEY,
  TUI_WIDGET_KEY,
  type SteerDeps,
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
  assert.match(lines[0]!, /在飞 2 · 排队 1/);
  assert.match(lines[0]!, /跑完 1 · 失败 0 · 取消 0 · 丢失 0/);
  // 在飞按开始时刻升序：先派的在上
  assert.match(lines[1]!, /#2222bbbb 收队 收一半的活/);
  assert.match(lines[2]!, /#1111aaaa 在飞 读日志/);
  assert.match(lines[3]!, /#3333cccc 排队 写报告/);
  // 没有败/丢时 footer 是干净形态（不带败/丢后缀）
  assert.equal(renderStatusText(records, OWNER), "派单 在飞2 · 排队1");
  // 在飞 == 排队 时：和为 2（非零要显示），差为 0（漏了就当空闲清掉）
  const oneEach = [
    rec({ id: "5555eeee", status: "running", task: "一个", startedAt: 30 }),
    rec({ id: "6666ffff", status: "queued", task: "一个" }),
  ];
  assert.equal(renderStatusText(oneEach, OWNER), "派单 在飞1 · 排队1");
});

test("tui：行内带预算到点与档位降级提示", () => {
  const records = [
    rec({
      id: "1111aaaa",
      status: "running",
      task: "烧钱的活",
      startedAt: 10,
      budgetExhausted: true,
      thinking: { requested: "high", effective: "low", adjusted: true, modelKnown: true },
    }),
    rec({
      id: "2222bbbb",
      status: "running",
      task: "普通的活",
      startedAt: 20,
      thinking: { requested: "low", effective: "low", adjusted: false, modelKnown: true },
    }),
    // 只降了档、没到预算 ⇒ 只有一条提示（不许把两条都挂上）
    rec({
      id: "3333cccc",
      status: "running",
      task: "降过档的活",
      startedAt: 30,
      thinking: { requested: "medium", effective: "low", adjusted: true, modelKnown: true },
    }),
    // 压根没解析过档位（没给 thinkingLevel）⇒ thinking 键不存在
    rec({ id: "4444dddd", status: "running", task: "没档位的活", startedAt: 40 }),
  ];
  const lines = renderWidgetLines(records, OWNER);
  assert.ok(lines);
  // 在飞按开始时刻升序
  assert.match(lines[1]!, /#1111aaaa 在飞 烧钱的活｜预算到点｜档位 high→low/);
  // 没到点、也没降档 ⇒ 不占位（提示只在真发生时出现）
  assert.equal(lines[2], "#2222bbbb 在飞 普通的活");
  // 只有档位提示 ⇒ 一条，不多不少
  assert.equal(lines[3], "#3333cccc 在飞 降过档的活｜档位 medium→low");
  // 没有 thinking 回执 ⇒ 不崩、不出提示
  assert.equal(lines[4], "#4444dddd 在飞 没档位的活");
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
  // 边界：恰好 36 字不加省略号，37 字才截（> 不是 >=）
  assert.equal(
    renderWidgetLines(
      [rec({ id: "1111aaaa", status: "running", task: "二".repeat(36) })],
      OWNER,
    )?.[1],
    `#1111aaaa 在飞 ${"二".repeat(36)}`,
  );
  assert.equal(
    renderWidgetLines(
      [rec({ id: "1111aaaa", status: "running", task: "二".repeat(37) })],
      OWNER,
    )?.[1],
    `#1111aaaa 在飞 ${"二".repeat(36)}…`,
  );
});

test("tui：1 在飞 + 1 排队仍在场（相加不是相减）", () => {
  const lines = renderWidgetLines(
    [
      rec({ id: "1111aaaa", status: "running", task: "飞", startedAt: 1 }),
      rec({ id: "2222bbbb", status: "queued", task: "排" }),
    ],
    OWNER,
  );
  assert.ok(lines, "active+queued 相减会让面板整体消失");
  assert.equal(lines.length, 3);
});

test("tui：行预算 10 行——超了汇总打头、尾行报还有几个", () => {
  const records = Array.from({ length: 13 }, (_, i) =>
    rec({ id: `${i}`.repeat(8), status: "running", task: `任务${i}`, startedAt: i }),
  );
  const lines = renderWidgetLines(records, OWNER);
  assert.ok(lines);
  assert.equal(lines.length, 10);
  assert.match(lines[9]!, /还有 5 个/);
  assert.match(lines[0]!, /在飞 13/);
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
  // 败与丢是相加不是相减：各有 1 个时合计 2
  records.push(rec({ id: "4444dddd", status: "lost", task: "丢", startedAt: 6, finishedAt: 9 }));
  assert.equal(renderStatusText(records, OWNER), "派单 在飞2 · 排队0 · 败/丢2");
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

// ── /steer 人入口 ─────────────────────────────────────────────────────────

/** steerReceipt 只接成功分支——收据要写 seq / state。 */
type SteerOk = Extract<SteerOutcome, { ok: true }>;

function steerOutcome(ok: boolean, taskId = "1111aaaa", seq = 1): SteerOutcome {
  return ok
    ? { ok: true, taskId, seq, state: "sent", path: "/tmp/x" }
    : { ok: false, taskId, error: "task is succeeded, not running" };
}

function fakeSteerUi(answers: { select?: string | undefined; input?: string | undefined } = {}) {
  const calls: string[] = [];
  return {
    calls,
    ui: {
      async select(title: string, options: string[]): Promise<string | undefined> {
        calls.push(`select:${title}:${options.join("|")}`);
        return answers.select;
      },
      async input(title: string): Promise<string | undefined> {
        calls.push(`input:${title}`);
        return answers.input;
      },
      notify(message: string, level: string): void {
        calls.push(`notify:${level}:${message}`);
      },
    },
  };
}

/**
 * 假绿元测试钩子：只由 test/test-runner.test.ts 的子进程注入。
 * 正常环境恒等；sabotage 时故意让 fake 说假话，验证断言真在盯实现而不是 fake 自己。
 *   no-steer  —— 只回 ok，不调真正的 steer（模拟「只 notify 不调引擎」）
 *   wrong-id  —— 转向错误的 taskId
 *   label-id  —— 把选项文案当 id 传下去
 */
const SABOTAGE = process.env.PI_DISPATCH_SABOTAGE ?? "";

function sabotageSteer(steer: SteerDeps["steer"]): SteerDeps["steer"] {
  switch (SABOTAGE) {
    case "no-steer":
      return async (taskId) => steerOutcome(true, taskId);
    case "wrong-id":
      return (taskId, text) => steer(`wrong-${taskId}`, text);
    case "label-id":
      return (taskId, text) => steer(`1) #${taskId.slice(0, 8)}`, text);
    default:
      return steer;
  }
}

function steerDeps(
  records: TaskRecord[],
  ui: ReturnType<typeof fakeSteerUi>["ui"],
  args = "",
  overrides: Partial<SteerDeps> = {},
): SteerDeps {
  const deps: SteerDeps = {
    hasUI: true,
    args,
    owner: OWNER,
    records,
    ui,
    steer: async () => steerOutcome(true),
    ...overrides,
  };
  return { ...deps, steer: sabotageSteer(deps.steer) };
}

test("steer：0 个在飞只 warning，不弹窗不调引擎", async () => {
  const { calls, ui } = fakeSteerUi();
  let steered = 0;
  await runSteerCommand(
    steerDeps([rec({ id: "1111aaaa", status: "queued", task: "排队" })], ui, "", {
      steer: async () => {
        steered++;
        return steerOutcome(true);
      },
    }),
  );
  assert.equal(steered, 0);
  assert.equal(calls.filter((c) => c.startsWith("select")).length, 0);
  assert.match(calls[0]!, /^notify:warning:/);
});

test("steer：单任务跳过 select，引擎收到完整 id 与原文", async () => {
  const { calls, ui } = fakeSteerUi({ input: "  改成先跑测试  " });
  const seen: Array<[string, string]> = [];
  await runSteerCommand(
    steerDeps([rec({ id: "1111aaaa", status: "running", task: "干活" })], ui, "", {
      steer: async (id, text) => {
        seen.push([id, text]);
        return steerOutcome(true, id, 3);
      },
    }),
  );
  assert.deepEqual(seen, [["1111aaaa", "改成先跑测试"]]);
  assert.equal(calls.filter((c) => c.startsWith("select")).length, 0);
  assert.match(calls.at(-1)!, /^notify:info:.*seq 3.*sent/);
});

test("steer：多任务按 index 回映真实 id，不把 label 当 id", async () => {
  const records = [
    rec({ id: "1111aaaa", status: "running", task: "甲", startedAt: 30 }),
    rec({ id: "2222bbbb", status: "running", task: "乙", startedAt: 10 }),
  ];
  const options = renderSteerOptions(runningSteerTargets(records, OWNER));
  const { calls, ui } = fakeSteerUi({ select: options[1], input: "改乙" });
  const seen: string[] = [];
  await runSteerCommand(
    steerDeps(records, ui, "", {
      steer: async (id) => {
        seen.push(id);
        return steerOutcome(true, id);
      },
    }),
  );
  assert.deepEqual(seen, ["1111aaaa"]);
  assert.equal(seen[0]!.includes(")"), false, "select 的文案不是 id");
  assert.equal(
    calls.some((c) => c.startsWith("select")),
    true,
  );
});

test("steer：args 非空跳过 input，多任务仍先选", async () => {
  const records = [
    rec({ id: "1111aaaa", status: "running", task: "甲", startedAt: 1 }),
    rec({ id: "2222bbbb", status: "running", task: "乙", startedAt: 2 }),
  ];
  const options = renderSteerOptions(runningSteerTargets(records, OWNER));
  const { calls, ui } = fakeSteerUi({ select: options[0] });
  const seen: string[] = [];
  await runSteerCommand(
    steerDeps(records, ui, "直接改", {
      steer: async (id, text) => {
        seen.push(`${id}:${text}`);
        return steerOutcome(true, id);
      },
    }),
  );
  assert.deepEqual(seen, ["1111aaaa:直接改"]);
  assert.equal(
    calls.some((c) => c.startsWith("input")),
    false,
  );
});

test("steer：Esc/空输入不写盘", async () => {
  const one = [rec({ id: "1111aaaa", status: "running", task: "活" })];
  for (const answer of [undefined, "   "]) {
    const { calls, ui } = fakeSteerUi({ input: answer });
    let steered = 0;
    await runSteerCommand(
      steerDeps(one, ui, "", {
        steer: async () => {
          steered++;
          return steerOutcome(true);
        },
      }),
    );
    assert.equal(steered, 0);
    assert.equal(
      calls.some((c) => c.startsWith("notify:error")),
      false,
    );
  }
});

test("steer：select 取消/未知项不发送", async () => {
  const records = [
    rec({ id: "1111aaaa", status: "running", task: "甲", startedAt: 1 }),
    rec({ id: "2222bbbb", status: "running", task: "乙", startedAt: 2 }),
  ];
  for (const answer of [undefined, "9) 不存在"]) {
    const { calls, ui } = fakeSteerUi({ select: answer });
    let steered = 0;
    await runSteerCommand(
      steerDeps(records, ui, "", {
        steer: async () => {
          steered++;
          return steerOutcome(true);
        },
      }),
    );
    assert.equal(steered, 0);
    if (answer === undefined) {
      assert.equal(
        calls.some((c) => c.includes("未知选项")),
        false,
        "Esc 是取消，不是错误",
      );
    }
  }
});

test("steer：失败回红字原文，不冒充已受理", async () => {
  const { calls, ui } = fakeSteerUi({ input: "改" });
  await runSteerCommand(
    steerDeps([rec({ id: "1111aaaa", status: "running", task: "活" })], ui, "", {
      steer: async () => steerOutcome(false),
    }),
  );
  assert.match(calls.at(-1)!, /^notify:error:task is succeeded/);
  assert.equal(
    calls.some((c) => c.includes("已受理")),
    false,
  );
});

test("steer：引擎抛异常不冒泡", async () => {
  const { calls, ui } = fakeSteerUi({ input: "改" });
  await runSteerCommand(
    steerDeps([rec({ id: "1111aaaa", status: "running", task: "活" })], ui, "", {
      steer: async () => {
        throw new Error("engine torn down");
      },
    }),
  );
  assert.match(calls.at(-1)!, /^notify:error:转向失败：engine torn down/);
});

test("steer：hasUI=false 全静默", async () => {
  const { calls, ui } = fakeSteerUi({ input: "改" });
  let steered = 0;
  await runSteerCommand(
    steerDeps([rec({ id: "1111aaaa", status: "running", task: "活" })], ui, "", {
      hasUI: false,
      steer: async () => {
        steered++;
        return steerOutcome(true);
      },
    }),
  );
  assert.equal(steered, 0);
  assert.deepEqual(calls, []);
});

test("steer：选项从 1 开始编号，标签用 id 前 8 位", () => {
  const records = [
    rec({ id: "abcdef123456", status: "running", task: "甲", startedAt: 1 }),
    rec({ id: "1234567890ab", status: "running", task: "乙", startedAt: 2 }),
  ];
  assert.deepEqual(renderSteerOptions(records), ["1) #abcdef12 甲", "2) #12345678 乙"]);
});

test("steer：回执用完整 id 前 8 位，不写 path", () => {
  const receipt = steerReceipt(steerOutcome(true, "abcdef123456", 2) as SteerOk);
  assert.match(receipt.text, /#abcdef12/);
  assert.doesNotMatch(receipt.text, /abcde123/);
});

test("steer：只列 running，stopping/queued/终态都不列", () => {
  const records = [
    rec({ id: "1111aaaa", status: "running", task: "在飞" }),
    rec({ id: "2222bbbb", status: "stopping", task: "收队" }),
    rec({ id: "3333cccc", status: "queued", task: "排队" }),
    rec({ id: "4444dddd", status: "succeeded", task: "完成" }),
  ];
  assert.deepEqual(
    runningSteerTargets(records, OWNER).map((r) => r.id),
    ["1111aaaa"],
  );
});

test("steer：owner 不同的在飞任务不列出", () => {
  const records = [
    rec({ id: "1111aaaa", status: "running", task: "自家" }),
    rec({ id: "2222bbbb", status: "running", task: "别家", ownerPid: 1 }),
  ];
  assert.deepEqual(
    runningSteerTargets(records, OWNER).map((r) => r.id),
    ["1111aaaa"],
  );
});

test("steer：成功回执只写 sent，不带 path", () => {
  const receipt = steerReceipt(steerOutcome(true, "abcdef123456", 7) as SteerOk);
  assert.equal(
    receipt.text,
    "已受理 #abcdef12 · seq 7 · state=sent（只代表写进信箱；送达与生效看任务结束通知）",
  );
  assert.equal(receipt.level, "info");
  // 只承诺 sent：不得出现送达/已读/路径等更强口径
  for (const forbidden of ["delivered", "seen", "http", "path", "/tmp"]) {
    assert.equal(receipt.text.includes(forbidden), false, `回执里不该有 ${forbidden}`);
  }
});

// ── 方案补口：排序/owner 三类/args 单任务/Esc 零副作用/退出竞态/重复 label ──

test("steer：多任务按 startedAt 升序给选项，不保留输入序", () => {
  const records = [
    rec({ id: "3333cccc", status: "running", task: "丙", startedAt: 30 }),
    rec({ id: "1111aaaa", status: "running", task: "甲", startedAt: 10 }),
    rec({ id: "2222bbbb", status: "running", task: "乙", startedAt: 20 }),
  ];
  assert.deepEqual(renderSteerOptions(runningSteerTargets(records, OWNER)), [
    "1) #1111aaaa 甲",
    "2) #2222bbbb 乙",
    "3) #3333cccc 丙",
  ]);
});

test("steer：别 pid/缺戳/restore 的在飞任务都不列出", async () => {
  const records = [
    rec({ id: "1111aaaa", status: "running", task: "自家" }),
    rec({ id: "2222bbbb", status: "running", task: "别 pid", ownerPid: 1 }),
    rec({ id: "3333cccc", status: "running", task: "缺戳", ownerPid: undefined }),
    rec({
      id: "4444dddd",
      status: "running",
      task: "restore 装回",
      ownerStartMs: OWNER.startMs - 1,
    }),
  ];
  assert.deepEqual(
    runningSteerTargets(records, OWNER).map((r) => r.id),
    ["1111aaaa"],
  );

  // 只剩异己记录 ⇒ 0 targets：只 warning，不弹选择
  const { calls, ui } = fakeSteerUi();
  let steered = 0;
  await runSteerCommand(
    steerDeps(records.slice(1), ui, "改", {
      steer: async () => {
        steered++;
        return steerOutcome(true);
      },
    }),
  );
  assert.equal(steered, 0);
  assert.equal(
    calls.some((c) => c.startsWith("select")),
    false,
  );
  assert.deepEqual(calls, ["notify:warning:没有在飞任务（排队中的先 dispatch_stop 再重派）"]);
});

test("steer：单任务 args 非空跳过 input，原文直达引擎", async () => {
  const { calls, ui } = fakeSteerUi({ input: "不该被用到" });
  const seen: Array<[string, string]> = [];
  await runSteerCommand(
    steerDeps([rec({ id: "1111aaaa", status: "running", task: "活" })], ui, "直接改", {
      steer: async (id, text) => {
        seen.push([id, text]);
        return steerOutcome(true, id);
      },
    }),
  );
  assert.deepEqual(seen, [["1111aaaa", "直接改"]]);
  assert.equal(calls.filter((c) => c.startsWith("input")).length, 0);
});

test("steer：input Esc 静默，零副作用", async () => {
  const { calls, ui } = fakeSteerUi({ input: undefined });
  let steered = 0;
  await runSteerCommand(
    steerDeps([rec({ id: "1111aaaa", status: "running", task: "活" })], ui, "", {
      steer: async () => {
        steered++;
        return steerOutcome(true);
      },
    }),
  );
  assert.equal(steered, 0);
  assert.equal(calls.length, 1, `只该有 input 调用，实际：${calls.join("|")}`);
  assert.match(calls[0]!, /^input:转向 #1111aaaa：/);
});

test("steer：select 后任务退出，透传 engine 原文且不重试", async () => {
  const records = [
    rec({ id: "1111aaaa", status: "running", task: "甲", startedAt: 1 }),
    rec({ id: "2222bbbb", status: "running", task: "乙", startedAt: 2 }),
  ];
  const options = renderSteerOptions(runningSteerTargets(records, OWNER));
  const { calls, ui } = fakeSteerUi({ select: options[1] });
  const seen: string[] = [];
  await runSteerCommand(
    steerDeps(records, ui, "改", {
      steer: async (id) => {
        seen.push(id);
        return { ok: false, taskId: id, error: "task is succeeded, not running" };
      },
    }),
  );
  assert.deepEqual(seen, ["2222bbbb"], "只发一次，且是选中项");
  assert.equal(calls.filter((c) => c.startsWith("select")).length, 1, "退出后不许二次选择/重试");
  assert.match(calls.at(-1)!, /^notify:error:task is succeeded, not running$/);
  assert.equal(
    calls.some((c) => c.includes("已受理")),
    false,
  );
});

test("steer：重复 label 仍按序号映射到第二项", async () => {
  const records = [
    rec({ id: "abcdef120001", status: "running", task: "同名", startedAt: 1 }),
    rec({ id: "abcdef120002", status: "running", task: "同名", startedAt: 2 }),
  ];
  assert.deepEqual(renderSteerOptions(records), ["1) #abcdef12 同名", "2) #abcdef12 同名"]);
  const { ui } = fakeSteerUi({ select: "2) #abcdef12 同名" });
  const seen: string[] = [];
  await runSteerCommand(
    steerDeps(records, ui, "改", {
      steer: async (id) => {
        seen.push(id);
        return steerOutcome(true, id);
      },
    }),
  );
  assert.deepEqual(seen, ["abcdef120002"]);
});
