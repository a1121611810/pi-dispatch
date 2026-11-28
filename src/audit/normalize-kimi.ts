// kimi code（wire 1.3–1.5）→ 归一化事件。
//
// 四处与另外三家不同，都来自真机实测：
//   1. `isError` 键大面积缺省（本机 708 份主线里 77.8% 的结果没有这个键）：**缺省 = 成功**，
//      只有 `isError === true` 才算失败。写成 `isError === false` 会让正常会话的
//      每条命令都拿不到退出码，判词永远 unverified——功能等于白做。
//   2. 失败退出码多数在输出**尾部**（`Command failed with exit code: N`），少数在
//      开头（`Process exited with code N`）。只读开头会丢掉七成以上的真码。
//   3. 后台启动（`args.run_in_background === true`）那一次结果里没有退出码；
//      真码在稍后的 `task.terminated.info.exitCode`，按 `parentToolCallId` 认回来。
//   4. `Write` / `Edit` 的 `isError` 是「被策略拒了」（计划模式、插件路由）
//      而不是「写了但失败」：文件没动，所以不产路径收据。**这里与 claude 有意分叉**
//      （claude 不看 `is_error`）——假路径收据比少一条收据危险得多，别偷偷统一。
//
// 不读的源，每一条都有理由：
//   `context.append_message`           1.3–1.5 基本只有 user 镜像；assistant/tool 角色集中在
//                                      1.0（从 kimi-cli 导入的另一套格式）。少数 1.5 会话整份
//                                      只有这个镜像、没有 loop 事件，本适配器不支持（退 2 并点名）
//   `agent.message.appended`           turn 结束时批量落盘，会把转向后的旧结论排到转向之后
//   `context.apply_compaction.summary` 摘抄，里面是别人（甚至上一次会话）的命令与路径
//   `file_history.*`                   存储行为，不是 agent 的写动作
//   `agents/agent-*/wire.jsonl`        子代理侧链（同 claude 的 sidechain：不并进主链）
import type { SessionEvent } from "./types.ts";

export interface NormalizedKimi {
  events: SessionEvent[];
  report: string | null;
  malformed: number;
}

const WRITE_TOOLS = new Set(["Write", "Edit"]);

/** 失败码：尾部是主流，开头是少数；两个都认。 */
const EXIT_TRAILING = /Command failed with exit code: (\d+)/;
const EXIT_LEADING = /^\s*Process exited with code (\d+)/;

/**
 * 「命令根本没跑」的签名。命中这些说明这次调用被插件路由或参数校验拦下了，
 * 记成「跑过但失败」会让一条诚实的负评被一个没执行的命令兑现。
 */
const NEVER_RAN = ["Aborted before command started", "Invalid args for tool", "ptc-tools 插件"];

/**
 * 后台启动回执。**不是每个后台命令都带 `run_in_background` 旗标**——实测 94 次自动转后台的
 * 调用旗标是缺省的，只回了这一段。把它当成功就是给还在跑的进程发一张 `exit 0` 收据；
 * 真退出码在 `task.terminated` 里。
 */
const LAUNCHED = /^\s*task_id: bash-/;

/** 旧协议的正文段里裹着 `<think>`：推理不能当自述。 */
const THINK_BLOCK = /<think>[\s\S]*?<\/think>/g;

