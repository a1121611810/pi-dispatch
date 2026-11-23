// 门禁自身的环境卫生：继承来的 NODE_TEST_CONTEXT / PI_DISPATCH_DEPTH 会把门禁变成
// 假绿（一条用例不跑，退出码 0）或红错地方（适配层按子代理装配）。
// 端到端用临时夹具跑真跑器——断言「夹具真跑了」，不是「跑器返回 0」。
//
// 副作用：最后一条用例真起一次 `scripts/breakpoints.ts`，期间会临时改写
// scripts/test.ts 再复原（破坏点跑器的正常动作）；挑的是本文件的用例，不碰别人的源文件。
//
// 等价变异（变异器杀不掉，也不该杀）：
//   `plan` 里的 `arg !== "--"` —— `--` 交给 node --test 是「后面当文件」的分隔符，
//     先摘掉与留着都得到同一份文件清单 ⇒ 等价。
//   `result.status ?? 1` 的 1 —— spawnSync 只有被子进程信号带走时 status 为 null，
//     而这里跑的是 node --test，它自己收尾；那条路只有手动 kill 才到得了 ⇒ 等价。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { plan } from "../scripts/test.ts";
import { check, runOne } from "../scripts/breakpoints.ts";
import {
  INHERITED_DISPATCH_DEPTH,
  INHERITED_TEST_CONTEXT,
  scrubbedEnv,
} from "../scripts/test-env.ts";

const RUNNER = fileURLToPath(new URL("../scripts/test.ts", import.meta.url));
const BREAKPOINTS = fileURLToPath(new URL("../scripts/breakpoints.ts", import.meta.url));

/** 临时夹具：一条用例，跑过就写标记（有标记 = 真跑了，不是零命中）。 */
function probeFile(body: string[]): { file: string; marker: string } {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-runner-"));
  const marker = join(dir, "ran.txt");
  const file = join(dir, "probe.test.ts");
  writeFileSync(
    file,
    [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'import { writeFileSync } from "node:fs";',
      ...body,
      "",
    ].join("\n"),
    "utf8",
  );
  return { file, marker };
}

/** 跑一次门禁，返回退出码 + 输出 + 标记内容（undefined = 夹具根本没跑）。 */
function runRunner(
  probe: { file: string; marker: string },
  extraEnv: NodeJS.ProcessEnv,
): { status: number | null; output: string; marker: string | undefined } {
  const result = spawnSync(process.execPath, [RUNNER, probe.file], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, PROBE_MARKER: probe.marker, ...extraEnv },
  });
  let ran: string | undefined;
  try {
    ran = readFileSync(probe.marker, "utf8");
  } catch {
    ran = undefined;
  }
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    marker: ran,
  };
}

test("测试门禁：旗标透传，缺文件时默认整棵 test/", () => {
  assert.deepEqual(plan([]), ["--test", "test/**/*.test.ts"]);
  assert.deepEqual(plan(["--experimental-test-coverage"]), [
    "--test",
    "--experimental-test-coverage",
    "test/**/*.test.ts",
  ]);
  assert.deepEqual(plan(["--test-name-pattern=收件", "test/child.test.ts"]), [
    "--test",
    "--test-name-pattern=收件",
    "test/child.test.ts",
  ]);
});

test("测试环境：继承来的三个变量擦掉、locale 固定，其余原样", () => {
  const env = scrubbedEnv({
    PATH: "/usr/bin",
    PI_MODEL: "m",
    NODE_TEST_CONTEXT: "child-v8",
    NODE_TEST_WORKER_ID: "7",
    PI_DISPATCH_DEPTH: "1",
  });
  assert.deepEqual(env, {
    PATH: "/usr/bin",
    PI_MODEL: "m",
    LC_ALL: "C.UTF-8",
    LANG: "C.UTF-8",
  });

  // 不传 base 时读进程环境：擦口只有一个，不留旁路
  const oldDepth = process.env[INHERITED_DISPATCH_DEPTH];
  process.env[INHERITED_DISPATCH_DEPTH] = "3";
  try {
    assert.equal(INHERITED_DISPATCH_DEPTH in scrubbedEnv(), false);
    assert.equal(
      INHERITED_TEST_CONTEXT.every((key) => key in scrubbedEnv()),
      false,
    );
  } finally {
    if (oldDepth === undefined) delete process.env[INHERITED_DISPATCH_DEPTH];
    else process.env[INHERITED_DISPATCH_DEPTH] = oldDepth;
  }
});

