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
//   addUsage 的 `(a ?? 0)`——a 是 JSON 解析出的有限数或 undefined（JSON 无 NaN），
//   a 为 0 时 ?? 与 || 都给 0 ⇒ 等价。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAppendBlock,
  buildPiArgv,
  deliveryUnverified,
  extractReportFromText,
  parseChildStream,
  pathMatches,
  spawnChild,
  supportsNoMcp,
  CHILD_REPORT_TOOL_NAME,
  REPORT_CONTRACT_BLOCK,
  SUBAGENT_CONTEXT_BLOCK,
} from "../src/core/child.ts";
import { ChildActivityTracker, DEFAULT_STALL_MS } from "../src/core/activity.ts";

/** 真机抓的样本（2026-11-18，pi 1.5.2）：read + bash 两次工具调用，最后交回正文 "12"。 */
const REAL_STREAM = [
  '{"type":"session","version":3,"id":"01a1","timestamp":"2026-11-18T00:00:00.000Z","cwd":"/tmp"}',
  '{"type":"agent_start"}',
  '{"type":"turn_start"}',
  '{"type":"message_start","message":{"role":"assistant","content":[],"stopReason":"pending"}}',
  '{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"read the file"},{"type":"text","text":"12"}],"api":"openai-completions","provider":"vendor-local","model":"regex:group/main","usage":{"input":2484,"output":3,"cacheRead":128,"cacheWrite":0,"totalTokens":2615,"cost":{"input":0.0003726,"output":0.0000018,"cacheRead":0.00000192,"cacheWrite":0,"total":0.00037632}}}}',
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

test("附加块：理由被实体转义（<> 不会伪造标签）", () => {
  const block = buildAppendBlock({ why: "<script>alert(1)</script>" });
  assert.ok(!block.includes("<script>"), "未转义的标签会破坏块边界");
  assert.ok(block.includes("&lt;script&gt;"));
});

test("附加块：没给理由时不带理由段", () => {
  const block = buildAppendBlock({});
  assert.ok(!block.includes("pi-dispatch-why"));
  assert.ok(block.includes(SUBAGENT_CONTEXT_BLOCK));
});

test("附加块：报告契约总是带上", () => {
  assert.ok(buildAppendBlock({}).includes("<child-report-contract>"));
});

test("报告契约：说清「报告是摘要，交付物是正文」", () => {
  assert.match(REPORT_CONTRACT_BLOCK, /NOT the deliverable/);
  assert.match(REPORT_CONTRACT_BLOCK, /never hide the deliverable/);
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
  assert.equal(parsed.observedModel, "regex:group/main");
  assert.equal(parsed.observedProvider, "vendor-local");
  assert.equal(parsed.observedUsage?.input, 2484);
  assert.equal(parsed.observedUsage?.output, 3);
  assert.equal(parsed.observedUsage?.cacheRead, 128);
});

test("收件：收据统计工具调用次数与路径", () => {
  const parsed = parseChildStream(REAL_STREAM);
  assert.equal(parsed.delivery.tools.read, 1);
  assert.equal(parsed.delivery.tools.bash, 1);
  assert.deepEqual(parsed.delivery.paths, ["/etc/hosts"]);
  assert.equal(parsed.delivery.errors, 0);
  assert.equal(parsed.delivery.textChars, 2);
});

test("收件：bash 的路径不进清单（它的 args 里没有 path，不猜命令行）", () => {
  const parsed = parseChildStream(REAL_STREAM);
  assert.equal(parsed.delivery.paths.length, 1, "只有 read 的 path");
  assert.ok(!parsed.delivery.paths.some((p) => p.includes("grep")));
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

test("真起进程：信号杀死的孩子退出码是 -1", async () => {
  // close 事件对「被信号杀死」的进程给 null ⇒ 核心记 -1（区别于进程自己 exit 1）。
  const child = spawnChild(["/bin/sh", "-c", "sleep 30"], process.env);
  const exitCode = await new Promise<number>((resolve) => {
    child.onExit((code) => resolve(code));
    setTimeout(() => child.kill("SIGKILL"), 100);
  });
  assert.equal(exitCode, -1, "信号杀死的进程 close code 是 null ⇒ 核心记 -1");
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
  const cli = join(
    "/home/dev/develop/pi-dispatch",
    "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
  );
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
    '{"type":"tool_execution_start","toolName":"read","args":{"path":"/a"}}',
    '{"type":"tool_execution_start","toolName":"read","args":{"path":"/a"}}',
    '{"type":"tool_execution_start","toolName":"read","args":{"path":"/b"}}',
  ].join("\n");
  assert.deepEqual(parseChildStream(stream).delivery.paths, ["/a", "/b"]);
});

test("收件：路径清单有上限（超出的不记）", () => {
  const lines: string[] = [];
  for (let i = 0; i < 30; i++) {
    lines.push(`{"type":"tool_execution_start","toolName":"read","args":{"path":"/p${i}"}}`);
  }
  const paths = parseChildStream(lines.join("\n")).delivery.paths;
  assert.equal(paths.length, 20, "路径清单上限 20");
});

test("收件：args 不是对象或 path 不是字符串时不记路径", () => {
  const stream = [
    '{"type":"tool_execution_start","toolName":"read"}',
    '{"type":"tool_execution_start","toolName":"read","args":{}}',
    '{"type":"tool_execution_start","toolName":"read","args":{"path":123}}',
    '{"type":"tool_execution_start","toolName":"read","args":{"path":""}}',
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
  const report = { summary: "s", files_touched: ["src/a.ts"] };
  const delivery = (paths: string[]) => ({ tools: {}, paths, errors: 0, textChars: 10 });
  assert.equal(deliveryUnverified(report, delivery(["/repo/src/a.ts"])), false);
  assert.equal(deliveryUnverified(report, delivery(["/repo/b.ts"])), true);
  assert.equal(deliveryUnverified(report, delivery([])), true, "收据里没有路径 = 没有实测支撑");
  assert.equal(deliveryUnverified({ summary: "s" }, delivery([])), false, "没自述就不判");
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
