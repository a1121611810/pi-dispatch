// 隐私扫描的夹具用例。
//
// 这个文件的作用是给「以后别再把家目录/密钥带进仓库」这条规矩钉住：
// 规矩写在文档里没人看，规矩写成检查才会拦人。
//
// 等价变异（探针杀不掉，且也不该杀）：
//   无——本文件全是纯函数断言，没有分支可变异。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_HOME_USERS,
  ALLOWED_ROUTE_NAMES,
  EXEMPT_FILES,
  EXEMPT_ROUTE_FILES,
  KNOWN_ROUTE_GROUP_NAMES,
  isBinaryFile,
  isExempt,
  PRIVATE_VENDORS,
  ROUTE_GROUP_PREFIX,
  scanText,
} from "../scripts/privacy.ts";
import { sanitize, sanitizeJsonl, REPLACEMENTS } from "../scripts/sanitize-fixture.ts";

/** 测试用的"真名样本"——拼出来，文件里没有明文的家目录路径。 */
const FAKE_HOME = "/Users/" + "real-user";

test("隐私：真名家目录要报出来", () => {
  const findings = scanText(`const p = "${FAKE_HOME}/develop/x";`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.kind, "home-path");
  assert.equal(findings[0]!.text, FAKE_HOME);
});

test("隐私：占位符家目录放行（/Users/x/… 是文档里的示例写法）", () => {
  for (const user of ALLOWED_HOME_USERS) {
    assert.deepEqual(scanText(`path = "/${user}/proj"`), [], `${user} 应当放行`);
  }
  assert.deepEqual(scanText('path = "/home/dev/proj"'), []);
});

test("隐私：行号要准（报错得能直接定位）", () => {
  const text = `line1\nline2\nconst p = '${FAKE_HOME}/x';\nline4`;
  const findings = scanText(text);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.line, 3);
});

test("隐私：密钥一律命中（宁可误报不能漏）", () => {
  const cases = [
    "sk-abcdefgh12345678",
    "ghp_abcdefghij1234567890",
    "github_pat_11ABCDEFG0abcdefghij",
    "AKIAIOSFODNN7EXAMPLE",
    "npm_abcdefghij1234567890",
    "xoxb-1234567890-abcdef",
    "-----BEGIN RSA PRIVATE KEY-----",
    "Bearer abcdefghijklmnopqrstuvwxyz",
  ];
  for (const secret of cases) {
    const findings = scanText(`const k = "${secret}";`);
    assert.ok(
      findings.some((f) => f.kind.startsWith("secret:")),
      `${secret.slice(0, 12)}… 应当被判成密钥`,
    );
  }
});

test("隐私：保留域名的邮箱不算（测试里故意用不可达的）", () => {
  assert.deepEqual(scanText("git config user.email verify@example.invalid"), []);
  assert.deepEqual(scanText("mail me at someone@example.com"), []);
  const real = scanText(`mail me at ${FAKE_HOME.split("/").pop()}@personal.dev`);
  assert.equal(real.length, 1);
  assert.equal(real[0]!.kind, "email");
});

test("隐私：模型路由组名与供应商前缀要报出来（能推出定价与供应商）", () => {
  const group = scanText('const model = "group/some-route";');
  assert.equal(group.length, 1);
  assert.equal(group[0]!.kind, "route:model-route-group");
  const vendor = scanText(`const model = "${PRIVATE_VENDORS[0]}/group/some-route";`);
  assert.ok(vendor.some((f) => f.kind === "route:vendor-prefix"));
  const config = scanText(`数据来自 ~/.config/${PRIVATE_VENDORS[0]}/affinity.json`);
  assert.ok(config.some((f) => f.kind === "route:vendor-config-path"));
});

test("隐私：裸的已知路由组名要报出来（文档里的散文写法）", () => {
  for (const name of KNOWN_ROUTE_GROUP_NAMES) {
    const found = scanText(`流量走 ${name} 这条`);
    assert.ok(
      found.some((f) => f.kind === "route:route-group-bare"),
      `${name} 应当报出来`,
    );
  }
});

test("隐私：路由名占位符放行（示例与测试值不是真路由组）", () => {
  for (const name of ALLOWED_ROUTE_NAMES) {
    assert.deepEqual(scanText(`model = "${name}"`), [], `${name} 应当放行`);
  }
  // 对照：白名单外的仍要报。没这条的话，白名单判断被改成「全部 continue」也是绿的
  assert.ok(scanText('model = "group/some-real-route"').length > 0, "白名单外的路由名仍要报出来");
  for (const vendor of PRIVATE_VENDORS) {
    assert.ok(
      scanText(`model = "${vendor}/group/x"`).length > 0,
      `私有供应商 ${vendor} 仍要报出来`,
    );
  }
});

test("隐私：成本分析文档不再豁免（里面的路由名已换成假名）", () => {
  const doc = "docs/spec/cost-control.md";
  assert.deepEqual(EXEMPT_ROUTE_FILES, [], "文档不该再豁免——真名已换成假名");
  assert.ok(
    scanText('model = "group/some-route"', doc).length > 0,
    "成本文档与其他文件一样要扫（真名已不在文档里）",
  );
});

test("隐私：二进制文件不扫（扫出来是乱码）", () => {
  assert.equal(isBinaryFile("a/b.png"), true);
  assert.equal(isBinaryFile("a/b.jsonl"), false);
  assert.equal(isBinaryFile("a/b.ts"), false);
});