test("测试门禁：在测试进程里也真跑用例（不再假绿，退出码照传）", () => {
  const probe = probeFile([
    `test("夹具：写标记后失败", () => {`,
    `  writeFileSync(process.env.PROBE_MARKER ?? "", "ran");`,
    `  throw new Error("probe-must-run");`,
    `});`,
  ]);
  const run = runRunner(probe, { NODE_TEST_CONTEXT: "child-v8", NODE_TEST_WORKER_ID: "4" });
  assert.equal(run.marker, "ran", "夹具必须真跑：零命中也是退出 0，只看退出码会假绿");
  assert.equal(run.status, 1, "用例失败 ⇒ 门禁非零");
  assert.match(run.output, /probe-must-run/);
});

test("测试门禁：在派发子代理里也擦掉深度（否则适配层按子代理装配）", () => {
  const probe = probeFile([
    `test("夹具：深度标记必须是空的", () => {`,
    `  writeFileSync(process.env.PROBE_MARKER ?? "", String(process.env.PI_DISPATCH_DEPTH ?? "absent"));`,
    `  assert.equal(process.env.PI_DISPATCH_DEPTH, undefined);`,
    `});`,
  ]);
  const run = runRunner(probe, { PI_DISPATCH_DEPTH: "2" });
  assert.equal(run.marker, "absent");
  assert.equal(run.status, 0, run.output);
});

test("测试门禁：0 用例不许退出 0（glob 写错不许假绿）", () => {
  const result = spawnSync(process.execPath, [RUNNER, "test/**/*.nope.ts"], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env },
  });
  assert.notEqual(result.status, 0, "0 用例退出 0 就是假绿");
  assert.match(`${result.stdout ?? ""}${result.stderr ?? ""}`, /一条用例都没跑过/);
});

test("测试门禁：经软链调用也真跑（overlay 把 scripts/ 做成软链）", () => {
  const probe = probeFile([
    `test("夹具：写标记后失败", () => {`,
    `  writeFileSync(process.env.PROBE_MARKER ?? "", "ran");`,
    `  throw new Error("probe-must-run");`,
    `});`,
  ]);
  // mutator 的 worker overlay 把没变异的目录都做成软链：入口是软链路径，import.meta.url 是真路径
  const dir = mkdtempSync(join(tmpdir(), "dispatch-symlink-"));
  symlinkSync(fileURLToPath(new URL("../scripts", import.meta.url)), join(dir, "scripts"));
  const result = spawnSync(process.execPath, [join(dir, "scripts", "test.ts"), probe.file], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, PROBE_MARKER: probe.marker },
  });
  let ran: string | undefined;
  try {
    ran = readFileSync(probe.marker, "utf8");
  } catch {
    ran = undefined;
  }
  assert.equal(ran, "ran", "字面路径比较会把「软链入口」当成 import，静默空转退出 0");
  // 只看非零：夹具失败就非零（信号带走的 null 也算非零）——这条守的是「真跑了」不是退出码形状
  assert.notEqual(result.status, 0, "用例失败 ⇒ 门禁非零");
});

