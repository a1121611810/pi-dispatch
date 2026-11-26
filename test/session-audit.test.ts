// 会话审计的判词层：五档、八条对抗样本、纯函数性。
// 每条用例都写明「实现写错时它凭什么红」——判词链是这一层的全部价值。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { audit, claimHit, extractClaims, normalizePath } from "../src/audit/index.ts";
import type { CommandClaim, SessionEvent } from "../src/audit/index.ts";

const write = (path: string, cwd?: string): SessionEvent => ({
  kind: "tool",
  name: "write",
  input: { path },
  ...(cwd ? { cwd } : {}),
});
const bash = (command: string, exitCode?: number): SessionEvent => ({
  kind: "tool",
  name: "bash",
  input: { command },
  ...(typeof exitCode === "number" ? { exitCode } : {}),
});
const say = (
  text: string,
  role: "assistant" | "user" = "assistant",
  steer?: true,
): SessionEvent => ({
  kind: "message",
  role,
  text,
  ...(steer ? { steer } : {}),
});
const claim = (command: string, wantOk = true): CommandClaim => ({ command, wantOk });

// ── 五档：每档一正一反 ───────────────────────────────────────────────────

test("审计：verified——路径与命令全部对上", () => {
  const result = audit(
    [write("src/a.ts"), bash("pnpm test", 0), say("改了 `src/a.ts`，`pnpm test` 跑通了。")],
    null,
  );
  assert.equal(result.deliverable, "verified");
  assert.deepEqual(result.mismatch, { paths: [], commands: [] });
});

test("审计：absent——没报告、没正文、没改动", () => {
  assert.equal(audit([bash("ls", 0)], null).deliverable, "absent");
});

test("审计：absent 不吞「改了文件但没报告」——那是 unverified", () => {
  // 只看正文会把动过手的孩子判成空跑；路径收据在，就不算空跑。
  assert.equal(audit([write("src/a.ts")], null).deliverable, "unverified");
});

test("审计：unverified——有报告但一条都对不上", () => {
  assert.equal(audit([write("src/a.ts")], "改了 `src/b.ts`。").deliverable, "unverified");
});

test("审计：unclaimed——只读分析，报告里没有可核对项", () => {
  // 「读过」不算「改过」：路径自述要最近的动词是改动类。
  assert.equal(audit([], "我读了 `src/a.ts`，未改动。").deliverable, "unclaimed");
});

test("审计：unclaimed 不是静音键——零自述但有路径收据 ⇒ unverified", () => {
  // 干完活写一句嘴干净的报告，不能换到 exit 0。
  assert.equal(audit([write("src/a.ts")], "搞定了。").deliverable, "unverified");
});

test("审计：partial——路径命中、命令没命中", () => {
  const result = audit(
    [write("src/a.ts"), bash("pnpm lint", 0)],
    "改了 `src/a.ts`，`pnpm test` 跑通了。",
  );
  assert.equal(result.deliverable, "partial");
  assert.deepEqual(result.mismatch.commands, ["pnpm test"]);
});

test("审计：截断 + 一条对不上 ⇒ unverified（截断不能洗白）", () => {
  // 21 条路径：窗口保最先 20，第 21 条不在窗口里。另一条对上的不能把它洗白。
  const events = Array.from({ length: 21 }, (_, i) => write(`src/f${i}.ts`));
  const result = audit(events, "改了 `src/f0.ts` 和 `src/f20.ts`。");
  assert.equal(result.truncated, true);
  assert.equal(result.deliverable, "unverified");
});

test("审计：纯截断但都对得上 ⇒ 仍然 verified", () => {
  const events = Array.from({ length: 21 }, (_, i) => write(`src/f${i}.ts`));
  assert.equal(audit(events, "改了 `src/f0.ts`。").deliverable, "verified");
});

// ── 八条对抗样本里的六条（另外两条在归一化/CLI 层） ──────────────────────

