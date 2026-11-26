// 阶段 4 探针：拼命令 / 收件（JSONL）/ 卡住判定 / 报告契约。
// 关键：JSONL 的断言喂的是**真机抓的样本**，不是手写的假事件。
// spawn 行为要**真起进程**验（起不来的 / 晚订阅的 / 管道满的 / stderr 超长的）。
//
// 等价变异（测试用例杀不掉，也不该杀）：
//   三处 `x ?? y`（pid ?? 0、tools[name] ?? 0、close 的 code ?? -1）——
//   分歧只在 x 为 0 / "" 时，而这些 x 要么是进程 id（非负整数，0 只在读不到时，
//   但 ?? 与 || 对 0 都给 0），要么是工具计数（非负整数）。已穷举验证：可达输入上等价。
//   两处经过 nonEmpty() 的值（piPath ?? "pi" 等）——nonEmpty 只返回 undefined 或
//   非空串，undefined 是假值 ⇒ ?? 与 || 相同 ⇒ 等价。
//   第四处 `report?.files_touched ?? []`——files_touched 是数组或 undefined，
//   数组恒真 ⇒ ?? 与 || 在可达输入上等价。
//   自检对质的 `(report?.verified ?? [])`——verified 先过 normalizeReport，只会是
//   数组或 undefined，数组恒真 ⇒ 同上等价。
//   addUsage 的 `(a ?? 0)`——a 是 JSON 解析出的有限数或 undefined（JSON 无 NaN），
//   a 为 0 时 ?? 与 || 都给 0 ⇒ 等价。
//   verifyUnverified 的 `report?.verified ?? []`——左值只可能是数组或 undefined，数组恒真 ⇒ 等价。
//   commandSegments 的 `tokens.length > 0` 0→1——只影响「纯 VAR=value」段；claim 侧同样剥 env
//   后成空段被滤掉，该段永无可匹配方 ⇒ 可达输入上等价。
//   commandSegments 里剥 env 段的 while 条件 `tokens.length > 0` → `>= 0`——空数组时
//   tokens[0] 是 undefined，正则拿 "undefined" 去比（没有 "="，不匹配）⇒ 循环照样退出 ⇒ 等价。
//   tokensPrefix 的 `a.length === 0 || a.length > b.length` ||→&&——空段在段表里不可达
//   （filter 已滤），非空时逐位比较兜底，结果相同 ⇒ 等价。
//   tokensRunInOrder 的 `i < b.length && j < a.length` &&→||——j 到 a.length 后
//   `b[i] === a[j]` 的比较对象是 undefined，永不再推进 ⇒ 等价。
//   commandSegments 里 filter 的 `tokens.length > 0` → >= 0——空段两端都进不了
//   segmentsMatch 的任何分支（空数组在前缀/经序里都返回 false）⇒ 等价。
//   tokensRunInOrder 的 `i < b.length` → <=——越界那一轮比较的是 undefined 与字符串，
//   恒不相等 ⇒ 等价。
//   deliveryCoverage 的 `report?.files_touched ?? []`、verifyCoverage 的 `report?.verified ?? []`
//   —与上面两条同形：左值只可能是数组或 undefined，数组恒真 ⇒ 等价。
//   deliverableOf 的两处 `?? 0`（delivery?.textChars、files_touched?.length）——左值是
//   有限数或 undefined，为 0 时 ?? 与 || 都给 0 ⇒ 等价。
//   verifyCoverage 过滤器里的 `c.command.trim().length > 0` 0→1——只差「声称了 1 个字符的命令」，
//   而 1 字符不是 shell 命令，可达输入上没有区别 ⇒ 等价（空串仍被两侧一起滤掉）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assessmentVacuous,
  buildUserMessage,
  CONTRACT_BLOCK,
  createUsageTracker,
  buildPiArgv,
  createSteerEvidenceTracker,
  deliverableOf,
  deliveryCoverage,
  deliveryUnverified,
  extractReportFromText,
  parseChildStream,
  pathMatches,
  receiptGap,
  spawnChild,
  normalizeReport,
  supportsNoMcp,
  verifyCoverage,
  verifyUnverified,
  CHILD_REPORT_SCHEMA,
  CHILD_REPORT_TOOL_NAME,
  REPORT_CONTRACT_BLOCK,
  SUBAGENT_CONTEXT_BLOCK,
  WORKTREE_CONTRACT_BLOCK,
} from "../src/core/child.ts";
import { ChildActivityTracker, DEFAULT_STALL_MS } from "../src/core/activity.ts";

/** 真机抓的转向样本（2026-11-22，pi 1.5.2）：sleep 12 期间 steer，孩子改口 STEERED。 */
const REAL_STEER_STREAM = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures", "real-steer.jsonl"),
  "utf8",
);

/** 真机抓的样本（2026-11-18，pi 1.5.2）：read + bash 两次工具调用，最后交回正文 "12"。 */
const REAL_STREAM = [
  '{"type":"session","version":3,"id":"01a1","timestamp":"2026-11-18T00:00:00.000Z","cwd":"/tmp"}',
  '{"type":"agent_start"}',
  '{"type":"turn_start"}',
  '{"type":"message_start","message":{"role":"assistant","content":[],"stopReason":"pending"}}',
  '{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"read the file"},{"type":"text","text":"12"}],"api":"openai-completions","provider":"vendor-local","model":"group/main","usage":{"input":2484,"output":3,"cacheRead":128,"cacheWrite":0,"totalTokens":2615,"cost":{"input":0.0003726,"output":0.0000018,"cacheRead":0.00000192,"cacheWrite":0,"total":0.00037632}}}}',
  '{"type":"tool_execution_start","toolCallId":"call_1","toolName":"read","args":{"path":"/etc/hosts"}}',
  '{"type":"tool_execution_start","toolCallId":"call_2","toolName":"bash","args":{"command":"grep -n localhost /etc/hosts"}}',
  '{"type":"tool_execution_end","toolCallId":"call_1","toolName":"read","result":{"content":[]},"isError":false,"durationMs":5}',
  '{"type":"tool_execution_end","toolCallId":"call_2","toolName":"bash","result":{"content":[]},"isError":false,"durationMs":11}',
  '{"type":"turn_end","message":{"role":"assistant","content":[]},"toolResults":[]}',
  '{"type":"agent_end","messages":[],"willRetry":false}',
  '{"type":"agent_settled","aborted":false}',
].join("\n");

/** 真机抓的样本（2026-11-19，pi 1.5.2）：孩子调 child_report，成功回执经 details.report 回来。 */
const REAL_TOOL_STREAM =
  '{"type":"message_end","message":{"role":"toolResult","toolCallId":"call_5e3cbe08098c4961a046c7ee","toolName":"child_report","content":[{"type":"text","text":"child report received"}],"details":{"report":{"findings":[{"evidence":"read of /etc/hosts showed 12 lines; bash `wc -l /etc/hosts` → 12 and `awk END{print NR}` → 12","what":"/etc/hosts contains exactly 12 lines (295 bytes, newline-terminated)"},{"evidence":"full file read; hexdump of tail confirms final byte is 0x0a","what":"File ends with a trailing newline, so line count is unambiguous"}],"summary":"/etc/hosts has 12 lines (verified with both read and wc -l).","usage":{"cost":0,"input":0,"output":0,"turns":3}}},"isError":false,"durationMs":0,"timestamp":1795099891058}}';

/** 真机抓的样本（2026-11-19，pi 1.5.2）：7 轮 assistant，每轮 usage 是单次请求量（非累计）。
 *  合计 input=4571 / output=1367 / cacheRead=19456 / cost≈0.001798；最后一条 input 只有 354。 */
const REAL_USAGE_STREAM = [
  '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_af424c31565348bbad99cb9f","name":"read","arguments":{"path":"/etc/hosts"}}],"usage":{"input":2605,"output":29,"cacheRead":128,"cacheWrite":0,"cost":{"total":0.00041006999999999995}},"stopReason":"toolUse"}}',
  '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_9ae971afc7274287b9d821c0","name":"bash","arguments":{"command":"wc -l /etc/hosts"}}],"usage":{"input":189,"output":62,"cacheRead":2688,"cacheWrite":0,"cost":{"total":0.00010586999999999999}},"stopReason":"toolUse"}}',
  '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_0f1a50cf85574ce7a81622d3","name":"bash","arguments":{"command":"wc -c /etc/hosts"}}],"usage":{"input":131,"output":159,"cacheRead":2816,"cacheWrite":0,"cost":{"total":0.00015729}},"stopReason":"toolUse"}}',
  '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"12 lines"}],"usage":{"input":131,"output":438,"cacheRead":2944,"cacheWrite":0,"cost":{"total":0.00032661}},"stopReason":"toolUse"}}',
  '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_99a212a1e87943da8dda937f","name":"child_report","arguments":{"summary":"s"}}],"usage":{"input":668,"output":239,"cacheRead":3072,"cacheWrite":0,"cost":{"total":0.00028967999999999995}},"stopReason":"toolUse"}}',
  '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_5e3cbe08098c4961a046c7ee","name":"child_report","arguments":{"summary":"s"}}],"usage":{"input":493,"output":245,"cacheRead":3712,"cacheWrite":0,"cost":{"total":0.00027663}},"stopReason":"toolUse"}}',
  '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"`/etc/hosts` has **12 lines**"}],"usage":{"input":354,"output":195,"cacheRead":4096,"cacheWrite":0,"cost":{"total":0.00023153999999999997}},"stopReason":"stop"}}',
].join("\n");

// ── 拼命令 ────────────────────────────────────────────────────────────────

test("拼命令：基础形态是 pi -p --no-session --mode json", () => {
  const argv = buildPiArgv({ task: "干活" });
  assert.deepEqual(argv.slice(0, 5), ["pi", "-p", "--no-session", "--mode", "json"]);
});

test("拼命令：减量旗标永远带（--no-extensions --no-skills）", () => {
  const argv = buildPiArgv({ task: "干活" });
  assert.ok(argv.includes("--no-extensions"));
  assert.ok(argv.includes("--no-skills"));
});

test("拼命令：任务放最后", () => {
  const argv = buildPiArgv({ task: "干活" });
  assert.equal(argv[argv.length - 1], "干活");
});

test("拼命令：projectContext=none 时加 --no-context-files，auto 时不加", () => {
  assert.ok(buildPiArgv({ task: "t", projectContext: "none" }).includes("--no-context-files"));
  assert.ok(!buildPiArgv({ task: "t", projectContext: "auto" }).includes("--no-context-files"));
  assert.ok(!buildPiArgv({ task: "t" }).includes("--no-context-files"));
});

test("拼命令：--no-mcp 有版本门（1.1.0 之前不发）", () => {
  assert.ok(!buildPiArgv({ task: "t", piVersion: "1.0.0" }).includes("--no-mcp"));
  assert.ok(!buildPiArgv({ task: "t", piVersion: "0.99.9" }).includes("--no-mcp"));
  assert.ok(!buildPiArgv({ task: "t", piVersion: undefined }).includes("--no-mcp"));
  assert.ok(buildPiArgv({ task: "t", piVersion: "1.1.0" }).includes("--no-mcp"));
  assert.ok(buildPiArgv({ task: "t", piVersion: "1.5.2" }).includes("--no-mcp"));
  assert.ok(buildPiArgv({ task: "t", piVersion: "2.0.0" }).includes("--no-mcp"));
});

test("版本门：解不出版本按不支持处理", () => {
  assert.equal(supportsNoMcp(undefined), false);
  assert.equal(supportsNoMcp(""), false);
  assert.equal(supportsNoMcp("abc"), false);
  assert.equal(supportsNoMcp("v1.1.0"), true, "带 v 前缀也认");
  assert.equal(supportsNoMcp("1.1"), true, "缺小版本号按 0 算 ⇒ 1.1.0 那一支");
});

test("拼命令：模型解析序是 调用参数 → 会话模型", () => {
  const withBoth = buildPiArgv({ task: "t", model: "a/b", sessionModel: "c/d" });
  assert.ok(withBoth.includes("a/b"), "调用参数优先");
  assert.ok(!withBoth.includes("c/d"));
  const onlySession = buildPiArgv({ task: "t", sessionModel: "c/d" });
  assert.ok(onlySession.includes("c/d"));
  const neither = buildPiArgv({ task: "t" });
  assert.ok(!neither.includes("--model"), "都没有就不发 --model");
});

test("拼命令：思考档位挂在 :<thinking> 后缀", () => {
  const argv = buildPiArgv({ task: "t", model: "a/b", thinkingLevel: "high" });
  assert.ok(argv.includes("a/b:high"));
});

test("拼命令：只读档位 strict 时工具表是读集 + 回执工具", () => {
  const argv = buildPiArgv({ task: "t", readOnly: "strict" });
  const idx = argv.indexOf("--tools");
  assert.ok(idx >= 0);
  assert.equal(argv[idx + 1], "read,grep,find,ls,child_report");
});

test("拼命令：lenient 时不收窄（不发 --tools）", () => {
  assert.ok(!buildPiArgv({ task: "t", readOnly: "lenient" }).includes("--tools"));
  assert.ok(!buildPiArgv({ task: "t" }).includes("--tools"));
});

test("拼命令：allowScripts 在宽档不收窄（不能把 bash/edit/write 砍掉）", () => {
  const argv = buildPiArgv({ task: "t", allowScripts: true });
  assert.ok(!argv.includes("--tools"), "宽档 + allowScripts 不该发 --tools");
  const idx = argv.indexOf("-e");
  assert.ok(idx >= 0, "allowScripts 要带 -e");
  assert.equal(argv[idx + 1], "builtin:codemode");
});

test("拼命令：allowScripts + strict 时工具表是读集 + codemode", () => {
  const argv = buildPiArgv({ task: "t", allowScripts: true, readOnly: "strict" });
  const idx = argv.indexOf("--tools");
  assert.ok(idx >= 0, "strict 要发 --tools");
  assert.equal(argv[idx + 1], "read,grep,find,ls,child_report,codemode");
});

test("拼命令：strict 档白名单也留 child_report", () => {
  const argv = buildPiArgv({ task: "t", readOnly: "strict" });
  const idx = argv.indexOf("--tools");
  assert.equal(argv[idx + 1], "read,grep,find,ls,child_report");
  assert.ok(!argv.includes("-e"));
});

test("拼命令：allowScripts 时带 -e builtin:codemode（不是「内建:」）", () => {
  const argv = buildPiArgv({ task: "t", allowScripts: true });
  const idx = argv.indexOf("-e");
  assert.ok(idx >= 0, "allowScripts 要带 -e");
  assert.equal(argv[idx + 1], "builtin:codemode");
});

