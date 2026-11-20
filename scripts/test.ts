#!/usr/bin/env node
// 测试门禁的唯一入口：先擦掉继承来的测试上下文，再交给 `node --test`。
//
// 直接跑 `node --test` 会假绿：在测试进程或派发子代理里，它可能一条用例都不跑却退出 0。
// 口径见 scripts/test-env.ts。`pnpm mutate` 也走这条门禁（mutator 读 package.json 的 test）。
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
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

if (isDirectInvocation(process.argv[1], fileURLToPath(import.meta.url))) {
  const result = spawnSync(process.execPath, plan(process.argv.slice(2)), {
    stdio: "inherit",
    env: scrubbedEnv(),
  });
  process.exit(result.status ?? 1);
}