test("对抗 1：`||` 掩码不能证明跑通", () => {
  // 整条 `pnpm test || true` 退出 0；pnpm test 的成败被掩掉。
  assert.equal(
    audit([bash("pnpm test || true", 0)], "`pnpm test` 跑通了。").deliverable,
    "unverified",
  );
});

test("对抗 2 的一半：`;` 后面的段不可推", () => {
  const result = audit([bash("pnpm lint; pnpm test", 0)], "`pnpm lint` 跑通了。");
  assert.equal(result.deliverable, "unverified");
});

test("对抗 2：两条只对上一条 ⇒ partial", () => {
  const result = audit([bash("pnpm lint; pnpm test", 0)], "`pnpm lint` 和 `pnpm test` 都跑通了。");
  assert.equal(result.deliverable, "partial");
});

test("对抗 3：`sed -i` 不是路径收据（读过/命令写过都不算改过）", () => {
  // shell 写不进路径收据是已知盲区：这里判 unverified，而不是拿命令收据当豁免。
  assert.equal(
    audit([bash("sed -i 's/a/b/' src/a.ts", 0)], "改了 `src/a.ts`。").deliverable,
    "unverified",
  );
});

test("对抗 5：`..` 按 cwd 解析后才比对", () => {
  const result = audit([write("/repo/lib/a.ts")], "改了 `../lib/a.ts`。", { cwd: "/repo/sub" });
  assert.equal(result.deliverable, "verified");
});

test("对抗 5 的反面：不解析 `..` 就永远对不上", () => {
  assert.equal(audit([write("/repo/lib/a.ts")], "改了 `../lib/a.ts`。").deliverable, "unverified");
});

test("对抗 6：heredoc 正文里的命令不算跑过", () => {
  const result = audit([bash("cat <<'EOF'\npnpm test\nEOF", 0)], "`pnpm test` 跑通了。");
  assert.equal(result.deliverable, "unverified");
});

test("对抗 7：报告早于最后一次转向 ⇒ unverified + notes", () => {
  const result = audit(
    [bash("pnpm test", 0), say("`pnpm test` 跑通了。"), say("再跑一遍", "user", true)],
    null,
  );
  assert.equal(result.deliverable, "unverified");
  assert.ok(result.notes.includes("report predates last steer"));
});

test("对抗 8：退出码 0 但空跑 ⇒ absent", () => {
  assert.equal(audit([bash("echo hi", 0), say("")], "").deliverable, "absent");
});

// ── 模糊成功 / 完成词绑定 ────────────────────────────────────────────────

test("审计：完成词但零可核对项 ⇒ unverified + vague success claim", () => {
  const result = audit([], "已实现路由注册，测试全部通过。");
  assert.equal(result.deliverable, "unverified");
  assert.ok(result.notes.includes("vague success claim"));
});

test("审计：「测试未通过」不算模糊成功（诚实的负评不罚）", () => {
  assert.equal(audit([], "测试未通过。").deliverable, "unclaimed");
});

test("审计：完成词绑到「跑过但失败」的命令 ⇒ unverified", () => {
  // `失败` 把命令降成「只声称跑过」，`已修复` 再绑上去就是想拿失败当交付。
  const result = audit([bash("pnpm test", 1)], "`pnpm test` 失败了，已修复。");
  assert.equal(result.deliverable, "unverified");
  assert.ok(result.notes.includes("vague success claim"));
});

test("审计：完成词跨句兜底——「失败。已修复。」也绑得上", () => {
  const result = audit([bash("pnpm test", 1)], "`pnpm test` 失败。已修复。");
  assert.equal(result.deliverable, "unverified");
});

test("审计：完成词绑到成功且命中的命令 ⇒ 不扣分", () => {
  const result = audit(
    [write("src/a.ts"), bash("pnpm test", 0)],
    "改了 `src/a.ts`，`pnpm test` 通过，已修复。",
  );
  assert.equal(result.deliverable, "verified");
});