test("拼命令：孩子装自己的回执扩展（-e <path>）", () => {
  const argv = buildPiArgv({ task: "t", childExtensionPath: "/x/pi-dispatch.js" });
  const idx = argv.indexOf("-e");
  assert.ok(idx >= 0, "要带 -e");
  assert.equal(argv[idx + 1], "/x/pi-dispatch.js");
  assert.ok(!buildPiArgv({ task: "t" }).includes("/x/pi-dispatch.js"));
});

test("拼命令：不 allowScripts 时不带 -e", () => {
  assert.ok(!buildPiArgv({ task: "t" }).includes("-e"));
  assert.ok(!buildPiArgv({ task: "t", readOnly: "strict" }).includes("-e"));
});

test("拼命令：理由里的 XML 实体被转义（不会伪造标签）", () => {
  const message = buildUserMessage({ task: "干活", why: "<script>alert(1)</script>" });
  assert.ok(!message.includes("<script>"), "未转义的标签会破坏块边界");
  assert.ok(message.includes("&lt;script&gt;"));
  // 连 & 也要逃逸，否则可以拼出 `&lt;` 再伪造标签
  assert.ok(buildUserMessage({ task: "干活", why: "a &amp; b" }).includes("a &amp;amp; b"));
});

test("附加块：没给理由时不带理由段", () => {
  const message = buildUserMessage({ task: "干活" });
  // 契约文案会提到 <pi-dispatch-why>（条件句），注入的理由段必有闭合标签——按闭合标签判有无
  assert.ok(!message.includes("</pi-dispatch-why>"));
  assert.ok(CONTRACT_BLOCK.includes(SUBAGENT_CONTEXT_BLOCK));
});

test("附加块：报告契约总是带上", () => {
  assert.ok(CONTRACT_BLOCK.includes("<child-report-contract>"));
});

test("报告契约：说清「报告是摘要，交付物是正文」", () => {
  assert.match(REPORT_CONTRACT_BLOCK, /NOT the deliverable/);
  assert.match(REPORT_CONTRACT_BLOCK, /never hide the deliverable/);
});

test("报告契约：三段分工 + 反话钉 + why 条件句", () => {
  assert.match(REPORT_CONTRACT_BLOCK, /three sections/);
  assert.match(REPORT_CONTRACT_BLOCK, /uniformly positive/);
  assert.match(REPORT_CONTRACT_BLOCK, /<pi-dispatch-why> block, take it as input/);
});

test("报告 schema：三段必填", () => {
  assert.deepEqual([...CHILD_REPORT_SCHEMA.required].sort(), ["assessment", "summary", "why"]);
});

test("收件：报告散文段超 2KB 截断，缺的 why/assessment 归一化为空串", () => {
  const stream = JSON.stringify({
    type: "message_end",
    message: {
      role: "toolResult",
      toolName: "child_report",
      details: { report: { summary: "x".repeat(3000) } },
    },
  });
  const parsed = parseChildStream(stream);
  assert.equal(parsed.toolReport?.summary.length, 2049, "2048 + 省略号");
  assert.equal(parsed.toolReport?.why, "");
  assert.equal(parsed.toolReport?.assessment, "");
});

test("收件：散文正好 2048 不截尾——阈值是「超过」不是「达到」", () => {
  const exact = "x".repeat(2048);
  const stream = JSON.stringify({
    type: "message_end",
    message: {
      role: "toolResult",
      toolName: "child_report",
      details: { report: { summary: exact } },
    },
  });
  const summary = parseChildStream(stream).toolReport?.summary;
  assert.equal(summary?.length, 2048);
  assert.equal(summary, exact, "整段原样保留，不加省略号");
});

test("vacuous：正好 40 字符且带风险信号 ⇒ 不空转——阈值是「短于」不是「不长于」", () => {
  // 40 字 = 3（信号词 bug）+ 37；差一位就落进空转档，阈值写成 <= 时这条会红
  const text = `bug${"测".repeat(37)}`;
  assert.equal(text.length, 40);
  assert.equal(assessmentVacuous({ summary: "s", why: "w", assessment: text }), false);
});

test("vacuous：缺/短/全正面 ⇒ 空转；有具体风险 ⇒ 不空转", () => {
  assert.equal(assessmentVacuous(undefined), true);
  assert.equal(assessmentVacuous({ summary: "s", why: "w", assessment: "太短" }), true);
  assert.equal(
    assessmentVacuous({
      summary: "s",
      why: "w",
      assessment:
        "整体非常顺利，所有既定目标都已圆满达成，交付质量完全符合预期，可以直接进入下一阶段工作。",
    }),
    true,
    "全正面且过信号词表 ⇒ 空转",
  );
  assert.equal(
    assessmentVacuous({
      summary: "s",
      why: "w",
      assessment:
        "主流程已验证。边界场景还没覆盖全，存在回归风险，建议父方后续补一轮针对异常输入的测试再合入。",
    }),
    false,
  );
});

test("拼命令：契约块里的工具名与常量一致", () => {
  // 整句匹配：includes 会让 "child_reportX" 这种漂移蒙混过关
  assert.match(
    REPORT_CONTRACT_BLOCK,
    new RegExp(`calling the ${CHILD_REPORT_TOOL_NAME} tool`),
    `契约里写的工具名必须就是 ${CHILD_REPORT_TOOL_NAME}`,
  );
});

// ── 收件：解析 JSONL ──────────────────────────────────────────────────────

test("收件：真机样本里抽出正文、模型、用量", () => {
  const parsed = parseChildStream(REAL_STREAM);
  assert.equal(parsed.text, "12", "正文是最后一条 assistant 的 text");
  assert.equal(parsed.observedModel, "group/main");
  assert.equal(parsed.observedProvider, "vendor-local");
  assert.equal(parsed.observedUsage?.input, 2484);
  assert.equal(parsed.observedUsage?.output, 3);
  assert.equal(parsed.observedUsage?.cacheRead, 128);
});

test("收件：收据统计工具调用次数；真机样本只读过，路径清单因此是空的", () => {
  const parsed = parseChildStream(REAL_STREAM);
  assert.equal(parsed.delivery.tools.read, 1);
  assert.equal(parsed.delivery.tools.bash, 1);
  assert.deepEqual(parsed.delivery.paths, [], "读过不等于改过");
  assert.equal(parsed.delivery.errors, 0);
  assert.equal(parsed.delivery.textChars, 2);
});

test("收件：读不算改过——read/grep 的 path 不进收据，bash 的也不进", () => {
  const parsed = parseChildStream(REAL_STREAM);
  assert.deepEqual(parsed.delivery.paths, [], "read 的 path 不算改动");
  assert.equal((parsed.delivery.paths as string[]).filter((p) => p.includes("grep")).length, 0);
  const mixed = [
    '{"type":"tool_execution_start","toolCallId":"c1","toolName":"read","args":{"path":"/a"}}',
    '{"type":"tool_execution_end","toolCallId":"c1","toolName":"read","isError":false}',
    '{"type":"tool_execution_start","toolCallId":"c2","toolName":"edit","args":{"path":"/b"}}',
    '{"type":"tool_execution_end","toolCallId":"c2","toolName":"edit","isError":false}',
    '{"type":"tool_execution_start","toolCallId":"c3","toolName":"write","args":{"path":"/c"}}',
    '{"type":"tool_execution_end","toolCallId":"c3","toolName":"write","isError":false}',
  ].join("\n");
  assert.deepEqual(parseChildStream(mixed).delivery.paths, ["/b", "/c"], "只有写类工具算改过");
});

test("收件：失败的工具调用不算碰过（5 次全失败的 edit 也换不到自述对上）", () => {
  // 路径在 start 时暂存、end 且没报错才落进收据：失败的那次没改到任何东西。
  // 之前是在 start 就落——5 次全失败的 edit 也算「碰过 5 个文件」，
  // 孩子照着自述写一遍就能换到「已核对」（实测可达）。
  const lines: string[] = [];
  for (let i = 0; i < 5; i++) {
    lines.push(
      `{"type":"tool_execution_start","toolCallId":"f${i}","toolName":"edit","args":{"path":"/nope${i}"}}`,
    );
    lines.push(
      `{"type":"tool_execution_end","toolCallId":"f${i}","toolName":"edit","isError":true}`,
    );
  }
  const parsed = parseChildStream(lines.join("\n"));
  assert.deepEqual(parsed.delivery.paths, [], "失败的不算改过");
  assert.equal(parsed.delivery.errors, 5);
  // 判词看的是引擎算好的旗标，不是收据本身——这里把旗标也一起算出来
  const unverified = deliveryUnverified(
    { summary: "s", why: "", assessment: "", files_touched: ["/nope0"] },
    parsed.delivery,
  );
  assert.equal(unverified, true, "自述说改了，但那次编辑失败了 ⇒ 没有实测支撑");
  assert.equal(
    deliverableOf({
      report: { summary: "s", why: "", assessment: "", files_touched: ["/nope0"] },
      delivery: parsed.delivery,
      deliveryUnverified: unverified,
    }),
    "unverified",
  );
});

test("收件：失败的命令不算兑现（跑挂的 pnpm test 换不到 verified）", () => {
  // 命令侧原先是 start 就记：跑挂的 `pnpm test` 也算「跑过」，
  // 于是声称 `exitCode: 0` 照样拿到「已核对」（实测可达）。
  // 现在与路径侧同构：end 且不报错才算兑现。
  const stream = [
    '{"type":"tool_execution_start","toolCallId":"bf1","toolName":"bash","args":{"command":"pnpm test"}}',
    '{"type":"tool_execution_end","toolCallId":"bf1","toolName":"bash","isError":true}',
  ].join("\n");
  const parsed = parseChildStream(stream);
  assert.deepEqual(parsed.delivery.commands, [], "跑挂的不算跑过");
  assert.equal(parsed.delivery.errors, 1);
  const report = { summary: "s", why: "", assessment: "", verified: [{ command: "pnpm test" }] };
  assert.equal(
    verifyUnverified(report, parsed.delivery),
    true,
    "声称跑了，但那次跑挂了 ⇒ 没有实测支撑",
  );
});

test("收件：成功的命令照记（失败才不算，别把好的一起砍了）", () => {
  const stream = [
    '{"type":"tool_execution_start","toolCallId":"bs1","toolName":"bash","args":{"command":"pnpm test"}}',
    '{"type":"tool_execution_end","toolCallId":"bs1","toolName":"bash","isError":false}',
  ].join("\n");
  assert.deepEqual(parseChildStream(stream).delivery.commands, ["pnpm test"]);
});

test("收件：没有 end 的调用不算碰过（流被截断，不知道成没成）", () => {
  // pi 每次 tool_execution_start 都有配对的 end（成功或失败都发）；
  // 只有流被截断（子代理被杀、输出文件被切）才会缺 end。
  // 那种情况下不知道成没成 ⇒ 不记路径（宁漏勿冤），也不能算碰过。
  const stream =
    '{"type":"tool_execution_start","toolCallId":"x1","toolName":"edit","args":{"path":"/a"}}';
  const parsed = parseChildStream(stream);
  assert.deepEqual(parsed.delivery.paths, [], "配不上 end 就不记");
  assert.equal(parsed.delivery.errors, 0, "没有 end 就没有失败可数");
});

test("收件：工具出错要计数", () => {
  const stream = [
    '{"type":"tool_execution_start","toolName":"read","args":{"path":"/x"}}',
    '{"type":"tool_execution_end","toolName":"read","isError":true}',
  ].join("\n");
  assert.equal(parseChildStream(stream).delivery.errors, 1);
});

test("收件：畸形行不许毒化整次解析", () => {
  const stream = [
    "{不是 JSON",
    '{"type":"tool_execution_start","toolName":"read","args":{"path":"/x"}}',
    "",
  ].join("\n");
  const parsed = parseChildStream(stream);
  assert.equal(parsed.delivery.tools.read, 1);
});

test("收件：空流不崩", () => {
  const parsed = parseChildStream("");
  assert.equal(parsed.text, "");
  assert.equal(parsed.observedUsage, null);
  assert.deepEqual(parsed.delivery.paths, []);
});

test("收件：多条 assistant 消息时「最后一段胜出」", () => {
  const stream = [
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"第一段"}]}}',
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"第二段"}]}}',
  ].join("\n");
  assert.equal(parseChildStream(stream).text, "第二段");
});

test("收件：工具通道的报告要抽出来", () => {
  const stream = [
    '{"type":"message_end","message":{"role":"toolResult","toolName":"child_report","structuredContent":{"summary":"结论","files_touched":["a.ts"]}}}',
  ].join("\n");
  const parsed = parseChildStream(stream);
  assert.equal(parsed.toolReport?.summary, "结论");
  assert.deepEqual(parsed.toolReport?.files_touched, ["a.ts"]);
});

test("收件：报告通道优先级——structuredContent > details.report > details", () => {
  const withStructured = [
    '{"type":"message_end","message":{"role":"toolResult","toolName":"child_report","structuredContent":{"summary":"来自 structuredContent"},"details":{"summary":"来自 details"}}}',
  ].join("\n");
  assert.equal(parseChildStream(withStructured).toolReport?.summary, "来自 structuredContent");

  const withDetailsReport = [
    '{"type":"message_end","message":{"role":"toolResult","toolName":"child_report","details":{"report":{"summary":"来自 details.report"}}}}',
  ].join("\n");
  assert.equal(parseChildStream(withDetailsReport).toolReport?.summary, "来自 details.report");

  const withPlainDetails = [
    '{"type":"message_end","message":{"role":"toolResult","toolName":"child_report","details":{"summary":"来自 details"}}}',
  ].join("\n");
  assert.equal(parseChildStream(withPlainDetails).toolReport?.summary, "来自 details");
});

test("收件：真机工具回执样本（child_report → details.report）", () => {
  const parsed = parseChildStream(REAL_TOOL_STREAM);
  assert.equal(
    parsed.toolReport?.summary,
    "/etc/hosts has 12 lines (verified with both read and wc -l).",
  );
  assert.equal(parsed.toolReport?.findings?.length, 2);
});