test("破坏点跑器：子代理环境里也真判红（擦掉继承来的测试上下文）", () => {
  const result = spawnSync(process.execPath, [BREAKPOINTS, "旗标透传"], {
    encoding: "utf8",
    timeout: 120_000,
    // 故意带上测试进程的上下文：跑器自己必须擦，不能指望调用方擦
    env: { ...process.env, NODE_TEST_CONTEXT: "child-v8", NODE_TEST_WORKER_ID: "4" },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.match(output, /✅ killed/, `跑器必须真判红，实际输出：\n${output}`);
  assert.equal(result.status, 0, output);
});

test("破坏点：red 标题写错必须判 bad-title，不能当 killed", () => {
  const result = check({
    feature: "元测试：写错标题",
    file: "scripts/test.ts",
    from: "export function isDirectInvocation",
    to: "export function isDirectInvocationBROKEN",
    test: "test/test-runner.test.ts",
    red: "这条标题根本不存在：元测试",
    why: "标题写错时 node 输出 ok 1 - <文件名>、退出 0，必须归到 bad-title",
  });
  assert.equal(result.outcome, "bad-title");
});

// ── 验红器自己的假绿：失败块边界与「抛错的变异」 ─────────────────────────

test("破坏点跑器：失败块只吃到本用例结束，不吃下一条的 ERR_ASSERTION", () => {
  const probe = probeFile([
    `test("元测试：抛错的那条", () => {`,
    `  assert.ok(true);`,
    `});`,
    `test("元测试：抛错的那条之后还有断言失败", () => {`,
    `  assert.equal(1, 2);`,
    `});`,
  ]);
  const result = check({
    feature: "元测试：失败块边界",
    file: probe.file,
    from: "  assert.ok(true);",
    to: '  throw new TypeError("probe-explode");',
    test: probe.file,
    red: "元测试：抛错的那条",
    why: "失败块吃到 TAP 末尾 ⇒ 下一条的 ERR_ASSERTION 被算成这一条的",
  });
  assert.equal(
    result.outcome,
    "wrong-red",
    `无名异常的块不许借下一条的断言变红：${result.outcome} — ${result.note}`,
  );
});

test("破坏点跑器：抛错的变异给关键字也算 killed", () => {
  const probe = probeFile([`test("元测试：关键字那条", () => {`, `  assert.ok(true);`, `});`]);
  const result = check({
    feature: "元测试：关键字逃生口",
    file: probe.file,
    from: "  assert.ok(true);",
    to: '  throw new Error("probe-keyword-hit");',
    test: probe.file,
    red: "元测试：关键字那条",
    redKeyword: "probe-keyword-hit",
    why: "guard 型代码删早退只会抛，写不出断言失败——显式关键字是唯一诚实信号",
  });
  assert.equal(result.outcome, "killed", `${result.outcome} — ${result.note}`);
});

test("破坏点跑器：子进程超时要放弃（挂死也不拖死门禁）", () => {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-timeout-"));
  const file = join(dir, "slow.test.ts");
  // 真实定时器：这里测的就是「子进程挂死多久被杀」——假定时器会让被测的进程永远不超时
  writeFileSync(
    file,
    [
      'import { test } from "node:test";',
      'test("慢用例", async () => {',
      "  await new Promise((resolve) => setTimeout(resolve, 2000));",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  const t0 = Date.now();
  const out = runOne(file, "慢用例", 200);
  const elapsed = Date.now() - t0;
  assert.equal(out, "", "超时要放弃：返回空 TAP，不许把挂死的输出当结果");
  assert.ok(elapsed < 1500, `200ms 的超时不该跑这么久：${elapsed}ms`);
});

// ── 假绿元测试：转向用例必须真的盯实现，而不是盯 fake 自己 ────────────────
const TUI_TEST = fileURLToPath(new URL("./tui.test.ts", import.meta.url));

function runTuiPattern(
  pattern: string,
  sabotage?: string,
): { status: number | null; output: string } {
  const env = { ...process.env };
  if (sabotage) env.PI_DISPATCH_SABOTAGE = sabotage;
  else delete env.PI_DISPATCH_SABOTAGE;
  const result = spawnSync(process.execPath, [RUNNER, `--test-name-pattern=${pattern}`, TUI_TEST], {
    encoding: "utf8",
    timeout: 60_000,
    env,
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

test("假绿元测试：坏 fake（只回 ok/错 id/把 label 当 id）必须让转向用例变红", () => {
  const single = "steer：单任务跳过 select";
  const multi = "steer：多任务按 index 回映";

  // 对照：不 sabotage 时必须绿且真跑到了 1 条——零命中也是退出 0，只看退出码会假绿
  const control = runTuiPattern(single);
  assert.equal(control.status, 0, control.output);
  assert.match(control.output, /pass 1\b/, "对照必须真跑到 1 条");

  for (const [mode, pattern] of [
    ["no-steer", single],
    ["wrong-id", single],
    ["label-id", multi],
  ] as const) {
    const run = runTuiPattern(pattern, mode);
    assert.notEqual(run.status, 0, `${mode} 下用例还是绿的 ⇒ 断言没盯住实现\n${run.output}`);
  }
});