// ── 自述抽取与路径归一 ──────────────────────────────────────────────────

test("抽取：并列路径共享句子里的改动动词", () => {
  assert.deepEqual(extractClaims("修改了 `src/a.ts`、`src/b.ts`。").paths, [
    "src/a.ts",
    "src/b.ts",
  ]);
});

test("抽取：读与写同句时各归各的", () => {
  assert.deepEqual(extractClaims("读了 `src/a.ts` 并修改了 `src/b.ts`。").paths, ["src/b.ts"]);
});

test("抽取：否定辖域到小句末为止", () => {
  assert.deepEqual(extractClaims("已改 `src/a.ts`，未跑测试。").paths, ["src/a.ts"]);
});

test("抽取：否定词后面的改动动词不作数", () => {
  // 「没有修改 X」不是改了 X；不排否定的话只读报告会被判 unverified。
  assert.deepEqual(extractClaims("没有修改任何代码，`src/a.ts` 保持原样。").paths, []);
});

test("抽取：不在 runner 闭集里的首 token 不算命令", () => {
  assert.deepEqual(extractClaims("跑了 `ls -la`。").commands, []);
});

test("归一：尾斜杠、`./` 前缀、反斜杠都消掉", () => {
  assert.equal(normalizePath("./src/a.ts/"), "src/a.ts");
  assert.equal(normalizePath("src\\a.ts"), "src/a.ts");
});

test("归一：相对 cwd 一律当 `/`，不偷用 process.cwd()", () => {
  assert.equal(normalizePath("../lib/a.ts", "repo/sub"), "/lib/a.ts");
  assert.equal(normalizePath("../lib/a.ts", "/repo/sub"), "/repo/lib/a.ts");
});

test("归一：`..` 越过根就停在根", () => {
  assert.equal(normalizePath("../../a.ts", "/repo"), "/a.ts");
});

// ── 命中规则 ────────────────────────────────────────────────────────────

test("命中：没有退出码的收据不能证明跑通", () => {
  assert.equal(claimHit(claim("pnpm test"), [{ command: "pnpm test", trusted: false }]), false);
});

test("命中：声称跑过时，失败收据也算数", () => {
  assert.equal(
    claimHit(claim("pnpm test", false), [{ command: "pnpm test", exitCode: 1, trusted: true }]),
    true,
  );
});

test("命中：含分隔符的自述不走整串快路", () => {
  assert.equal(
    claimHit(claim("pnpm test || true"), [
      { command: "pnpm test || true", exitCode: 0, trusted: true },
    ]),
    false,
  );
});

// ── 纯函数性与规模 ──────────────────────────────────────────────────────

test("纯函数：不看时钟、不读磁盘，同一输入两次同结果", () => {
  const events = [write("src/a.ts"), bash("pnpm test", 0)];
  const report = "改了 `src/a.ts`，`pnpm test` 跑通了。";
  const originalNow = Date.now;
  const originalRandom = Math.random;
  Date.now = () => {
    throw new Error("不允许读时钟");
  };
  Math.random = () => {
    throw new Error("不允许用随机数");
  };
  try {
    const a = audit(events, report, { cwd: "/definitely/not/here" });
    const b = audit(events, report, { cwd: "/definitely/not/here" });
    assert.deepEqual(a, b);
    assert.equal(a.deliverable, "verified");
  } finally {
    Date.now = originalNow;
    Math.random = originalRandom;
  }
});

test("规模：审计模块每个文件 ≤ 600 行", () => {
  const dir = new URL("../src/audit/", import.meta.url);
  for (const file of ["types.ts", "claims.ts", "verdict.ts", "index.ts"]) {
    const text = readFileSync(new URL(file, dir), "utf8");
    assert.ok(text.split("\n").length <= 600, `${file} 超了 600 行`);
  }
});
