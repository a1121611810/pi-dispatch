// 会话审计的判词层：五档、八条对抗样本、纯函数性。
// 每条用例都写明「实现写错时它凭什么红」——判词链是这一层的全部价值。
//
// ── 变异测试（`mutator --no-coverage --mutate-all src/audit`）───────────
// 当前：350 个位点，杀掉 261，**幸存 89**，0 超时。**不是零幸存**——这是明账。
// 按类：`?? -> ||` 22、`&& -> ||` 17、`0 -> 1` 15、`=== -> !==` 7、`>= -> >` 6、`true -> false` 6。
//
// 能证死的等价类（两条，都不是猜的）：
//   1. `str(x) ?? y`：`str()` 只返回非空字符串或 undefined（空串已被它映射成
//      undefined），所以 `??` 与 `||` 外延相等；
//   2. `m.index ?? 0`：`matchAll` 的 `index` 一定是 number，`?? 1` 那条变异只在
//      「index 为 undefined」时才有差别，而这个前提不可达。
// 这两类占幸存者的大头，但我**没有**逐条对着夹具验证剩下的，全按欠账记。
// 其余没有逐个证明，记成欠账——别当已经绿了。
// 已经钉死的边界：否定辖域 12 字端点、路径去重、两维窗口方向、命中两分支、
// 空命令自述、分词器的「命令 vs 路径」优先、字段缺省分支。
// 声称成功/声称跑过两条命中分支、空命令自述。
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

// ── 边界：把变异测试里能杀的那批钉住 ────────────────────────────────────

test("否定辖域是 12 字：第 12 字还算被否定，第 13 字不算", () => {
  // 差一个字就差一档判词，窗口端点必须钉死。
  const inside = "没有" + "x".repeat(9) + "改动 `src/a.ts`"; // 「改」在偏移 11，辖域内
  const edge = "没有" + "x".repeat(10) + "改动 `src/a.ts`"; // 偏移 12，正好在边界上
  const outside = "没有" + "x".repeat(11) + "改动 `src/a.ts`"; // 偏移 13，超出 12 字辖域
  assert.deepEqual(extractClaims(inside).paths, [], "辖域内不算改动");
  assert.deepEqual(extractClaims(edge).paths, [], "边界（第 12 字）仍算被否定");
  assert.deepEqual(extractClaims(outside).paths, ["src/a.ts"], "超出 12 字就算数");
});

test("抽取：同一路径只算一条自述", () => {
  assert.deepEqual(extractClaims("改了 `src/a.ts`，又改了 `src/a.ts`。").paths, ["src/a.ts"]);
});

test("命中：声称成功但收据是失败 ⇒ 不命中", () => {
  assert.equal(
    claimHit(claim("pnpm test"), [{ command: "pnpm test", exitCode: 1, trusted: true }]),
    false,
  );
});

test("命中：声称跑过但没有退出码 ⇒ 不命中", () => {
  assert.equal(
    claimHit(claim("pnpm test", false), [{ command: "pnpm test", trusted: false }]),
    false,
  );
});

test("命中：空命令自述不命中", () => {
  assert.equal(
    claimHit(claim("   "), [{ command: "pnpm test", exitCode: 0, trusted: true }]),
    false,
  );
});