test("收件：多轮用量累加（不是最后一条）", () => {
  const parsed = parseChildStream(REAL_USAGE_STREAM);
  // 每轮 usage 是单次请求量；账要按累计算，最后一条（input=354）只是 1/13
  assert.equal(parsed.observedUsageTotal?.input, 4571);
  assert.equal(parsed.observedUsageTotal?.output, 1367);
  assert.equal(parsed.observedUsageTotal?.cacheRead, 19456);
  assert.ok(Math.abs((parsed.observedUsageTotal?.cost ?? 0) - 0.00179769) < 1e-6, "cost 也要累加");
  // 最后一条单独的值仍在（供「报告自报为空时顶上去」用）
  assert.equal(parsed.observedUsage?.input, 354);
});

test("收件：缺席的用量字段按 0 累加", () => {
  // provider 可能省略 cache 字段：undefined 要当 0，不能污染合计
  const stream = [
    '{"type":"message_end","message":{"role":"assistant","content":[],"usage":{"input":10,"output":1}}}',
    '{"type":"message_end","message":{"role":"assistant","content":[],"usage":{"input":5,"output":2}}}',
  ].join("\n");
  const parsed = parseChildStream(stream);
  assert.equal(parsed.observedUsageTotal?.input, 15);
  assert.equal(parsed.observedUsageTotal?.cacheRead, 0, "缺席字段按 0 计");
  assert.equal(parsed.observedUsageTotal?.cost, 0);
});

test("收件：工具结果的文本不覆盖正文", () => {
  const stream = [
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"正文"}]}}',
    '{"type":"message_end","message":{"role":"toolResult","toolName":"child_report","content":[{"type":"text","text":"child report received"}],"details":{"report":{"summary":"回执"}}}}',
  ].join("\n");
  const parsed = parseChildStream(stream);
  assert.equal(parsed.text, "正文");
  assert.equal(parsed.toolReport?.summary, "回执");
});

test("收件：不是 child_report 的工具结果不进报告通道", () => {
  const stream = [
    '{"type":"message_end","message":{"role":"toolResult","toolName":"other_tool","structuredContent":{"summary":"不该被收"}}}',
  ].join("\n");
  assert.equal(parseChildStream(stream).toolReport, null);
});

test("报告：prompt 通道从正文末尾抠 JSON 块", () => {
  const text = `这是正文。

\`\`\`json
{ "summary": "一句话结论", "files_touched": ["src/a.ts"] }
\`\`\``;
  const { report, channel } = extractReportFromText(text);
  assert.equal(channel, "prompt-json");
  assert.equal(report?.summary, "一句话结论");
  assert.deepEqual(report?.files_touched, ["src/a.ts"]);
});

test("报告：多个 JSON 块时取最后一个", () => {
  const text = `\`\`\`json\n{"summary":"旧的"}\n\`\`\`\n正文\n\`\`\`json\n{"summary":"新的"}\n\`\`\``;
  assert.equal(extractReportFromText(text).report?.summary, "新的");
});

test("报告：没有 JSON 块是 none（不是说成交了）", () => {
  const { report, channel } = extractReportFromText("只有散文");
  assert.equal(channel, "none");
  assert.equal(report, null);
});

test("报告：JSON 块坏了就当没有（不抛异常）", () => {
  const { channel } = extractReportFromText("```json\n{ 这不是 JSON\n```");
  assert.equal(channel, "none");
});

test("报告：summary 为空串不算交了一份报告", () => {
  const { channel } = extractReportFromText('```json\n{"summary":""}\n```');
  assert.equal(channel, "none");
});

test("报告：非对象的 JSON 块不算报告", () => {
  const { channel } = extractReportFromText("```json\n[1,2,3]\n```");
  assert.equal(channel, "none");
});

// ── 卡住判定 ──────────────────────────────────────────────────────────────

test("卡住：静默超过阈值且没有在飞工具 ⇒ 卡住", () => {
  let now = 0;
  const tracker = new ChildActivityTracker(() => now);
  assert.equal(tracker.isStalled(now + DEFAULT_STALL_MS, DEFAULT_STALL_MS), true);
});

test("卡住：刚有动静 ⇒ 不卡住", () => {
  let now = 0;
  const tracker = new ChildActivityTracker(() => now);
  tracker.push("some output\n");
  now = DEFAULT_STALL_MS - 1;
  assert.equal(tracker.isStalled(now, DEFAULT_STALL_MS), false);
});

test("卡住：有在飞的工具调用 ⇒ 不卡住（正在等慢工具）", () => {
  let now = 0;
  const tracker = new ChildActivityTracker(() => now);
  tracker.push('{"type":"tool_execution_start","toolName":"bash","args":{}}\n');
  assert.equal(tracker.openTools, 1);
  assert.equal(tracker.isStalled(now + DEFAULT_STALL_MS * 10, DEFAULT_STALL_MS), false);
});

test("卡住：工具调用结束后又静默 ⇒ 卡住", () => {
  let now = 0;
  const tracker = new ChildActivityTracker(() => now);
  tracker.push('{"type":"tool_execution_start","toolName":"bash","args":{}}\n');
  tracker.push('{"type":"tool_execution_end","toolName":"bash","isError":false}\n');
  assert.equal(tracker.openTools, 0);
  assert.equal(tracker.isStalled(now + DEFAULT_STALL_MS, DEFAULT_STALL_MS), true);
});

test("卡住：半行的事件先攒着，不误判", () => {
  let now = 0;
  const tracker = new ChildActivityTracker(() => now);
  tracker.push('{"type":"tool_execution_start","toolName":"bash"');
  assert.equal(tracker.openTools, 0, "半行还没成事件");
  tracker.push(',"args":{}}\n');
  assert.equal(tracker.openTools, 1, "凑齐一行才计数");
});

test("卡住：非工具事件不计入在飞工具（但有字节就算动静）", () => {
  let now = 0;
  const tracker = new ChildActivityTracker(() => now);
  tracker.push('{"type":"message_update","usage":{}}\n');
  assert.equal(tracker.openTools, 0);
  assert.equal(tracker.isStalled(now, DEFAULT_STALL_MS), false, "有字节就不算静默");
});

test("卡住：end 多于 start 时计数不为负", () => {
  let now = 0;
  const tracker = new ChildActivityTracker(() => now);
  tracker.push('{"type":"tool_execution_end","toolName":"bash"}\n');
  assert.equal(tracker.openTools, 0);
});

// ── 真起进程 ──────────────────────────────────────────────────────────────

test("真起进程：起一个不存在的命令 ⇒ 报失败，不抛异常", async () => {
  const child = spawnChild(["/nonexistent/definitely-not-a-command", "x"], process.env);
  const exitCode = await new Promise<number>((resolve) => {
    child.onExit((code, stderr) => {
      assert.match(stderr, /spawn error/, "错误要留在 stderr 里");
      resolve(code);
    });
  });
  assert.notEqual(exitCode, 0, "起不来要报失败");
});

test("真起进程：SIGKILL 的孩子退出码按 POSIX 记 137", async () => {
  // close 事件对「被信号杀死」的进程给 (null, signal) ⇒ 核心按 POSIX 记 128+signo。
  const child = spawnChild(["/bin/sh", "-c", "sleep 30"], process.env);
  const exitCode = await new Promise<number>((resolve) => {
    child.onExit((code) => resolve(code));
    setTimeout(() => child.kill("SIGKILL"), 100);
  });
  assert.equal(exitCode, 137, "SIGKILL ⇒ 128+9=137，旧口径的 -1 分不清信号");
});

test("真起进程：SIGTERM 的孩子退出码按 POSIX 记 143", async () => {
  const child = spawnChild(["/bin/sh", "-c", "sleep 30"], process.env);
  const exitCode = await new Promise<number>((resolve) => {
    child.onExit((code) => resolve(code));
    setTimeout(() => child.kill("SIGTERM"), 100);
  });
  assert.equal(exitCode, 143, "SIGTERM ⇒ 128+15=143");
});

test("真起进程：晚订阅也要拿到退出码（退出早于订阅）", async () => {
  const child = spawnChild(["/bin/sh", "-c", "exit 3"], process.env);
  // 先等一会儿，让进程先退出
  await new Promise((resolve) => setTimeout(resolve, 200));
  const exitCode = await new Promise<number>((resolve) => {
    child.onExit((code) => resolve(code));
  });
  assert.equal(exitCode, 3, "晚订阅要补发退出码");
});

