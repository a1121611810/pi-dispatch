import { posix } from "node:path";
// src/core/steer.ts
/** 首行标记：整行必须正好是标记——正文/前后缀伪造不算。 */
const STEER_MARKER_RE = /^\[pi-dispatch-steer #(\d+)\]$/;
/** 从一段文本的首行取 seq；不是精确标记就 undefined。 */
function steerSeqFromText(text) {
	const firstLine = text.split("\n", 1)[0] ?? "";
	const match = STEER_MARKER_RE.exec(firstLine);
	if (!match) return void 0;
	const seq = Number(match[1]);
	return Number.isInteger(seq) && seq > 0 ? seq : void 0;
}
/** user/steering 的 content 可能是 string，也可能是 text block 数组；其余形状为空。 */
function textOfContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part) => Boolean(part) && typeof part === "object" && part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
}
// src/core/child.ts
/** 附加块：告诉子代理它是什么、交付物是什么。 */
const SUBAGENT_CONTEXT_BLOCK = [
	"<pi-dispatch-context>",
	"你是被派出去的子代理：看不到父方的对话，你的最后一段话就是交付物。",
	"你的最终消息就是父方读到的东西——把结论写在正文里，不要只放在 JSON 块里。",
	"</pi-dispatch-context>"
].join("\n");
/**
* 报告契约。刻意零 import——这里是契约的唯一持有者。
* 报告是摘要，**交付物是正文**——不能把正文藏进 JSON 块。
*/
const REPORT_CONTRACT_BLOCK = [
	"<child-report-contract>",
	`Before finishing, deliver a child report — preferably by calling the child_report tool (its schema fixes the shape); if that tool is not available, put a fenced JSON block at the very end of your final message:`,
	"```json",
	"{ \"summary\": \"one sentence conclusion\", \"why\": \"why you conclude so\", \"assessment\": \"how it actually went\", \"findings\": [{ \"what\": \"claim\", \"evidence\": \"where it comes from\" }], \"files_touched\": [\"relative/path\"], \"verified\": [{ \"command\": \"pnpm test\", \"exitCode\": 0 }], \"usage\": { \"input\": 0, \"output\": 0, \"cost\": 0, \"turns\": 0 } }",
	"```",
	"Rules: the report is a SUMMARY — it is NOT the deliverable. The deliverable is your prose answer, in exactly the format the task asked for; never hide the deliverable inside the JSON block.",
	"The report judges in three sections. \"summary\" = what you concluded (one sentence). \"why\" = why you conclude so — if your instructions contained a <pi-dispatch-why> block, take it as input (answer the parent's actual motive); otherwise reason from the task text alone. \"assessment\" = how the work actually went — quality judgment, problems hit, deviations, what remains unverified; its main anchor is the same: the why block if you received one, else the task text.",
	"Goodhart pin: \"assessment\" must name at least one concrete problem, risk, limitation, or thing to recheck. If it is uniformly positive, the parent treats the whole report as not delivered.",
	"\"files_touched\", \"verified\" and \"usage\" are a receipt for the parent's machine cross-check, not prose — keep them exact: files you actually touched, checks you actually ran (commands exactly as run).",
	"Do NOT write report/summary .md files — your final message is what the parent reads.",
	"findings/files_touched/verified/usage may be omitted when empty.",
	"</child-report-contract>"
].join("\n");
[
	"<pi-dispatch-worktree>",
	"你在一个独立工作区（git worktree）里干活：当前目录不是父方的仓库目录，你的改动不会踩到父方的工作区。",
	"分支由父方掌握，你只管在当前分支上干活：交付前自己把改动 commit 在这个工作区里——父方靠提交收编你的产出。",
	"不要 push、不要 rebase、不要切分支、不要动父方的主分支：合并归父方。",
	"</pi-dispatch-worktree>"
].join("\n");
[SUBAGENT_CONTEXT_BLOCK, REPORT_CONTRACT_BLOCK].join("\n");
/**
* 会改文件的工具（pi 内置只有这两个）。收据只认白名单——
* 黑名单会把「任何带 path 参数的调用」都当改文件，`child_report` 多传个 path 就能伪造收据。
*/
const WRITE_TOOLS$1 = ["edit", "write"];
/** 路径清单上限：父面只看前几条，超出部分不记。 */
const MAX_PATHS = 20;
/** 命令清单上限：留最近 N 条——对质关心的是交付前跑没跑。 */
const MAX_COMMANDS = 20;
/** 单条命令保留长度：超长截尾。匹配方向是「声称 ⊆ 观测」，截观测的尾不伤命中。 */
const COMMAND_KEEP_CHARS = 500;
function emptyStreamAcc() {
	return {
		text: "",
		toolReport: null,
		observedUsage: null,
		usageTotal: null,
		turns: [],
		observedModel: null,
		observedProvider: null,
		tools: Object.create(null),
		paths: [],
		commands: [],
		failedCommands: [],
		lostPath: false,
		lostCommand: false,
		pathsTruncated: false,
		commandsTruncated: false,
		errors: 0,
		malformed: 0,
		declaredTools: [],
		queuedSteers: [],
		deliveredSteers: [],
		seenSteers: [],
		pendingSeen: [],
		pendingWrites: /* @__PURE__ */ new Map()
	};
}
function evidenceOf(acc) {
	return {
		queued: acc.queuedSteers,
		delivered: acc.deliveredSteers,
		seen: acc.seenSteers,
		...acc.reportLine !== void 0 ? { reportLine: acc.reportLine } : {}
	};
}
/**
* pi 给孩子声明的工具名（system 消息的 sections.tools，形如 "- codemode: 跑脚本"）。
* 这是父方观测到的事实：codemode 在不在声明里，看的是 pi 打的工具清单，
* 不是孩子正文里复述的字符串。
*/
function declaredToolNames(sections) {
	if (!sections || typeof sections !== "object" || !("tools" in sections)) return [];
	const tools = sections.tools;
	if (typeof tools !== "string") return [];
	const names = [];
	for (const line of tools.split("\n")) {
		const match = /^\s*-\s+([A-Za-z0-9_.-]+)\s*:/.exec(line);
		if (match && !names.includes(match[1])) names.push(match[1]);
	}
	return names;
}
/**
* 这是一次写类工具调用要记的路径（读类工具与 bash 不给路径）。
* 读类工具（read/grep/find/ls）不算——读过不等于改过，否则「自述改了 N 个文件」
* 只要把那 N 个文件读一遍就能对上（实测可洗白）。
*/
function writablePath(toolName, args) {
	if (!WRITE_TOOLS$1.includes(toolName)) return void 0;
	const path = args?.path;
	if (typeof path !== "string" || !path) return void 0;
	return path;
}
/**
* 记一条改过的路径。到上限就丢并置 truncated。
* 只在工具调用**成功**后才调（见 takeToolEvent）：失败的不算碰过。
*/
function recordPath(path, acc) {
	if (acc.paths.includes(path)) return;
	if (acc.paths.length >= MAX_PATHS) {
		acc.pathsTruncated = true;
		return;
	}
	acc.paths.push(path);
}
/**
* 这次调用要记的命令串（只有 bash——它的效果就是命令行，codemode 最终也走 bash 执行）。
* 与 `writablePath` 对称：只回答「要记什么」，不落账（落账时机由 takeToolEvent 定）。
*/
function commandOf(toolName, args) {
	if (toolName !== "bash") return void 0;
	const command = args?.command;
	if (typeof command !== "string" || !command) return void 0;
	return command.length > COMMAND_KEEP_CHARS ? `${command.slice(0, COMMAND_KEEP_CHARS)}…` : command;
}
/**
* 记一条跑过的命令。原样记串不解析；保最近 N 条（交付前的验证命令在尾部）。
* 成功失败都记——跑过就是出勤。是不是「兑现」看 failedCommands（见 claimSatisfied）：
* 声称 exitCode:0 的自述不能拿一条失败观测顶过去。
*/
function recordCommandText(command, acc) {
	const at = acc.commands.indexOf(command);
	if (at >= 0) acc.commands.splice(at, 1);
	acc.commands.push(command);
	if (acc.commands.length > MAX_COMMANDS) {
		const dropped = acc.commands.shift();
		if (dropped !== void 0) {
			const i = acc.failedCommands.indexOf(dropped);
			if (i >= 0) acc.failedCommands.splice(i, 1);
		}
		acc.commandsTruncated = true;
	}
}
/** 记一条跑挂的命令。账本跟 commands 同一条：淘汰同步，不单独设窗口。 */
function recordFailedCommand(command, acc) {
	if (acc.failedCommands.includes(command)) return;
	acc.failedCommands.push(command);
}
/**
* 同一条命令后来跑通了 ⇒ 把失败记录撤掉（末次结局胜）。
* 不撤的话「跑挂 → 改代码 → 再跑通过」这个最常见的动作会被判成谎报。
* 掩码过的「成功」不算数：`pnpm test || true` 整条成功，测试未必过。
*/
function clearFailedCommand(command, acc) {
	if (hasMaskingSeparator(command)) return;
	const i = acc.failedCommands.indexOf(command);
	if (i >= 0) acc.failedCommands.splice(i, 1);
}
/**
* 工具轨迹：start 计次并把收据**暂存**，end 计错并决定去留。
*
* 为什么要等 end：`isError` 只在 end 上，start 时不知道这次调用成没成。
* 之前 start 就落账，于是两条洗白通道（都实测可达）：
*   - 5 次全失败的 edit 也算「碰过 5 个文件」⇒ 照着自述写一遍就换到「已核对」
*   - 跑挂的 `pnpm test` 也算「跑过」⇒ 声称 `exitCode: 0` 照样「已核对」
* 路径和命令都按同一套走：**成了才算兑现**。
*/
function takeToolEvent(event, acc) {
	if (event.type === "tool_execution_start") {
		const name = typeof event.toolName === "string" ? event.toolName : "unknown";
		acc.tools[name] = (acc.tools[name] ?? 0) + 1;
		const callId = typeof event.toolCallId === "string" ? event.toolCallId : void 0;
		const path = writablePath(name, event.args);
		const command = commandOf(name, event.args);
		if (callId === void 0) {
			if (path !== void 0) acc.lostPath = true;
			if (command !== void 0) acc.lostCommand = true;
		}
		if (callId !== void 0 && (path !== void 0 || command !== void 0)) acc.pendingWrites.set(callId, {
			...path !== void 0 ? { path } : {},
			...command !== void 0 ? { command } : {}
		});
	} else if (event.type === "tool_execution_end") {
		const failed = event.isError === true || event.result?.isError === true;
		if (failed) acc.errors++;
		const callId = typeof event.toolCallId === "string" ? event.toolCallId : void 0;
		if (callId === void 0) return;
		const pending = acc.pendingWrites.get(callId);
		if (pending === void 0) return;
		acc.pendingWrites.delete(callId);
		if (pending.path !== void 0 && !failed) recordPath(pending.path, acc);
		if (pending.command !== void 0) {
			recordCommandText(pending.command, acc);
			if (failed) recordFailedCommand(pending.command, acc);
			else clearFailedCommand(pending.command, acc);
		}
	}
}
/** 用量：自报的 cacheRead/cacheWrite/cost 缺省就不出键。逐字段 finite——NaN 会污染账。 */
function takeUsage(usage) {
	const cost = typeof usage.cost === "number" ? usage.cost : usage.cost?.total;
	return {
		input: finiteNumber(usage.input),
		output: finiteNumber(usage.output),
		...usage.cacheRead !== void 0 ? { cacheRead: finiteNumber(usage.cacheRead) } : {},
		...usage.cacheWrite !== void 0 ? { cacheWrite: finiteNumber(usage.cacheWrite) } : {},
		...cost !== void 0 ? { cost: finiteNumber(cost) } : {}
	};
}
/** ChildUsage → TurnUsage：缺席字段按 0（与 addUsage 的口径一致），promptTokens 当场钉死。 */
function turnUsageOf(usage) {
	const input = usage.input ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	return {
		input,
		output: usage.output ?? 0,
		cacheRead,
		cacheWrite,
		promptTokens: input + cacheRead + cacheWrite
	};
}
/** 有限数才留（NaN / Infinity 一律当没给）。 */
function finiteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
/** assistant 消息：正文「最后一段胜出」，顺带记模型与用量。 */
function takeAssistant(message, acc) {
	if (message.role !== "assistant") return;
	if (typeof message.model === "string") acc.observedModel = message.model;
	if (typeof message.provider === "string") acc.observedProvider = message.provider;
	acc.text = (Array.isArray(message.content) ? message.content : []).filter((part) => Boolean(part) && typeof part === "object" && part.type === "text").map((part) => typeof part.text === "string" ? part.text : "").join("\n");
	if (message.usage) {
		const usage = takeUsage(message.usage);
		acc.observedUsage = usage;
		acc.turns.push(turnUsageOf(usage));
		acc.usageTotal = addUsage(acc.usageTotal, usage);
	}
}
/** 用量累加：逐轮相加（每轮 usage 是单次请求量，不是累计值）。 */
function addUsage(total, next) {
	const sum = (a, b) => (a ?? 0) + (b ?? 0);
	return {
		input: sum(total?.input, next.input),
		output: sum(total?.output, next.output),
		cacheRead: sum(total?.cacheRead, next.cacheRead),
		cacheWrite: sum(total?.cacheWrite, next.cacheWrite),
		cost: sum(total?.cost, next.cost)
	};
}
/** queue_update / steering 元素：字符串或 {text}；其余形状忽略。 */
function steerText(value) {
	if (typeof value === "string") return value;
	if (value && typeof value === "object" && typeof value.text === "string") return value.text;
	return textOfContent(value);
}
/** queue_update：只记带标记的 seq；空队列不清已有证据。 */
function takeQueueUpdate(event, acc, line) {
	const items = Array.isArray(event.steering) ? event.steering : [];
	for (const item of items) {
		const seq = steerSeqFromText(steerText(item));
		if (seq === void 0) continue;
		if (!acc.queuedSteers.some((entry) => entry.seq === seq)) acc.queuedSteers.push({
			seq,
			line
		});
	}
}
/** user 回显：首行精确标记 + 该 seq 已进过 steering 队列才算送达（初始 prompt 伪造不算）。 */
function takeUserSteer(message, acc, line) {
	const seq = steerSeqFromText(textOfContent(message.content));
	if (seq === void 0) return;
	if (!acc.queuedSteers.some((entry) => entry.seq === seq)) return;
	if (!acc.deliveredSteers.some((entry) => entry.seq === seq)) {
		acc.deliveredSteers.push({
			seq,
			line
		});
		acc.pendingSeen.push(seq);
	}
}
/** assistant 回合：回显后的第一条 assistant 记 seen；再后面的不重复记。 */
function takeAssistantSeen(acc, line) {
	for (const seq of acc.pendingSeen) if (!acc.seenSteers.some((entry) => entry.seq === seq)) acc.seenSteers.push({
		seq,
		line
	});
	acc.pendingSeen = [];
}
/** 工具通道的报告：structuredContent > details.report > details 本体。 */
function takeToolReport(message, acc, line) {
	if (message.role !== "toolResult" || message.toolName !== "child_report") return;
	const candidate = message.structuredContent ?? message.details?.report ?? message.details;
	if (candidate && typeof candidate.summary === "string") {
		acc.toolReport = normalizeReport(candidate);
		acc.reportLine = line;
	}
}
/** 只处理转向证据；返回是否已消费该事件。 */
function takeSteerEvent(event, acc, line) {
	if (event.type === "queue_update") {
		takeQueueUpdate(event, acc, line);
		return true;
	}
	if (event.type !== "message_end" || !event.message) return false;
	if (event.message.role === "user") {
		takeUserSteer(event.message, acc, line);
		return true;
	}
	if (event.message.role === "assistant") {
		takeAssistantSeen(acc, line);
		return true;
	}
	return false;
}
/**
* 一行 JSON 变成一个事件；畸形行返回 undefined（不许毒化整次解析）。
* `type` 必须是字符串：`{"type":5}` 不是事件，是坏数据。
*/
function parseLine(line) {
	const trimmed = line.trim();
	if (!trimmed.startsWith("{")) return void 0;
	try {
		const parsed = JSON.parse(trimmed);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return void 0;
		const event = parsed;
		if (event.type !== void 0 && typeof event.type !== "string") return void 0;
		return event;
	} catch {
		return;
	}
}
/**
* 解析 pi --mode json 的事件流（JSONL，一行一个 JSON 对象）。
* 单个畸形事件不许毒化整次解析——content 形状随 pi 版本变。
*/
function parseChildStream(stdout) {
	const acc = emptyStreamAcc();
	for (const [index, line] of stdout.split("\n").entries()) {
		const event = parseLine(line);
		if (!event) {
			if (line.trim() !== "") acc.malformed += 1;
			continue;
		}
		const lineNo = index + 1;
		if (event.type === "queue_update") {
			takeSteerEvent(event, acc, lineNo);
			continue;
		}
		if (event.type?.startsWith("tool_execution_")) {
			takeToolEvent(event, acc);
			continue;
		}
		if (event.type !== "message_end" || !event.message) continue;
		if (event.message.role === "system") {
			for (const name of declaredToolNames(event.message.sections)) if (!acc.declaredTools.includes(name)) acc.declaredTools.push(name);
			continue;
		}
		if (event.message.role === "user") {
			takeSteerEvent(event, acc, lineNo);
			continue;
		}
		if (event.message.role === "assistant") {
			takeAssistant(event.message, acc);
			takeSteerEvent(event, acc, lineNo);
		}
		takeToolReport(event.message, acc, lineNo);
	}
	let danglingPath = false;
	let danglingCommand = false;
	for (const pending of acc.pendingWrites.values()) {
		if (pending.path !== void 0) danglingPath = true;
		if (pending.command !== void 0) danglingCommand = true;
	}
	return {
		text: acc.text,
		toolReport: acc.toolReport,
		observedUsage: acc.observedUsage,
		observedUsageTotal: acc.usageTotal,
		observedTurns: acc.turns,
		observedModel: acc.observedModel,
		observedProvider: acc.observedProvider,
		delivery: {
			tools: acc.tools,
			paths: acc.paths,
			commands: acc.commands,
			...acc.failedCommands.length > 0 ? { failedCommands: [...acc.failedCommands] } : {},
			errors: acc.errors,
			textChars: acc.text.length,
			...acc.malformed > 0 ? { malformed: acc.malformed } : {},
			...acc.pathsTruncated || danglingPath || acc.lostPath ? { pathsTruncated: true } : {},
			...acc.commandsTruncated || danglingCommand || acc.lostCommand ? { commandsTruncated: true } : {}
		},
		declaredTools: acc.declaredTools,
		steerEvidence: evidenceOf(acc)
	};
}
/** 报告散文段的上限：summary/why/assessment 各 2KB——report 本身是限字摘要，这是「有回执优先」档的前提。 */
const REPORT_PROSE_MAX_CHARS = 2048;
/** 自称命令的保留长度：声称要短，截尾只伤奇葩不构成误报。 */
const VERIFIED_COMMAND_MAX_CHARS = 200;
function clipReportProse(text) {
	return text.length > REPORT_PROSE_MAX_CHARS ? `${text.slice(0, REPORT_PROSE_MAX_CHARS)}…` : text;
}
function normalizeReport(parsed) {
	return {
		summary: clipReportProse(parsed.summary),
		why: typeof parsed.why === "string" ? clipReportProse(parsed.why) : "",
		assessment: typeof parsed.assessment === "string" ? clipReportProse(parsed.assessment) : "",
		findings: Array.isArray(parsed.findings) ? parsed.findings.filter((f) => typeof f?.what === "string").slice(0, MAX_REPORT_ITEMS) : void 0,
		files_touched: Array.isArray(parsed.files_touched) ? parsed.files_touched.filter((f) => typeof f === "string").slice(0, MAX_REPORT_ITEMS) : void 0,
		verified: Array.isArray(parsed.verified) ? parsed.verified.filter((v) => typeof v?.command === "string").slice(0, MAX_REPORT_ITEMS).map((v) => ({
			command: v.command.length > VERIFIED_COMMAND_MAX_CHARS ? `${v.command.slice(0, VERIFIED_COMMAND_MAX_CHARS)}…` : v.command,
			...typeof v.exitCode === "number" && Number.isInteger(v.exitCode) && v.exitCode >= 0 && v.exitCode <= 255 ? { exitCode: v.exitCode } : {}
		})) : void 0,
		usage: normalizeUsage(parsed.usage)
	};
}
/** 报告里清单类字段的条数上限：孩子自报一万条也不许撑爆父方的内存与列表。 */
const MAX_REPORT_ITEMS = 50;
/** 自报用量逐字段必须是有限数：NaN / Infinity 会污染账。 */
function normalizeUsage(usage) {
	if (!usage || typeof usage !== "object") return void 0;
	const out = {};
	for (const field of [
		"input",
		"output",
		"cost",
		"turns",
		"cacheRead",
		"cacheWrite"
	]) {
		const value = usage[field];
		if (typeof value === "number" && Number.isFinite(value)) out[field] = value;
	}
	return Object.keys(out).length > 0 ? out : void 0;
}
/**
* 交付核对：自述的路径和收据里的路径是不是同一个文件。
* 两边写法常不同（相对 vs 绝对），所以比结尾；但按分隔符对齐，
* 否则 a.ts 会命中 xa.ts。
*/
function pathMatches(claim, path) {
	return claim === path || path.endsWith(`/${claim}`) || claim.endsWith(`/${path}`);
}
/**
* 扫一遍命令串，切成段并标出每段「整条成功时能否推出它成功」。引号和反斜杠按 shell 的意思处理：
* 引号内的分隔符不切、`\"` 不是闭合引号（否则 `echo "x\" && pnpm test"` 会被切出
* 一段干净的 pnpm test）。`&` 紧邻 `>` 是重定向（2>&1 / &>log），不算控制符。
*
* 信任按 shell 的优先级建树后**自顶向下**传播——`|` 最高，`&&`/`||` 同级左结合，
* `;`/`&`/未加引号换行最低：
*   And(l,r)           ⇒ 两边都可推（`a && b` 成功 ⇒ a、b 都成功）
*   Or(l,r)            ⇒ 两边都不可推（`a || b` 成功只说明「至少一边」，另一条可能根本没跑）
*   Seq(l,r)/Pipe(l,r) ⇒ 只有右边可推；左边的成败被整条退出码掩掉
* 父节点不可推时，整棵子树一律不可推。观测侧不按换行切——heredoc 正文留在 cat 段里，
* 段首对不上声称命令。
*/
function scanCommand(command, splitNewlines) {
	const stages = [];
	const seps = [];
	let quote = null;
	const hasHeredoc = command.includes("<<");
	let current = "";
	const takeTokens = () => {
		const tokens = current.trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
		while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
		current = "";
		return tokens;
	};
	const closeStage = () => {
		const tokens = takeTokens();
		if (tokens.length > 0) stages.push(tokens);
	};
	const pushSep = (sep) => {
		closeStage();
		if (stages.length > 0 && seps.length === stages.length - 1) seps.push(sep);
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote !== null) {
			current += ch;
			if (ch === "\\" && i + 1 < command.length) {
				current += command[++i];
				continue;
			}
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			current += ch + command[++i];
			continue;
		}
		if (ch === "\"" || ch === "'") {
			quote = ch;
			current += ch;
			continue;
		}
		const next = command[i + 1];
		if (ch === "\n" || ch === "\r") {
			if (splitNewlines || !hasHeredoc) pushSep("seq");
			else current += " ";
			continue;
		}
		if (ch === "&" && next === "&") {
			pushSep("and");
			i++;
			continue;
		}
		if (ch === "&") {
			if (command[i - 1] === ">" || next === ">") {
				current += ch;
				continue;
			}
			pushSep("seq");
			continue;
		}
		if (ch === "|" && next === "|") {
			pushSep("or");
			i++;
			continue;
		}
		if (ch === "|") {
			pushSep("pipe");
			continue;
		}
		if (ch === ";") {
			pushSep("seq");
			continue;
		}
		current += ch;
	}
	closeStage();
	while (seps.length > 0 && seps.length >= stages.length) seps.pop();
	if (stages.length === 0) return [];
	const PREC = {
		pipe: 3,
		and: 2,
		or: 2,
		seq: 1
	};
	let cursor = 0;
	const parseExpr = (minPrec) => {
		let left = { leaf: cursor };
		while (cursor < seps.length) {
			const op = seps[cursor];
			if (PREC[op] < minPrec) break;
			cursor++;
			left = {
				op,
				l: left,
				r: parseExpr(PREC[op] + 1)
			};
		}
		return left;
	};
	const tree = parseExpr(1);
	const known = stages.map(() => false);
	const markAll = (node, value) => {
		if ("leaf" in node) known[node.leaf] = value;
		else {
			markAll(node.l, value);
			markAll(node.r, value);
		}
	};
	const mark = (node, trusted) => {
		if (!trusted) {
			markAll(node, false);
			return;
		}
		if ("leaf" in node) {
			known[node.leaf] = true;
			return;
		}
		if (node.op === "and") {
			mark(node.l, true);
			mark(node.r, true);
			return;
		}
		if (node.op === "or") {
			markAll(node.l, false);
			markAll(node.r, false);
			return;
		}
		mark(node.l, false);
		mark(node.r, true);
	};
	mark(tree, true);
	return stages.map((tokens, index) => ({
		tokens,
		known: known[index] === true
	}));
}
/**
* 这条命令的成败有没有被掩码（`;` `|` `||` 后台 `&` 未加引号的换行）。
* 直接复用扫描器的结论——两处各写一遍扫描器是上一轮漂移的根因。
*/
function hasMaskingSeparator(command) {
	return scanCommand(command, false).some((seg) => !seg.known);
}
/**
* 两个 token 是否同一个。观测侧可能被截断（带 …），那时按前缀认；
* **自述侧只有自己也被截断**（超过报告上限、由 normalizeReport 打的 …）才当通配——
* 否则 `verified:[{command:"…"}]` 能命中任意一条观测，一条 ls 就换到「已核对」。
*/
function tokensEquivalent(claimTok, obsTok, claimTruncated) {
	if (claimTok === obsTok) return true;
	if (obsTok.endsWith("…")) return claimTok.startsWith(obsTok.slice(0, -1));
	if (claimTruncated && claimTok.endsWith("…")) return obsTok.startsWith(claimTok.slice(0, -1));
	return false;
}
/**
* 自述的一段 vs 观测的一段。
* 自述 token 要按序出现，中间只许夹旗标**及其值**（值被吃掉，不能反手当自述 token，
* 否则 `npm --prefix test install` 能满足声称的 `npm test`）。
* 观测比自述多出来的尾巴（--coverage 之类）放行。
*/
function segmentsMatch(claim, observed, claimTruncated) {
	if (claim.length === 0) return false;
	let j = 0;
	let afterFlag = false;
	for (let i = 0; i < observed.length && j < claim.length; i++) {
		const token = observed[i];
		if (afterFlag) {
			afterFlag = false;
			continue;
		}
		if (tokensEquivalent(claim[j], token, claimTruncated)) {
			j++;
			continue;
		}
		if (token.startsWith("-")) {
			afterFlag = true;
			continue;
		}
		return false;
	}
	return j === claim.length;
}
// src/audit/claims.ts
/** 命令首 token 的闭集。不在里面的不当命令自述（`ls` / `cat` 这类也不认）。 */
const RUNNERS = /* @__PURE__ */ new Set([
	"pnpm",
	"npm",
	"npx",
	"yarn",
	"bun",
	"node",
	"tsc",
	"vitest",
	"jest",
	"pytest",
	"cargo",
	"go",
	"make",
	"git"
]);
const CHANGE_VERB = /改|修改|新增|新建|删除|写入|implemented|changed|added|created|wrote|updated|fixed/gi;
const READ_VERB = /读|看了|查看|检查|搜索|grep|read|inspected|checked|reviewed|scanned/gi;
/** 失败词。裸「红」不算（「红利 / 红灯」会误伤）。 */
const FAIL_WORD = /失败|报错|挂了|failed|error|failing|not ok|未通过|没通过|没有通过/gi;
/** 完成词。`完成` 单独不算，除非同句有 实现 / 修复 / 改动。 */
const DONE_WORD = /已实现|已修复|已通过|全部通过|测试通过|全绿|fixed|implemented|passed|all tests pass/gi;
const DONE_LOOSE = /完成/;
const DONE_NEEDS = /实现|修复|改动/;
/** 否定词。`no` / `not` 带词边界，否则 `node` 里的 `no` 会误伤；裸 `0`/`零` 不收。 */
const NEG = /没有|没|未(?!来|知|必|免)|无|不是|并非|不算|\bnot\b|\bno\b|\bnever\b|\bdidn't\b|\bwithout\b/gi;
/** 自己就是失败短语，不能被自己的「未 / not」当成否定。 */
const FAIL_PHRASES = [
	"未通过",
	"没通过",
	"没有通过",
	"not ok"
];
/** 说「这条没跑」的说法：它不能当完成词的绑定目标。 */
const NOT_RUN = /(?:没跑|未跑|未执行|没有运行|didn't run)\s*$/i;
const EXT = /^[\w-]{1,10}$/;
/** 句子分隔：句号/问号/叹号/换行/分号，以及「句点+空白」。反引号与围栏内部不切。 */
function splitSentences(text) {
	const out = [];
	let cur = "";
	let inCode = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "`") {
			inCode = !inCode;
			cur += ch;
			continue;
		}
		if (!inCode) {
			const hard = "。！？!?\n;；".includes(ch);
			const dot = ch === "." && /\s/.test(text[i + 1] ?? "");
			if (hard || dot) {
				out.push(cur);
				cur = "";
				continue;
			}
		}
		cur += ch;
	}
	out.push(cur);
	return out.map((s) => s.trim()).filter((s) => s !== "");
}
/** 小句分隔：中英文逗号、顿号、转折/顺承多字词。单字 就/并/且/再 不切（会切在词内）。 */
const CONJ = /\s*(?:但是|不过|然而|而是|然后|之后|随后|但|却|but|however|then)\s*/i;
function splitClauses(sentence) {
	const out = [];
	let cur = "";
	let inCode = false;
	for (const ch of sentence) {
		if (ch === "`") inCode = !inCode;
		if (!inCode && "，,、".includes(ch)) {
			out.push(cur);
			cur = "";
			continue;
		}
		cur += ch;
	}
	out.push(cur);
	return out.flatMap((c) => c.split(CONJ)).map((s) => s.trim()).filter((s) => s !== "");
}
/** 把四个失败短语抹成等长空格：算否定辖域时它们不算否定。 */
function maskFailPhrases(text) {
	let out = text;
	for (const phrase of FAIL_PHRASES) out = out.replace(new RegExp(phrase, "gi"), (m) => " ".repeat(m.length));
	return out;
}
/** 位置 `at` 是否落在某个否定辖域里（否定词后 12 字以内）。 */
function isNegated(clause, at) {
	const masked = maskFailPhrases(clause);
	const re = new RegExp(NEG.source, "gi");
	let m;
	while ((m = re.exec(masked)) !== null) {
		const start = m.index;
		if (start >= at) break;
		if (at - start <= 12) return true;
	}
	return false;
}
/** 这一段的原文里，按出现顺序列出命令 / 路径 / 动词 / 失败词 / 完成词。 */
function tokensOf(clause) {
	const toks = [];
	const codeSpans = [];
	const re = /`([^`]+)`/g;
	let m;
	while ((m = re.exec(clause)) !== null) {
		const inner = m[1].trim();
		codeSpans.push([
			m.index,
			m.index + m[0].length,
			inner
		]);
		const head = inner.split(/\s+/)[0] ?? "";
		if (RUNNERS.has(head)) toks.push({
			t: "cmd",
			v: inner,
			at: m.index
		});
		else if (looksLikePath(inner)) toks.push({
			t: "path",
			v: inner,
			at: m.index
		});
	}
	const inSpan = (at) => codeSpans.some(([start, end]) => at >= start && at < end);
	for (const m2 of clause.matchAll(/[^\s`'"()（）[\]]+/g)) {
		const raw = m2[0].replace(/[.,;:。，；]+$/, "");
		if (!looksLikePath(raw)) continue;
		if (inSpan(m2.index ?? 0)) continue;
		toks.push({
			t: "path",
			v: raw,
			at: m2.index ?? 0
		});
	}
	for (const m3 of clause.matchAll(CHANGE_VERB)) toks.push({
		t: "verb-change",
		at: m3.index ?? 0
	});
	for (const m4 of clause.matchAll(READ_VERB)) toks.push({
		t: "verb-read",
		at: m4.index ?? 0
	});
	for (const m5 of clause.matchAll(FAIL_WORD)) toks.push({
		t: "fail",
		at: m5.index ?? 0
	});
	for (const m6 of clause.matchAll(DONE_WORD)) toks.push({
		t: "done",
		at: m6.index ?? 0
	});
	if (DONE_LOOSE.test(clause) && DONE_NEEDS.test(clause)) {
		const at = clause.search(DONE_LOOSE);
		if (at >= 0) toks.push({
			t: "done",
			at
		});
	}
	return toks.sort((a, b) => a.at - b.at);
}
/** 带斜杠、末段带扩展名、不是 URL。 */
function looksLikePath(raw) {
	if (raw.includes("://") || !raw.includes("/")) return false;
	const last = raw.split("/").pop() ?? "";
	const dot = last.lastIndexOf(".");
	if (dot <= 0) return false;
	return EXT.test(last.slice(dot + 1));
}
/** 相对路径只归一写法；带 `..` 的才按 cwd 解析成绝对路径。 */
function normalizePath(raw, cwd) {
	let p = raw.trim().replace(/\\/g, "/").replace(/\/+$/, "").replace(/^\.\//, "");
	if (!p.includes("..")) return p;
	const base = typeof cwd === "string" && posix.isAbsolute(cwd) ? cwd : "/";
	p = posix.resolve(base, p);
	return p;
}
/**
* 从报告正文抽自述。
*
* 三条绑定规则（顺序即优先级）：
*   路径 → 「同一句子里最近的前置动词」属于改动闭集才算改动自述；
*   失败词 → 绑「最近的前置命令」，把那条命令降成「只声称跑过」；
*   完成词 → 先在本句找前置命令，找不到再绑上一句的最后一条。
*/
function extractClaims(report) {
	const paths = [];
	const commands = [];
	const vagueBindings = [];
	let prevSentenceLastCmd = null;
	for (const sentence of splitSentences(report)) {
		let lastVerb = null;
		let lastCmd = null;
		const doneToks = [];
		for (const clause of splitClauses(sentence)) for (const tok of tokensOf(clause)) {
			const notRun = tok.t === "cmd" && NOT_RUN.test(clause.slice(0, tok.at));
			switch (tok.t) {
				case "verb-change":
					if (!isNegated(clause, tok.at)) lastVerb = "change";
					break;
				case "verb-read":
					if (!isNegated(clause, tok.at)) lastVerb = "read";
					break;
				case "cmd":
					commands.push({
						command: tok.v,
						wantOk: true
					});
					if (!notRun) lastCmd = commands.length - 1;
					break;
				case "path":
					if (lastVerb === "change" && !isNegated(clause, tok.at)) paths.push(tok.v);
					break;
				case "fail":
					if (lastCmd !== null && !isNegated(clause, tok.at)) commands[lastCmd].wantOk = false;
					break;
				case "done": if (!isNegated(clause, tok.at)) doneToks.push(tok);
			}
		}
		for (const _ of doneToks) vagueBindings.push(lastCmd ?? prevSentenceLastCmd);
		prevSentenceLastCmd = lastCmd ?? prevSentenceLastCmd;
	}
	const seen = /* @__PURE__ */ new Set();
	return {
		paths: paths.filter((p) => {
			const key = p;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		}),
		commands,
		vagueBindings
	};
}
// src/audit/verdict.ts
const DEFAULT_MAX = 20;
const squash = (text) => text.replace(/\s+/g, " ").trim();
/** 命令自述有没有被某条收据兑现。 */
function claimHit(claim, receipts) {
	const segs = scanCommand(claim.command, true).filter((seg) => seg.tokens.length > 0);
	if (segs.length === 0) return false;
	const usable = receipts.filter((r) => claim.wantOk ? r.exitCode === 0 : typeof r.exitCode === "number");
	if (usable.length === 0) return false;
	if (!/[|;&\n]/.test(claim.command)) {
		const target = squash(claim.command);
		if (usable.some((r) => squash(r.command) === target)) return true;
	}
	return segs.every((seg) => usable.some((r) => scanCommand(r.command, false).some((os) => (claim.wantOk ? os.known : true) && segmentsMatch(seg.tokens, os.tokens, false))));
}
/** 从事件里收收据。路径保最先 N 条、命令保最近 N 条——与 core 一致。 */
function collectReceipts(events, max = DEFAULT_MAX) {
	const paths = [];
	const commands = [];
	let pathsTruncated = false;
	let commandsTruncated = false;
	for (const event of events) {
		if (event.kind !== "tool") continue;
		if (event.name === "write") {
			const raw = event.input.path;
			if (typeof raw !== "string" || raw === "") continue;
			const path = normalizePath(raw, event.cwd);
			if (paths.includes(path)) continue;
			if (paths.length >= max) {
				pathsTruncated = true;
				continue;
			}
			paths.push(path);
			continue;
		}
		if (event.name === "bash") {
			const command = event.input.command;
			if (typeof command !== "string" || command.trim() === "") continue;
			commands.push({
				command,
				...typeof event.exitCode === "number" ? { exitCode: event.exitCode } : {},
				trusted: typeof event.exitCode === "number"
			});
			if (commands.length > max) {
				commands.shift();
				commandsTruncated = true;
			}
		}
	}
	return {
		receipts: {
			paths,
			commands
		},
		pathsTruncated,
		commandsTruncated
	};
}
/**
* 九条判定链，顺序即优先级，每条 return。
* `notes` 是副作用：`stale` 与 `vague` 各自往里写一句。
*/
function verdictOf(facts) {
	if (!facts.hasBody && !facts.hasPathReceipts && !facts.pathsTruncated) return "absent";
	if (!facts.hasBody) return "unverified";
	if (facts.stale) {
		facts.notes.push("report predates last steer");
		return "unverified";
	}
	if (facts.vagueBoundMissed) {
		facts.notes.push("vague success claim");
		return "unverified";
	}
	if (facts.total === 0 && (facts.hasPathReceipts || facts.vagueUnbound)) {
		if (facts.vagueUnbound) facts.notes.push("vague success claim");
		return "unverified";
	}
	if (facts.total > 0 && facts.hits === 0) return "unverified";
	if (facts.truncated && facts.hits < facts.total) return "unverified";
	if (facts.hits > 0 && facts.hits < facts.total) return "partial";
	if (facts.total === 0) return "unclaimed";
	if (facts.hits === facts.total && facts.total > 0) return "verified";
	return "unverified";
}
/** 报告在流里的位置：最后一条主链 assistant 文本；没有就落到流末尾。 */
function reportIndex(events) {
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i];
		if (e.kind === "message" && e.role === "assistant" && !e.sidechain && e.text.trim() !== "") return i;
	}
	return events.length;
}
function lastAssistantText(events) {
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i];
		if (e.kind === "message" && e.role === "assistant" && !e.sidechain) {
			if (e.text.trim() !== "") return e.text;
		}
	}
}
function lastSteerIndex(events) {
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i];
		if (e.kind === "message" && e.role === "user" && e.steer === true) return i;
	}
	return -1;
}
const toClaimSet = (claims) => ({
	paths: [...claims.paths],
	commands: claims.commands.map((c) => c.command)
});
/**
* 审一段会话。
*
* - `events`：按时间顺序的归一化事件；
* - `report`：agent 最后写给用户的那段话；`null` 时用流里最后一条主链 assistant 文本；
* - `opts.cwd`：解析 `..` 的基准；相对路径当 `/`。
*/
function audit(events, report, opts = {}) {
	const { receipts, pathsTruncated, commandsTruncated } = collectReceipts(events, opts.maxReceipts ?? DEFAULT_MAX);
	const text = (report ?? lastAssistantText(events) ?? "").trim();
	const hasBody = text !== "";
	const claims = opts.claims ?? extractClaims(text);
	const pathHits = claims.paths.filter((claim) => receipts.paths.some((path) => pathMatches(normalizePath(claim, opts.cwd), path)));
	const commandHits = claims.commands.filter((claim) => claimHit(claim, receipts.commands));
	const total = claims.paths.length + claims.commands.length;
	const hits = pathHits.length + commandHits.length;
	const vagueBoundMissed = claims.vagueBindings.some((binding) => {
		if (binding === null) return false;
		const bound = claims.commands[binding];
		return !bound.wantOk || !commandHits.includes(bound);
	});
	const vagueUnbound = claims.vagueBindings.some((binding) => binding === null);
	const notes = [];
	const deliverable = verdictOf({
		hasBody,
		pathsTruncated,
		truncated: pathsTruncated || commandsTruncated,
		stale: lastSteerIndex(events) > reportIndex(events),
		total,
		hits,
		vagueBoundMissed,
		vagueUnbound,
		hasPathReceipts: receipts.paths.length > 0,
		notes
	});
	const matchedPaths = new Set(pathHits);
	const matchedCommands = new Set(commandHits.map((c) => c.command));
	return {
		deliverable,
		claims: toClaimSet(claims),
		receipts,
		mismatch: {
			paths: claims.paths.filter((p) => !matchedPaths.has(p)),
			commands: claims.commands.map((c) => c.command).filter((c) => !matchedCommands.has(c))
		},
		truncated: pathsTruncated || commandsTruncated,
		notes
	};
}
// src/audit/normalize-codex.ts
const str$1 = (value) => typeof value === "string" && value !== "" ? value : void 0;
/** `["/bin/zsh","-lc",script]` → script；`/bin/zsh -lc "…"` → 内层；其余原样。 */
function unwrapShell(command) {
	if (Array.isArray(command)) {
		const last = command[command.length - 1];
		return typeof last === "string" ? last : void 0;
	}
	const text = str$1(command);
	if (text === void 0) return void 0;
	const m = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z|da|k)?sh\s+-l?c\s+(["'])([\s\S]*)\1$/.exec(text.trim());
	return m ? m[2] : text;
}
/** `arguments` 是 JSON 字符串，命令在里面。 */
function cmdOfArguments(arguments_) {
	if (typeof arguments_ !== "string") return void 0;
	try {
		const parsed = JSON.parse(arguments_);
		return str$1(parsed.cmd);
	} catch {
		return;
	}
}
const textOf$1 = (content) => {
	if (!Array.isArray(content)) return void 0;
	const parts = [];
	for (const block of content) if (block && typeof block === "object") {
		const b = block;
		if (typeof b.text === "string" && b.text !== "") parts.push(b.text);
	}
	return parts.length > 0 ? parts.join("\n") : void 0;
};
/**
* 解析整份 codex 日志。
* `malformed` 只数坏行；CLI 用「一条事件都没有」判退出码 2，不拿坏行判死。
*/
function normalizeCodex(lines) {
	const originals = /* @__PURE__ */ new Map();
	const commands = [];
	const writes = [];
	const messages = [];
	let malformed = 0;
	let cwd;
	for (const line of lines) {
		if (line.trim() === "") continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			malformed++;
			continue;
		}
		const payload = record.payload ?? {};
		const payloadType = str$1(payload.type);
		const topType = str$1(record.type);
		const metaCwd = str$1(payload.cwd)?.replace(/^file:\/\//, "");
		if (cwd === void 0 && metaCwd !== void 0) cwd = metaCwd;
		if (topType === "response_item" && payloadType === "function_call") {
			const callId = str$1(payload.call_id);
			const cmd = cmdOfArguments(payload.arguments);
			if (callId !== void 0 && cmd !== void 0) originals.set(callId, cmd);
			continue;
		}
		const envelopeItem = payloadType === "item_completed" ? payload.item : void 0;
		const topItem = topType === "item.completed" ? record.item ?? void 0 : void 0;
		const item = envelopeItem ?? topItem;
		if (item !== void 0) {
			const type = (item.type ?? "").toLowerCase().replace(/[_-]/g, "");
			if (type === "commandexecution") {
				const command = unwrapShell(item.command);
				if (command !== void 0) commands.push({
					...item.id !== void 0 ? { id: item.id } : {},
					command,
					...typeof item.exit_code === "number" ? { exitCode: item.exit_code } : {},
					...str$1(item.cwd) !== void 0 ? { cwd: str$1(item.cwd).replace(/^file:\/\//, "") } : {}
				});
				continue;
			}
			if (type === "filechange") {
				const changes = item.changes;
				const paths = Array.isArray(changes) ? changes.map((entry) => entry.path).filter((p) => typeof p === "string") : changes && typeof changes === "object" ? Object.keys(changes) : [];
				for (const path of paths) writes.push({
					path,
					...cwd !== void 0 ? { cwd } : {}
				});
				continue;
			}
			if (type === "agentmessage") {
				const text = str$1(item.text) ?? textOf$1(item.content);
				if (text !== void 0) messages.push({
					role: "assistant",
					text,
					...str$1(item.phase) !== void 0 ? { phase: str$1(item.phase) } : {}
				});
				continue;
			}
			if (type === "usermessage") {
				const text = textOf$1(item.content) ?? str$1(item.text);
				if (text !== void 0) messages.push({
					role: "user",
					text
				});
				continue;
			}
		}
		if (topType === "response_item" && payloadType === "message") {
			const role = str$1(payload.role);
			const text = textOf$1(payload.content);
			if ((role === "user" || role === "assistant") && text !== void 0) messages.push({
				role,
				text
			});
		}
	}
	const events = [];
	if (cwd !== void 0) events.push({
		kind: "meta",
		cwd
	});
	for (const command of commands) {
		const command_ = (command.id !== void 0 ? originals.get(command.id) : void 0) ?? command.command;
		events.push({
			kind: "tool",
			name: "bash",
			input: { command: command_ },
			...command.exitCode !== void 0 ? { exitCode: command.exitCode } : {},
			...command.cwd !== void 0 ? { cwd: command.cwd } : {}
		});
	}
	for (const write of writes) events.push({
		kind: "tool",
		name: "write",
		input: { path: write.path },
		...write.cwd !== void 0 ? { cwd: write.cwd } : {}
	});
	for (const message of messages) events.push({
		kind: "message",
		role: message.role,
		text: message.text
	});
	const finalAnswer = [...messages].reverse().find((m) => m.role === "assistant" && m.phase === "final_answer");
	const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
	return {
		events,
		report: finalAnswer?.text ?? lastAssistant?.text ?? null,
		malformed
	};
}
// src/audit/normalize-claude.ts
const WRITE_TOOLS = /* @__PURE__ */ new Set([
	"Write",
	"Edit",
	"NotebookEdit"
]);
const BACKGROUND_MARKERS = [
	"Command running in background",
	"did not complete within",
	"moved to the background"
];
const str = (value) => typeof value === "string" && value !== "" ? value : void 0;
const textOf = (content) => {
	if (typeof content === "string") return content === "" ? void 0 : content;
	if (!Array.isArray(content)) return void 0;
	const parts = [];
	for (const block of content) if (block && typeof block === "object") {
		const b = block;
		if (typeof b.text === "string" && b.text !== "") parts.push(b.text);
	}
	return parts.length > 0 ? parts.join("\n") : void 0;
};
/** 一条 tool_result 对应的退出码。`undefined` = 不是收据。 */
function exitCodeOf(output, isError, background) {
	const marker = /^Exit code (\d+)/.exec(output.trim());
	if (marker !== null) return Number(marker[1]);
	if (isError) return void 0;
	if (background) return void 0;
	if (BACKGROUND_MARKERS.some((m) => output.includes(m))) return void 0;
	return 0;
}
function normalizeClaude(lines) {
	const events = [];
	const pending = /* @__PURE__ */ new Map();
	const messages = [];
	let malformed = 0;
	let seenUserText = false;
	let cwd;
	for (const line of lines) {
		if (line.trim() === "") continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			malformed++;
			continue;
		}
		if (cwd === void 0) cwd = str(record.cwd);
		const type = str(record.type);
		if (type !== "assistant" && type !== "user") continue;
		const message = record.message ?? {};
		const sidechain = record.isSidechain === true;
		const blocks = Array.isArray(message.content) ? message.content : [];
		for (const raw of blocks) {
			if (!raw || typeof raw !== "object") continue;
			const block = raw;
			const kind = str(block.type);
			if (kind === "text") {
				const text = str(block.text);
				if (text === void 0) continue;
				if (type === "assistant") {
					messages.push({
						text,
						sidechain
					});
					continue;
				}
				if (seenUserText) events.push({
					kind: "message",
					role: "user",
					text,
					steer: true
				});
				else events.push({
					kind: "message",
					role: "user",
					text
				});
				seenUserText = true;
				continue;
			}
			if (kind === "tool_use" && type === "assistant") {
				const id = str(block.id);
				const name = str(block.name);
				if (id === void 0 || name === void 0) continue;
				const input = block.input ?? {};
				pending.set(id, {
					name,
					input: {
						...str(input.file_path) !== void 0 ? { path: str(input.file_path) } : str(input.notebook_path) !== void 0 ? { path: str(input.notebook_path) } : {},
						...str(input.command) !== void 0 ? { command: str(input.command) } : {},
						...input.run_in_background === true ? { runInBackground: true } : {}
					},
					sidechain
				});
				continue;
			}
			if (kind === "tool_result" && type === "user") {
				const id = str(block.tool_use_id);
				if (id === void 0) continue;
				const tool = pending.get(id);
				pending.delete(id);
				if (tool === void 0) continue;
				const output = textOf(block.content) ?? "";
				const isError = block.is_error === true;
				if (tool.sidechain) continue;
				if (tool.name === "bash" || tool.name === "Bash") {
					const exitCode = exitCodeOf(output, isError, tool.input.runInBackground === true);
					if (exitCode === void 0) continue;
					events.push({
						kind: "tool",
						name: "bash",
						input: { command: tool.input.command ?? "" },
						exitCode
					});
					continue;
				}
				if (WRITE_TOOLS.has(tool.name)) {
					const path = tool.input.path;
					if (path === void 0) continue;
					events.push({
						kind: "tool",
						name: "write",
						input: { path }
					});
				}
			}
		}
	}
	const mainChain = messages.filter((m) => !m.sidechain);
	const report = mainChain.length > 0 ? mainChain[mainChain.length - 1].text : null;
	for (const message of messages) events.push({
		kind: "message",
		role: "assistant",
		text: message.text,
		...message.sidechain ? { sidechain: true } : {}
	});
	if (cwd !== void 0) events.unshift({
		kind: "meta",
		cwd
	});
	return {
		events,
		report,
		malformed
	};
}
// src/audit/normalize-pi.ts
function normalizePi(lines) {
	const parsed = parseChildStream([...lines].join("\n"));
	const events = [];
	for (const path of parsed.delivery.paths) events.push({
		kind: "tool",
		name: "write",
		input: { path }
	});
	const failed = new Set(parsed.delivery.failedCommands);
	for (const command of parsed.delivery.commands) events.push({
		kind: "tool",
		name: "bash",
		input: { command },
		exitCode: failed.has(command) ? 1 : 0
	});
	const text = parsed.text.trim();
	if (text !== "") events.push({
		kind: "message",
		role: "assistant",
		text
	});
	return {
		events,
		report: text === "" ? null : text,
		malformed: 0
	};
}
export { audit, claimHit, collectReceipts, extractClaims, normalizeClaude, normalizeCodex, normalizePath, normalizePi, unwrapShell, verdictOf };
