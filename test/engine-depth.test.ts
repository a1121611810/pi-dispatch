// 杀死 src/core/engine.ts `childEnvFor` 的「深度不递增」变异：
//   变异前  PI_DISPATCH_DEPTH: String(Number(baseEnv.PI_DISPATCH_DEPTH ?? 0) + 1)
//   变异后  PI_DISPATCH_DEPTH: String(Number(baseEnv.PI_DISPATCH_DEPTH ?? 0) + 0)
//
// 契约（childEnvFor 注释「深度 + 编号」）：孩子的 depth = 父 depth + 1，且必须是十进制串。
// 现有用例只钉了「未设 ⇒ 1」与「"2" ⇒ 3」两个点；这里补上父侧显式 "0" 的边界——派发测试里
// 就是这么设的（test/adapter.test.ts 设 PI_DISPATCH_DEPTH="0"），若孩子停在 "0"，
// 第二层孩子会被当成第一层，深度闸（默认上限 3）整段失效。
//
// 两个探针都不起子进程、不落盘：只调纯函数 childEnvFor。
import { test } from "node:test";
import assert from "node:assert/strict";
import { childEnvFor } from "../src/core/engine.ts";

test("引擎：childEnvFor——父 depth 显式 0 ⇒ 孩子 1（深度必须递增，不许停在 0）", () => {
  const base = { PI_DISPATCH_DEPTH: "0" };
  const env = childEnvFor(base, "t-depth-0");
  assert.equal(env.PI_DISPATCH_DEPTH, "1", "0 的下一层是 1：停在 0 等于没递进，深度闸失效");
  assert.equal(base.PI_DISPATCH_DEPTH, "0", "不改入参");
});

test("引擎：childEnvFor——每层正好 +1，且写成十进制串", () => {
  for (const parent of ["0", "1", "2", "7"]) {
    const env = childEnvFor({ PI_DISPATCH_DEPTH: parent }, `t-${parent}`);
    assert.equal(
      env.PI_DISPATCH_DEPTH,
      String(Number(parent) + 1),
      `父 ${parent} ⇒ 孩子 ${Number(parent) + 1}（不是 ${parent}，也不是别的）`,
    );
    assert.match(env.PI_DISPATCH_DEPTH!, /^\d+$/, "depth 必须是十进制串");
  }
});