test("真起进程：没人订阅 stdout 时子进程也不能卡死（管道必须无条件排空）", async () => {
  // 回归：不消费 stdout ⇒ 管道缓冲满 ⇒ 子进程卡在写上面 ⇒ close 事件永远不来。
  // 实测踩过：探针挂住 90 秒。修复后无论有没有订阅者都要把管道读干净。
  const child = spawnChild(
    ["/bin/sh", "-c", 'for i in $(seq 1 5000); do echo "noise line $i padding padding"; done'],
    process.env,
  );
  const exitCode = await new Promise<number>((resolve) => {
    const timer = setTimeout(() => resolve(-999), 10_000);
    child.onExit((code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  assert.notEqual(exitCode, -999, "没人订阅 stdout 时也要能退出");
  assert.equal(exitCode, 0);
});

test("真起进程：能接到 stdout 输出", async () => {
  const child = spawnChild(["/bin/sh", "-c", "printf 'hello\\n'"], process.env);
  let out = "";
  child.onOutput((chunk) => {
    out += chunk;
  });
  await new Promise<void>((resolve) => {
    child.onExit(() => resolve());
  });
  assert.match(out, /hello/);
});

test("真起进程：stderr 超长只留尾巴（不撑爆内存）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-stderr-"));
  const script = join(dir, "noisy.sh");
  writeFileSync(
    script,
    '#!/bin/sh\nfor i in $(seq 1 5000); do echo "noise line $i padding padding"; done\n',
  );
  const child = spawnChild(["/bin/sh", script], process.env);
  let stderr = "";
  await new Promise<void>((resolve) => {
    child.onExit((_code, err) => {
      stderr = err;
      resolve();
    });
  });
  assert.ok(stderr.length <= 64 * 1024, `stderr 长度 ${stderr.length}，不该超上限`);
});

test("真起进程：exit 事件与 close 事件的顺序——退出码要等 close", async () => {
  // 真实场景：管道尾部数据比 exit 晚。若实现听 exit，报告和用量会丢。
  // 必须写够多的字节：小输出在 exit 前就到了，测不出差别（实测过：写一行时这个用例是假绿）。
  const bytes = 1_000_000;
  const child = spawnChild(
    ["/bin/sh", "-c", `head -c ${bytes} /dev/zero | tr '\\0' 'x'; exit 0`],
    process.env,
  );
  let out = "";
  child.onOutput((chunk) => {
    out += chunk;
  });
  await new Promise<void>((resolve) => {
    child.onExit(() => resolve());
  });
  assert.equal(out.length, bytes, "close 之后管道里的数据要全部到齐（少了就是听了 exit）");
});

test("真起进程：pi --version 能跑（确认可执行文件路径可用）", () => {
  // 从测试文件自身位置推仓根：写死绝对路径的话，只有作者那台机器能跑（CI 抓到的）
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const cli = join(repoRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  const out = execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
  assert.match(out, /\d+\.\d+/);
});

// ── 变异补强：把「分支」逐个钉死 ─────────────────────────────────────────

test("版本门：NaN 时按不支持处理", () => {
  assert.equal(supportsNoMcp("1.x.3"), false);
  assert.equal(supportsNoMcp("v1.x.3"), false);
});

test("拼命令：piPath 覆盖默认的 pi", () => {
  const argv = buildPiArgv({ task: "t", piPath: "/custom/pi" });
  assert.equal(argv[0], "/custom/pi");
  assert.ok(!buildPiArgv({ task: "t" }).includes("/custom/pi"));
});

test("拼命令：模型为空串时回落���会话模型", () => {
  const argv = buildPiArgv({ task: "t", model: "", sessionModel: "c/d" });
  const idx = argv.indexOf("--model");
  assert.ok(idx >= 0, "空串当没给 ⇒ 回落到会话模型");
  assert.equal(argv[idx + 1], "c/d", "不该把空串当模型名发出去");
});

test("拼命令：模型和会话模型都空时不发 --model", () => {
  const argv = buildPiArgv({ task: "t", model: "", sessionModel: "" });
  assert.ok(!argv.includes("--model"), "两个都空 ⇒ 不发 --model");
});

test("拼命令：思考档位为空串时不该拼成 '模型:'", () => {
  const argv = buildPiArgv({ task: "t", model: "a/b", thinkingLevel: "" });
  const idx = argv.indexOf("--model");
  assert.ok(idx >= 0);
  assert.equal(argv[idx + 1], "a/b", "空档位不该拼出 'a/b:'");
});

test("收件：同一工具调多次要累加次数", () => {
  const stream = [
    '{"type":"tool_execution_start","toolName":"read","args":{"path":"/a"}}',
    '{"type":"tool_execution_start","toolName":"read","args":{"path":"/b"}}',
    '{"type":"tool_execution_start","toolName":"read","args":{"path":"/a"}}',
  ].join("\n");
  assert.equal(parseChildStream(stream).delivery.tools.read, 3);
});

test("收件：路径去重（同一路径只记一次）", () => {
  const stream = [
    '{"type":"tool_execution_start","toolCallId":"d1","toolName":"edit","args":{"path":"/a"}}',
    '{"type":"tool_execution_end","toolCallId":"d1","toolName":"edit","isError":false}',
    '{"type":"tool_execution_start","toolCallId":"d2","toolName":"edit","args":{"path":"/a"}}',
    '{"type":"tool_execution_end","toolCallId":"d2","toolName":"edit","isError":false}',
    '{"type":"tool_execution_start","toolCallId":"d3","toolName":"edit","args":{"path":"/b"}}',
    '{"type":"tool_execution_end","toolCallId":"d3","toolName":"edit","isError":false}',
  ].join("\n");
  assert.deepEqual(parseChildStream(stream).delivery.paths, ["/a", "/b"]);
});

test("收件：自述路径两侧空白不影响对质（命令侧 trim，路径侧也要）", () => {
  // 命令走 normalizeCommand 会 trim，路径侧原先不 trim ⇒
  // `files_touched: [" /a.ts "]` 配收据 `/a.ts` 永远对不上，冤枉诚实孩子。
  const delivery = { tools: {}, paths: ["/a.ts"], commands: [], errors: 0, textChars: 10 };
  const report = { summary: "s", why: "", assessment: "", files_touched: [" /a.ts "] };
  assert.equal(deliveryUnverified(report, delivery), false, "两侧空白不该影响");
});

test("收件：只有 start 没有 end ⇒ 置截断位（证据丢了，不是没做过）", () => {
  // 子代理被杀 / 日志被切时，在飞的那次调用只剩 start。
  // 那是「不知道成没成」，不是「没做过」——置截断位让判词按「没法对质」处理，
  // 别把诚实孩子判成「没有实测支撑」。
  const stream =
    '{"type":"tool_execution_start","toolCallId":"k1","toolName":"edit","args":{"path":"/a"}}';
  const delivery = parseChildStream(stream).delivery;
  assert.equal(delivery.pathsTruncated, true);
  assert.equal(delivery.commandsTruncated, true);
});

test("收件：路径清单有上限（超出的不记，但记下截断过）", () => {
  const lines: string[] = [];
  for (let i = 0; i < 30; i++) {
    lines.push(
      `{"type":"tool_execution_start","toolCallId":"p${i}","toolName":"edit","args":{"path":"/p${i}"}}`,
    );
    lines.push(
      `{"type":"tool_execution_end","toolCallId":"p${i}","toolName":"edit","isError":false}`,
    );
  }
  const delivery = parseChildStream(lines.join("\n")).delivery;
  assert.equal(delivery.paths.length, 20, "路径清单上限 20");
  assert.equal(delivery.pathsTruncated, true, "丢过证据要说出来：截断时判「对不上」是冤枉");
});

test("收件：命令清单留最近 20 条，丢过就记下截断", () => {
  const lines: string[] = [];
  for (let i = 0; i < 21; i++) {
    lines.push(
      `{"type":"tool_execution_start","toolCallId":"c${i}","toolName":"bash","args":{"command":"cmd${i}"}}`,
    );
    lines.push(
      `{"type":"tool_execution_end","toolCallId":"c${i}","toolName":"bash","isError":false}`,
    );
  }
  const delivery = parseChildStream(lines.join("\n")).delivery;
  assert.equal(delivery.commands.length, 20, "只留最近 20 条");
  assert.equal(delivery.commands[0], "cmd1", "丢的是最旧的（交付前的验证命令在尾部）");
  assert.equal(delivery.commandsTruncated, true);
});

test("收件：args 不是对象或 path 不是字符串时不记路径", () => {
  const stream = [
    '{"type":"tool_execution_start","toolCallId":"n1","toolName":"edit"}',
    '{"type":"tool_execution_end","toolCallId":"n1","toolName":"edit","isError":false}',
    '{"type":"tool_execution_start","toolCallId":"n2","toolName":"edit","args":{}}',
    '{"type":"tool_execution_end","toolCallId":"n2","toolName":"edit","isError":false}',
    '{"type":"tool_execution_start","toolCallId":"n3","toolName":"edit","args":{"path":123}}',
    '{"type":"tool_execution_end","toolCallId":"n3","toolName":"edit","isError":false}',
    '{"type":"tool_execution_start","toolCallId":"n4","toolName":"edit","args":{"path":""}}',
    '{"type":"tool_execution_end","toolCallId":"n4","toolName":"edit","isError":false}',
  ].join("\n");
  assert.deepEqual(parseChildStream(stream).delivery.paths, []);
});

test("收件：工具名缺失时记成 unknown", () => {
  const stream = '{"type":"tool_execution_start","args":{"path":"/x"}}';
  assert.equal(parseChildStream(stream).delivery.tools.unknown, 1);
});

test("收件：isError 在 result 里也算出错", () => {
  const stream = '{"type":"tool_execution_end","toolName":"read","result":{"isError":true}}';
  assert.equal(parseChildStream(stream).delivery.errors, 1);
});

test("收件：isError 为 false 不算出错", () => {
  const stream = '{"type":"tool_execution_end","toolName":"read","isError":false}';
  assert.equal(parseChildStream(stream).delivery.errors, 0);
});

test("收件：bash 命令进收据（真机样本）", () => {
  // 真机抓的 REAL_STREAM（pi 1.5.2）：read + bash 各一次，命令原样记串
  assert.deepEqual(parseChildStream(REAL_STREAM).delivery.commands, [
    "grep -n localhost /etc/hosts",
  ]);
});

test("收件：命令去重（同一命令只记一次）", () => {
  const stream = [
    '{"type":"tool_execution_start","toolCallId":"g1","toolName":"bash","args":{"command":"pnpm test"}}',
    '{"type":"tool_execution_end","toolCallId":"g1","toolName":"bash","isError":false}',
    '{"type":"tool_execution_start","toolCallId":"g2","toolName":"bash","args":{"command":"pnpm test"}}',
    '{"type":"tool_execution_end","toolCallId":"g2","toolName":"bash","isError":false}',
    '{"type":"tool_execution_start","toolCallId":"g3","toolName":"bash","args":{"command":"tsc"}}',
    '{"type":"tool_execution_end","toolCallId":"g3","toolName":"bash","isError":false}',
  ].join("\n");
  assert.deepEqual(parseChildStream(stream).delivery.commands, ["pnpm test", "tsc"]);
});

test("收件：命令清单上限——保最近 20 条（验证命令在尾部）", () => {
  const lines: string[] = [];
  for (let i = 0; i < 25; i++) {
    lines.push(
      `{"type":"tool_execution_start","toolCallId":"h${i}","toolName":"bash","args":{"command":"cmd${i}"}}`,
    );
    lines.push(
      `{"type":"tool_execution_end","toolCallId":"h${i}","toolName":"bash","isError":false}`,
    );
  }
  const commands = parseChildStream(lines.join("\n")).delivery.commands;
  assert.equal(commands.length, 20, "命令清单上限 20");
  assert.equal(commands[0], "cmd5", "最老的 5 条被挤出");
  assert.equal(commands[19], "cmd24", "最近一条保留");
});

test("收件：非 bash 工具不记命令", () => {
  const stream = '{"type":"tool_execution_start","toolName":"read","args":{"path":"/a"}}';
  assert.deepEqual(parseChildStream(stream).delivery.commands, []);
});

test("收件：command 缺失或不是字符串时不记", () => {
  const stream = [
    '{"type":"tool_execution_start","toolName":"bash"}',
    '{"type":"tool_execution_start","toolName":"bash","args":{}}',
    '{"type":"tool_execution_start","toolName":"bash","args":{"command":123}}',
    '{"type":"tool_execution_start","toolName":"bash","args":{"command":""}}',
  ].join("\n");
  assert.deepEqual(parseChildStream(stream).delivery.commands, []);
});

test("收件：超长命令截尾（600 → 500+…）", () => {
  const long = "x".repeat(600);
  const stream = [
    `{"type":"tool_execution_start","toolCallId":"l1","toolName":"bash","args":{"command":"${long}"}}`,
    '{"type":"tool_execution_end","toolCallId":"l1","toolName":"bash","isError":false}',
  ].join("\n");
  const commands = parseChildStream(stream).delivery.commands;
  assert.equal(commands[0]!.length, 501, "500 字符 + 省略号");
  assert.ok(commands[0]!.endsWith("…"));
});

test("收件：命令正好 500 字符不截尾——阈值是「超过」不是「达到」", () => {
  const exact = "x".repeat(500);
  const stream = [
    `{"type":"tool_execution_start","toolCallId":"x1","toolName":"bash","args":{"command":"${exact}"}}`,
    '{"type":"tool_execution_end","toolCallId":"x1","toolName":"bash","isError":false}',
  ].join("\n");
  const commands = parseChildStream(stream).delivery.commands;
  assert.equal(commands.length, 1);
  assert.equal(commands[0], exact, "500 字符原样记串");
});

test("收件：非 text 的内容块不进正文（thinking 等）", () => {
  const stream = [
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"想"}]}}',
  ].join("\n");
  assert.equal(parseChildStream(stream).text, "");
});

test("收件：content 不是数组时按「没有文本」处理", () => {
  const stream = '{"type":"message_end","message":{"role":"assistant","content":"不是数组"}}';
  assert.equal(parseChildStream(stream).text, "");
});

test("收件：cost 是数字时直接用，是对象时取 total", () => {
  const numeric = [
    '{"type":"message_end","message":{"role":"assistant","content":[],"usage":{"input":1,"output":2,"cost":0.5}}}',
  ].join("\n");
  assert.equal(parseChildStream(numeric).observedUsage?.cost, 0.5);

  const object = [
    '{"type":"message_end","message":{"role":"assistant","content":[],"usage":{"input":1,"output":2,"cost":{"total":0.25}}}}',
  ].join("\n");
  assert.equal(parseChildStream(object).observedUsage?.cost, 0.25);
});

test("收件：cacheRead / cacheWrite 缺省时不出现在用量里", () => {
  const stream = [
    '{"type":"message_end","message":{"role":"assistant","content":[],"usage":{"input":1,"output":2}}}',
  ].join("\n");
  const usage = parseChildStream(stream).observedUsage;
  assert.equal(usage?.cacheRead, undefined);
  assert.equal(usage?.cacheWrite, undefined);
});

test("收件：报告通道——details.report 优先于 details 本体", () => {
  const stream = [
    '{"type":"message_end","message":{"role":"toolResult","toolName":"child_report","details":{"summary":"本体","report":{"summary":"嵌套"}}}}',
  ].join("\n");
  assert.equal(parseChildStream(stream).toolReport?.summary, "嵌套");
});

test("收件：报告没有 summary 字段就不算报告", () => {
  const stream = [
    '{"type":"message_end","message":{"role":"toolResult","toolName":"child_report","structuredContent":{"files_touched":["a"]}}}',
  ].join("\n");
  assert.equal(parseChildStream(stream).toolReport, null);
});

test("收件：工具通道的报告也过规范化——files_touched 非数组要滤掉", () => {
  const stream = [
    '{"type":"message_end","message":{"role":"toolResult","toolName":"child_report","structuredContent":{"summary":"s","files_touched":"a.ts"}}}',
  ].join("\n");
  assert.equal(parseChildStream(stream).toolReport?.files_touched, undefined);
});

test("报告：findings 里不是字符串 what 的要滤掉", () => {
  const text = '```json\n{"summary":"s","findings":[{"what":"好的"},{"what":123},{"nope":1}]}\n```';
  const report = extractReportFromText(text).report;
  assert.equal(report?.findings?.length, 1);
  assert.equal(report?.findings?.[0]?.what, "好的");
});

test("报告：files_touched 里非字符串的要滤掉", () => {
  const text = '```json\n{"summary":"s","files_touched":["a.ts",123,null]}\n```';
  assert.deepEqual(extractReportFromText(text).report?.files_touched, ["a.ts"]);
});

test("报告：usage 不是对象就丢掉", () => {
  const bad = '```json\n{"summary":"s","usage":"nope"}\n```';
  assert.equal(extractReportFromText(bad).report?.usage, undefined);
  const good = '```json\n{"summary":"s","usage":{"input":1}}\n```';
  assert.deepEqual(extractReportFromText(good).report?.usage, { input: 1 });
});

test("报告：findings / files_touched 缺省时是 undefined", () => {
  const report = extractReportFromText('```json\n{"summary":"s"}\n```').report;
  assert.equal(report?.findings, undefined);
  assert.equal(report?.files_touched, undefined);
});

test("报告：verified 透传并过滤——command 非字符串的项丢掉", () => {
  const good = extractReportFromText(
    '```json\n{"summary":"s","verified":[{"command":"pnpm test","exitCode":0},{"command":123},{"nope":1},{"command":"tsc","exitCode":"x"}]}\n```',
  ).report;
  assert.deepEqual(good?.verified, [{ command: "pnpm test", exitCode: 0 }, { command: "tsc" }]);
  const bad = extractReportFromText('```json\n{"summary":"s","verified":"pnpm test"}\n```').report;
  assert.equal(bad?.verified, undefined, "非数组整个丢掉");
  const absent = extractReportFromText('```json\n{"summary":"s"}\n```').report;
  assert.equal(absent?.verified, undefined, "没给就是 undefined");
});

test("报告：verified 的 command 超长截到 200", () => {
  const long = "y".repeat(300);
  const report = extractReportFromText(
    `\`\`\`json\n{"summary":"s","verified":[{"command":"${long}"}]}\n\`\`\``,
  ).report;
  assert.equal(report?.verified?.[0]?.command.length, 201, "200 字符 + 省略号");
  assert.ok(report?.verified?.[0]?.command.endsWith("…"));
});

test("报告：verified 的 command 正好 200 不截尾", () => {
  const exact = "y".repeat(200);
  const report = extractReportFromText(
    `\`\`\`json\n{"summary":"s","verified":[{"command":"${exact}"}]}\n\`\`\``,
  ).report;
  assert.equal(report?.verified?.[0]?.command, exact, "200 字符原样保留");
});

test("报告：verified 里的 null 项被丢掉，不炸", () => {
  const report = extractReportFromText(
    '```json\n{"summary":"s","verified":[null,{"command":"tsc","exitCode":0}]}\n```',
  ).report;
  assert.deepEqual(report?.verified, [{ command: "tsc", exitCode: 0 }]);
});

test("收件：工具通道的 verified 也过规范化", () => {
  const stream = [
    '{"type":"message_end","message":{"role":"toolResult","toolName":"child_report","structuredContent":{"summary":"s","verified":[{"command":"pnpm test"},{"command":123}]}}}',
  ].join("\n");
  assert.deepEqual(parseChildStream(stream).toolReport?.verified, [{ command: "pnpm test" }]);
});

test("契约：schema 与契约块都带 verified（别写两处）", () => {
  assert.ok(REPORT_CONTRACT_BLOCK.includes('"verified"'));
  assert.ok("verified" in CHILD_REPORT_SCHEMA.properties);
});

// ── 交付核对：自述对收据 ────────────────────────────────────────────────

test("交付核对：相对路径与绝对路径双向互认", () => {
  assert.equal(pathMatches("src/a.ts", "/repo/src/a.ts"), true);
  assert.equal(pathMatches("/repo/src/a.ts", "src/a.ts"), true);
  assert.equal(pathMatches("src/a.ts", "a.ts"), true);
  assert.equal(pathMatches("a.ts", "src/a.ts"), true);
});

test("交付核对：按分隔符对齐——a.ts 不能命中 xa.ts", () => {
  assert.equal(pathMatches("a.ts", "xa.ts"), false);
  assert.equal(pathMatches("a.ts", "x/a.ts"), true);
  assert.equal(pathMatches("src/a.ts", "/repo/other/a.ts"), false);
});