test("隐私：规则文件与夹具用例自己豁免（它们里的家目录路径是故意的）", () => {
  for (const file of EXEMPT_FILES) {
    assert.equal(isExempt(file), true, `${file} 应当豁免`);
  }
  assert.equal(isExempt("test/fixtures/real-steer.jsonl"), false, "真机样本不豁免——那是要扫的");
  assert.equal(isExempt("src/core/child.ts"), false);
});

test("脱敏：家目录路径换成占位符", () => {
  assert.equal(sanitize(`${FAKE_HOME}/x`), "/home/dev/x");
});

test("脱敏：模型路由名与供应商名换掉", () => {
  assert.equal(sanitize('"model":"group/some-route"'), '"model":"test/model"');
  assert.equal(sanitize(`"provider":"${PRIVATE_VENDORS[0]}"`), '"provider":"test/provider"');
});

test("脱敏：project_context 整块留结构不留内容", () => {
  const out = sanitize(
    '<project_context>\\n<project_instructions path="/home/x/.pi/agent/AGENTS.md">\\n# Global Agent Rules\\n\\nFFF 扩展、search-guard、CodeGraph……\\n</project_instructions>\\n</project_context>',
  );
  assert.ok(out.includes("<project_context>"), "结构要留着（真机上就是这么大）");
  assert.ok(out.includes("</project_context>"));
  assert.ok(!out.includes("FFF"), "全局 agent 配置的内容不该跟出去");
  assert.ok(!out.includes("search-guard"));
  assert.ok(!out.includes("CodeGraph"));
});

test("脱敏：产物每行都必须是合法 JSON（解析器会静默跳过坏行 ⇒ 假绿）", () => {
  // 这条是根治点：早先的脱敏把换行写成了真换行，产出 3 行非法 JSON；解析器把它们
  // 当 malformed 跳过，「转向」那条用例照样绿——脱敏脚本自己造了假绿。
  const line =
    '{"type":"message_end","message":{"role":"assistant","project_context":"<project_context>\\n# X\\n</project_context>"}}';
  const out = sanitizeJsonl(line);
  assert.doesNotThrow(() => JSON.parse(out), "脱敏后必须是合法 JSON");
  assert.ok(JSON.parse(out).message.project_context.includes("[REDACTED]"));
});

test("脱敏：整份 JSONL 走一遍，每行都得能解析", () => {
  const source = [
    `{"type":"session","cwd":"${FAKE_HOME}/x","id":"01a200ed-7e02-7508-ac60-412b1c0ff1fe"}`,
    `{"type":"message_end","message":{"provider":"${PRIVATE_VENDORS[0]}","model":"group/some-route"}}`,
    '{"type":"message_end","message":{"role":"assistant","project_context":"<project_context>\\n# Secret Rules\\n</project_context>"}}',
  ].join("\n");
  const out = sanitizeJsonl(source);
  const lines = out.split("\n").filter(Boolean);
  assert.equal(lines.length, 3);
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  assert.ok(!out.includes(FAKE_HOME));
  assert.ok(!out.includes("group/some-route"));
  assert.ok(!out.includes("Secret Rules"));
});

test("脱敏：会话 id 与绝对时刻换掉", () => {
  assert.equal(
    sanitize('"id":"01a200ed-7e02-7508-ac60-412b1c0ff1fe"'),
    '"id":"00000000-0000-4000-8000-000000000000"',
  );
  assert.equal(sanitize('"timestamp":1795311907408'), '"timestamp":1700000000000');
});

test("脱敏：规则清单每条都要写清为什么（规则是给人审的）", () => {
  for (const rule of REPLACEMENTS) {
    assert.ok(rule.why.length > 0, `${rule.from} 没写为什么`);
    assert.ok(rule.to.length > 0);
  }
});

test("隐私：文档里不许有真路由名（数字留着，名字换成假的）", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const docs = [
    "docs/spec/cache-hit-analysis.md",
    "docs/spec/cache-strategy-2026-11-25.md",
    "docs/spec/cost-control-plan.md",
    "docs/spec/cost-control.md",
    "docs/spec/cache-metrics-construction.md",
  ];
  for (const doc of docs) {
    const raw = readFileSync(join(root, doc), "utf8");
    assert.ok(
      !raw.includes(`${ROUTE_GROUP_PREFIX}/${KNOWN_ROUTE_GROUP_NAMES[0]}`),
      `${doc} 还有真路由组名`,
    );
    for (const name of KNOWN_ROUTE_GROUP_NAMES) {
      assert.ok(!raw.includes(name), `${doc} 还有裸的真路由组名 ${name}`);
    }
    assert.ok(!raw.includes(PRIVATE_VENDORS[0]!), `${doc} 还有真供应商名`);

    // 数字得留着——文档的价值在实测数字，不在名字
    assert.ok(/\d/.test(raw), `${doc} 的实测数字不该被一起清掉`);
  }
});

test("脱敏：仓库里那个 fixture 本身得是干净的", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const raw = readFileSync(join(root, "test/fixtures/real-steer.jsonl"), "utf8");
  assert.deepEqual(
    scanText(raw, "test/fixtures/real-steer.jsonl"),
    [],
    "fixture 里还有隐私——跑 node scripts/sanitize-fixture.ts 重新脱敏",
  );
  // 每一行都得是合法 JSON：解析器把坏行当 malformed 跳过，坏行会让「转向」那条用例
  // 读不到它要的东西却照样绿（实测踩过：脱敏产出 3 行非法 JSON，测试没发现）
  const lines = raw.split("\n").filter(Boolean);
  for (const [index, line] of lines.entries()) {
    assert.doesNotThrow(
      () => JSON.parse(line),
      `第 ${index + 1} 行不是合法 JSON——跑 pnpm sanitize:fixture 重新脱敏`,
    );
  }
});