test("收据：命令保最近 20 条，路径保最先 20 条", () => {
  const commands = Array.from({ length: 21 }, (_, i) => bash(`cmd-${i}`, 0));
  const result = audit(commands, null);
  assert.equal(result.receipts.commands.length, 20, "命令留最近 20 条");
  assert.equal(result.receipts.commands[0]!.command, "cmd-1", "最早的一条被挤掉");

  const paths = Array.from({ length: 21 }, (_, i) => write(`src/f${i}.ts`));
  const kept = audit(paths, null).receipts.paths;
  assert.equal(kept.length, 20, "路径留最先 20 条");
  assert.equal(kept[0], "src/f0.ts", "最后一条被挤掉");
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

// ── 逐分支补测（二）：抽取 / 命中 / 判定链的边角 ────────────────────────

test("抽取：转折词切小句，否定只作用于自己的小句", () => {
  assert.deepEqual(extractClaims("没有修改 `src/a.ts` 但是改了 `src/b.ts`。").paths, ["src/b.ts"]);
});

test("抽取：分号切句子，后半句照常抽", () => {
  assert.deepEqual(extractClaims("没有改 `src/a.ts`；改了 `src/b.ts`。").paths, ["src/b.ts"]);
});

test("抽取：围栏代码块的第一行算命令", () => {
  const report = "跑过了：\n```\npnpm test\n```\n";
  assert.deepEqual(
    extractClaims(report).commands.map((c) => c.command),
    ["pnpm test"],
  );
});

test("路径识别：URL 不算路径", () => {
  assert.deepEqual(extractClaims("看了 `https://example.com/a.ts`，没有改动。").paths, []);
});

test("路径识别：没有斜杠的不算路径（README.md 这类）", () => {
  assert.deepEqual(extractClaims("改了 `README.md`。").paths, []);
});

test("归一：绝对路径原样保留", () => {
  assert.equal(normalizePath("/repo/src/a.ts"), "/repo/src/a.ts");
});

test("审计：调用方给了结构化自述就不跑散文抽取", () => {
  const result = audit([bash("pnpm test", 0)], "这段散文完全对不上", {
    claims: { paths: [], commands: [{ command: "pnpm test", wantOk: true }], vagueBindings: [] },
  });
  assert.equal(result.deliverable, "verified");
  assert.deepEqual(result.claims.commands, ["pnpm test"]);
});

test("审计：maxReceipts 可调（收 1 条就截断）", () => {
  const result = audit([bash("a", 0), bash("b", 0)], null, { maxReceipts: 1 });
  assert.equal(result.receipts.commands.length, 1);
  assert.equal(result.truncated, true);
});

test("审计：mismatch 精确列出没对上的路径与命令", () => {
  const result = audit([write("src/a.ts")], "改了 `src/a.ts` 和 `src/b.ts`，`pnpm test` 跑通了。");
  assert.deepEqual(result.mismatch.paths, ["src/b.ts"]);
  assert.deepEqual(result.mismatch.commands, ["pnpm test"]);
});

test("命中：整串逐字相等走快路（无分隔符）", () => {
  assert.equal(
    claimHit(claim("pnpm test --silent"), [
      { command: "pnpm  test --silent", exitCode: 0, trusted: true },
    ]),
    true,
  );
});

test("命中：多段自述里有一段找不到就不命中", () => {
  assert.equal(
    claimHit(claim("pnpm test && pnpm lint"), [
      { command: "pnpm test", exitCode: 0, trusted: true },
    ]),
    false,
  );
});

test("判定链：stale 与 vague 同时成立时 notes 两条都在", () => {
  const result = audit(
    [bash("pnpm test", 1), say("`pnpm test` 失败。已修复。"), say("再试一次", "user", true)],
    null,
  );
  assert.equal(result.deliverable, "unverified");
  assert.ok(result.notes.includes("report predates last steer"));
});

test("抽取：路径写在动词前面不算改动自述（已知盲区）", () => {
  assert.deepEqual(extractClaims("`src/a.ts` 被改了。").paths, []);
});

test("抽取：倒装的失败词绑不到命令（已知盲区）", () => {
  // 「失败：`pnpm test`」里失败词在命令前面，绑不到——写进盲区，不当谎报。
  const claims = extractClaims("失败：`pnpm test`。");
  assert.equal(claims.commands.length, 1);
  assert.equal(claims.commands[0]!.wantOk, true);
});

test("抽取：一句话里多条命令，失败只绑最近的前一条", () => {
  const claims = extractClaims("`pnpm lint` 跑通了，`pnpm test` 失败了。").commands;
  assert.deepEqual(
    claims.map((c) => [c.command, c.wantOk]),
    [
      ["pnpm lint", true],
      ["pnpm test", false],
    ],
  );
});

test("审计：转向在报告之前不算陈旧", () => {
  const result = audit(
    [say("先看看", "user", true), bash("pnpm test", 0), say("`pnpm test` 跑通了。")],
    null,
  );
  assert.equal(result.deliverable, "verified");
  assert.deepEqual(result.notes, []);
});

test("命中：自述带多余空白也能对上", () => {
  assert.equal(
    claimHit(claim("  pnpm   test  "), [{ command: "pnpm test", exitCode: 0, trusted: true }]),
    true,
  );
});

test("抽取：反引号里同时像命令又像路径时，按命令算（首 token 是 runner）", () => {
  const claims = extractClaims("跑了 `node ./scripts/gen.ts`。");
  assert.equal(claims.commands.length, 1);
  assert.deepEqual(claims.paths, []);
});

test("抽取：反引号里的路径只算一条（不被裸 token 再数一遍）", () => {
  assert.deepEqual(extractClaims("改了 `src/a.ts`。").paths, ["src/a.ts"]);
});

test("抽取：否定词在目标之后不生效", () => {
  // 「改了 a，没有报错」里的「没有」在「改」后面，不能把改动否掉。
  assert.deepEqual(extractClaims("改了 `src/a.ts`，没有报错。").paths, ["src/a.ts"]);
});

test("切句：裸句点不切（`a.ts` 里那个点不算句子边界）", () => {
  assert.deepEqual(extractClaims("改了 `src/a.ts`，然后跑 `pnpm test` 通过了。").paths, [
    "src/a.ts",
  ]);
});

test("审计：显式传空报告就是没正文，不回落去用流里的 assistant 文本", () => {
  // `report ?? …` 与 `report || …` 在这里分道：空串是「作者没写」，不是「没给」。
  const result = audit([bash("pnpm test", 0), say("`pnpm test` 跑通了。")], "");
  assert.equal(result.deliverable, "absent");
});

test("审计：maxReceipts 传 0 就是一条都不留（不是回落到默认 20）", () => {
  const result = audit([bash("a", 0)], null, { maxReceipts: 0 });
  assert.equal(result.receipts.commands.length, 0);
  assert.equal(result.truncated, true);
});

test("形状：一次完整审计的结果逐字段相等", () => {
  // 判词层最容易漏的不是「判词对不对」，而是 claims / receipts / mismatch / notes
  // 这些输出的字段级差异。整份 deepEqual 一次钉死。
  const result = audit(
    [write("src/a.ts"), bash("pnpm lint", 0), bash("pnpm test", 1)],
    "改了 `src/a.ts`，`pnpm test` 跑通了。",
  );
  assert.deepEqual(result, {
    deliverable: "partial",
    claims: { paths: ["src/a.ts"], commands: ["pnpm test"] },
    receipts: {
      paths: ["src/a.ts"],
      commands: [
        { command: "pnpm lint", exitCode: 0, trusted: true },
        { command: "pnpm test", exitCode: 1, trusted: true },
      ],
    },
    mismatch: { paths: [], commands: ["pnpm test"] },
    truncated: false,
    notes: [],
  });
});

test("抽取：动词跨小句继续生效（同一句子内）", () => {
  // 「改了代码，`src/a.ts`」——动词在前一小句，路径在后一小句，仍算改动自述。
  assert.deepEqual(extractClaims("改了代码，`src/a.ts`。").paths, ["src/a.ts"]);
});

test("抽取：动词不跨句子生效", () => {
  // 「改了代码。`src/a.ts` 在那。」——句号之后重新起算，不能借上一句的动词。
  assert.deepEqual(extractClaims("改了代码。`src/a.ts` 在那。").paths, []);
});

test("抽取：两个完成词各自绑定", () => {
  const claims = extractClaims("`pnpm lint` 通过，`pnpm test` 通过，已修复。");
  assert.equal(claims.commands.length, 2);
  assert.equal(claims.vagueBindings.length, 1, "「已修复」只绑最近的一条");
  assert.equal(claims.vagueBindings[0], 1);
});