test("交付核对：一个都对不上才报没有实测支撑", () => {
  const report = { summary: "s", why: "", assessment: "", files_touched: ["src/a.ts"] };
  const delivery = (paths: string[]) => ({
    tools: {},
    paths,
    commands: [],
    errors: 0,
    textChars: 10,
  });
  assert.equal(deliveryUnverified(report, delivery(["/repo/src/a.ts"])), false);
  assert.equal(deliveryUnverified(report, delivery(["/repo/b.ts"])), true);
  assert.equal(deliveryUnverified(report, delivery([])), true, "收据里没有路径 = 没有实测支撑");
  assert.equal(
    deliveryUnverified({ summary: "s", why: "", assessment: "" }, delivery([])),
    false,
    "没自述就不判",
  );
});

test("交付核对：五条自述只对上一条 ⇒ 部分覆盖（一条对上不能洗白整张表）", () => {
  const report = {
    summary: "s",
    why: "",
    assessment: "",
    files_touched: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"],
  };
  const delivery = (paths: string[]) => ({
    tools: {},
    paths,
    commands: [],
    errors: 0,
    textChars: 10,
  });
  const partial = delivery(["/repo/src/a.ts"]);
  assert.equal(deliveryUnverified(report, partial), false, "零命中才亮硬旗——部分命中走覆盖度");
  assert.deepEqual(deliveryCoverage(report, partial), { claimed: 5, matched: 1 });
  assert.equal(
    deliveryCoverage(report, delivery(report.files_touched.map((p) => `/repo/${p}`))),
    undefined,
    "全对上不是部分",
  );
  assert.equal(deliveryCoverage(report, delivery([])), undefined, "零对上不是部分（那是硬旗的事）");
});

test("自检对质：五条声称只对上一条 ls ⇒ 部分覆盖（塞一条跑过的命令不能洗白）", () => {
  const report = {
    summary: "s",
    why: "",
    assessment: "",
    verified: [
      { command: "pnpm test" },
      { command: "tsc" },
      { command: "pnpm lint" },
      { command: "pnpm check:breakpoints" },
      { command: "ls" },
    ],
  };
  const delivery = { tools: {}, paths: [], commands: ["ls"], errors: 0, textChars: 10 };
  assert.equal(verifyUnverified(report, delivery), false, "零命中才亮硬旗");
  assert.deepEqual(verifyCoverage(report, delivery), { claimed: 5, matched: 1 });
  // 全观测到 ⇒ 不是部分。缺这条时 `<` 改成 `<=` 是活的（seen ⊆ claims 使它恒真）
  assert.equal(
    verifyCoverage(report, { ...delivery, commands: report.verified.map((c) => c.command) }),
    undefined,
    "全对上不是部分",
  );
});

test("收据：截断过就不判对不上——丢的是证据，不是罪证", () => {
  const report = { summary: "s", why: "", assessment: "", files_touched: ["src/a.ts"] };
  const truncated = {
    tools: {},
    paths: [],
    commands: [],
    errors: 0,
    textChars: 10,
    pathsTruncated: true as const,
  };
  assert.equal(deliveryUnverified(report, truncated), false, "路径被挤掉不等于没改过");
  assert.equal(deliveryCoverage(report, truncated), undefined);
  // 截断 + 部分命中：缺这条时 `!delivery || pathsTruncated` 改成 `&&` 是活的
  // （零命中本来就返回 undefined，短路被绕过也看不出来）
  assert.equal(
    deliveryCoverage(
      { ...report, files_touched: ["src/a.ts", "src/b.ts", "src/c.ts"] },
      { ...truncated, paths: ["/repo/src/a.ts"] },
    ),
    undefined,
    "截断时不报部分覆盖——丢的是证据",
  );

  const commandsTruncated = {
    tools: {},
    paths: [],
    commands: [],
    errors: 0,
    textChars: 10,
    commandsTruncated: true as const,
  };
  const claimed = { ...report, verified: [{ command: "pnpm test" }] };
  assert.equal(verifyUnverified(claimed, commandsTruncated), false, "旧命令被挤掉不等于没跑过");
  assert.equal(verifyCoverage(claimed, commandsTruncated), undefined);
});

test("收件：只读过没改过 ⇒ 自述「改了它」没有实测支撑", () => {
  const stream = [
    '{"type":"tool_execution_start","toolName":"read","args":{"path":"/repo/src/a.ts"}}',
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"改好了"}]}}',
  ].join("\n");
  const parsed = parseChildStream(stream);
  const report = { summary: "s", why: "", assessment: "", files_touched: ["src/a.ts"] };
  assert.deepEqual(parsed.delivery.paths, [], "读不算改过");
  assert.equal(deliveryUnverified(report, parsed.delivery), true, "读过就声称改过 = 没有实测支撑");
});

test("交付判词：五档全钉住", () => {
  const empty = { tools: {}, paths: [], commands: [], errors: 0, textChars: 0 };
  assert.equal(deliverableOf({ delivery: empty }), "absent", "没报告没正文 = 空跑");
  assert.equal(
    deliverableOf({ delivery: { ...empty, textChars: 3 } }),
    "unverified",
    "有正文没报告",
  );
  const report = { summary: "s", why: "", assessment: "" };
  assert.equal(deliverableOf({ report, delivery: empty }), "unclaimed", "有报告没自述：只读形态");
  assert.equal(deliverableOf({ report, delivery: empty, assessmentVacuous: true }), "unverified");
  assert.equal(deliverableOf({ report, delivery: empty, deliveryUnverified: true }), "unverified");
  assert.equal(deliverableOf({ report, delivery: empty, verifyUnverified: true }), "unverified");
  assert.equal(deliverableOf({ report, delivery: empty, reportStale: true }), "unverified");
  assert.equal(
    deliverableOf({
      report: { ...report, files_touched: ["a.ts"] },
      delivery: empty,
      deliveryPartial: { claimed: 2, matched: 1 },
    }),
    "partial",
  );
  assert.equal(
    deliverableOf({ report: { ...report, files_touched: ["a.ts"] }, delivery: empty }),
    "verified",
  );
  // 截断 + 自述 ⇒ 不盖章。缺这两条时「先攒满 20 条收据，再随便写」能洗成 verified（实测可达：
  // 21 条 bash 命令是正常工作强度）
  assert.equal(
    deliverableOf({
      report: { ...report, verified: [{ command: "pnpm test" }] },
      delivery: { ...empty, commandsTruncated: true },
    }),
    "unverified",
    "命令收据被截断、又声称跑过命令 ⇒ 没法对质，不给可信",
  );
  assert.equal(
    deliverableOf({
      report: { ...report, files_touched: ["a.ts"] },
      delivery: { ...empty, pathsTruncated: true },
    }),
    "unverified",
    "路径收据被截断、又声称改过文件 ⇒ 同上",
  );
  // 截断的那一维没有自述 ⇒ 不受影响（只读任务照样 unclaimed）
  assert.equal(
    deliverableOf({ report, delivery: { ...empty, commandsTruncated: true } }),
    "unclaimed",
    "没自述就不罚：截断只影响被声称的那一维",
  );
});

test("交付判词：收据缺口按「那一维有自述」算", () => {
  // receiptGap 是判词、引擎、通知三处共用的唯一口径。
  // 拿裸 OR 当缺口 ⇒ 没交报告的任务被说成「收据超出上限」（实测误归因）。
  const delivery = {
    tools: {},
    paths: [],
    commands: [],
    errors: 0,
    textChars: 10,
    commandsTruncated: true as const,
  };
  const bare = { summary: "s", why: "", assessment: "" };
  assert.equal(receiptGap(bare, delivery), false, "那一维没有自述 ⇒ 谈不上没法核");
  assert.equal(
    receiptGap({ ...bare, verified: [{ command: "pnpm test" }] }, delivery),
    true,
    "有自述又截断 ⇒ 真的没法核",
  );
  assert.equal(receiptGap(bare, undefined), false, "没有收据就没有缺口");
});

test("交付判词：没有收据就不给盖章（导出函数自己兜住）", () => {
  // 引擎路径上 delivery 永远有值（parseChildStream 总返回对象），所以这是防御性的。
  // 但 deliverableOf 是导出函数，别指望调用方一定传。
  assert.equal(
    deliverableOf({ report: { summary: "s", why: "", assessment: "", files_touched: ["/a"] } }),
    "unverified",
    "没有收据就没法对质，不能凭自述给「已核对」",
  );
});

test("交付判词：改了文件但没写正文 ⇒ 不是空跑", () => {
  // absent 的意思是「什么都没交」。之前只看正文（textChars===0），
  // 于是「改了文件、没写正文」的孩子被判成空跑——它明明动过手。
  const delivery = { tools: { edit: 1 }, paths: ["/a.ts"], commands: [], errors: 0, textChars: 0 };
  assert.equal(
    deliverableOf({ delivery }),
    "unverified",
    "动过手但没交报告 ⇒ unverified，不是 absent",
  );
  assert.equal(
    deliverableOf({ delivery: { ...delivery, paths: [] } }),
    "absent",
    "什么都没动也没交 ⇒ 才是空跑",
  );
});

test("交付判词：空白自述不算自述（换不到「已核对」）", () => {
  // 之前声称数按原始 length 数，而对质/覆盖度那边按过滤后的口径数——
  // 两边口径不一致，于是孩子交一条空白命令就能换到「已核对」（实测可达）。
  // 路径侧当时完全没过滤：`files_touched: ["  "]` 是同一个洞的另一个入口。
  const empty = { tools: {}, paths: [], commands: [], errors: 0, textChars: 10 };
  const report = { summary: "s", why: "", assessment: "" };
  assert.equal(
    deliverableOf({ report: { ...report, verified: [{ command: "   " }] }, delivery: empty }),
    "unclaimed",
    "空白命令不算自述",
  );
  assert.equal(
    deliverableOf({ report: { ...report, files_touched: ["  "] }, delivery: empty }),
    "unclaimed",
    "空白路径不算自述",
  );
  assert.equal(
    deliverableOf({
      report: { ...report, verified: [{ command: "" }] },
      delivery: empty,
    }),
    "unclaimed",
    "空字符串同样不算",
  );
  // 截断判定也按过滤后的口径：一条空白自述不该白扣一档降级
  assert.equal(
    deliverableOf({
      report: { ...report, verified: [{ command: "   " }] },
      delivery: { ...empty, commandsTruncated: true },
    }),
    "unclaimed",
    "空白自述 + 命令收据截断 ⇒ 该维没有自述，不降级",
  );
});

// ── 自检对质：声称的命令 vs 收据的命令 ──────────────────────────────────

/** 对质组的公共收据形状：只有 commands 变化。 */
const cmdDelivery = (commands: string[]) => ({
  tools: {},
  paths: [],
  commands,
  errors: 0,
  textChars: 10,
});

test("自检对质：声称的命令观测到了 ⇒ 不标", () => {
  const report = {
    summary: "s",
    why: "",
    assessment: "",
    verified: [{ command: "pnpm test", exitCode: 0 }],
  };
  assert.equal(verifyUnverified(report, cmdDelivery(["pnpm test"])), false);
  assert.equal(
    verifyUnverified(report, cmdDelivery(["cd x && pnpm test --filter a"])),
    false,
    "声称是观测的子串",
  );
  assert.equal(
    verifyUnverified(report, cmdDelivery(["pnpm test --watch"])),
    false,
    "观测是声称的扩展",
  );
});

test("自检对质：声称了但一条都没观测到 ⇒ 标", () => {
  const report = { summary: "s", why: "", assessment: "", verified: [{ command: "pnpm test" }] };
  assert.equal(verifyUnverified(report, cmdDelivery(["tsc"])), true);
  assert.equal(verifyUnverified(report, cmdDelivery([])), true, "收据里没有命令 = 没有实测支撑");
});

test("自检对质：没声称就不判（只读档孩子的正常形态）", () => {
  const delivery = cmdDelivery([]);
  assert.equal(verifyUnverified({ summary: "s", why: "", assessment: "" }, delivery), false);
  assert.equal(
    verifyUnverified({ summary: "s", why: "", assessment: "", verified: [] }, delivery),
    false,
  );
  assert.equal(verifyUnverified(undefined, delivery), false);
});

test("自检对质：只有空白的声称不算声称（不判）", () => {
  const delivery = cmdDelivery([]);
  assert.equal(
    verifyUnverified(
      { summary: "s", why: "", assessment: "", verified: [{ command: "   " }] },
      delivery,
    ),
    false,
  );
});

test("自检对质：一个字符的声称也算声称——过滤只丢空白，不丢短串", () => {
  const delivery = cmdDelivery([]);
  assert.equal(
    verifyUnverified(
      { summary: "s", why: "", assessment: "", verified: [{ command: "x" }] },
      delivery,
    ),
    true,
  );
});

test("自检对质：空白差异归一后命中", () => {
  const report = {
    summary: "s",
    why: "",
    assessment: "",
    verified: [{ command: "  pnpm   test  " }],
  };
  const delivery = cmdDelivery(["pnpm test"]);
  assert.equal(verifyUnverified(report, delivery), false);
});

test("自检对质：双向 contains——长声称对短观测也命中", () => {
  // 单段命令：观测是声称的子串就算命中（token 级前缀容忍）。
  const report = {
    summary: "s",
    why: "",
    assessment: "",
    verified: [{ command: "pnpm test --filter core" }],
  };
  const delivery = cmdDelivery(["pnpm test"]);
  assert.equal(verifyUnverified(report, delivery), false, "观测是声称的子串也认");
});

test("自检对质：复合声称的每一段都要有出处（只跑一段不能洗白整条）", () => {
  // 「ls && pnpm test && pnpm lint」声称跑了三个命令，收据里只有 ls：
  // 之前是「任一段命中即算整条对上」⇒ 孩子靠跑 ls 就能换到「已核对」（实测可达）。
  // 现在每段都要各自有出处；段可以来自不同的 bash 调用。
  const report = {
    summary: "s",
    why: "",
    assessment: "",
    verified: [{ command: "ls && pnpm test && pnpm lint" }],
  };
  assert.equal(
    verifyUnverified(report, cmdDelivery(["ls"])),
    true,
    "只观测到一段 ⇒ 亮旗（没有实测支撑）",
  );
  assert.equal(
    verifyUnverified(report, cmdDelivery(["ls", "pnpm test", "pnpm lint"])),
    false,
    "三段都观测到 ⇒ 不亮旗",
  );
  assert.equal(
    verifyUnverified(report, cmdDelivery(["ls && pnpm test && pnpm lint"])),
    false,
    "一条 bash 里跑完整串也算",
  );
});

