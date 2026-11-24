// 任务 0（run-fd4df4d8-7595-488a-aa16-896a916d1a4c/worker-0）：
// 杀死 src/core/engine.ts `definedOnly` 的「只留 undefined」反向变异：
//   变异前  Object.entries(source).filter(([, value]) => value !== undefined)
//   变异后  Object.entries(source).filter(([, value]) => value === undefined)
//
// 契约（definedOnly 注释 + 构造器）：合并默认配置时只丢 undefined 键。
//   · 非 undefined 的注入必须活下来；
//   · 显式 undefined 必须落回默认值（否则 `{...defaults, ...deps}` 会被 undefined 盖掉默认）。
//
// 两个探针都不起子进程、不落盘：
//   1) 注入带计数器的假 machineReader —— 变异「只留 undefined」把非 undefined 的注入全滤掉，
//      引擎改用系统读数，计数器停在 0 ⇒ 红。
//   2) 显式 machineReader: undefined —— 「只留 undefined」会把它当值保留，构造器读机器时
//      TypeError；「全都保留」型变异同理 ⇒ 红。正确实现滤掉 ⇒ 落回系统读数 ⇒ 绿。
import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskEngine } from "../src/core/engine.ts";
import { TaskRegistry } from "../src/core/registry.ts";
import type { MachineReader } from "../src/core/pool.ts";
import type { SpawnChild } from "../src/core/child.ts";

/** 假的机器读数：只记账，不碰真机。 */
function countingMachineReader(onRead: (what: "spec" | "available") => void): MachineReader {
  return {
    readSpec: () => {
      onRead("spec");
      return { totalBytes: 24 * 1024 ** 3, cpus: 10 };
    },
    readAvailable: () => {
      onRead("available");
      return 5 * 1024 ** 3;
    },
  };
}

/** 谁调用谁炸：证明探针没有起真子进程。 */
const noSpawn: SpawnChild = () => {
  throw new Error("探针不该起子进程");
};

test("引擎：definedOnly 放行非 undefined 的注入（显式 undefined 才落回默认）", () => {
  const reads: string[] = [];
  new TaskEngine({
    registry: new TaskRegistry(),
    machineReader: countingMachineReader((what) => reads.push(what)),
    spawnChild: noSpawn,
    hostMode: "one-shot",
    stallMs: undefined, // 显式 undefined：滤掉，落回默认 5 分钟（不该盖掉默认）
  });
  assert.equal(
    reads.filter((what) => what === "spec").length,
    1,
    "构造器必须用注入的机器读数（definedOnly 不能把非 undefined 的注入滤掉）",
  );
});

test("引擎：definedOnly 丢掉显式 undefined（不拿 undefined 盖掉默认机器读数）", () => {
  assert.doesNotThrow(() => {
    new TaskEngine({
      registry: new TaskRegistry(),
      machineReader: undefined, // 显式 undefined：滤掉 ⇒ 用系统读数；被当成值保留 ⇒ 读机器时炸
      spawnChild: noSpawn,
      hostMode: "one-shot",
    });
  }, "显式 undefined 必须落回默认值，而不是把默认值盖成 undefined");
});
