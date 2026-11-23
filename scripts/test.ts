#!/usr/bin/env node
// 测试门禁的唯一入口：先擦掉继承来的测试上下文，再交给 `node --test`。
//
// 直接跑 `node --test` 会假绿：在测试进程或派发子代理里，它可能一条用例都不跑却退出 0。
// 口径见 scripts/test-env.ts。`pnpm mutate` 也走这条门禁（mutator 读 package.json 的 test）。
//
// 第二道假绿：glob / 文件路径写错 ⇒ `node --test` 0 命中 ⇒ 退出 0 ⇒ 门禁自己说「全绿」。
// 所以这里额外挂一个 TAP reporter 数 `# pass`：一条都没跑过就不许退出 0。
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubbedEnv } from "./test-env.ts";

/** 默认目标：整棵 test/。给了文件路径就只跑给的那些。 */
export const DEFAULT_TARGETS = ["test/**/*.test.ts"];

/** 参数分两拨：以 - 开头的是 node --test 的旗标，其余当文件；没给文件就整棵 test/。 */
export function plan(argv: string[]): string[] {
  const args = argv.filter((arg) => arg !== "--");
  const flags = args.filter((arg) => arg.startsWith("-"));
  const targets = args.filter((arg) => !arg.startsWith("-"));
  return ["--test", ...flags, ...(targets.length > 0 ? targets : DEFAULT_TARGETS)];
}

/**
 * 是不是直接跑的（而不是被人 import 来找 plan）。
 * 比 realpath 而不是字面路径：mutator 的 overlay 把 scripts/ 做成软链，
 * 字面比较会「不是直接跑的」⇒ 整个门禁静默空转退出 0（比假绿还坏：连 warn 都没有）。
 */
export function isDirectInvocation(argv1: string | undefined, self: string): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(self);
  } catch {
    return false;
  }
}

/**
 * 从 TAP 输出里取通过条数；取不到算坏值（宁可红，别假绿）。
 * TAP 写 `# pass N`，spec 写 `ℹ pass N`——两种都认。
 */
export function passedCount(output: string): number | undefined {
  const match = /(?:^|\n)(?:#|ℹ)\s*pass (\d+)/.exec(output);
  return match ? Number(match[1]) : undefined;
}

if (isDirectInvocation(process.argv[1], fileURLToPath(import.meta.url))) {
  const dir = mkdtempSync(join(tmpdir(), "pi-dispatch-count-"));
  const tapFile = join(dir, "tap.txt");
  const [head, ...rest] = plan(process.argv.slice(2));
  // reporter 必须排在位置参数之前（实测：放文件之后不生效，tap 文件不生成）
  const result = spawnSync(
    process.execPath,
    [
      head!,
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
      "--test-reporter=tap",
      `--test-reporter-destination=${tapFile}`,
      ...rest,
    ],
    { stdio: "inherit", env: scrubbedEnv() },
  );
  const status = result.status ?? 1;
  let passed: number | undefined;
  try {
    passed = passedCount(readFileSync(tapFile, "utf8"));
  } catch {
    passed = undefined; // 没有 tap 文件 = 没跑起来，按 0 处理
  }
  rmSync(dir, { recursive: true, force: true });
  if (status !== 0) process.exit(status); // 红照传，先红先报
  if (passed === undefined || passed === 0) {
    console.error(
      `测试门禁：这次一条用例都没跑过（pass=${passed ?? "?"}）——glob 或文件路径写错了？`,
    );
    process.exit(1);
  }
  process.exit(0);
}