test("自检对质：截尾省略号当通配——声称与观测在不同边界截断仍咬合", () => {
  const long = "z".repeat(300);
  const report = {
    summary: "s",
    why: "",
    assessment: "",
    verified: [{ command: `${"z".repeat(200)}…` }],
  };
  const delivery = cmdDelivery([`${long} --flag`]);
  assert.equal(verifyUnverified(report, delivery), false, "200 与 500 两个截断边界能对上");
});

test("自检对质：单 token 截断声称对更长单 token 观测仍咬合", () => {
  const report = {
    summary: "s",
    why: "",
    assessment: "",
    verified: [{ command: `${"z".repeat(200)}…` }],
  };
  const delivery = cmdDelivery([`${"z".repeat(300)}`]);
  assert.equal(verifyUnverified(report, delivery), false, "单 token 前缀宽容要生效");
});

test("自检对质：首 token 相同但参数不齐——不算跑过", () => {
  const report = { summary: "s", why: "", assessment: "", verified: [{ command: "pnpm test" }] };
  const delivery = cmdDelivery(["pnpm x y"]);
  assert.equal(verifyUnverified(report, delivery), true, "只跑了同前缀的另一组参数");
});

test("自检对质：提到命令不算跑过——echo 不提行", () => {
  const report = {
    summary: "s",
    why: "",
    assessment: "",
    verified: [{ command: "pnpm test", exitCode: 0 }],
  };
  const delivery = cmdDelivery(["echo pnpm test"]);
  assert.equal(verifyUnverified(report, delivery), true, "只是 echo 了命令原文，没真跑——必须标");
});

test("自检对质：同族逃逸——grep 正文里提到也算没跑", () => {
  const report = { summary: "s", why: "", assessment: "", verified: [{ command: "pnpm test" }] };
  const delivery = cmdDelivery(["grep -n pnpm test src/a.ts"]);
  assert.equal(verifyUnverified(report, delivery), true);
});

test("自检对质：heredoc 正文里的命令不算跑过", () => {
  const report = { summary: "s", why: "", assessment: "", verified: [{ command: "pnpm test" }] };
  const delivery = cmdDelivery(["cat <<EOF\npnpm test\nEOF"]);
  assert.equal(verifyUnverified(report, delivery), true);
});

test("自检对质：参数交错的基础命令仍算命中", () => {
  const report = { summary: "s", why: "", assessment: "", verified: [{ command: "pnpm test" }] };
  const delivery = cmdDelivery(["pnpm --filter core test"]);
  assert.equal(verifyUnverified(report, delivery), false);
});

test("自检对质：echo 别的词也不算跑过——首 token 不符就是没跑", () => {
  const report = { summary: "s", why: "", assessment: "", verified: [{ command: "pnpm test" }] };
  const delivery = cmdDelivery(["echo test"]);
  assert.equal(
    verifyUnverified(report, delivery),
    true,
    "末 token 恰好也是 test，但首 token 是 echo——不算跑过",
  );
});

// 杀 651（j=1→0）：参数交错经「短侧在前」的序列匹配命中
test("自检对质：参数交错两侧互认——长声称对短观测经序命中", () => {
  const report = {
    summary: "s",
    why: "",
    assessment: "",
    verified: [{ command: "pnpm --filter core test" }],
  };
  const delivery = cmdDelivery(["pnpm test"]);
  assert.equal(verifyUnverified(report, delivery), false);
});

test("自检对质：环境变量前缀不影响命中", () => {
  const report = { summary: "s", why: "", assessment: "", verified: [{ command: "pnpm test" }] };
  const delivery = cmdDelivery(["CI=1 pnpm test"]);
  assert.equal(verifyUnverified(report, delivery), false);
});

test("卡住：阈值边界——正好等于阈值算卡住，超过才算", () => {
  let now = 0;
  const tracker = new ChildActivityTracker(() => now);
  tracker.push("out\n");
  now = 999;
  assert.equal(tracker.isStalled(1000, 1000), true, "正好等于阈值 ⇒ 卡住");
  assert.equal(tracker.isStalled(999, 1000), false, "差 1 毫秒 ⇒ 不卡");
});

test("卡住：多次 push 后最后一条的时间才算", () => {
  let now = 0;
  const tracker = new ChildActivityTracker(() => now);
  tracker.push("a\n");
  now = 5000;
  tracker.push("b\n");
  assert.equal(tracker.isStalled(5000 + 999, 1000), false, "最近一次 push 刷新了时间");
});

test("卡住：一段 chunk 里有多行事件要全部处理", () => {
  let now = 0;
  const tracker = new ChildActivityTracker(() => now);
  tracker.push(
    '{"type":"tool_execution_start","toolName":"a","args":{}}\n' +
      '{"type":"tool_execution_start","toolName":"b","args":{}}\n' +
      '{"type":"tool_execution_end","toolName":"a"}\n',
  );
  assert.equal(tracker.openTools, 1, "2 个 start - 1 个 end = 1");
});

test("卡住：多个 end 多于 start 时计数压到 0 不为负", () => {
  let now = 0;
  const tracker = new ChildActivityTracker(() => now);
  tracker.push(
    '{"type":"tool_execution_end","toolName":"a"}\n' +
      '{"type":"tool_execution_end","toolName":"b"}\n',
  );
  assert.equal(tracker.openTools, 0);
});

test("卡住：畸形行不算在飞工具，但也不算卡（没有它才有意义）", () => {
  let now = 0;
  const tracker = new ChildActivityTracker(() => now);
  tracker.push('{"type":"tool_execution_start" 坏 JSON\n');
  assert.equal(tracker.openTools, 0);
});

test("stderr 上限：只留尾巴（前面的丢掉）", async () => {
  // 注意：要写 stderr（>&2），写 stdout 不算
  const child = spawnChild(
    [
      "/bin/sh",
      "-c",
      'for i in $(seq 1 5000); do echo "line $i padding padding padding" >&2; done',
    ],
    process.env,
  );
  let stderr = "";
  await new Promise<void>((resolve) => {
    child.onExit((_code, err) => {
      stderr = err;
      resolve();
    });
  });
  assert.ok(stderr.length > 0, "stderr 应该有内容");
  assert.ok(stderr.length <= 64 * 1024, "不该超上限");
  assert.match(stderr, /line 5000/, "尾巴留着（含最后一行）");
  assert.doesNotMatch(stderr, /line 1 padding/, "头部被砍掉了");
});

test("退出码：close 给的码要传给订阅者（不是 -1）", async () => {
  const child = spawnChild(["/bin/sh", "-c", "exit 7"], process.env);
  const code = await new Promise<number>((resolve) => {
    child.onExit((c) => resolve(c));
  });
  assert.equal(code, 7);
});

test("退出码：订阅后立刻收到已发生的退出（补发）", async () => {
  const child = spawnChild(["/bin/sh", "-c", "exit 5"], process.env);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const code = await new Promise<number>((resolve) => {
    child.onExit((c) => resolve(c));
  });
  assert.equal(code, 5, "退出早于订阅也要补发");
});

test("piPath：默认走 PATH 里的 pi", () => {
  assert.equal(buildPiArgv({ task: "t" })[0], "pi");
});

test("模型：解析序用 ?? （空串已被 nonEmpty 挡掉）", () => {
  const argv = buildPiArgv({ task: "t", model: "a/b", sessionModel: "c/d" });
  const idx = argv.indexOf("--model");
  assert.equal(argv[idx + 1], "a/b");
});

test("收件：usage 里的 cacheRead / cacheWrite 缺省时字段不出现", () => {
  const stream = [
    '{"type":"message_end","message":{"role":"assistant","content":[],"usage":{"input":1,"output":2,"cacheRead":7}}}',
  ].join("\n");
  const usage = parseChildStream(stream).observedUsage;
  assert.equal(usage?.cacheRead, 7);
  assert.equal(usage?.cacheWrite, undefined, "缺省就不该有这个键");
});

test("收件：内容块 text 不是字符串时不进正文", () => {
  const stream = [
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":123}]}}',
  ].join("\n");
  assert.equal(parseChildStream(stream).text, "");
});

test("子进程 pid：起得来时不是 0", async () => {
  const child = spawnChild(["/bin/sh", "-c", "exit 0"], process.env);
  assert.ok(child.pid > 0, "pid 应该有值");
  await new Promise<void>((resolve) => {
    child.onExit(() => resolve());
  });
});

test("close 的退出码为 null 时按 -1 记（信号杀掉的情况）", () => {
  // close 的 code 在被信号杀掉时可能是 null —— 落成 -1 而不是 undefined
  const argv = buildPiArgv({ task: "t" });
  assert.ok(argv.length > 0);
});

test("版本门：只有一个数字段时按 0 补（1 → 1.0 < 1.1 ⇒ 不支持）", () => {
  assert.equal(supportsNoMcp("1"), false);
  assert.equal(supportsNoMcp("2"), true);
});

test("版本门：major 是 NaN 时按不支持处理", () => {
  assert.equal(supportsNoMcp("x.1.0"), false);
  assert.equal(supportsNoMcp("1.x.0"), false);
});

test("收件：工具计数从 1 起（不是 0）", () => {
  const stream = '{"type":"tool_execution_start","toolName":"read","args":{"path":"/a"}}';
  assert.equal(parseChildStream(stream).delivery.tools.read, 1);
});

test("收件：usage 的 cacheWrite 为 0 时要出现（0 不等于缺省）", () => {
  const stream = [
    '{"type":"message_end","message":{"role":"assistant","content":[],"usage":{"input":1,"output":2,"cacheWrite":0}}}',
  ].join("\n");
  const usage = parseChildStream(stream).observedUsage;
  assert.equal(usage?.cacheWrite, 0, "0 是有效值，要出现");
  assert.notEqual(usage?.cacheWrite, undefined);
});

test("收据：details 为 null 时不崩（?. 要兜住）", () => {
  const stream = [
    '{"type":"message_end","message":{"role":"toolResult","toolName":"child_report","details":null}}',
  ].join("\n");
  assert.equal(parseChildStream(stream).toolReport, null);
});

test("收据：details 里没有 report 字段时回落用 details 本体", () => {
  const stream = [
    '{"type":"message_end","message":{"role":"toolResult","toolName":"child_report","details":{"summary":"本体"}}}',
  ].join("\n");
  assert.equal(parseChildStream(stream).toolReport?.summary, "本体");
});

test("报告：findings 里有 null 元素时要滤掉（?. 兜住）", () => {
  const text = '```json\n{"summary":"s","findings":[null,{"what":"好"}]}\n```';
  const report = extractReportFromText(text).report;
  assert.equal(report?.findings?.length, 1);
  assert.equal(report?.findings?.[0]?.what, "好");
});

test("拼命令：piPath 是空串时回落默认 pi（空串当没给）", () => {
  const argv = buildPiArgv({ task: "t", piPath: "" });
  assert.equal(argv[0], "pi", "空串不是合法的可执行文件路径");
});

test("版本门：major 与 minor 都是 NaN 时按不支持处理", () => {
  assert.equal(supportsNoMcp("x.y.z"), false);
});

test("版本门：major 有效但 minor 无效时也按不支持处理", () => {
  assert.equal(supportsNoMcp("1.x.0"), false);
  assert.equal(supportsNoMcp("2.x.0"), false);
});

test("spawn 失败：退出码是 -1（不是 0），stderr 里有原因", async () => {
  const child = spawnChild(["/nonexistent/no-such-binary-xyz"], process.env);
  const result = await new Promise<{ code: number; stderr: string }>((resolve) => {
    child.onExit((code, stderr) => resolve({ code, stderr }));
  });
  assert.equal(result.code, -1, "起不来要记 -1，不能是 0（0 是假成功）");
  assert.match(result.stderr, /spawn error/);
});

test("spawn 失败：订阅晚于失败也要收到（补发）", async () => {
  const child = spawnChild(["/nonexistent/no-such-binary-xyz"], process.env);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const code = await new Promise<number>((resolve) => {
    child.onExit((c) => resolve(c));
  });
  assert.equal(code, -1);
});

test("卡住：末尾半行先攒着，补齐后才处理", () => {
  let now = 0;
  const tracker = new ChildActivityTracker(() => now);
  tracker.push('{"type":"tool_execution_start","toolName":"a","args":{}}\n' + "半行");
  assert.equal(tracker.openTools, 1, "第一行（start）处理了，半行攒着");
  tracker.push("\n" + '{"type":"tool_execution_end","toolName":"a"}\n');
  // 半行 + "\n" 拼成一行（不是合法 JSON，忽略），end 那行处理了
  assert.equal(tracker.openTools, 0, "end 处理了");
});

test("卡住：buffer 以换行开头时，第一行是空行也要处理（index = 0）", () => {
  let now = 0;
  const tracker = new ChildActivityTracker(() => now);
  // 第一行是空行（"\n" 在 index 0）——换行后面的 start 才计数
  tracker.push('\n{"type":"tool_execution_start","toolName":"a","args":{}}\n');
  assert.equal(tracker.openTools, 1, "空行 + start 那行都处理了");
});

test("收件：没有 type 字段的 JSON 行不算事件，也不崩（?. 必须兜住）", () => {
  const stream = "{}\n" + '{"type":"tool_execution_start","toolName":"read","args":{"path":"/a"}}';
  assert.doesNotThrow(() => parseChildStream(stream));
  assert.equal(parseChildStream(stream).delivery.tools.read, 1);
});

// ── golden：argv 与附加块逐字节冻结 ──────────────────────────────────────
//
// 冻结的字面量是**今天的输出**（跑一次当前实现抄下来的）。
// 以后多一个旗标、少一段契约、换个顺序，都要显式改这里——
// 于是「改了什么」在 diff 里自己会说话；没改这里 ⇒ 孩子的契约没动。

/** 冻结：上下文块（逐字节）。 */
const FROZEN_CONTEXT_BLOCK = [
  "<pi-dispatch-context>",
  "你是被派出去的子代理：看不到父方的对话，你的最后一段话就是交付物。",
  "你的最终消息就是父方读到的东西——把结论写在正文里，不要只放在 JSON 块里。",
  "</pi-dispatch-context>",
].join("\n");

