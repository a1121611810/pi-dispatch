#!/usr/bin/env node
// 测试门禁的唯一入口：先擦掉继承来的测试上下文，再交给 `node --test`。
//
// 直接跑 `node --test` 会假绿：在测试进程或派发子代理里，它可能一条用例都不跑却退出 0。
// 口径见 scripts/test-env.ts。`pnpm mutate` 也走这条门禁（mutator 读 package.json 的 test）。
//
// 第二道假绿：glob / 文件路径写错 ⇒ `node --test` 0 命中 ⇒ 退出 0 ⇒ 门禁自己说「全绿」。
// 所以这里额外挂一个 TAP reporter 数 `# pass`：一条都没跑过就不许退出 0。
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
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

/**
 * 测试自己 mkdtemp 出来、从不清理的临时桶前缀。
 * 实测：freshStorage() 一次 pnpm test 建 38 个 17MB 目录（storage 测试要写 16MB 产出），
 * 不清就每次泄约 650MB。清单变长时改这里一处即可。
 */
export const TMP_LEFTOVER_PREFIXES = [
  "dispatch-store-",
  "dispatch-board-",
  "dispatch-git-",
  "dispatch-verify-",
  "dispatch-steer-",
];

/**
 * 清掉**上一轮**遗留的临时桶，返回删掉的个数。
 *
 * 只删本进程启动之前创建的（mtime 早于 startedAt）：本轮自己建的不动，
 * 因为 `pnpm mutate` 会并行起多个测试进程，删活目录会误杀别人的用例。
 * 代价是最后一轮会留一批——下一次跑门禁时清掉。
 *
 * 删不掉不算失败：清扫是副产品，不影响测试结论。
 */
export function sweepLeftoverTmp(startedAt: number, root = tmpdir()): number {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!TMP_LEFTOVER_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    const full = join(root, name);
    try {
      if (statSync(full).mtimeMs >= startedAt) continue; // 本轮或并发的，别动
      rmSync(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      // 权限/占用：跳过，下一次再清
    }
  }
  return removed;
}

if (isDirectInvocation(process.argv[1], fileURLToPath(import.meta.url))) {
  const startedAt = Date.now();
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
  // 顺手清上一轮遗留的临时桶：测试自己 mkdtemp、从不清理，不清会每次泄几百 MB。
  const swept = sweepLeftoverTmp(startedAt);
  if (swept > 0) console.error(`测试门禁：清掉上一轮遗留的临时桶 ${swept} 个`);
  if (status !== 0) process.exit(status); // 红照传，先红先报
  if (passed === undefined || passed === 0) {
    console.error(
      `测试门禁：这次一条用例都没跑过（pass=${passed ?? "?"}）——glob 或文件路径写错了？`,
    );
    process.exit(1);
  }
  process.exit(0);
}