/** 人话打断的排除项：skill 加载也走 `msg_`，但它不是人说的。 */
const SKILL_LOAD = ["Skill tool loaded", "[ponytail"];

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** 文本块既可能是字符串，也可能是 `[{type:"text",text}]`（后台任务的输出就是这样）。 */
const textOf = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const block of value) {
    if (block && typeof block === "object") {
      const b = block as { type?: unknown; text?: unknown };
      if (str(b.type) === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("\n");
};

/**
 * 一次 Bash 结果的退出码。
 *
 * - `isError` 缺省就是成功：本机六成结果没有这个键，写成 `=== false` 会让正常会话全废；
 * - 成功命令的输出里出现标记只说明它 **引用** 了别人的日志，不能读；
 * - 真失败但没标记（被 kill、超时）记 1：它确实跑挂了，只是没有数字码。
 */
function exitCodeOf(output: string, isError: boolean): number {
  if (!isError) return 0;
  const marker = EXIT_TRAILING.exec(output) ?? EXIT_LEADING.exec(output);
  return marker === null ? 1 : Number(marker[1]);
}

/**
 * 这一条是不是人发起的回合。
 *
 * `origin.kind === "user"` 是常态；但用户敲斜杠技能时走的是
 * `kind: "skill_activation"` + `trigger: "user-slash"`——那也是人发的话（本机 880 条），
 * 当成注入吞掉，报告之后的人话就再也标不出「早于最后一次转向」⇒ 假 verified。
 * 模型自己触发的技能加载是 `trigger: "model-tool"`（144 条），仍然不算。
 */
const isHumanTurn = (origin: { kind?: unknown; trigger?: unknown }): boolean =>
  str(origin.kind) === "user" ||
  (str(origin.kind) === "skill_activation" && str(origin.trigger) === "user-slash");

/** 一次工具调用的待配对状态。 */
interface Pending {
  name: string;
  path?: string;
  command?: string;
  /** 后台启动：这一次的结果没有退出码，不产收据。 */
  background: boolean;
}

export function normalizeKimi(lines: Iterable<string>): NormalizedKimi {
  const events: SessionEvent[] = [];
  const pending = new Map<string, Pending>();
  /** 见过启动的后台命令：`task.terminated.parentToolCallId` 要在这里才认。 */
  const backgroundCalls = new Set<string>();
  /**
   * 后台终态收据先挂起：**落在最后一条报告之后的终态不能给那份报告作证**。
   * 否则「构建还在跑 → 先写『跑通了』→ 两分钟后真跑通了」会被判 verified（假绿）。
   */
  const terminated: Array<{ at: number; event: SessionEvent }> = [];
  /**
   * 上一条转向的原文：同一条人话会同时出现在 `turn.steer` 与 `prompt.steered` 里（相邻两行）。
   * **只跟紧邻的那一条比**——按全文去重会吞掉「隔一会儿又说了一次『继续』」，
   * 于是最后一条转向消失、旧报告被当成新鲜的（假 verified）。
   */
  let lastSteerText: string | null = null;
  let malformed = 0;
  let seenUser = false;

  // 正文按步聚合：`content.part` 是流式的，一步可能好几段。
  let buffer: string[] = [];
  let bufferStep: string | null = null;

  const flush = (): void => {
    if (buffer.length === 0) return;
    const text = buffer.join("\n").replace(THINK_BLOCK, "").trim();
    buffer = [];
    bufferStep = null;
    // 报告一落盘，「上一条转向」的比对就断了：隔一会儿再说同一句话是新的转向。
    lastSteerText = null;
    if (text !== "") events.push({ kind: "message", role: "assistant", text });
  };

  const pushUser = (text: string): void => {
    // 第一条用户消息是任务本身，其后都是转向。
    if (seenUser) events.push({ kind: "message", role: "user", text, steer: true });
    else events.push({ kind: "message", role: "user", text });
    seenUser = true;
  };

  const pushSteer = (text: string): void => {
    const key = text.trim();
    if (key === "" || key === lastSteerText) return;
    lastSteerText = key;
    events.push({ kind: "message", role: "user", text, steer: true });
  };

  for (const line of lines) {
    if (line.trim() === "") continue;
    let record: { type?: unknown; event?: unknown; input?: unknown; content?: unknown };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      malformed++;
      continue;
    }
    const type = str(record.type);

    if (type === "context.append_loop_event") {
      const event = (record.event ?? {}) as {
        type?: unknown;
        turnId?: unknown;
        step?: unknown;
        toolCallId?: unknown;
        name?: unknown;
        args?: unknown;
        display?: unknown;
        part?: unknown;
        result?: unknown;
      };
      const kind = str(event.type);

      if (kind === "content.part") {
        const part = (event.part ?? {}) as { type?: unknown; text?: unknown };
        // `think` 段不进正文，也不打断当前步——它就夹在正文中间。
        if (str(part.type) !== "text") continue;
        if (typeof part.text !== "string") continue;
        const step = `${event.turnId ?? ""}/${event.step ?? ""}`;
        if (bufferStep !== null && bufferStep !== step) flush();
        bufferStep = step;
        buffer.push(part.text);
        continue;
      }

      // 其余 loop 事件（tool.call / tool.result / step.end / step.begin）都意味着
      // 上一步的正文到此为止：先落盘，保证事件顺序与流里的顺序一致。
      flush();

      if (kind === "tool.call") {
        const id = str(event.toolCallId);
        const name = str(event.name);
        if (id === undefined || name === undefined) continue;
        const args = (event.args ?? {}) as {
          path?: unknown;
          command?: unknown;
          run_in_background?: unknown;
        };
        const display = (event.display ?? {}) as { path?: unknown };
        // 写工具的相对路径很常见，`display.path` 是绝对路径但有一部分调用没有 display；
        // 谁在就用谁，都不在就当没有。
        const path = str(display.path) ?? str(args.path);
        const background = name === "Bash" && args.run_in_background === true;
        if (background) backgroundCalls.add(id);
        pending.set(id, {
          name,
          ...(path !== undefined ? { path } : {}),
          ...(str(args.command) !== undefined ? { command: str(args.command)! } : {}),
          background,
        });
        continue;
      }

      if (kind === "tool.result") {
        const id = str(event.toolCallId);
        if (id === undefined) continue;
        const call = pending.get(id);
        pending.delete(id);
        if (call === undefined) continue;
        const result = (event.result ?? {}) as { output?: unknown; isError?: unknown };
        const isError = result.isError === true;

        if (call.name === "Bash") {
          if (call.command === undefined) continue;
          const output = textOf(result.output);
          // 后台启动没有退出码：等 `task.terminated` 补，不用 0 冒充。
          // 旗标和启动回执任一命中都算——自动转后台的调用没有旗标。
          if (call.background || LAUNCHED.test(output)) {
            backgroundCalls.add(id);
            continue;
          }
          if (NEVER_RAN.some((marker) => output.trimStart().startsWith(marker))) continue;
          const exitCode = exitCodeOf(output, isError);
          events.push({ kind: "tool", name: "bash", input: { command: call.command }, exitCode });
          continue;
        }

        if (WRITE_TOOLS.has(call.name)) {
          // 被策略拒的写没动过文件。
          if (isError) continue;
          if (call.path === undefined) continue;
          events.push({ kind: "tool", name: "write", input: { path: call.path } });
        }
      }
      continue;
    }

    flush();

    if (type === "turn.prompt" || type === "turn.steer") {
      const origin = ((record as { origin?: unknown }).origin ?? {}) as {
        kind?: unknown;
        trigger?: unknown;
      };
      if (!isHumanTurn(origin)) continue;
      const text = textOf(record.input).trim();
      if (text === "") continue;
      if (type === "turn.steer") pushSteer(text);
      else pushUser(text);
      continue;
    }

    if (type === "prompt.steered") {
      const steered = record as { messageId?: unknown; content?: unknown };
      const messageId = str(steered.messageId);
      // 后台完成通知（`task:<id>:…`）不是人说的话；没有 id 的一律不认。
      if (messageId === undefined || !messageId.startsWith("msg_")) continue;
      const text = textOf(steered.content).trim();
      if (SKILL_LOAD.some((prefix) => text.startsWith(prefix))) continue;
      pushSteer(text);
      continue;
    }

    if (type === "task.terminated") {
      const info = ((record as { info?: unknown }).info ?? {}) as {
        command?: unknown;
        exitCode?: unknown;
        parentToolCallId?: unknown;
      };
      // 只认本 wire 里见过启动的后台命令：别把别人（或上一次会话）的任务算成收据。
      const parent = str(info.parentToolCallId);
      if (parent === undefined || !backgroundCalls.has(parent)) continue;
      const command = str(info.command);
      if (command === undefined || typeof info.exitCode !== "number") continue;
      terminated.push({
        at: events.length,
        event: { kind: "tool", name: "bash", input: { command }, exitCode: info.exitCode },
      });
    }
  }

  flush();

  let report: string | null = null;
  let lastAssistant = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.kind === "message" && event.role === "assistant") {
      report = event.text;
      lastAssistant = i;
      break;
    }
  }

  // 终态收据只在报告之前发生才算数；位置按记录时的下标插回，保持流里的顺序。
  const kept = terminated.filter((entry) => lastAssistant === -1 || entry.at <= lastAssistant);
  for (const [offset, entry] of kept.entries()) {
    events.splice(entry.at + offset, 0, entry.event);
  }

  return { events, report, malformed };
}