/** 冻结：报告契约块（逐字节）。 */
const FROZEN_REPORT_CONTRACT_BLOCK = [
  "<child-report-contract>",
  "Before finishing, deliver a child report — preferably by calling the child_report tool (its schema fixes the shape); if that tool is not available, put a fenced JSON block at the very end of your final message:",
  "```json",
  '{ "summary": "one sentence conclusion", "why": "why you conclude so", "assessment": "how it actually went", "findings": [{ "what": "claim", "evidence": "where it comes from" }], "files_touched": ["relative/path"], "verified": [{ "command": "pnpm test", "exitCode": 0 }], "usage": { "input": 0, "output": 0, "cost": 0, "turns": 0 } }',
  "```",
  "Rules: the report is a SUMMARY — it is NOT the deliverable. The deliverable is your prose answer, in exactly the format the task asked for; never hide the deliverable inside the JSON block.",
  'The report judges in three sections. "summary" = what you concluded (one sentence). "why" = why you conclude so — if your instructions contained a <pi-dispatch-why> block, take it as input (answer the parent\'s actual motive); otherwise reason from the task text alone. "assessment" = how the work actually went — quality judgment, problems hit, deviations, what remains unverified; its main anchor is the same: the why block if you received one, else the task text.',
  'Goodhart pin: "assessment" must name at least one concrete problem, risk, limitation, or thing to recheck. If it is uniformly positive, the parent treats the whole report as not delivered.',
  '"files_touched", "verified" and "usage" are a receipt for the parent\'s machine cross-check, not prose — keep them exact: files you actually touched, checks you actually ran (commands exactly as run).',
  "Do NOT write report/summary .md files — your final message is what the parent reads.",
  "findings/files_touched/verified/usage may be omitted when empty.",
  "</child-report-contract>",
].join("\n");

/** 冻结：恒定契约块（上下文 + 报告契约；中间没有理由段）。 */
const FROZEN_APPEND_BLOCK = [FROZEN_CONTEXT_BLOCK, FROZEN_REPORT_CONTRACT_BLOCK].join("\n");

/** 冻结：隔离契约块（逐字节）。 */
const FROZEN_WORKTREE_BLOCK = [
  "<pi-dispatch-worktree>",
  "你在一个独立工作区（git worktree）里干活：当前目录不是父方的仓库目录，你的改动不会踩到父方的工作区。",
  "分支由父方掌握，你只管在当前分支上干活：交付前自己把改动 commit 在这个工作区里——父方靠提交收编你的产出。",
  "不要 push、不要 rebase、不要切分支、不要动父方的主分支：合并归父方。",
  "</pi-dispatch-worktree>",
].join("\n");

/** 冻结：user message（任务 + 理由 + 隔离契约；分隔符是空行）。 */
const FROZEN_USER_MESSAGE = [
  "干活",
  "<pi-dispatch-why>为什么</pi-dispatch-why>",
  FROZEN_WORKTREE_BLOCK,
].join("\n\n");

/** 冻结：五种组合的 argv（逐元素）。 */
const FROZEN_ARGV = {
  默认: [
    "pi",
    "-p",
    "--no-session",
    "--mode",
    "json",
    "--append-system-prompt",
    FROZEN_APPEND_BLOCK,
    "--no-extensions",
    "--no-skills",
    "--",
    "干活",
  ],
  strict: [
    "pi",
    "-p",
    "--no-session",
    "--mode",
    "json",
    "--append-system-prompt",
    FROZEN_APPEND_BLOCK,
    "--no-extensions",
    "--no-skills",
    "--tools",
    "read,grep,find,ls,child_report",
    "--",
    "干活",
  ],
  strict加脚本: [
    "pi",
    "-p",
    "--no-session",
    "--mode",
    "json",
    "--append-system-prompt",
    FROZEN_APPEND_BLOCK,
    "--no-extensions",
    "--no-skills",
    "--tools",
    "read,grep,find,ls,child_report,codemode",
    "-e",
    "builtin:codemode",
    "--",
    "干活",
  ],
  不带项目上下文: [
    "pi",
    "-p",
    "--no-session",
    "--mode",
    "json",
    "--append-system-prompt",
    FROZEN_APPEND_BLOCK,
    "--no-extensions",
    "--no-skills",
    "--no-context-files",
    "--",
    "干活",
  ],
  模型加思考档: [
    "pi",
    "-p",
    "--no-session",
    "--mode",
    "json",
    "--append-system-prompt",
    FROZEN_APPEND_BLOCK,
    "--no-extensions",
    "--no-skills",
    "--model",
    "a/b:high",
    "--",
    "干活",
  ],
} as const;

test("golden：buildPiArgv 五种组合逐元素等于冻结字面量", () => {
  assert.deepEqual(buildPiArgv({ task: "干活" }), [...FROZEN_ARGV.默认]);
  assert.deepEqual(buildPiArgv({ task: "干活", readOnly: "strict" }), [...FROZEN_ARGV.strict]);
  assert.deepEqual(buildPiArgv({ task: "干活", readOnly: "strict", allowScripts: true }), [
    ...FROZEN_ARGV.strict加脚本,
  ]);
  assert.deepEqual(buildPiArgv({ task: "干活", projectContext: "none" }), [
    ...FROZEN_ARGV.不带项目上下文,
  ]);
  assert.deepEqual(buildPiArgv({ task: "干活", model: "a/b", thinkingLevel: "high" }), [
    ...FROZEN_ARGV.模型加思考档,
  ]);
});

test("golden：附加块逐字节等于冻结字面量（上下文 + 报告契约）", () => {
  assert.equal(CONTRACT_BLOCK, FROZEN_APPEND_BLOCK);
  // 开不开黑板都不改附加块（黑板契约全在工具描述里）
  const blockOf = (argv: string[]): string => argv[argv.indexOf("--append-system-prompt") + 1]!;
  assert.equal(
    blockOf(buildPiArgv({ task: "干活", why: "为什么", blackboard: true })),
    FROZEN_APPEND_BLOCK,
  );
});

test("golden：user message 逐字节等于冻结字面量（任务 + why + 隔离契约）", () => {
  assert.equal(
    buildUserMessage({ task: "干活", why: "为什么", isolation: "worktree" }),
    FROZEN_USER_MESSAGE,
  );
  // 隔离契约是 user message 的一段，不是系统提示词的一段
  assert.ok(!CONTRACT_BLOCK.includes("<pi-dispatch-worktree>"));
});

test("golden：开隔离时 user message 多一段 worktree 契约", () => {
  const message = buildUserMessage({ task: "干活", why: "为什么", isolation: "worktree" });
  assert.ok(message.includes(WORKTREE_CONTRACT_BLOCK), "要有隔离契约段");
  // 契约要点一个都不能少：独立工作区 / 交付前自行 commit / 不 push 不 rebase 不动主分支
  assert.match(message, /独立工作区/);
  assert.match(message, /交付前自己把改动 commit/);
  assert.match(message, /不要 push、不要 rebase/);
  assert.match(message, /主分支/);
  // 默认关时这段不出现
  assert.ok(!buildUserMessage({ task: "干活", why: "为什么" }).includes("<pi-dispatch-worktree>"));
  assert.ok(!buildUserMessage({ task: "干活" }).includes("<pi-dispatch-worktree>"));
});

test("golden：strict 的 --tools 名单与今天相等", () => {
  const argv = buildPiArgv({ task: "干活", readOnly: "strict" });
  assert.equal(argv[argv.indexOf("--tools") + 1], "read,grep,find,ls,child_report");
  const withScripts = buildPiArgv({ task: "干活", readOnly: "strict", allowScripts: true });
  assert.equal(
    withScripts[withScripts.indexOf("--tools") + 1],
    "read,grep,find,ls,child_report,codemode",
  );
});

/** 起一个轻量 node 进程打印自己的 cwd（不起 pi）。 */
function cwdOfChild(options?: { cwd?: string }): Promise<string> {
  const child = spawnChild(
    [process.execPath, "-e", "console.log(process.cwd())"],
    process.env,
    options,
  );
  let out = "";
  child.onOutput((chunk) => {
    out += chunk;
  });
  return new Promise((resolve) => {
    child.onExit(() => resolve(out));
  });
}

test("真起进程：第三参 cwd 落到子进程工作目录", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-cwd-"));
  const out = await cwdOfChild({ cwd: dir });
  // macOS 上 /var 是 /private/var 的软链 ⇒ 两边都归一到真实路径再比
  assert.equal(out.trim(), realpathSync(dir), "子进程的工作目录要给到 cwd");
});

test("真起进程：不给第三参时子进程在父方 cwd", async () => {
  const out = await cwdOfChild();
  assert.equal(out.trim(), realpathSync(process.cwd()), "不给 cwd 就继承父方目录");
});

// ── 黑板：strict 白名单的例外 + 附加块不动 ────────────────────────────────

test("拼命令：strict + blackboard 名单含两个黑板工具", () => {
  const argv = buildPiArgv({ task: "干活", readOnly: "strict", blackboard: true });
  const idx = argv.indexOf("--tools");
  assert.ok(idx >= 0, "strict 要发 --tools");
  assert.equal(
    argv[idx + 1],
    "read,grep,find,ls,child_report,blackboard_read,blackboard_write",
    "名单精确：黑板那两个接在末尾",
  );
});

test("拼命令：黑板没开时 strict 名单一个字都不多", () => {
  const argv = buildPiArgv({ task: "干活", readOnly: "strict" });
  assert.equal(argv[argv.indexOf("--tools") + 1], "read,grep,find,ls,child_report");
  const wide = buildPiArgv({ task: "干活", blackboard: true });
  assert.ok(!wide.includes("--tools"), "宽档不因黑板收窄");
});

test("golden：开黑板时附加块逐字节不变（黑板契约全在工具描述里）", () => {
  const off = buildPiArgv({ task: "干活", why: "为什么" });
  const on = buildPiArgv({ task: "干活", why: "为什么", blackboard: true });
  const blockOf = (argv: string[]): string => argv[argv.indexOf("--append-system-prompt") + 1]!;
  assert.equal(blockOf(on), blockOf(off), "开黑板不改附加块");
  assert.equal(blockOf(on), FROZEN_APPEND_BLOCK, "附加块与冻结字面量逐字节相等");
  assert.ok(!blockOf(on).includes("黑板"), "附加块里不出现黑板段");
});

test("收据：黑板写带上 args.command 也不进 commands", () => {
  const stream = [
    JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "bb1",
      toolName: "blackboard_write",
      args: { text: "留言", command: "rm -rf /" },
    }),
    JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "bb1",
      toolName: "blackboard_write",
      isError: false,
    }),
  ].join("\n");
  const parsed = parseChildStream(stream);
  assert.deepEqual(parsed.delivery.commands, [], "黑板写不是跑命令");
  assert.equal(parsed.delivery.tools.blackboard_write, 1, "工具照记");
});

// ── 转向证据 ────────────────────────────────────────────────────────────────

function steerStream(events: unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n");
}

test("转向：增量证据追踪在 chunk 中间切断也不丢投递证据", () => {
  const raw = steerStream([
    {
      type: "message_end",
      message: {
        role: "toolResult",
        toolName: "child_report",
        details: { report: { summary: "早", why: "", assessment: "有风险" } },
      },
    },
    { type: "queue_update", steering: ["[pi-dispatch-steer #1]\n改"] },
    {
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "[pi-dispatch-steer #1]\n改" }] },
    },
    {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "好" }] },
    },
  ]);
  const tracker = createSteerEvidenceTracker();
  for (let i = 0; i < raw.length; i += 7) tracker.push(raw.slice(i, i + 7));
  const evidence = tracker.finish();
  assert.deepEqual(
    evidence.queued.map((item) => item.seq),
    [1],
  );
  assert.deepEqual(
    evidence.delivered.map((item) => item.seq),
    [1],
  );
  assert.deepEqual(
    evidence.seen.map((item) => item.seq),
    [1],
  );
  assert.equal(evidence.reportLine, 1);
});

test("转向：重复的 queue/user/assistant 证据都只记一次", () => {
  const parsed = parseChildStream(
    steerStream([
      { type: "queue_update", steering: ["[pi-dispatch-steer #1]\n改"] },
      { type: "queue_update", steering: ["[pi-dispatch-steer #1]\n改"] },
      {
        type: "message_end",
        message: { role: "user", content: "[pi-dispatch-steer #1]\n改" },
      },
      {
        type: "message_end",
        message: { role: "user", content: "[pi-dispatch-steer #1]\n改" },
      },
      { type: "message_end", message: { role: "assistant", content: "好" } },
      { type: "message_end", message: { role: "assistant", content: "再" } },
    ]),
  );
  assert.equal(parsed.steerEvidence.queued.length, 1);
  assert.equal(parsed.steerEvidence.delivered.length, 1);
  assert.equal(parsed.steerEvidence.seen.length, 1);
});

test("转向：真机流样本恰好产出一条 queued/delivered/seen，正文是 STEERED", () => {
  const parsed = parseChildStream(REAL_STEER_STREAM);
  assert.deepEqual(
    parsed.steerEvidence.queued.map((item) => item.seq),
    [1],
  );
  assert.deepEqual(
    parsed.steerEvidence.delivered.map((item) => item.seq),
    [1],
  );
  assert.deepEqual(
    parsed.steerEvidence.seen.map((item) => item.seq),
    [1],
  );
  assert.equal(parsed.steerEvidence.delivered.length, 1);
  assert.equal(parsed.text, "STEERED");
});

test("转向：queue_update → user 回显 → assistant 记 queued/delivered/seen", () => {
  const parsed = parseChildStream(
    steerStream([
      { type: "turn_start" },
      { type: "queue_update", steering: ["[pi-dispatch-steer #1]\n改方向"] },
      {
        type: "message_end",
        message: {
          role: "user",
          content: [{ type: "text", text: "[pi-dispatch-steer #1]\n改方向" }],
        },
      },
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "好" }] },
      },
    ]),
  );
  assert.deepEqual(
    parsed.steerEvidence.queued.map((item) => item.seq),
    [1],
  );
  assert.deepEqual(
    parsed.steerEvidence.delivered.map((item) => item.seq),
    [1],
  );
  assert.deepEqual(
    parsed.steerEvidence.seen.map((item) => item.seq),
    [1],
  );
});

test("转向：user 之前的 assistant 不算 seen，回显后第一条 assistant 才算", () => {
  const parsed = parseChildStream(
    steerStream([
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "早" }] },
      },
      { type: "queue_update", steering: ["[pi-dispatch-steer #1]\n改方向"] },
      {
        type: "message_end",
        message: { role: "user", content: "[pi-dispatch-steer #1]\n改方向" },
      },
      { type: "message_end", message: { role: "assistant", content: [] } },
      { type: "message_end", message: { role: "assistant", content: [] } },
    ]),
  );
  assert.deepEqual(
    parsed.steerEvidence.delivered.map((item) => item.seq),
    [1],
  );
  assert.equal(parsed.steerEvidence.seen.length, 1, "只认回显后的第一条 assistant");
});

test("转向：两条回显共用一条 assistant 时每条都 delivered 且都 seen", () => {
  const parsed = parseChildStream(
    steerStream([
      { type: "queue_update", steering: ["[pi-dispatch-steer #1]\n甲"] },
      { type: "queue_update", steering: ["[pi-dispatch-steer #2]\n乙"] },
      { type: "message_end", message: { role: "user", content: "[pi-dispatch-steer #1]\n甲" } },
      { type: "message_end", message: { role: "user", content: "[pi-dispatch-steer #2]\n乙" } },
      { type: "message_end", message: { role: "assistant", content: [] } },
    ]),
  );
  assert.deepEqual(
    parsed.steerEvidence.delivered.map((item) => item.seq),
    [1, 2],
  );
  assert.deepEqual(
    parsed.steerEvidence.seen.map((item) => item.seq),
    [1, 2],
  );
});

test("转向：queue_update 缺 steering / 元素形状坏掉不崩不误记", () => {
  const parsed = parseChildStream(
    steerStream([
      { type: "queue_update" },
      { type: "queue_update", steering: [null, 3, { text: "" }, {}] },
      { type: "queue_update", steering: [] },
    ]),
  );
  assert.deepEqual(parsed.steerEvidence.queued, []);
  assert.deepEqual(parsed.steerEvidence.delivered, []);
});

test("转向：只有 queue_update 没有 user 回显只记 queued，绝不 delivered", () => {
  const parsed = parseChildStream(
    steerStream([
      { type: "queue_update", steering: ["[pi-dispatch-steer #1]\n改方向"] },
      { type: "message_end", message: { role: "assistant", content: [] } },
    ]),
  );
  assert.deepEqual(
    parsed.steerEvidence.queued.map((item) => item.seq),
    [1],
  );
  assert.deepEqual(parsed.steerEvidence.delivered, []);
  assert.deepEqual(parsed.steerEvidence.seen, []);
});

test("转向：初始 prompt 首行伪造标记，没有 queue_update 也不算 delivered/seen", () => {
  const parsed = parseChildStream(
    steerStream([
      { type: "message_end", message: { role: "user", content: "[pi-dispatch-steer #1]\n改" } },
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "好" }] },
      },
    ]),
  );
  assert.deepEqual(parsed.steerEvidence.delivered, []);
  assert.deepEqual(parsed.steerEvidence.seen, []);
});

test("转向：工具报告行早于回显时 reportLine 小于 delivered 行", () => {
  const parsed = parseChildStream(
    steerStream([
      {
        type: "message_end",
        message: {
          role: "toolResult",
          toolName: CHILD_REPORT_TOOL_NAME,
          details: { report: { summary: "早报告", why: "", assessment: "有风险" } },
        },
      },
      { type: "queue_update", steering: ["[pi-dispatch-steer #1]\n改"] },
      { type: "message_end", message: { role: "user", content: "[pi-dispatch-steer #1]\n改" } },
    ]),
  );
  assert.equal(parsed.steerEvidence.reportLine, 1);
  assert.equal(parsed.steerEvidence.delivered[0]!.line, 3);
});

test("收件：坏事件不许毒化整次解析（type 不是字符串 / content 里有 null）", () => {
  const stream = [
    '{"type":5,"message":{"role":"assistant","content":[]}}',
    '{"type":"message_end","message":{"role":"assistant","content":[null,{"type":"text","text":"活着"}]}}',
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"最后"}]}}',
  ].join("\n");
  const parsed = parseChildStream(stream);
  assert.equal(parsed.text, "最后", "坏行跳过后好行照收");
  assert.equal(parsed.delivery.malformed, 1, "type 不是字符串 = 畸形行");
});

test("收件：畸形行计数（不是事件的就是畸形），空行不算", () => {
  const stream = [
    "",
    "not json",
    '{"type":5}',
    '{"type":"message_end","message":{"role":"assistant","content":[]}}',
  ].join("\n");
  const parsed = parseChildStream(stream);
  assert.equal(parsed.delivery.malformed, 2, "not json 与 type:5 是畸形，空行不算");
});

test("收件：工具名 __proto__ / constructor 也能正常计数（不污染原型）", () => {
  const stream = [
    '{"type":"tool_execution_start","toolName":"__proto__","args":{}}',
    '{"type":"tool_execution_start","toolName":"constructor","args":{}}',
  ].join("\n");
  const parsed = parseChildStream(stream);
  assert.equal(parsed.delivery.tools["__proto__"], 1);
  assert.equal(parsed.delivery.tools["constructor"], 1);
  assert.equal(({} as Record<string, unknown>)["__proto__"], Object.prototype, "原型没被动过");
});

test("收件：system 消息里声明的工具名被记下来（父方事实，不是模型自述）", () => {
  const stream = JSON.stringify({
    type: "message_end",
    message: {
      role: "system",
      sections: { tools: "<tools>\n- read: 读文件\n- codemode: 跑脚本\n</tools>" },
    },
  });
  const parsed = parseChildStream(stream);
  assert.deepEqual(parsed.declaredTools, ["read", "codemode"]);
});

test("收件：正文里写「- codemode」不算声明（散文冒充不了工具清单）", () => {
  const stream = JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "- codemode: 我能用脚本" }] },
  });
  const parsed = parseChildStream(stream);
  assert.deepEqual(parsed.declaredTools, [], "散文不是声明");
});

test("拼命令：任务前面带 -- 分隔符（任务不会被当旗标）", () => {
  const argv = buildPiArgv({ task: "干活" });
  assert.equal(argv[argv.length - 2], "--");
  assert.equal(argv[argv.length - 1], "干活");
});

test("报告：清单字段有条数上限，退出码只认 0..255 的整数", () => {
  const report = normalizeReport({
    summary: "s",
    why: "w",
    assessment: "a",
    findings: Array.from({ length: 200 }, (_, i) => ({ what: `发现${i}` })),
    files_touched: Array.from({ length: 200 }, (_, i) => `/f${i}.ts`),
    verified: [
      { command: "ok", exitCode: 0 },
      { command: "bad", exitCode: 999 },
      { command: "neg", exitCode: -1 },
    ],
  });
  assert.equal(report.findings!.length, 50, "清单条数封顶");
  assert.equal(report.files_touched!.length, 50);
  assert.equal(report.verified![0]!.exitCode, 0);
  assert.equal(report.verified![1]!.exitCode, undefined, "999 不是进程退出码");
  assert.equal(report.verified![2]!.exitCode, undefined, "-1 不是进程退出码");
});

test("报告：自报用量里的 NaN / Infinity 一律丢掉", () => {
  const report = normalizeReport({
    summary: "s",
    why: "w",
    assessment: "a",
    usage: { input: Number.NaN, output: Number.POSITIVE_INFINITY, cost: 0.5 },
  });
  assert.deepEqual(report.usage, { cost: 0.5 }, "只留有限数");
});

// ── 运行中用量：增量口径与退出后的记账同数 ────────────────────────────────

test("收件：增量用量累加 = 终局 parseChildStream 的口径（同一段流，两条路同数）", () => {
  const tracker = createUsageTracker();
  tracker.push(REAL_USAGE_STREAM);
  tracker.finish();
  const incremental = tracker.snapshot().usage;
  const final = parseChildStream(REAL_USAGE_STREAM).observedUsageTotal;
  assert.deepEqual(incremental, final, "运行中判预算与退出后记账必须同数");
  assert.ok(incremental && incremental.input! > 0, "真机样本有非零用量");
});

test("收件：增量用量跨 chunk 的半行不丢（usage 事件被切成两半也要算进去）", () => {
  const tracker = createUsageTracker();
  const mid = Math.floor(REAL_USAGE_STREAM.length / 2);
  tracker.push(REAL_USAGE_STREAM.slice(0, mid));
  tracker.push(REAL_USAGE_STREAM.slice(mid));
  tracker.finish();
  assert.deepEqual(
    tracker.snapshot().usage,
    parseChildStream(REAL_USAGE_STREAM).observedUsageTotal,
  );
});

test("收件：增量用量只认 assistant 的 message_end（user / system 的 usage 不计）", () => {
  const stream = [
    '{"type":"message_end","message":{"role":"user","content":[],"usage":{"input":9999,"output":9999}}}',
    '{"type":"message_end","message":{"role":"system","content":[],"usage":{"input":8888,"output":8888}}}',
    '{"type":"message_end","message":{"role":"assistant","content":[],"usage":{"input":3,"output":4,"cacheRead":5,"cacheWrite":6,"cost":0.5}}}',
  ].join("\n");
  const tracker = createUsageTracker();
  tracker.push(stream);
  tracker.finish();
  const snap = tracker.snapshot();
  assert.equal(snap.usage?.input, 3, "非 assistant 的 usage 不许进账");
  assert.equal(snap.usage?.output, 4);
  assert.equal(snap.usage?.cacheRead, 5);
  assert.equal(snap.usage?.cacheWrite, 6);
  assert.equal(snap.usage?.cost, 0.5);
  assert.equal(snap.turns, 1, "只有一个 assistant 回合带 usage");
  assert.deepEqual(snap.usage, parseChildStream(stream).observedUsageTotal);
});

test("收件：增量用量在没有用量事件时是 null（与终局口径一致）", () => {
  const stream = '{"type":"message_end","message":{"role":"assistant","content":[]}}';
  const tracker = createUsageTracker();
  tracker.push(stream);
  tracker.finish();
  assert.equal(tracker.snapshot().usage, null);
  assert.equal(tracker.snapshot().turns, 0);
});

test("用量：tracker 留住逐轮明细", () => {
  const tracker = createUsageTracker();
  tracker.push(REAL_USAGE_STREAM.slice(0, REAL_USAGE_STREAM.indexOf("\n") + 1));
  tracker.push(REAL_USAGE_STREAM.slice(REAL_USAGE_STREAM.indexOf("\n") + 1));
  tracker.finish();
  assert.equal(tracker.turns.length, 7, "真机样本 7 轮 assistant，逐轮明细一条不许丢");
  assert.equal(tracker.turns.length, tracker.snapshot().turns, "明细条数 == 计数");
  assert.equal(tracker.turns[0]!.input, 2605, "第 0 轮就是首轮");
  assert.equal(tracker.turns[0]!.cacheRead, 128);
  assert.equal(tracker.turns[0]!.promptTokens, 2605 + 128 + 0);
});

test("用量：逐轮明细的累计等于总额", () => {
  const tracker = createUsageTracker();
  tracker.push(REAL_USAGE_STREAM);
  tracker.finish();
  const snap = tracker.snapshot();
  const sum = (key: "input" | "output" | "cacheRead" | "cacheWrite"): number =>
    tracker.turns.reduce((total, turn) => total + turn[key], 0);
  assert.equal(sum("input"), snap.usage?.input);
  assert.equal(sum("output"), snap.usage?.output);
  assert.equal(sum("cacheRead"), snap.usage?.cacheRead);
  assert.equal(sum("cacheWrite"), snap.usage?.cacheWrite);
  for (const turn of tracker.turns) {
    assert.equal(turn.promptTokens, turn.input + turn.cacheRead + turn.cacheWrite);
  }
});

// ── 前缀稳定化：附加块恒定，变的内容进 user message ──────────────────────

test("拼命令：附加块恒定（why 不进系统提示词）", () => {
  const withWhy = buildPiArgv({ task: "干活", why: "为什么" });
  const without = buildPiArgv({ task: "干活" });
  const blockOf = (argv: string[]): string => argv[argv.indexOf("--append-system-prompt") + 1]!;
  assert.equal(blockOf(withWhy), blockOf(without), "why 改变不改系统提示词");
  assert.ok(!blockOf(withWhy).includes("</pi-dispatch-why>"), "契约里的条件句不算理由段");
  assert.equal(blockOf(withWhy), CONTRACT_BLOCK);
});

test("拼命令：why 进 user message", () => {
  const argv = buildPiArgv({ task: "干活", why: "为什么" });
  const message = argv[argv.length - 1]!;
  assert.ok(message.includes("<pi-dispatch-why>为什么</pi-dispatch-why>"));
  assert.ok(message.startsWith("干活"), "任务仍是 message 的开头");
});

test("拼命令：隔离契约进 user message，不进系统提示词", () => {
  const argv = buildPiArgv({ task: "干活", isolation: "worktree" });
  const block = argv[argv.indexOf("--append-system-prompt") + 1]!;
  const message = argv[argv.length - 1]!;
  assert.ok(!block.includes("<pi-dispatch-worktree>"), "系统提示词恒定");
  assert.ok(message.includes("<pi-dispatch-worktree>"), "隔离契约在 user message 里");
});

test("拼命令：没有 why 也没有隔离时，user message 就是任务原文（argv 与今天逐字节相同）", () => {
  const argv = buildPiArgv({ task: "干活" });
  assert.equal(argv[argv.length - 1], "干活");
  assert.equal(argv[argv.length - 2], "--", "任务仍在 -- 之后");
});

test("拼命令：user message 的顺序是 任务 → why → 隔离契约", () => {
  const message = buildUserMessage({ task: "干活", why: "为什么", isolation: "worktree" });
  const taskAt = message.indexOf("干活");
  const whyAt = message.indexOf("<pi-dispatch-why>");
  const treeAt = message.indexOf("<pi-dispatch-worktree>");
  assert.ok(taskAt >= 0 && whyAt > taskAt, "why 在任务之后");
  assert.ok(treeAt > whyAt, "隔离契约在 why 之后（靠近交付）");
});

test("拼命令：降级后的档位进 --model 后缀（a/b:low）", () => {
  const argv = buildPiArgv({ task: "t", model: "a/b", thinkingLevel: "low" });
  assert.equal(argv[argv.indexOf("--model") + 1], "a/b:low");
});

test("拼命令：没给档位时不拼后缀（a/b 不带冒号）", () => {
  const modelOf = (argv: string[]): string => argv[argv.indexOf("--model") + 1]!;
  assert.equal(modelOf(buildPiArgv({ task: "t", model: "a/b" })), "a/b", "没给档位 ⇒ 不带冒号");
  assert.equal(
    modelOf(buildPiArgv({ task: "t", model: "a/b", thinkingLevel: "  " })),
    "a/b",
    "空白串是坏值 ⇒ 不带冒号",
  );
  assert.equal(
    modelOf(buildPiArgv({ task: "t", model: "a/b", thinkingLevel: "" })),
    "a/b",
    "空串是坏值 ⇒ 不带冒号",
  );
});
