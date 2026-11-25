#!/usr/bin/env node
// 破坏点表 + 验红跑器。
//
// 一条 = 一个功能点。跑器把 `from` 改成 `to`（弄坏功能），**只跑 `red` 指名的那一条测试用例**，
// 要求它真的变红，然后复原。三条判据：
//   假绿       —— 改了源码，指名的用例还是绿的
//   红错地方   —— 套件红了，但红的是别的用例
//   标题写错   —— 0 命中时 node 输出 `ok 1 - <文件名>`、退出码 0（实测），看起来像通过
//
// 用法：pnpm check:breakpoints [功能点片段…]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDirectInvocation } from "./test.ts";
import { scrubbedEnv } from "./test-env.ts";

export type Breakpoint = {
  /** 功能点（一句话） */
  feature: string;
  /** 改哪个文件 */
  file: string;
  /** 原样：必须在该文件里恰好出现一次 */
  from: string;
  /** 破坏版：必须仍是合法 TS */
  to: string;
  /** 跑哪个测试文件 */
  test: string;
  /** 该红的测试用例标题（精确） */
  red: string;
  /**
   * 失败消息里必须出现的关键字（可选）。
   * 给了就当锚点：变异后指名用例红了，但消息里没有这个关键字 ⇒ 是别的理由红的，记 wrong-red。
   */
  redKeyword?: string;
  /** 弄坏之后什么表现坏掉 */
  why: string;
};

// 写不出单行破坏点的功能点（不静默缺）：
//   听 close 不听 exit —— 实测 1MB 输出在 exit 事件前已读空；shell 造不出确定性差异。
//                        实现仍按规格用 close；这条只能靠读代码守。
//   座位上限不超发 —— 座位数与池子两道上限互为备份，单行破坏点打不破，行为不变。
//   定终态先于还座位 —— 缺陷是语句顺序，文本替换表达不了。
//   收件四样一起收 —— 顺序无关。
//   不给 cwd 时 spawn options 里连键都不出现 —— 缺席类：node 的 spawn 收到
//     `cwd: undefined` 与「没有 cwd」同义（都落在父方目录），单行破坏点打不出差别。
//     实现仍按规格连键都不给（省掉一个假键）；这条只能靠读代码守。
//   黑板笔记永不自动注入任何提示词 —— 结构缺席：没有「读板 → 拼提示词」的代码路径。
//     靠 test/child.test.ts 的 append 块逐字节 golden 守（开黑板与不开逐字节相等）。
//   观测先于 resolve-exit、失败不回改终态 —— 顺序 + 缺席：顺序写不出单行差别；
//     「失败不回改终态」由「引擎：观测失败时 dirty 留空（不填 0）」的 succeeded 断言守。
//   建盘在启动名额内 —— 顺序类：名额跨 await 持有，单行替换打不出可观测差异；
//     由「引擎：建盘期间被叫停 ⇒ 不 spawn」与「引擎：创建失败 ⇒ failed 且不 spawn」夹住。
//   不自动 merge / 不代提交 / 不建消息队列 / 不按孩子数判黑板 / 无跨会话板 —— 缺席类：
//     没有对应代码路径可改，单行破坏点写不出来。各自靠单测/契约守——孩子契约要求
//     交付前自行 commit（不代提交、不 merge）、openBoard 不看孩子数、blackboardView 拒别家板号。
//
// 成本控制（本轮）：
//   ① 硬门走 stop（SIGTERM → SIGKILL）—— 已落破坏点：把硬门分支的 stop 换成空操作，
//      由「引擎：硬门 ⇒ 收掉孩子（SIGTERM），部分正文照交」守。
//   ② 预算判定与报告通道解耦（reportChannel=none 时预算照判）—— 已落破坏点：关掉
//      运行中的用量检查，由「引擎：没交报告时预算照样判（账上也有数）」守。
//   ③ 孩子没起来 ⇒ 不带 budget 字段 —— 已落破坏点：去掉 startedAt > 0 条件，
//      由「引擎：孩子没起来 ⇒ 不带 budget 字段」守。
//   ④ 受理时钉死预算（排队期间改参数不生效）—— 已落破坏点：改成共享原对象，
//      由「引擎：受理时钉死预算（排队期间改参数不生效）」守。
//   ⑤ 报告旗标与预算旗标不互相掩盖 —— 已落破坏点：把预算旗标改成只在没报告时出现，
//      由「引擎：软门后孩子交了差 ⇒ 报告旗标与预算旗标不互相掩盖」守。
//   ⑥ 跨子代理缓存共享 —— 外部类：收益在 provider 侧（缓存键 / TTL / 会话亲和），
//      本仓没有可改代码；仓内只守「前缀逐字节恒定」（BP-9 / BP-48 / BP-49）。
//   ⑦ 虚拟模型的 thinking 档位（路由后）—— 外部类：档位由 provider 路由决定，
//      本仓不可测；走 test:mode 真机验证。
//   ⑧ user message 顺序（任务 → why → 隔离契约）—— 已落破坏点：交换数组元素，
//      由「拼命令：user message 的顺序是 任务 → why → 隔离契约」守。
//      硬门先于软门仍由 BP-22 守（纯「先判哪个」的另一种写法杀不出差别）。
//   ⑨ 黑板消息从不进提示词 / 报告契约文本一字不改 —— 结构类：没有那段拼提示词的代码。
//      由 test/child.test.ts 既有附加块 golden 与「报告契约：三段分工 + 反话钉 + why 条件句」守。
//   ⑩ provider 侧的预热经济性判定 —— 外部类：只有 pi 算「划不划算」，本仓只负责说不说 stop。
//      由「成本：depth>0 的孩子关掉 cache 预热（action=stop）」守。
//   ⑪ 不给子代理写 .pi/settings.json —— 结构类：没有写文件这条路径；预热改由
//      cache_warming_decision 钩子返回 stop 关闭，不落任何 settings 文件。
//
// BP-20 的矩阵把「硬收过就一直硬门」写到引擎的 `hard: state.hard` 入参；但引擎可达状态下
// 一旦进过硬门，hardByUsd / hardByTokens / hardByTime 仍恒为真（累计用量不回退、宽限时刻
// 已过），把 `hard: state.hard` 改成 `hard: false` 杀不出差别 ⇒ 引擎侧是等价变异。
// 可杀的语义在 budget.ts 的 `if (input.hard)`，由「预算：已经硬收过就一直是硬门」守。

const CASES: Breakpoint[] = [
  // ── 安检 ────────────────────────────────────────────────────────────────
  {
    feature: "readOnly 写错值要退回",
    file: "src/core/gates.ts",
    from: '  input.readOnly !== undefined && input.readOnly !== "strict" && input.readOnly !== "lenient"',
    to: "  input.readOnly !== undefined && false",
    test: "test/core-logic.test.ts",
    red: "安检 1：readOnly 写错值要拒，不能 coerce 成宽松",
    why: "只读档位被写错值时悄悄按宽松放行",
  },
  {
    feature: "会话收尾时不接新派发",
    file: "src/core/gates.ts",
    from: '    isEnding() ? rejection("session is ending：这次派发不被接受") : null;',
    to: "    isEnding() ? null : null;",
    test: "test/core-logic.test.ts",
    red: "安检 3：会话收尾时不接新派发",
    why: "收尾中起的子代理没人收，成孤儿",
  },
  {
    feature: "递归深度有上限",
    file: "src/core/gates.ts",
    from: "    depth() + 1 > maxDepth ? rejection(`dispatch depth limit reached（max ${maxDepth}）`) : null;",
    to: "    depth() + 1 > maxDepth ? null : null;",
    test: "test/core-logic.test.ts",
    red: "安检 4：递归深度有上限",
    why: "子代理无限嵌套，进程树失控",
  },
  {
    feature: "空任务要退回",
    file: "src/core/gates.ts",
    from: '  typeof input.task !== "string" || input.task.trim() === ""',
    to: '  typeof input.task !== "string"',
    test: "test/core-logic.test.ts",
    red: "安检 5：空任务要拒",
    why: "空任务被派出去，孩子什么都不知道",
  },
  {
    feature: "横线开头的任务要退回",
    file: "src/core/gates.ts",
    from: '      ? rejection("task 不能以 - 开头：当前 -- 分隔符已挡住旗标，这条是纵深防御")',
    to: "      ? null",
    test: "test/core-logic.test.ts",
    red: "安检 6：以横线开头的任务要拒（pi 会当命令行选项）",
    why: "pi 把任务当命令行选项，可能假装成功",
  },
  {
    feature: "超时必须是正数",
    file: "src/core/gates.ts",
    from: "    input.timeoutMs <= 0 ||",
    to: "    input.timeoutMs < 0 ||",
    test: "test/core-logic.test.ts",
    red: "安检：timeoutMs 必须是正数",
    why: "timeoutMs 0 被当成有效时限",
  },
  {
    feature: "task 以 @ 开头要退回",
    file: "src/core/gates.ts",
    from: '      : input.task.startsWith("@")',
    to: "      : false",
    test: "test/core-logic.test.ts",
    red: "安检 14：task 以 @ 开头要拒（pi 会把它当文件读，任务正文被丢弃）",
    why: "@ 开头的位置参数被 pi 当文件路径：任务正文丢弃、文件内容变成孩子的指令",
  },
  {
    feature: "task 含 C0 控制字符要退回",
    file: "src/core/gates.ts",
    from: "        : hasC0(input.task)",
    to: "        : false",
    test: "test/core-logic.test.ts",
    red: "安检 15：task 含 C0 控制字符要拒（NUL 进 argv 会让 spawn 抛）",
    why: "NUL 进 argv 让 spawn 抛在铸编号之后：闸放行、占了座位、留下误导记录",
  },
  {
    feature: "C0 字符类不许收窄",
    file: "src/core/types.ts",
    from: "const C0_RE = /[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]/;",
    to: "const C0_RE = /[\\u0000-\\u0008]/;",
    test: "test/core-logic.test.ts",
    red: "C0：垂直制表 / 单元分隔符也算控制字符",
    why: "字符类收窄后 \\u000B / \\u001F 混进 argv：spawn 在铸编号之后抛，记成 failed",
  },
  {
    feature: "allowScripts 非布尔要退回",
    file: "src/core/gates.ts",
    from: '  input.allowScripts !== undefined && typeof input.allowScripts !== "boolean"',
    to: "  false",
    test: "test/core-logic.test.ts",
    red: "安检 11：allowScripts 非 boolean 要拒（truthy 就是开了 codemode）",
    why: 'allowScripts="false" 是 truthy：猜成布尔就是把「不许写脚本」偷偷变成「能写脚本」',
  },
  {
    feature: "文本字段必须是字符串",
    file: "src/core/gates.ts",
    from: '    if (typeof value !== "string")',
    to: '    if (typeof value !== "string")\n      return null;',
    test: "test/core-logic.test.ts",
    red: "安检 12：model/thinkingLevel/why 必须是字符串，不许带控制字符",
    why: "非字符串在铸编号之后 .trim 抛错 ⇒ 记成 failed 而不是 rejected",
  },
  {
    feature: "文本字段的控制字符闸不只查 why",
    file: "src/core/gates.ts",
    from: "    if (hasC0(value))",
    to: '    if (hasC0(value) && field === "why")',
    test: "test/core-logic.test.ts",
    red: "安检 12b：model / thinkingLevel 带控制字符也拒（不只 why）",
    why: "只有 why 查控制字符，model 里的 NUL 照样进 argv——spawn 在铸编号之后抛，记成 failed",
  },
  {
    feature: "task / why 有字节上限",
    file: "src/core/gates.ts",
    from: "export const MAX_TEXT_BYTES = 64 * 1024;",
    to: "export const MAX_TEXT_BYTES = Number.MAX_SAFE_INTEGER;",
    test: "test/core-logic.test.ts",
    red: "安检 16：task / why 有字节上限（超了 rejected，不是 spawn 后 E2BIG）",
    why: "上限被取消，2 MiB 的 task 会在 spawn 处抛 E2BIG：闸放行、记 failed、留误导记录",
  },
  {
    feature: "projectContext 写错值要退回",
    file: "src/core/gates.ts",
    from: '  input.projectContext !== undefined &&\n  input.projectContext !== "auto" &&\n  input.projectContext !== "none"',
    to: "  false",
    test: "test/core-logic.test.ts",
    red: "安检 13：projectContext 写错值要拒（错值方向是多加载上下文）",
    why: '"NON" 被悄悄当成 auto：父方想少加载上下文，加载量反而变多',
  },
  {
    feature: "深度解析只认整串十进制",
    file: "src/core/gates.ts",
    from: "  const value = /^\\d+$/.test(raw) ? Number(raw) : Number.NaN;",
    to: "  const value = /\\d+/.test(raw) ? Number(raw) : Number.NaN;",
    test: "test/core-logic.test.ts",
    red: "深度解析：坏值按「太深」算，不当 0",
    why: "坏值被解析成负数/小数混进深度：闸按「0 层」放行，子进程被当宿主装全套工具",
  },
  {
    feature: "超时必须是整数",
    file: "src/core/gates.ts",
    from: "    !Number.isInteger(input.timeoutMs) ||",
    to: "    false ||",
    test: "test/core-logic.test.ts",
    red: "安检：timeoutMs 必须是 1..2^31-1 的整数毫秒",
    why: "1.5 毫秒不是有效时限：小数被当成真时限，计时口径就说不清了",
  },
  {
    feature: "超时不超过 Node 定时器上限",
    file: "src/core/gates.ts",
    from: "    input.timeoutMs > MAX_TIMEOUT_MS)",
    to: "    false)",
    test: "test/core-logic.test.ts",
    red: "安检：timeoutMs 必须是 1..2^31-1 的整数毫秒",
    why: "超过 2^31-1 的定时器立刻溢出：不是「很久」，是几乎立刻超时",
  },
  {
    feature: "退回不留记录",
    file: "src/core/engine.ts",
    from: "      if (rejected) return rejected; // 闸在铸 id 前：不留记录不占座位",
    to: '      if (rejected) { await this.#registry.submit({ kind: "spawn", record: { id: "leak", status: "queued", task: "t" } }); return rejected; }',
    test: "test/engine.test.ts",
    red: "引擎：安检不过要退回，且不留记录不占座位",
    why: "被拒的派发留下记录，查列表会看到幽灵任务",
  },

  // ── 理由 ────────────────────────────────────────────────────────────────
  {
    feature: "理由被丢时要记一笔",
    file: "src/core/engine.ts",
    from: "    const whySuppressed = !whyEnabled && rawInput.why !== undefined;",
    to: "    const whySuppressed = false as boolean;",
    test: "test/engine.test.ts",
    red: "引擎：理由开关关着——记「理由被丢了」，不记内容",
    why: "父方以为理由送出去了",
  },

  // ── 容量 ────────────────────────────────────────────────────────────────
  {
    feature: "池子量 = 可用 − 预留",
    file: "src/core/pool.ts",
    from: "  return availableBytes - Math.floor(totalBytes * options.reserveRatio);",
    to: "  return availableBytes;",
    test: "test/pool.test.ts",
    red: "池子 ①：池子量 = 可用 − 预留，预留按总内存算",
    why: "不扣预留，座位越开越多直到机器换页",
  },
  {
    feature: "每座份额取下限与比例中的大者",
    file: "src/core/pool.ts",
    from: "  return Math.max(options.perSeatMinBytes, Math.floor(totalBytes * options.perSeatMaxRatio));",
    to: "  return Math.min(options.perSeatMinBytes, Math.floor(totalBytes * options.perSeatMaxRatio));",
    test: "test/pool.test.ts",
    red: "池子 ②：每座份额 = max(下限, 总内存 × 比例)",
    why: "大机器上每座只给 2%，座位被无谓压少",
  },
  {
    feature: "座位数向下取整、可为 0",
    file: "src/core/pool.ts",
    from: "  return Math.max(0, Math.floor(pool / perSeat));",
    to: "  return Math.max(0, Math.ceil(pool / perSeat));",
    test: "test/pool.test.ts",
    red: "池子 ③：座位数 = ⌊池子量 ÷ 每座份额⌋，可为 0",
    why: "差一点也硬开一个，池子被撑破",
  },
  {
    feature: "判「还能再开一个」= 池子÷份额 ≥ 在跑 + 1",
    file: "src/core/pool.ts",
    from: "  return seatCount(pool, perSeat) >= running + 1;",
    to: "  return seatCount(pool, perSeat) >= running + 2;",
    test: "test/pool.test.ts",
    red: "判「还能不能再开一个」：此刻池子量 ÷ 每座份额 ≥ 已在跑的 + 1",
    why: "明明还有余位却不放行",
  },
  {
    feature: "CPU 启动上限 = clamp(核数÷2, 1, 4)",
    file: "src/core/pool.ts",
    from: "  return Math.min(4, Math.max(1, Math.floor(cpus / 2)));",
    to: "  return Math.min(9, Math.max(1, Math.floor(cpus / 2)));",
    test: "test/pool.test.ts",
    red: "CPU 启动节流：核数 ÷ 2，夹在 1 到 4",
    why: "一次起太多进程，父方跟着变慢",
  },
  {
    feature: "核数读不到时按 1 算",
    file: "src/core/pool.ts",
    from: "  return cpus || 1;",
    to: "  return cpus;",
    test: "test/pool.test.ts",
    red: "核数兜底：读到 0 或读不到时按 1 算（单核也要能起）",
    why: "核数 0 时启动节流算成 0，永远起不来",
  },
  {
    feature: "vm_stat 可用 = free+inactive+speculative+purgeable",
    file: "src/core/pool.ts",
    from: '    pages("Pages speculative") +\n    pages("Pages purgeable");',
    to: '    pages("Pages purgeable");',
    test: "test/pool.test.ts",
    red: "解析：vm_stat 的可用 = free + inactive + speculative + purgeable",
    why: "算漏一项，池子比实际小",
  },

  // ── 座位 ────────────────────────────────────────────────────────────────
  {
    feature: "错峰：一个结束后，排队的立刻起",
    file: "src/core/engine.ts",
    from: "    if (this.#claimed.size >= this.#seatCap) return false;",
    to: "    if (this.#children.size + this.#claimed.size >= this.#seatCap) return false;",
    test: "test/engine.test.ts",
    red: "引擎：错峰——一个结束后，排队的要立刻起（座位不该数两次）",
    why: "空出的座位被闲置，队列看起来卡住",
  },
  {
    feature: "启动名额只占启动，不占整个运行期",
    file: "src/core/engine.ts",
    from: "      this.#releaseLaunchSlot(); // 起了（或抛错）就交还名额，别占整个运行期",
    to: "      void 0;",
    test: "test/engine.test.ts",
    red: "引擎：启动名额只占启动，不占整个运行期（并发上限 = 座位数）",
    why: "名额被长期占用，并发被压到启动上限",
  },

  // ── 生命周期 ────────────────────────────────────────────────────────────
  {
    feature: "终态不可再迁",
    file: "src/core/registry.ts",
    from: "    const current = this.#require(id);\n    if (isTerminal(current.status))\n      return { record: current, fromStatus: current.status, changed: false };\n    if (!ALLOWED_TRANSITIONS[current.status].includes(to)) {",
    to: "    const current = this.#require(id);\n    if (isTerminal(current.status))\n      return { record: { ...current, status: to }, fromStatus: current.status, changed: true };\n    if (!ALLOWED_TRANSITIONS[current.status].includes(to)) {",
    test: "test/core-logic.test.ts",
    red: "状态机：终态哪儿也去不了——迟到写入静默丢弃不报错",
    why: "终态被改写，账本回头会说谎",
  },
  {
    feature: "迟到写入静默丢弃",
    file: "src/core/registry.ts",
    from: "        const current = this.#require(command.id);\n        if (isTerminal(current.status))\n          return { record: current, fromStatus: current.status, changed: false };\n        const next: TaskRecord = {\n          ...current,\n          report: command.report,",
    to: "        const current = this.#require(command.id);\n        const next: TaskRecord = {\n          ...current,\n          report: command.report,",
    test: "test/core-logic.test.ts",
    red: "状态机：终态哪儿也去不了——迟到写入静默丢弃不报错",
    why: "迟到的报告覆盖了终态记录",
  },
  {
    feature: "退出码 0 是成了",
    file: "src/core/registry.ts",
    from: '      to: command.exitCode === 0 ? "succeeded" : "failed",',
    to: '      to: command.exitCode === 1 ? "succeeded" : "failed",',
    test: "test/core-logic.test.ts",
    red: "状态机：queued → running → succeeded 走通",
    why: "跑成功却记成失败",
  },
  {
    feature: "叫停过的收完算取消",
    file: "src/core/registry.ts",
    from: '    const to: TaskStatus = command.exitCode === 0 ? "succeeded" : "canceled";',
    to: '    const to: TaskStatus = command.exitCode === 0 ? "succeeded" : "failed";',
    test: "test/core-logic.test.ts",
    red: "状态机：stopping 的子代理收完算 canceled（退出码非 0）",
    why: "用户主动停的显示成失败",
  },
  {
    feature: "只有排队中的能被抽掉",
    file: "src/core/registry.ts",
    from: '        if (current.status !== "queued")\n          return { record: current, fromStatus: current.status, changed: false };',
    to: '        if (current.status !== "queued")\n          return {\n            record: { ...current, status: "canceled" },\n            fromStatus: current.status,\n            changed: true,\n          };',
    test: "test/core-logic.test.ts",
    red: "状态机：cancel-queued 只对 queued 生效",
    why: "在跑的任务被 cancel-queued 改名，实际还在跑",
  },
  {
    feature: "挤掉时最老先出",
    file: "src/core/registry.ts",
    from: "  if (at !== bt) return at - bt;",
    to: "  if (at !== bt) return bt - at;",
    test: "test/core-logic.test.ts",
    red: "状态机：挤掉的是最老的那条（按结束时刻）",
    why: "挤掉的是最新的，取证价值最高的先没",
  },
  {
    feature: "同刻按编号定序",
    file: "src/core/registry.ts",
    from: "  return a.id < b.id ? -1 : 1;",
    to: "  return a.id < b.id ? -1 : 0;",
    test: "test/core-logic.test.ts",
    red: "状态机：比较器同刻按编号双向定序（大 id 必须返回正数）",
    why: "同刻时排序退化成插入顺序，最老的那条选错",
  },

  // ── 看护 ────────────────────────────────────────────────────────────────
  {
    feature: "卡住要两条同时成立（有在飞工具就不算）",
    file: "src/core/activity.ts",
    from: "    if (this.#toolOpen > 0) return false;",
    to: "    if (false) return false;",
    test: "test/child.test.ts",
    red: "卡住：有在飞的工具调用 ⇒ 不卡住（正在等慢工具）",
    why: "跑长工具的子代理被误杀",
  },
  {
    feature: "卡住阈值边界：等于就算",
    file: "src/core/activity.ts",
    from: "    return now - this.#lastActivityAt >= thresholdMs;",
    to: "    return now - this.#lastActivityAt > thresholdMs;",
    test: "test/child.test.ts",
    red: "卡住：阈值边界——正好等于阈值算卡住，超过才算",
    why: "边界上永远差一毫秒，卡死的收不掉",
  },

  // ── 收件 ────────────────────────────────────────────────────────────────
  {
    feature: "正文取最后一段",
    file: "src/core/child.ts",
    from: "  acc.text = parts",
    to: "  acc.text ||= parts",
    test: "test/child.test.ts",
    red: "收件：多条 assistant 消息时「最后一段胜出」",
    why: "交付物变成第一段中间过程",
  },
  {
    feature: "报告三档优先（structuredContent 最优先）",
    file: "src/core/child.ts",
    from: "  const candidate = (message.structuredContent ??",
    to: "  const candidate = (undefined ??",
    test: "test/child.test.ts",
    red: "收件：报告通道优先级——structuredContent > details.report > details",
    why: "报告取到低优先级的形状",
  },
  {
    feature: "路径只取 args.path",
    file: "src/core/child.ts",
    from: '  if (typeof path !== "string" || !path) return;',
    to: "  if (!path) return;",
    test: "test/child.test.ts",
    red: "收件：args 不是对象或 path 不是字符串时不记路径",
    why: "收据里混进非路径值",
  },
  {
    feature: "stderr 只留尾",
    file: "src/core/child.ts",
    from: "    stderr = (stderr + String(chunk)).slice(-STDERR_KEEP_CHARS);",
    to: "    stderr = (stderr + String(chunk)).slice(0, STDERR_KEEP_CHARS);",
    test: "test/child.test.ts",
    red: "stderr 上限：只留尾巴（前面的丢掉）",
    why: "留了头，真正的错因在尾巴被截掉",
  },
  {
    feature: "起不来只报失败，不崩",
    file: "src/core/child.ts",
    from: "    settle(-1);",
    to: "    settle(0);",
    test: "test/child.test.ts",
    red: "真起进程：起一个不存在的命令 ⇒ 报失败，不抛异常",
    why: "起不来记成成功，父方等一个不存在的交付",
  },

  // ── 留痕 ────────────────────────────────────────────────────────────────
  {
    feature: "桶名编码照抄 pi",
    file: "src/core/storage.ts",
    from: '  return `--${projectRoot.replace(/^\\//, "").replace(/[\\\\/:\\s]+/g, "-")}--`;',
    to: '  return `--${projectRoot.replace(/^\\//, "").replace(/[\\\\/:]+/g, "-")}--`;',
    test: "test/storage.test.ts",
    red: "桶名编码：分隔符全换 -",
    why: "含空格的路径与 pi 的会话目录对不上",
  },
  {
    feature: "编号里的 / \\ .. 要拒",
    file: "src/core/storage.ts",
    from: '  if (taskId.includes("/") || taskId.includes("\\\\") || taskId.includes("..")) return false;',
    to: '  if (taskId.includes("/")) return false;',
    test: "test/storage.test.ts",
    red: "编号安全：斜杠、反斜杠、两个点都拒",
    why: "路径穿越，写到桶外",
  },
  {
    feature: "坏记录不拖垮启动",
    file: "src/core/storage.ts",
    from: "      } catch {\n        // 单条坏记录不拖垮启动\n        this.#skippedRecords += 1;\n      }",
    to: "      } catch (error) {\n        throw new Error(`bad record kills startup: ${String(error)}`);\n      }",
    test: "test/storage.test.ts",
    red: "记录：坏文件不拖垮启动，跳过继续",
    why: "一条坏记录让整个会话起不来",
    redKeyword: "bad record kills startup",
  },
  {
    feature: "恢复：只读普通文件（FIFO / 超大文件跳过）",
    file: "src/core/storage.ts",
    from: "    if (!info.isFile() || info.size > maxBytes) return undefined;",
    to: "    if (false) return undefined;",
    test: "test/storage.test.ts",
    red: "记录：恢复时 FIFO / 超大文件 / 文件名与 id 对不上的都跳过，不阻塞启动",
    why: "孩子放一个 FIFO 叫 x.json，下次启动 #ready 永不落定，该项目所有派发永久挂住",
  },
  {
    feature: "恢复：文件名必须等于记录 id",
    file: "src/core/storage.ts",
    from: "        if (isRestorableRecord(record) && file === `${record.id}.json`) records.push(record);",
    to: "        if (isRestorableRecord(record)) records.push(record);",
    test: "test/storage.test.ts",
    red: "记录：恢复时 FIFO / 超大文件 / 文件名与 id 对不上的都跳过，不阻塞启动",
    why: 'evil.json 写 {"id":"other"} 就冒充别人的记录进账',
  },
  {
    feature: "空产出是空串，不是没产出",
    file: "src/core/engine.ts",
    from: "this.#storage?.readOutput(taskId) ?? this.#storage?.readArchivedOutput(taskId),",
    to: "this.#storage?.readOutput(taskId) || this.#storage?.readArchivedOutput(taskId),",
    test: "test/engine.test.ts",
    red: "引擎：产出是空串时 readOutput 返回空串（不落归档）",
    why: "空产出被当成没落盘——父方拿到 undefined，报「还没落盘：任务未结束或编号不存在」",
  },
  {
    feature: "挤掉即归档",
    file: "src/core/engine.ts",
    from: "      setImmediate(() => this.#storage!.archiveOne(record));",
    to: "      void record;",
    test: "test/engine.test.ts",
    red: "引擎：运行时挤掉的记录要归档（不是只从内存删）",
    why: "磁盘只增不减",
  },
  {
    feature: "TTL 按文件 mtime 判",
    file: "src/core/storage.ts",
    from: "        if (now - statSync(join(this.#paths.archiveDir, file)).mtimeMs > ttlMs) {",
    to: "        if (false) {",
    test: "test/storage.test.ts",
    red: "TTL：按 mtime 判，过期清掉，没过期留下",
    why: "归档永不清理",
  },
  {
    feature: "ps 输出锁 locale",
    file: "src/core/storage.ts",
    from: '  return { ...process.env, LC_ALL: "C" };',
    to: "  return process.env;",
    test: "test/storage.test.ts",
    red: "locale：ps 子进程的环境锁 LC_ALL=C（任何平台都钉得住）",
    why: "中文环境下启动时刻解析失败，活着的会话被标失联",
  },
  {
    feature: "主方活着就不装（避免假停）",
    file: "src/core/engine.ts",
    from: "        if (ownerStart !== undefined && ownerStart === record.ownerStartMs) continue;",
    to: "        if (false) continue;",
    test: "test/engine.test.ts",
    red: "引擎：重启恢复——owner 活着（自己）的在飞任务不标 lost",
    why: "别的会话在飞的任务被标失联",
  },
  {
    feature: "不存在的 pid 判死",
    file: "src/core/storage.ts",
    from: '    return (error as NodeJS.ErrnoException).code === "EPERM";',
    to: "    return true;",
    test: "test/storage.test.ts",
    red: "进程存活：不存在的 pid 是死的",
    why: "死掉的进程被当成活着，孤儿任务永远不回收",
  },

  // ── 适配 ────────────────────────────────────────────────────────────────
  {
    feature: "宽档开 allowScripts 也带上 codemode",
    file: "src/core/child.ts",
    from: '  if (options.allowScripts) argv.push("-e", "builtin:codemode");',
    to: "  void options.allowScripts;",
    test: "test/child.test.ts",
    red: "拼命令：allowScripts 在宽档不收窄（不能把 bash/edit/write 砍掉）",
    why: "子代理看不见 codemode，写了脚本也调不到",
  },
  {
    feature: "只读档 + allowScripts：名单里带上 codemode",
    file: "src/core/child.ts",
    from: '    ...(options.allowScripts ? ["codemode"] : []),',
    to: "    ...([] as string[]),",
    test: "test/child.test.ts",
    red: "拼命令：allowScripts + strict 时工具表是读集 + codemode",
    why: "能力带进来了却被名单砍掉",
  },
  {
    feature: "一次性宿主等到终态才返回",
    file: "src/core/engine.ts",
    from: "      const finalRecord = await this.#awaitTerminal(taskId);",
    to: "      const finalRecord = this.#registry.get(taskId)!;",
    test: "test/engine.test.ts",
    red: "引擎：一次性模式等到终态才返回",
    why: "一次性宿主拿到未完成的记录，交付物是空的",
  },
  {
    feature: "座位 0 时一次性派发退回，不挂住",
    file: "src/core/engine.ts",
    from: '    if (this.#hostMode === "one-shot" && this.#claimed.size === 0 && !this.#canStart()) {',
    to: "    if (false) {",
    test: "test/engine.test.ts",
    red: "引擎：座位 0 时一次性派发要退回，不能挂住",
    why: "机器太挤时用户对话直接卡死",
  },
  {
    feature: "重开会话时清理旧的 handler",
    file: "src/index.ts",
    from: "    cleanup?.();",
    to: "    void cleanup;",
    test: "test/adapter.test.ts",
    red: "适配层：session_start 触发两次后，turn_end 只剩 1 个 handler",
    why: "/new 或 resume 后 handler 累积、旧引擎没人收",
  },
  {
    feature: "stop 的理由有长度上限（截断不拒）",
    file: "src/index.ts",
    from: "      const reason = raw.length > MAX_STOP_REASON_CHARS ? raw.slice(0, MAX_STOP_REASON_CHARS) : raw;",
    to: "      const reason = raw;",
    test: "test/adapter.test.ts",
    red: "适配层：stop 的理由超长要截断（不随 dispatch_list 反复重发）",
    why: "十万字的 stopReason 每轮随 dispatch_list 全量重发，父方上下文被一句话吃掉",
  },
  {
    feature: "allowScripts 缺省用会话默认值",
    file: "src/core/engine.ts",
    from: "    const allowScripts = rawInput.allowScripts ?? this.#allowScriptsDefault();",
    to: "    const allowScripts = rawInput.allowScripts ?? false;",
    test: "test/engine.test.ts",
    red: "引擎：allowScripts 缺省用会话默认值",
    why: "会话默认开着却用不上",
  },
  {
    feature: "allowScripts 默认值不是 boolean 要退回",
    file: "src/core/engine.ts",
    from: '    if (typeof allowScripts !== "boolean") {',
    to: "    if (false) {",
    test: "test/engine.test.ts",
    red: "引擎：allowScripts 会话默认值不是布尔 ⇒ 退回（不把 truthy 当开）",
    why: 'provider 返回 "yes" 时 truthy 开 codemode——「不许写脚本」被悄悄变成「能写脚本」',
  },

  // ── 验收判断（判断写错也要能抓住） ──────────────────────────────────────
  {
    feature: "判断·派发：成了且有正文才算数",
    file: "scripts/verdicts.ts",
    from: '    ok: record?.status === "succeeded" && chars > 0,',
    to: "    ok: Boolean(record),",
    test: "test/verdicts.test.ts",
    red: "判断·派发：failed ⇒ 红（哪怕输出里有数字）",
    why: "失败也判绿，验收形同虚设",
  },
  {
    feature: "判断·allowScripts：看工具声明",
    file: "scripts/verdicts.ts",
    from: '  const declared = parseChildStream(childLog).declaredTools.includes("codemode");',
    to: "  const declared = childLog.length > 0;",
    test: "test/verdicts.test.ts",
    red: "判断·allowScripts：声明里没有 codemode ⇒ 红",
    why: "有没有 codemode 都判绿",
  },
  {
    feature: "判断·退回：桶里必须空",
    file: "scripts/verdicts.ts",
    from: "  return { ok: records.length === 0, detail: `记录数=${records.length}` };",
    to: "  return { ok: true, detail: `记录数=${records.length}` };",
    test: "test/verdicts.test.ts",
    red: "判断·退回：桶里有记录 ⇒ 红",
    why: "退回了却留下记录也判绿",
  },
  {
    feature: "判断·事件流：能解析出工具调用",
    file: "scripts/verdicts.ts",
    from: "  const tools = Object.keys(parseChildStream(stdout).delivery.tools);",
    to: '  const tools = ["x"];',
    test: "test/verdicts.test.ts",
    red: "判断·事件流：没有任何事件 ⇒ 红",
    why: "空流也判绿",
  },
  {
    feature: "判断·rpc：往返与通知都在",
    file: "scripts/verdicts.ts",
    from: "    ok: sawToolEnd && sawNotification,",
    to: "    ok: sawToolEnd || sawNotification,",
    test: "test/verdicts.test.ts",
    red: "判断·rpc：通知没到 ⇒ 红",
    why: "通知丢了也判绿",
  },

  // ── 资源池与交付核对 ────────────────────────────────────────────────────
  {
    feature: "机器规格只读一次",
    file: "src/core/engine.ts",
    from: "    return canOpenAnother(this.#machine.readAvailable(), this.#claimed.size, this.#spec);",
    to: "    return canOpenAnother(this.#machine.readAvailable(), this.#claimed.size, this.#machine.readSpec());",
    test: "test/engine.test.ts",
    red: "引擎：机器规格只在启动时读一次，之后判座位不重读",
    why: "每次判座位都重读总内存/核数（macOS 上每次两个 sysctl 进程）",
  },
  {
    feature: "可用内存每次重读",
    file: "src/core/engine.ts",
    from: "    return canOpenAnother(this.#machine.readAvailable(), this.#claimed.size, this.#spec);",
    to: "    return canOpenAnother(5 * 1024 * 1024 * 1024, this.#claimed.size, this.#spec);",
    test: "test/engine.test.ts",
    red: "引擎：此刻可用每次判座位都重读（波动的读数不许缓存）",
    why: "池子按固定值算，机器变挤了也不收紧",
  },
  {
    feature: "显式 undefined 落回默认（只丢 undefined）",
    file: "src/core/engine.ts",
    from: "    Object.entries(source).filter(([, value]) => value !== undefined),",
    to: "    Object.entries(source).filter(([, value]) => value === undefined),",
    test: "test/engine-defined-only.test.ts",
    red: "引擎：definedOnly 放行非 undefined 的注入（显式 undefined 才落回默认）",
    why: "反向变异把非 undefined 的注入全滤掉：注入的 machineReader 被丢，引擎改用系统读数；而显式 undefined 被当场保留，读机器时 TypeError",
  },
  {
    feature: "交付核对·双向后缀",
    file: "src/core/child.ts",
    from: "  return claim === path || path.endsWith(`/${claim}`) || claim.endsWith(`/${path}`);",
    to: "  return claim === path || path.endsWith(`/${claim}`);",
    test: "test/child.test.ts",
    red: "交付核对：相对路径与绝对路径双向互认",
    why: "自述是相对路径、收据是绝对路径时误报「没有实测支撑」",
  },
  {
    feature: "交付核对·分隔符对齐",
    file: "src/core/child.ts",
    from: "  return claim === path || path.endsWith(`/${claim}`) || claim.endsWith(`/${path}`);",
    to: "  return claim === path || path.endsWith(claim) || claim.endsWith(path);",
    test: "test/child.test.ts",
    red: "交付核对：按分隔符对齐——a.ts 不能命中 xa.ts",
    why: "a.ts 命中 xa.ts，编造的文件名被当成有实测支撑",
  },
  {
    feature: "交付核对·判定",
    file: "src/core/child.ts",
    from: "  return !claims.some((claim) => delivery.paths.some((path) => pathMatches(claim, path)));",
    to: "  return false;",
    test: "test/child.test.ts",
    red: "交付核对：一个都对不上才报没有实测支撑",
    why: "自述的文件收据里一个都没有，也不报",
  },
  {
    feature: "交付核对·结果透传",
    file: "src/core/engine.ts",
    from: "      unverified,",
    to: "      unverified: false,",
    test: "test/engine.test.ts",
    red: "引擎：自述改了文件、收据一个都对不上 ⇒ 结果带 deliveryUnverified",
    why: "判定算出来了，但结果里永远不出现",
  },
  {
    feature: "工具通道的报告也规范化",
    file: "src/core/child.ts",
    from: `  if (candidate && typeof candidate.summary === "string") {
    acc.toolReport = normalizeReport(candidate);`,
    to: `  if (candidate && typeof candidate.summary === "string") {
    acc.toolReport = candidate;`,
    test: "test/child.test.ts",
    red: "收件：工具通道的报告也过规范化——files_touched 非数组要滤掉",
    why: "孩子从工具通道塞非数组的 files_touched，交付核对会崩",
  },

  // ── 通知：未核实标记 ────────────────────────────────────────────────────
  {
    feature: "通知带上未核实标记",
    file: "src/core/notifications.ts",
    from: "        ...(next.deliveryUnverified ? { deliveryUnverified: true } : {}),",
    to: "        ...({}),",
    test: "test/engine.test.ts",
    red: "通知：未核实的交付带标记，已验证的不带",
    why: "rpc 父方只收到状态，看不出报告没有实测支撑",
  },
  {
    feature: "通知标记不许恒真",
    file: "src/core/notifications.ts",
    from: "        ...(next.deliveryUnverified ? { deliveryUnverified: true } : {}),",
    to: "        ...({ deliveryUnverified: true }),",
    test: "test/engine.test.ts",
    red: "通知：未核实的交付带标记，已验证的不带",
    why: "所有任务都被标成没有实测支撑，父方学会忽略这个标记",
  },
  {
    feature: "通知文本写出未核实",
    file: "src/index.ts",
    from: '          n.deliveryUnverified ? "｜报告里的改动没有实测支撑（查 dispatch_list 复核）" : "",',
    to: '          "",',
    test: "test/adapter.test.ts",
    red: "deliver：未核实的交付在通知里写出警告",
    why: "标记随通知到了，但父方看不见",
  },
  {
    feature: "通知警告不许恒显",
    file: "src/index.ts",
    from: '          n.deliveryUnverified ? "｜报告里的改动没有实测支撑（查 dispatch_list 复核）" : "",',
    to: '          "｜报告里的改动没有实测支撑（查 dispatch_list 复核）",',
    test: "test/adapter.test.ts",
    red: "deliver：把待投递的通知发成一条 custom 消息（编号前缀 + 状态）",
    why: "每条完成通知都带警告，标注本身失去意义",
  },
  // ── verified × commands 对质 ────────────────────────────────────────────
  {
    feature: "收据记 bash 命令",
    file: "src/core/child.ts",
    from: "    recordPath(name, event.args, acc);\n    recordCommand(name, event.args, acc);",
    to: "    recordPath(name, event.args, acc);",
    test: "test/child.test.ts",
    red: "收件：bash 命令进收据（真机样本）",
    why: "收据不记命令，对质永远无米下锅",
  },
  {
    feature: "verified 回执规范化",
    file: "src/core/child.ts",
    from: '          .filter((v) => typeof v?.command === "string")',
    to: "          .filter(() => true)",
    test: "test/child.test.ts",
    red: "报告：verified 透传并过滤——command 非字符串的项丢掉",
    why: "脏 verified 进报告，对质拿非字符串崩或误标",
  },
  {
    feature: "自检对质判定",
    file: "src/core/child.ts",
    from: "  return !claims.some((claim) =>\n    commandSegments(claim.command).some((claimSeg) =>\n      delivery.commands.some((command) =>\n        commandSegments(command).some((observedSeg) => segmentsMatch(claimSeg, observedSeg)),\n      ),\n    ),\n  );",
    to: "  return false;",
    test: "test/child.test.ts",
    red: "自检对质：声称了但一条都没观测到 ⇒ 标",
    why: "对质永远说「已验证」，标记失去意义",
  },
  {
    feature: "提到命令不算跑过",
    file: "src/core/child.ts",
    from: "  return !claims.some((claim) =>\n    commandSegments(claim.command).some((claimSeg) =>\n      delivery.commands.some((command) =>\n        commandSegments(command).some((observedSeg) => segmentsMatch(claimSeg, observedSeg)),\n      ),\n    ),\n  );",
    to: "  return !claims.some((claim) =>\n    delivery.commands.some((observed) => observed.includes(claim.command)),\n  );",
    test: "test/child.test.ts",
    red: "自检对质：提到命令不算跑过——echo 不提行",
    why: "退回到 substring——echo/grep 里提到命令就算跑过（逃逸口复现）",
  },
  {
    feature: "对质结果透传",
    file: "src/core/engine.ts",
    from: "      verifyUnverified: verifyFailed,",
    to: "      verifyUnverified: false,",
    test: "test/engine.test.ts",
    red: "引擎：谎报自检（声称跑了命令、收据没有）⇒ 结果带 verifyUnverified",
    why: "判定算出来了，结果里永远不出现",
  },
  {
    feature: "谎报失去小窗资格",
    file: "src/core/child.ts",
    from: "    record.verifyUnverified ||",
    to: "    false ||",
    test: "test/child.test.ts",
    red: "交付判词：五档全钉住",
    why: "谎报自检仍判 verified，于是一路吃到 8KB 小窗信任档",
  },
  {
    feature: "转向：attach-steer 不许把 seen 降回 sent",
    file: "src/core/registry.ts",
    from: "      previous && STEER_ORDER[previous.state] > STEER_ORDER[steer.state]",
    to: "      false",
    test: "test/core-logic.test.ts",
    red: "状态机：attach-steer 迟到的 sent 不许把 seen 降级",
    why: "迟到的运行中写入会把已送达收据降级，通知与列表失真",
  },
  {
    feature: "转向：混合状态计数",
    file: "src/core/steer.ts",
    from: "      seen += 1;",
    to: "      seen += 0;",
    test: "test/steer.test.ts",
    red: "转向：混合状态计数——seen/delivered 算送达，其余算未送达",
    why: "通知里的送达/未送达计数会错",
  },
  {
    feature: "转向：受理计划拒绝非字符串",
    file: "src/core/steer.ts",
    from: '  if (typeof input.text !== "string") return { ok: false, error: "steer message must be a string" };',
    to: '  if (typeof input.text !== "string") return { ok: true, seq: 1, text: "" };',
    test: "test/steer.test.ts",
    red: "转向：受理计划只认 running、4096/4097 边界、16 条与续号",
    why: "非字符串会崩在 trim()，不是可预期拒绝",
  },
  {
    feature: "转向：seq 必须是安全整数",
    file: "src/core/steer.ts",
    from: '    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= afterSeq || seq <= 0)',
    to: '    if (typeof seq !== "number" || !Number.isInteger(seq) || seq <= afterSeq || seq <= 0)',
    test: "test/steer.test.ts",
    red: "转向：非安全整数 seq / 超长正文不解析",
    why: "1e21 进 Map 后会把后续 seq 推到不可预期的数",
  },
  {
    feature: "黑板：关板后拒绝写入",
    file: "src/core/blackboard.ts",
    from: "    if (this.ownerInfo(this.#boardId)?.closedAt !== undefined)",
    to: "    if (false)",
    test: "test/blackboard.test.ts",
    red: "黑板：关板后写入被拒，读取仍可看证据",
    why: "关板只写 closedAt，写侧不查就能继续往已结束的会话里塞话",
  },
  {
    feature: "转向：seq 到安全整数上限后拒绝",
    file: "src/core/steer.ts",
    from: "  if (last && last.seq >= Number.MAX_SAFE_INTEGER)",
    to: "  if (false)",
    test: "test/steer.test.ts",
    red: "转向：受理计划只认 running、4096/4097 边界、16 条与续号",
    why: "MAX_SAFE_INTEGER+1 会写出不可解析的 seq，后续转向全部失真",
  },
  {
    feature: "转向：半行后追加要另起一行",
    file: "src/core/storage.ts",
    from: "    const needsNewline = existsSync(path) && statSync(path).size > 0 && !endsWithNewline(path);",
    to: "    const needsNewline = false;",
    test: "test/engine.test.ts",
    red: "转向：信箱末尾半行时，新转向另起一行仍可解析",
    why: "半行会把下一条 JSON 粘进坏行，parseSteerLines 整条丢弃",
  },
  {
    feature: "转向：信箱读取限长",
    file: "src/core/storage.ts",
    from: "    if (info.size > MAX_STEER_INBOX_BYTES) {",
    to: "    if (false) {",
    test: "test/engine.test.ts",
    red: "转向：信箱不可读或超限时返回错误，不把父方带崩",
    why: "孩子可写的文件无上限，父方 readFileSync 会吃满内存",
  },
  {
    feature: "转向：证据在流式阶段累计，不靠末尾 16MB",
    file: "src/core/engine.ts",
    from: "      evidence.push(chunk);",
    to: "      void 0;",
    test: "test/engine.test.ts",
    red: "转向：17MB 输出砍头后，头部证据仍把 sent 对成 seen",
    why: "砍头后早段证据丢失，已送达会被误报 undelivered",
  },
  {
    feature: "转向：过期报告失去小窗资格",
    file: "src/core/child.ts",
    from: "    record.reportStale",
    to: "    false",
    test: "test/child.test.ts",
    red: "交付判词：五档全钉住",
    why: "stale 报告仍判 verified，父方会把旧结论当新结论",
  },
  {
    feature: "正好装得下不插省略标记",
    file: "src/index.ts",
    from: "  if (result.text.length <= budget.head + budget.tail) return result;",
    to: "  if (result.text.length < budget.head + budget.tail) return result;",
    test: "test/adapter.test.ts",
    red: "归约：恰好等于窗口预算 ⇒ 原样过（不插 0 字符省略标记）",
    why: "恰好等于预算的正文被当成要截——塞进「省略 0 字符」标记，交付物平白变形",
  },
  {
    feature: "通知带谎报标记",
    file: "src/core/notifications.ts",
    from: "        ...(next.verifyUnverified ? { verifyUnverified: true } : {}),",
    to: "        ...({}),",
    test: "test/adapter.test.ts",
    red: "deliver：谎报自检在通知里写出警告",
    why: "标记到不了通知，rpc 父方看不见谎报",
  },
  // ── 回执 tool 通道 ──────────────────────────────────────────────────────
  {
    feature: "孩子进程只注册回执工具",
    file: "src/index.ts",
    from: `    if (parseDepth(process.env.PI_DISPATCH_DEPTH) > 0) {
      registerChildReportTool(pi);
      registerBlackboardTools(pi);
      offSteerInbox?.();`,
    to: `    if (parseDepth(process.env.PI_DISPATCH_DEPTH) > 0) {
      registerBlackboardTools(pi);
      offSteerInbox?.();`,
    test: "test/adapter.test.ts",
    red: "适配层：子代理进程（depth>0）只注册 child_report",
    why: "孩子拿不到回执工具，tool 通道永远不可达",
  },
  {
    feature: "回执扩展要装进孩子（-e）",
    file: "src/core/child.ts",
    from: '  if (options.childExtensionPath) argv.push("-e", options.childExtensionPath);',
    to: '  if (false) argv.push("-e", options.childExtensionPath);',
    test: "test/child.test.ts",
    red: "拼命令：孩子装自己的回执扩展（-e <path>）",
    why: "孩子进程没装扩展，回执工具不存在，只能退回 prompt",
  },
  {
    feature: "strict 档也要留回执工具",
    file: "src/core/child.ts",
    from: `    ...READ_ONLY_TOOLS,
    CHILD_REPORT_TOOL_NAME,`,
    to: `    ...READ_ONLY_TOOLS,`,
    test: "test/child.test.ts",
    red: "拼命令：strict 档白名单也留 child_report",
    why: "只读档的孩子被白名单砍掉回执工具，strict 下 tool 通道不可达",
  },
  {
    feature: "正文只从 assistant 分派",
    file: "src/core/child.ts",
    from: '    if (event.message.role === "assistant") {',
    to: "    if (false) {",
    test: "test/child.test.ts",
    red: "收件：工具结果的文本不覆盖正文",
    why: "回执文本会变成交付物（超时或空收尾时最明显）",
  },
  {
    feature: "报告通道 tool 优先，prompt 兜底",
    file: "src/core/engine.ts",
    from: `    if (report) {
      channel = "tool";`,
    to: `    if (false) {
      channel = "tool";`,
    test: "test/engine.test.ts",
    red: "引擎：报告通道 tool > prompt-json > none",
    why: "有工具回执却标成 prompt-json/none，降级对父方不可见",
  },
  {
    feature: "回执经 details.report 交回",
    file: "src/index.ts",
    from: "      details: { report: args },",
    to: "      details: {},",
    test: "test/adapter.test.ts",
    red: "适配层：child_report 工具把报告放进 details.report",
    why: "父方从 toolResult 里读不到报告，tool 通道等于没接上",
  },
  {
    feature: "契约里的工具名不能漂",
    file: "src/core/child.ts",
    from: "  `Before finishing, deliver a child report — preferably by calling the ${CHILD_REPORT_TOOL_NAME} tool",
    to: "  `Before finishing, deliver a child report — preferably by calling the child_reportX tool",
    test: "test/child.test.ts",
    red: "拼命令：契约块里的工具名与常量一致",
    why: "契约里写错工具名 ⇒ 孩子去调不存在的工具，静默退回 prompt 通道",
  },
  {
    feature: "契约反话钉不能松",
    file: "src/core/child.ts",
    from: "If it is uniformly positive, the parent treats the whole report as not delivered.",
    to: "If it is positive throughout, the parent accepts it.",
    test: "test/child.test.ts",
    red: "报告契约：三段分工 + 反话钉 + why 条件句",
    why: "古德哈特钉被拔掉 ⇒ 全正面自评又算数",
  },
  {
    feature: "why 条件句不能丢",
    file: "src/core/child.ts",
    from: "if your instructions contained a <pi-dispatch-why> block, take it as input",
    to: "if your instructions contained a <pi-dispatch-why> block, ignore it",
    test: "test/child.test.ts",
    red: "报告契约：三段分工 + 反话钉 + why 条件句",
    why: "why 开关两世界的覆盖句没了，关缝隙下孩子的 why 失去校准指令",
  },
  {
    feature: "schema 三段必填",
    file: "src/core/child.ts",
    from: '  required: ["summary", "why", "assessment"],',
    to: '  required: ["summary"],',
    test: "test/child.test.ts",
    red: "报告 schema：三段必填",
    why: "缺段报告被工具校验放行，三段式名存实亡",
  },
  {
    feature: "报告散文段 2KB 截断",
    file: "src/core/child.ts",
    from: "    summary: clipReportProse(parsed.summary),",
    to: "    summary: parsed.summary,",
    test: "test/child.test.ts",
    red: "收件：报告散文段超 2KB 截断，缺的 why/assessment 归一化为空串",
    why: "report 不再是限字摘要，「有回执优先小窗」的前提塌了",
  },
  {
    feature: "vacuous 信号词判定",
    file: "src/core/child.ts",
    from: "  return !ASSESSMENT_SIGNALS.some((signal) => text.includes(signal));",
    to: "  return false;",
    test: "test/child.test.ts",
    red: "vacuous：缺/短/全正面 ⇒ 空转；有具体风险 ⇒ 不空转",
    why: "全正面报告不再视为空转，小窗资格粗筛失效",
  },
  {
    feature: "空转回执进不了 verified",
    file: "src/core/child.ts",
    from: "    record.assessmentVacuous ||",
    to: "    false ||",
    test: "test/child.test.ts",
    red: "交付判词：五档全钉住",
    why: "空转回执仍判 verified，三要件门被短路",
  },
  {
    feature: "锚失配必须拒绝",
    file: "src/index.ts",
    from: "    if (fresh !== m[2])",
    to: "    if (false)",
    test: "test/adapter.test.ts",
    red: "anchoredRead：around 命中给窗口，失配拒绝并回鲜锚",
    why: "锚失配照读，stale 拒绝失效，模型可能引错行",
  },
  {
    feature: "dispatch_read 必须散文化",
    file: "src/index.ts",
    from: "      const prose = parseChildStream(raw).text || raw;",
    to: "      const prose = raw;",
    test: "test/adapter.test.ts",
    red: "适配层：dispatch_read 把原始 JSONL 散文化并带行锚",
    why: "模型读到原始 JSONL 事件流，比正文还大还全是噪音",
  },
  {
    feature: "toHostMode 的 tui 分支",
    file: "src/index.ts",
    from: '  if (mode === "rpc" || mode === "tui") return "long-lived";',
    to: '  if (mode === "rpc") return "long-lived";',
    test: "test/adapter.test.ts",
    red: "toHostMode：rpc/tui 长驻，print/json 一次性",
    why: "tui 宿主被当成一次性 ⇒ 派发被挂住等终态",
  },
  {
    feature: "textResult 的 0 不能变 null",
    file: "src/index.ts",
    from: "JSON.stringify(value ?? null, null, 2)",
    to: "JSON.stringify(value || null, null, 2)",
    test: "test/adapter.test.ts",
    red: "textResult：0 是有效值（不是 null）",
    why: "0/false/空串被当成 null，调用方读到错的值",
  },
  {
    feature: "通知要 display",
    file: "src/index.ts",
    from: "content: text, display: true },",
    to: "content: text, display: false },",
    test: "test/adapter.test.ts",
    red: "deliver：通知带 display=true",
    why: "通知被 pi 折叠掉，父方看不到终态",
  },
  {
    feature: "停不存在的任务不崩",
    file: "src/index.ts",
    from: "        status: current().registry.get(a.taskId)?.status,",
    to: "        status: current().registry.get(a.taskId).status,",
    test: "test/adapter.test.ts",
    red: "适配层：停不存在的任务不崩（status 是 undefined）",
    why: "停一个没记录的编号就抛 TypeError，父方工具直接崩",
  },
  {
    feature: "空理由当没给",
    file: "src/index.ts",
    from: '      const raw = typeof a.reason === "string" && a.reason.trim() !== "" ? a.reason : "user stop";',
    to: '      const raw = typeof a.reason === "string" ? a.reason : "user stop";',
    test: "test/adapter.test.ts",
    red: "适配层：理由是空串当没给（回落 user stop）",
    why: "空串是坏值却当有效理由记进停止原因",
  },
  {
    feature: "信号杀死的孩子退出码按 POSIX 记 128+signo",
    file: "src/core/child.ts",
    from: "exitCode = code ?? (signo !== undefined ? 128 + signo : -1);",
    to: "exitCode = code ?? -1;",
    test: "test/child.test.ts",
    red: "真起进程：SIGKILL 的孩子退出码按 POSIX 记 137",
    why: "信号杀死退回一律 -1，137/143/1 又混为一谈",
  },
  {
    feature: "非零退出死因写进 errorMessage",
    file: "src/core/registry.ts",
    from: "...(command.exitCode !== 0 && command.detail ? { stopReason: command.detail } : {}),",
    to: "...({} as Record<string, never>),",
    test: "test/engine.test.ts",
    red: "引擎：孩子自己非零退出，errorMessage 带退出码而不是单词 failed",
    why: "死因不进 stopReason，errorMessage 退回单词 failed",
  },
  {
    feature: "stderr 末行要拼进死因",
    file: "src/core/engine.ts",
    from: "return clipped ? `exit code ${exitCode} — ${clipped}` : `exit code ${exitCode}`;",
    to: "return `exit code ${exitCode}`;",
    test: "test/engine.test.ts",
    red: "引擎：非零退出把 stderr 末行拼进 errorMessage",
    why: "只剩光杆退出码，401/段错误信息丢失",
  },
  {
    feature: "-1 退出用 stderr 当死因",
    file: "src/core/engine.ts",
    from: 'if (exitCode === -1) return clipped || "exit code -1（信号不明或起不来）";',
    to: 'if (exitCode === -1) return "exit code -1（信号不明或起不来）";',
    test: "test/engine.test.ts",
    red: "引擎：起不来的孩子，errorMessage 直接给 spawn 错误",
    why: "spawn 错误细节丢失，只剩模板句",
  },
  {
    feature: "stderr 末行截断要留全",
    file: "src/core/engine.ts",
    from: "const clipped = lastLine.length > 200 ? `…${lastLine.slice(-200)}` : lastLine;",
    to: "const clipped = lastLine.slice(-1);",
    test: "test/engine.test.ts",
    red: "引擎：非零退出把 stderr 末行拼进 errorMessage",
    why: "死因摘要只剩一个字符，401/段错误信息丢失",
  },
  {
    feature: "用量逐轮累加（不是最后一条）",
    file: "src/core/child.ts",
    from: "    acc.usageTotal = addUsage(acc.usageTotal, usage);",
    to: "    acc.usageTotal = usage;",
    test: "test/child.test.ts",
    red: "收件：多轮用量累加（不是最后一条）",
    why: "只记最后一轮的用量，多轮孩子的账少记一个量级",
  },
  {
    feature: "没交报告账上也有数",
    file: "src/core/engine.ts",
    from: "      usage: record.usage ?? record.report?.usage,",
    to: "      usage: record.report?.usage,",
    test: "test/engine.test.ts",
    red: "引擎：没交报告时用量仍从记录里出来",
    why: "孩子没交报告 ⇒ 用量跟着丢，烧了 token 账上显示零",
  },
  {
    feature: "用量累加后进记录",
    file: "src/core/engine.ts",
    from: "      usage: parsed.observedUsageTotal ?? undefined,",
    to: "      usage: parsed.observedUsage ?? undefined,",
    test: "test/engine.test.ts",
    red: "引擎：用量按轮累加，不是最后一条",
    why: "记录里只存最后一轮的用量，累加值被丢弃",
  },
  {
    feature: "记录里存独立用量字段",
    file: "src/core/registry.ts",
    from: "          usage: command.usage ?? current.usage,",
    to: "",
    test: "test/engine.test.ts",
    red: "引擎：没交报告时用量仍从记录里出来",
    why: "registry 不存用量字段 ⇒ 记录里没有账，父方读不到",
  },
  // ── TUI 常驻面 ────────────────────────────────────────────────────────────
  {
    feature: "TUI 面板只挂本会话的任务",
    file: "src/tui.ts",
    from: "  return record.ownerPid === owner.pid && record.ownerStartMs === owner.startMs;",
    to: "  return true;",
    test: "test/tui.test.ts",
    red: "tui：别家会话的记录不混进来",
    why: "restore 装回的历史记录、别家进程的记录混进面板计数",
  },
  {
    feature: "TUI 面板全跑完即清",
    file: "src/tui.ts",
    from: "  if (active.length + queued.length === 0) return undefined;",
    to: "  if (false) return undefined;",
    test: "test/tui.test.ts",
    red: "tui：全部终态即清",
    why: "任务全终态后面板残留不消，一直占着编辑器上方",
  },
  {
    feature: "TUI 行内带预算到点与档位降级提示",
    file: "src/tui.ts",
    from:
      "    (r) =>\n" +
      "      `#${r.id.slice(0, 8)} ${ACTIVE_TEXT[r.status] ?? r.status} ${snippet(r.task)}${costHint(r)}`,",
    to:
      "    (r) =>\n" +
      "      `#${r.id.slice(0, 8)} ${ACTIVE_TEXT[r.status] ?? r.status} ${snippet(r.task)}`,",
    test: "test/tui.test.ts",
    red: "tui：行内带预算到点与档位降级提示",
    why: "面板上看不出哪一单超了预算、哪一单被降了档——父方只能翻 dispatch_list",
  },
  // ── TUI 人转向 ────────────────────────────────────────────────────────────
  {
    feature: "TUI 转向选项从 1 编号",
    file: "src/tui.ts",
    from: "  return targets.map((record, index) => `${index + 1}) ${steerChoiceLabel(record)}`);",
    to: "  return targets.map((record, index) => `${index - 1}) ${steerChoiceLabel(record)}`);",
    test: "test/tui.test.ts",
    red: "steer：选项从 1 开始编号，标签用 id 前 8 位",
    why: "选项从 0/-1 编号，人按序号选会错位",
  },
  {
    feature: "TUI 转向只看本会话 running",
    file: "src/tui.ts",
    from: '    .filter((record) => isSessionRecord(record, owner) && record.status === "running")',
    to: '    .filter((record) => isSessionRecord(record, owner) && record.status !== "running")',
    test: "test/tui.test.ts",
    red: "steer：只列 running，stopping/queued/终态都不列",
    why: "排队/收队/终态任务也弹出选择，选中后必然 ok:false",
  },
  {
    feature: "TUI 转向单任务跳过选择",
    file: "src/tui.ts",
    from: "  if (targets.length > 1) {",
    to: "  if (targets.length >= 1) {",
    test: "test/tui.test.ts",
    red: "steer：单任务跳过 select，引擎收到完整 id 与原文",
    why: "只有一个在飞任务也要多弹一层选择，且 fake 未配 select 就静默失败",
  },
  {
    feature: "TUI 转向按选项下标回映 id",
    file: "src/tui.ts",
    from: "    const index = options.indexOf(choice);",
    to: "    const index = 0;",
    test: "test/tui.test.ts",
    red: "steer：多任务按 index 回映真实 id，不把 label 当 id",
    why: "选第二个任务却发到第一个，收据还显示成功",
  },
  {
    feature: "TUI 转向 Esc 不发送",
    file: "src/tui.ts",
    from: "    if (choice === undefined) return;",
    to: "    if (false) return;",
    test: "test/tui.test.ts",
    red: "steer：select 取消/未知项不发送",
    why: "Esc 被当成未知选项，弹错误但不发送；测试若只数发送次数会假绿",
  },
  {
    feature: "TUI 转向未知选项不猜 id",
    file: "src/tui.ts",
    from: '    if (index < 0) {\n      deps.ui.notify("选择器返回了未知选项，没发", "error");\n      return;\n    }',
    to: '    if (index < 0) {\n      throw new Error("unknown steer option");\n    }',
    test: "test/tui.test.ts",
    red: "steer：select 取消/未知项不发送",
    redKeyword: "unknown steer option",
    why: "select 返回未知串时 target 变 undefined，抛异常或发错任务",
  },
  {
    feature: "TUI 转向空输入不发送",
    file: "src/tui.ts",
    from: '  if (text === "") {\n    deps.ui.notify("空转向，没发", "warning");',
    to: '  if (false) {\n    deps.ui.notify("空转向，没发", "warning");',
    test: "test/tui.test.ts",
    red: "steer：Esc/空输入不写盘",
    why: "空白输入也调 engine.steer，父方收到一条空转向",
  },
  {
    feature: "TUI 转向无 UI 不执行",
    file: "src/tui.ts",
    from: "  if (!deps.hasUI) return;",
    to: "  if (false) return;",
    test: "test/tui.test.ts",
    red: "steer：hasUI=false 全静默",
    why: "print/json 里命令仍弹窗/写盘，且没有对话面可回显",
  },
  {
    feature: "TUI 转向失败不冒充成功",
    file: "src/tui.ts",
    from: "    if (outcome.ok) {",
    to: "    if (true) {",
    test: "test/tui.test.ts",
    red: "steer：失败回红字原文，不冒充已受理",
    why: "终态/停止中任务返回 ok:false，界面仍说已受理 sent",
  },
  {
    feature: "TUI 转向命令工厂层只注册一次",
    file: "src/index.ts",
    from: "  if (parseDepth(process.env.PI_DISPATCH_DEPTH) === 0) registerSteerCommand(pi, current);",
    to: "  if (false) registerSteerCommand(pi, current);",
    test: "test/adapter.test.ts",
    red: "steer 命令：工厂层只注册一次 /steer",
    why: "TUI 里 /steer 不存在，功能整体不可达",
  },
  {
    feature: "TUI 转向命令 hasUI 早退",
    file: "src/index.ts",
    from: "      if (!ctx.hasUI) return;",
    to: "      if (false) return;",
    test: "test/adapter.test.ts",
    red: "steer 命令：hasUI=false 时静默，不碰引擎",
    why: "print/json 下 current() 抛错被报成「引擎未就绪」，噪声且无意义",
  },
  {
    feature: "TUI 转向只列本会话任务（owner 过滤）",
    file: "src/tui.ts",
    from: '    .filter((record) => isSessionRecord(record, owner) && record.status === "running")',
    to: '    .filter((record) => record.status === "running")',
    test: "test/tui.test.ts",
    red: "steer：别 pid/缺戳/restore 的在飞任务都不列出",
    why: "别家/restore 的 running 也进选择，选中后引擎拒收（别家任务不收本会话的信）",
  },
  {
    feature: "TUI 转向选项按派发时间排序",
    file: "src/tui.ts",
    from: "    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.id.localeCompare(b.id));",
    to: "    .sort((a, b) => 0);",
    test: "test/tui.test.ts",
    red: "steer：多任务按 startedAt 升序给选项，不保留输入序",
    why: "选项顺序随 registry 返回序漂移，人按序号选会选错任务",
  },
  {
    feature: "TUI 转向空 args 才弹输入",
    file: "src/tui.ts",
    from: '  let text = deps.args.trim();\n  if (text === "") {',
    to: "  let text = deps.args.trim();\n  if (false) {",
    test: "test/tui.test.ts",
    red: "steer：单任务跳过 select，引擎收到完整 id 与原文",
    why: "带参数的命令也弹输入；不答就静默丢掉参数，答了就覆盖原文",
  },
  {
    feature: "TUI 转向失败用红字",
    file: "src/tui.ts",
    from: '      deps.ui.notify(outcome.error, "error");',
    to: '      deps.ui.notify(outcome.error, "info");',
    test: "test/tui.test.ts",
    red: "steer：失败回红字原文，不冒充已受理",
    why: "ok:false 的原文被当普通信息，用户读成转向成功",
  },
  {
    feature: "TUI 转向回执照抄 seq",
    file: "src/tui.ts",
    from: " · seq ${outcome.seq} ·",
    to: " · seq 0 ·",
    test: "test/tui.test.ts",
    red: "steer：成功回执只写 sent，不带 path",
    why: "回执序号永远是 0，人核对送达时对不上信箱里的 seq",
  },
  {
    feature: "TUI 转向命令孩子进程不注册",
    file: "src/index.ts",
    from: "  if (parseDepth(process.env.PI_DISPATCH_DEPTH) === 0) registerSteerCommand(pi, current);",
    to: "  if (parseDepth(process.env.PI_DISPATCH_DEPTH) >= 0) registerSteerCommand(pi, current);",
    test: "test/adapter.test.ts",
    red: "steer 命令：depth>0 不注册（孩子进程里连命令都没有）",
    why: "子代理进程也拿到 /steer，孩子之间可以互相插话",
  },
  // ── 门禁自身 ──────────────────────────────────────────────────────────────
  // 这三条守的是「跑门禁的人身上带着什么」：测试进程/子代理的上下文一旦漏进门禁，
  // 门禁会一杀用例都不跑却退出 0（假绿），或者把适配层按子代理装配（红错地方）。
  {
    feature: "测试门禁：擦掉继承来的测试上下文",
    file: "scripts/test-env.ts",
    from: "  for (const key of INHERITED_TEST_CONTEXT) delete env[key];",
    to: "  for (const key of INHERITED_TEST_CONTEXT) void key;",
    test: "test/test-runner.test.ts",
    red: "测试门禁：在测试进程里也真跑用例（不再假绿，退出码照传）",
    why: "在测试进程里起门禁，一条用例不跑但退出 0——门禁全假绿",
  },
  {
    feature: "测试门禁：擦掉派发子代理的深度",
    file: "scripts/test-env.ts",
    from: "  delete env[INHERITED_DISPATCH_DEPTH];",
    to: "  void env[INHERITED_DISPATCH_DEPTH];",
    test: "test/test-runner.test.ts",
    red: "测试门禁：在派发子代理里也擦掉深度（否则适配层按子代理装配）",
    why: "子代理里跑门禁，适配层只装 child_report ⇒ 宿主侧用例全红",
  },
  {
    feature: "测试门禁：旗标透传，缺文件时默认整棵 test/",
    file: "scripts/test.ts",
    from: '  const flags = args.filter((arg) => arg.startsWith("-"));',
    to: "  const flags: string[] = [];",
    test: "test/test-runner.test.ts",
    red: "测试门禁：旗标透传，缺文件时默认整棵 test/",
    why: "--experimental-test-coverage 之类被当文件传给 node --test",
  },
  {
    feature: "测试门禁：经软链调用也真跑",
    file: "scripts/test.ts",
    from: "    return realpathSync(argv1) === realpathSync(self);",
    to: "    return argv1 === self;",
    test: "test/test-runner.test.ts",
    red: "测试门禁：经软链调用也真跑（overlay 把 scripts/ 做成软链）",
    why: "mutator 的 overlay 里 scripts/ 是软链 ⇒ 门禁静默空转退出 0，变异全假活",
  },
  {
    feature: "测试门禁：0 用例不许退出 0",
    file: "scripts/test.ts",
    from: "  if (passed === undefined || passed === 0) {",
    to: "  if (false) {",
    test: "test/test-runner.test.ts",
    red: "测试门禁：0 用例不许退出 0（glob 写错不许假绿）",
    why: "glob/文件路径写错时一条用例都不跑却退出 0：整条门禁的「绿」全是假的",
  },
  {
    feature: "破坏点跑器：也擦掉继承来的测试上下文",
    file: "scripts/breakpoints.ts",
    // 锚点分两段拼：这张表就在同一个文件里，整段写死会连同本条一起匹配到自己
    from: "        env: scrubbedEn" + "v(),\n",
    to: "",
    test: "test/test-runner.test.ts",
    red: "破坏点跑器：子代理环境里也真判红（擦掉继承来的测试上下文）",
    why: "子代理里跑验红，每条都报「原本不是绿的」——验红门禁全瘫",
  },
  {
    feature: "破坏点跑器：失败块只吃到本用例结束",
    file: "scripts/breakpoints.ts",
    from:
      "  const end = lines.findIndex((line, index) => index > start && line.trimEnd() === " +
      '"  ...");',
    to: '  const end = lines.findIndex((line, index) => index > start && line.startsWith("  ...\\n"));',
    test: "test/test-runner.test.ts",
    red: "破坏点跑器：失败块只吃到本用例结束，不吃下一条的 ERR_ASSERTION",
    why: "按 \\n split 后行尾永远没有换行 ⇒ 块吃到 TAP 末尾，下一条的断言失败被算成本条 killed",
  },
  {
    feature: "破坏点跑器：显式关键字 kills 也算红",
    file: "scripts/breakpoints.ts",
    from: "        (bp.redKeyword !== undefined && block.includes(bp." + "redKeyword));",
    to: "        false;",
    test: "test/test-runner.test.ts",
    red: "破坏点跑器：抛错的变异给关键字也算 killed",
    why: "抛错类变异没有断言失败消息，只靠 ERR_ASSERTION 判会全记 wrong-red",
  },
  {
    feature: "破坏点跑器：子进程有超时（挂死拖不死单实例门禁）",
    file: "scripts/breakpoints.ts",
    from: "        timeout: timeout" + "Ms,",
    to: "        timeout: undefined,",
    test: "test/test-runner.test.ts",
    red: "破坏点跑器：子进程超时要放弃（挂死也不拖死门禁）",
    why: "变异触发 FIFO / 死循环时验红器永久挂住：单实例门禁一挂，整条交付线停摆",
  },
  // ── 隔离与黑板地基 ──────────────────────────────────────────────────────
  {
    feature: "isolation 写错值要退回",
    file: "src/core/gates.ts",
    from: '  input.isolation !== undefined && input.isolation !== "worktree"',
    to: "  input.isolation !== undefined && false",
    test: "test/core-logic.test.ts",
    red: "安检 7：isolation 写错值要拒，不 coerce",
    why: "隔离档位写错值时悄悄放行，子代理在共享目录里干活",
  },
  {
    feature: "blackboard 非布尔要退回",
    file: "src/core/gates.ts",
    from: 'typeof input.blackboard !== "boolean"',
    to: "false",
    test: "test/core-logic.test.ts",
    red: "安检 8：blackboard 非 boolean 要拒",
    why: "开关值被猜成布尔，父方的意图被改写",
  },
  {
    feature: "要 worktree 得有 git 仓",
    file: "src/core/gates.ts",
    from: 'input.isolation === "worktree" && !isGitRepo()',
    to: "false",
    test: "test/core-logic.test.ts",
    red: "安检 9：要 worktree 但没有可用 git 仓要拒",
    why: "非 git 目录里也放行隔离，worktree 到运行时才炸",
  },
  {
    feature: "新闸接进默认闸序",
    file: "src/core/gates.ts",
    from: "    isolationGate,",
    to: "    // isolationGate,",
    test: "test/core-logic.test.ts",
    red: "安检 10：默认闸序含隔离/黑板两道值闸",
    why: "闸写好了却没接进默认闸序，隔离值写错也放行",
  },
  {
    feature: "收尾闸与深度闸的次序固定",
    file: "src/core/gates.ts",
    from: "    sessionEndingGate(deps.isEnding),\n    depthGate(deps.depth, deps.maxDepth),",
    to: "    depthGate(deps.depth, deps.maxDepth),\n    sessionEndingGate(deps.isEnding),",
    test: "test/core-logic.test.ts",
    red: "安检 3/4 位置固定（会话收尾在深度之前）",
    why: "会话收尾闸挪到深度闸之后，收尾中还会先问深度——顺序变了，人读的编号与实现脱节",
  },
  {
    feature: "缺省 git 探测按「不是 git 仓」算",
    file: "src/core/gates.ts",
    from: "    worktreeNeedsGit(deps.isGitRepo ?? (() => false)),",
    to: "    worktreeNeedsGit(deps.isGitRepo ?? (() => true)),",
    test: "test/core-logic.test.ts",
    red: "安检 10：默认闸序含隔离/黑板两道值闸",
    why: "缺省配置被当成「是 git 仓」：非 git 目录里开隔离，worktree 到运行时才炸",
  },
  {
    feature: "spawn 第三参 cwd 落到子进程",
    file: "src/core/child.ts",
    from: "...(options?.cwd ? { cwd: options.cwd } : {})",
    to: "...({})",
    test: "test/child.test.ts",
    red: "真起进程：第三参 cwd 落到子进程工作目录",
    why: "隔离开的孩子还在父方目录里干活，改动踩到父方的工作区",
  },
  // ── worktree 隔离 ────────────────────────────────────────────────────────
  {
    feature: "引擎把 worktree 当 cwd",
    file: "src/core/engine.ts",
    from: "return this.#spawn(argv, env, { cwd: worktree.path });",
    to: "return this.#spawn(argv, env);",
    test: "test/engine.test.ts",
    red: "引擎：isolation 的 spawn 收到 cwd=worktree 路径",
    why: "隔离开的孩子还在父方目录里干活，改动踩到父方的工作区",
  },
  {
    feature: "默认关不传 spawn 第三参",
    file: "src/core/engine.ts",
    from: "return this.#spawn(argv, env);",
    to: 'return this.#spawn(argv, env, { cwd: worktree?.path ?? "" });',
    test: "test/engine.test.ts",
    red: "golden：默认关——spawn 无第三参",
    why: "默认关也硬塞一个 cwd——孩子落进一个不存在的目录",
  },
  {
    feature: "受理时钉死 baseCommit",
    file: "src/core/engine.ts",
    from: "baseCommit: probe.headCommit,",
    to: 'baseCommit: "",',
    test: "test/engine.test.ts",
    red: "引擎：受理时钉 base，排队期间 HEAD 前进不漂移",
    why: "base 不钉死——排队期间父仓 HEAD 前进，worktree 建在了别人已经改过的地方",
  },
  {
    feature: "建盘用钉死的 base",
    file: "src/core/worktree.ts",
    from: "args.push(baseCommit);",
    to: 'args.push("HEAD");',
    test: "test/worktree.test.ts",
    red: "worktree：分支建在受理时钉死的 baseCommit 上",
    why: "建在 HEAD 上而不是钉死的 base——排队期间父仓动了，隔离的起点跟着漂",
  },
  {
    feature: "创建失败不降级共享 cwd",
    file: "src/core/engine.ts",
    from: "if (!created.ok) {",
    to: "if (false) {",
    test: "test/engine.test.ts",
    red: "引擎：创建失败 ⇒ failed 且不 spawn（绝不回共享 cwd）",
    why: "建不出来也照样 spawn——孩子在父方的共享目录里改东西",
  },
  {
    feature: "建盘回来先复查是否被叫停",
    file: "src/core/engine.ts",
    from: '      if (this.#teardown || afterPrepare?.status !== "running") {',
    to: "      if (false) {",
    test: "test/engine.test.ts",
    red: "引擎：建盘期间被叫停 ⇒ 不 spawn、started:false、终态 canceled",
    why: "叫停发生在建盘 await 期间——回来照旧 spawn，取消不生效且孩子成孤儿",
  },
  {
    feature: "启动名额只归还一次",
    file: "src/core/engine.ts",
    from:
      '            detail: "等启动名额时被叫停",\n' +
      "          })\n" +
      "          .catch(() => undefined);\n" +
      "        if (r) this.#notifyTerminal(r.record);\n" +
      "        return;",
    to:
      '            detail: "等启动名额时被叫停",\n' +
      "          })\n" +
      "          .catch(() => undefined);\n" +
      "        if (r) this.#notifyTerminal(r.record);\n" +
      "        this.#releaseLaunchSlot();\n" +
      "        return;",
    test: "test/engine.test.ts",
    red: "引擎：叫停等名额的任务只归还一次名额（之后启动仍受节流）",
    why: "叫停分支与 finally 各还一次 ⇒ #starting 变负，启动节流超发",
  },
  {
    feature: "等名额被叫停要落终态",
    file: "src/core/engine.ts",
    from: `        const r = await this.#registry
          .submit({
            kind: "resolve-exit",
            id: taskId,
            exitCode: -1,
            notStarted: true,
            detail: "等启动名额时被叫停",
          })
          .catch(() => undefined);`,
    to: "        const r = undefined;",
    test: "test/engine.test.ts",
    red: "引擎：等启动名额时被叫停 ⇒ 一次性宿主以 canceled 返回，不挂住",
    redKeyword: "dispatch 挂住了",
    why: "叫停分支不 submit resolve-exit ⇒ 记录永远停在 stopping，一次性宿主在 #awaitTerminal 上永久挂住",
  },
  {
    feature: "notStarted 清 startedAt",
    file: "src/core/registry.ts",
    from: "        // 记录里 startedAt 有值必须恒等于「孩子真起过」。\n        ...(command.notStarted ? { startedAt: undefined } : {}),\n        exitCode: command.exitCode,",
    to: "        // 记录里 startedAt 有值必须恒等于「孩子真起过」。\n        ...({}),\n        exitCode: command.exitCode,",
    test: "test/core-logic.test.ts",
    red: "状态机：notStarted 的 resolve-exit ⇒ started:false、duration 0",
    why: "孩子压根没起，记录里却留着 startedAt——账上说它跑过",
  },
  {
    feature: "观测收据落 record",
    file: "src/core/engine.ts",
    from: 'await this.#registry.submit({ kind: "attach-worktree", id: taskId, worktree: receipt })',
    to: "void receipt;",
    test: "test/engine.test.ts",
    red: "引擎：孩子 close 后观测 worktree 并入记录",
    why: "观测了却不入账——父方看不到孩子到底改了什么",
  },
  {
    feature: "观测失败只记 captureError",
    file: "src/core/worktree.ts",
    from: "return { ...fallback, captureError: messageOf(error) };",
    to: "return { ...fallback, captureError: undefined };",
    test: "test/worktree.test.ts",
    red: "worktree：观测失败只记 captureError，不回改终态",
    why: "观测失败就抛——孩子明明跑完了，终态被观测的意外改掉",
  },
  {
    feature: "观测不到 ≠ 干净",
    file: "src/core/engine.ts",
    from: "dirty: probe.dirty,",
    to: "dirty: probe.dirty ?? 0,",
    test: "test/engine.test.ts",
    red: "引擎：观测失败时 dirty 留空（不填 0）",
    why: "观测不到就填 0——「没观测到」被说成「干净」",
  },
  {
    feature: "attach-worktree 不改状态",
    file: "src/core/registry.ts",
    from: "const next: TaskRecord = { ...current, worktree: command.worktree };",
    to: "const next: TaskRecord = current;",
    test: "test/core-logic.test.ts",
    red: "状态机：attach-worktree 只写元数据，不改 status",
    why: "回执把整条记录换掉——生命周期被观测事实顶了",
  },
  {
    feature: "有账本保护（热/归档）",
    file: "src/core/worktree.ts",
    from: "if (hasLedger(taskId)) continue;",
    to: "if (false) continue;",
    test: "test/worktree.test.ts",
    red: "清扫：有账本的 worktree 不删",
    why: "账上还认领着的工作区被清掉——父方还在查它，孩子的工作没了",
  },
  {
    feature: "非强制 remove",
    file: "src/core/worktree.ts",
    from: '["worktree", "remove", path]',
    to: '["worktree", "remove", "--force", path]',
    test: "test/worktree.test.ts",
    red: "清扫：脏 worktree 不强删（git 拒绝就留）",
    why: "脏的工作区被强删——孩子没提交的改动凭空消失",
  },
  {
    feature: "非强制删分支",
    file: "src/core/worktree.ts",
    from: '["branch", "-d", branch]',
    to: '["branch", "-D", branch]',
    test: "test/worktree.test.ts",
    red: "清扫：未合并分支不强删",
    why: "未合并的分支被强删——孩子还没交付的提交没了",
  },
  {
    feature: "只碰受管根下的 worktree",
    file: "src/core/worktree.ts",
    from: "if (!realish(entry.path).startsWith(root + sep)) continue;",
    to: "if (false) continue;",
    test: "test/worktree.test.ts",
    red: "清扫：用户自己的 worktree 不被误清",
    why: "清扫越界——用户自己建的 worktree 也被清掉",
  },
  {
    feature: "手工删目录只清元数据",
    file: "src/core/worktree.ts",
    from: "const existed = existsSync(path);",
    to: "const existed = true;",
    test: "test/worktree.test.ts",
    red: "清扫：手工删掉的目录不重建，只清元数据",
    why: "手工删掉的工作区被算成「我们删掉了目录」——计数撒谎，也掩盖了「我们没重建」",
  },
  // ── 黑板 ────────────────────────────────────────────────────────────────
  {
    feature: "黑板 env 注入",
    file: "src/core/engine.ts",
    from: "env.PI_DISPATCH_BLACKBOARD_DIR = blackboard.path;",
    to: "void blackboard.path;",
    test: "test/engine.test.ts",
    red: "引擎：开黑板的孩子 env 里有板目录",
    why: "孩子拿不到板目录——开了黑板也读不到兄弟的留言",
  },
  {
    feature: "继承 env 必擦",
    file: "src/core/engine.ts",
    from: "delete env.PI_DISPATCH_BLACKBOARD_DIR;",
    to: "void env.PI_DISPATCH_BLACKBOARD_DIR;",
    test: "test/engine.test.ts",
    red: "引擎：默认关——继承来的黑板 env 被擦除",
    why: "父进程预置的黑板 env 漏进孩子——没开黑板的孩子拿到了别人的板目录",
  },
  {
    feature: "父方视图缺省读当前板",
    file: "src/core/engine.ts",
    from: "if (options.boardId !== undefined && options.boardId !== current) {",
    to: "if (options.boardId !== undefined || options.boardId !== current) {",
    test: "test/engine.test.ts",
    red: "引擎：父方视图——缺省/显式给当前板号都照读，别家板号仍报错",
    why: "不带 boardId 调 blackboardView 被当成「别家会话的板」——父方读不到自己的板",
  },
  {
    feature: "黑板作者服务端盖章",
    file: "src/index.ts",
    from: '      const author = process.env.PI_DISPATCH_TASK_ID ?? "unknown";',
    to: '      const author = "unknown";',
    test: "test/adapter.test.ts",
    red: "黑板：作者取自 env，参数伪造不了",
    why: "作者写死——留言都成了同一个人签的，兄弟之间分不出谁说的",
  },
  {
    feature: "黑板 trust 恒 unverified",
    file: "src/core/blackboard.ts",
    from: "      trust: TRUST,\n      notes: window,",
    to: '      trust: "verified" as typeof TRUST,\n      notes: window,',
    test: "test/blackboard.test.ts",
    red: "黑板：文件自报的 trust 与多余字段不作数",
    why: "板上的话被标成已核实——兄弟子代理的谎话被当成事实",
  },
  {
    feature: "黑板活跃板不清",
    file: "src/core/blackboard.ts",
    from: "if (isActive(boardId)) continue;",
    to: "if (false) continue;",
    test: "test/blackboard.test.ts",
    red: "黑板：活跃板一条笔记都不清",
    why: "有人正在用的板被清掉——在飞的兄弟之间丢了留言",
  },
  {
    feature: "黑板 TTL 生效",
    file: "src/core/blackboard.ts",
    from: "if (now - mtimeMs > ttlMs) {",
    to: "if (false) {",
    test: "test/blackboard.test.ts",
    red: "黑板：TTL 边界——正好到期留着，过了 1ms 就清",
    why: "死板的笔记永不清理——磁盘只增不减",
  },
  {
    feature: "黑板笔记原子写",
    file: "src/core/blackboard.ts",
    from: "renameSync(tmp, final);",
    to: "void tmp;",
    test: "test/blackboard.test.ts",
    red: "黑板：先 .tmp 后 rename，不留半个 JSON",
    why: "写到一半崩了，磁盘上留半个 JSON——读的时候被当坏文件",
  },
  {
    feature: "黑板坏笔记不毒化",
    file: "src/core/blackboard.ts",
    from: "errors += 1;",
    to: "errors += 0;",
    test: "test/blackboard.test.ts",
    red: "黑板：坏 JSON 与 .tmp 计入 errors，其余照读",
    why: "坏文件不记错——父方看不到板上读漏了东西",
  },
  {
    feature: "黑板 after 游标必须是字符串",
    file: "src/core/blackboard.ts",
    from: 'typeof o.after !== "string"',
    to: "false",
    test: "test/blackboard.test.ts",
    red: "黑板：after 非字符串要拒（不悄悄从头读）",
    why: "非字符串游标静默从头读：父方以为读到的是新的一段，其实是全部旧笔记",
  },
  {
    feature: "strict 白名单收编黑板工具",
    file: "src/core/child.ts",
    from: "...(options.blackboard ? [BLACKBOARD_READ, BLACKBOARD_WRITE] : [])",
    to: "...([] as string[])",
    test: "test/child.test.ts",
    red: "拼命令：strict + blackboard 名单含两个黑板工具",
    why: "strict 孩子被白名单砍掉黑板工具——只读子代理没法跟兄弟交换信息",
  },
  {
    feature: "黑板写不算跑过命令",
    file: "src/core/child.ts",
    from: 'if (toolName !== "bash") return;',
    to: 'if (toolName === "bash") return;',
    test: "test/child.test.ts",
    red: "收据：黑板写带上 args.command 也不进 commands",
    why: "黑板留言被记成跑过的命令——自检对质拿留言当证据",
  },
  // ── 黑板判活 / 读预算 / 清扫 / dirty（F3） ─────────────────────────────
  {
    feature: "owner 读不到就跳过清扫",
    file: "src/core/blackboard.ts",
    from: "      if (!owner) {\n        skippedUnknown += 1;\n        continue;\n      }",
    to: "      if (false) {\n        skippedUnknown += 1;\n        continue;\n      }",
    test: "test/blackboard.test.ts",
    red: "黑板：owner.json 坏了 ⇒ 整板跳过（skippedUnknown），笔记与目录不动",
    why: "判不了活的板被当成死板——活板的 owner 与笔记被整块清掉",
  },
  {
    feature: "stat 失败也算未清",
    file: "src/core/blackboard.ts",
    from: "          } catch {\n            // 单条失败跳过，下轮再收；但算「没清」——不许因此把目录删掉\n            left += 1;",
    to: "          } catch {\n            // 单条失败跳过，下轮再收；但算「没清」——不许因此把目录删掉\n            left += 0;",
    test: "test/blackboard.test.ts",
    red: "黑板：stat 失败的笔记算未清 ⇒ 目录保留",
    why: "stat 全失败时 left 归零 ⇒ 板目录（连 owner.json）被删，笔记数据丢失",
  },
  {
    feature: "判活 fail-safe（启动时刻读不到按活）",
    file: "src/core/engine.ts",
    from: "  if (start === undefined) return true;",
    to: "  if (start === undefined) return false;",
    test: "test/engine.test.ts",
    red: "引擎：boardIsActive——pid 活但启动时刻读不到 ⇒ 按活（fail-safe）",
    why: "ps 读不到启动时刻就判死——活板被清，证据丢了",
  },
  {
    feature: "终态记录不续命活板",
    file: "src/core/engine.ts",
    from: "    if (!isTerminal(record.status)) return true;",
    to: "    if (true) return true;",
    test: "test/engine.test.ts",
    red: "引擎：boardIsActive——终态引用不算活板（owner 死了就是死板）",
    why: "终态引用把死板续成活板——已关/死 owner 的板永远清不掉",
  },
  {
    feature: "读侧字节预算",
    file: "src/core/blackboard.ts",
    from: "      if (bytes + cost > READ_BYTE_BUDGET) break;",
    to: "      if (false) break;",
    test: "test/blackboard.test.ts",
    red: "黑板：读侧字节预算——超预算截断，nextAfter 可续读",
    why: "一次读把整块板装进父方上下文——兄弟写巨型笔记就能撑爆父方",
  },
  {
    feature: "分支未知也回收受管目录",
    file: "src/core/worktree.ts",
    from: "    const outcome = await removeWorktree(git, repoRoot, entry.path, branch);",
    to: "    if (branch === undefined) continue;\n    const outcome = await removeWorktree(git, repoRoot, entry.path, branch);",
    test: "test/worktree.test.ts",
    red: "清扫：孩子换过分支的受管目录照收（目录删、分支保留）",
    why: "孩子换过分支/detached 的目录永远不进清扫——磁盘孤儿只增不减",
  },
  {
    feature: "dirty 数文件不数目录",
    file: "src/core/worktree.ts",
    from: '["status", "--porcelain", "--untracked-files=all"]',
    to: '["status", "--porcelain"]',
    test: "test/worktree.test.ts",
    red: "观测：未跟踪目录里的 3 个文件 ⇒ dirty 3（不折叠成目录一行）",
    why: "未跟踪目录折叠成一行——3 个未提交文件只报 1，脏度撒谎",
  },
  // ── P1 账本补齐（F4） ───────────────────────────────────────────────────
  {
    feature: "清扫：没到期 ⇒ 不删",
    file: "src/core/worktree.ts",
    from: "    if (mtime !== undefined && now - mtime <= ttlMs) continue;",
    to: "    if (mtime !== undefined && false) continue;",
    test: "test/worktree.test.ts",
    red: "清扫：没到期 ⇒ 不删",
    why: "TTL 没到就清掉受管工作区——账期里的孩子的工作没了",
  },
  {
    feature: "黑板：空白与超 8KiB 都拒",
    file: "src/core/blackboard.ts",
    from: '    if (Buffer.byteLength(text, "utf8") > NOTE_MAX_BYTES) {',
    to: "    if (false) {",
    test: "test/blackboard.test.ts",
    red: "黑板：空白与超 8KiB 都拒",
    why: "超限笔记被收下——一条留言就能把父方读预算撑爆",
  },
  {
    feature: "黑板：读上限 100",
    file: "src/core/blackboard.ts",
    from: "  return Math.min(limit, READ_MAX);",
    to: "  return limit;",
    test: "test/blackboard.test.ts",
    red: "黑板：读上限 100（多了夹到 100，缺省 50）",
    why: "limit 不夹上限——一次读能把整块板塞进父方上下文",
  },
  {
    feature: "黑板：after 游标严格在那条之后",
    file: "src/core/blackboard.ts",
    from: "  return at + 1;",
    to: "  return at;",
    test: "test/blackboard.test.ts",
    red: "黑板：after 游标严格在那条之后",
    why: "游标那条被重复给——续读卡在原地，永远读不完",
  },
  {
    feature: "黑板：清空了的板把目录删掉",
    file: "src/core/blackboard.ts",
    from: "      if (left === 0) {",
    to: "      if (false) {",
    test: "test/blackboard.test.ts",
    red: "黑板：清空了的板把目录删掉（owner 可读且证死）",
    why: "空板目录永不删——死板的 owner.json 与空目录只增不减",
  },
  {
    feature: "引擎：shutdown 给板补 closedAt",
    file: "src/core/engine.ts",
    from: "      new BlackboardStore({ root: storage.blackboardsDir, boardId }).close(this.#now());",
    to: "      new BlackboardStore({ root: storage.blackboardsDir, boardId });",
    test: "test/engine.test.ts",
    red: "引擎：shutdown 给板补 closedAt",
    why: "会话收尾不关板——下次启动只能靠 pid 判死，板一直像活的",
  },
  {
    feature: "适配层：父方有 dispatch_blackboard 工具（只读）",
    file: "src/index.ts",
    from: '    name: "dispatch_blackboard",',
    to: '    name: "dispatch_blackboard_readonly",',
    test: "test/adapter.test.ts",
    red: "适配层：父方有 dispatch_blackboard 工具（只读）",
    why: "父方拿不到读黑板的工具——孩子之间的留言父方看不见",
  },
  {
    feature: "判据·默认关：记录无新键且没有 worktree 目录 ⇒ 红",
    file: "scripts/verdicts.ts",
    from: '    ok: failures.length === 0,\n    detail: failures.length ? failures.join("；") : "默认关：记录无新键、worktrees 只含隔离那一个",',
    to: '    ok: true,\n    detail: failures.length ? failures.join("；") : "默认关：记录无新键、worktrees 只含隔离那一个",',
    test: "test/verdicts.test.ts",
    red: "判断·默认关：出现新键、多了目录或缺记录 ⇒ 红",
    why: "默认关判据被放宽成恒真——记录多出新键、多出 worktree 也报绿",
  },
  {
    feature: "会话级同板",
    file: "src/core/engine.ts",
    from: "    const boardId = (this.#boardId ??= randomUUID());",
    to: "    const boardId = randomUUID();",
    test: "test/engine.test.ts",
    red: "引擎：同一会话的两个孩子共用一块板",
    why: "每个孩子开一块新板——兄弟之间读不到彼此的留言",
  },
  {
    feature: "建盘失败回收半截目录",
    file: "src/core/engine.ts",
    from: "        const attempted = this.#registry.get(taskId)?.worktree;\n        if (attempted) {",
    to: "        const attempted = undefined as { path: string; branch: string } | undefined;\n        if (attempted) {",
    test: "test/engine.test.ts",
    red: "引擎：建盘失败留下半截目录 ⇒ best-effort 回收本次路径",
    why: "建盘失败留下的半截目录没人收——磁盘孤儿只增不减（直到清扫过期）",
  },
  {
    feature: "观测四连用独立 5s 超时",
    file: "src/core/worktree.ts",
    from: "export const OBSERVE_TIMEOUT_MS = 5_000;",
    to: "export const OBSERVE_TIMEOUT_MS = GIT_TIMEOUT_MS;",
    test: "test/worktree.test.ts",
    red: "观测：四连 git 各自 5s 超时、建盘仍 30s（不拖住座位归还）",
    why: "观测借建盘的 30s 上限——一条挂死的 git 扣住座位（和一次性宿主）两分钟",
  },
  {
    feature: "locale 固定",
    file: "scripts/test-env.ts",
    from: '  env.LC_ALL = "C.UTF-8";',
    to: "  void 0;",
    test: "test/test-runner.test.ts",
    red: "测试环境：继承来的三个变量擦掉、locale 固定，其余原样",
    why: "locale 随跑测试的人走——同一破坏点换台机器就假绿/红错地方",
  },
  // ── 真机判据 ────────────────────────────────────────────────────────────
  // 判据本身也要能坏：把 ok 条件改成恒真，对应的正反夹具用例必须红。
  // 真机腿（pnpm test:mode）用的是同一个函数，所以判据被放宽时真机腿也会假绿。
  {
    feature: "判据：隔离腿的 ok 条件",
    file: "scripts/verdicts.ts",
    from: '    ok: failures.length === 0,\n    detail: failures.length ? failures.join("；") : "隔离判据全部符合",',
    to: '    ok: true,\n    detail: failures.length ? failures.join("；") : "隔离判据全部符合",',
    test: "test/verdicts.test.ts",
    red: "判断·隔离：缺字段/脏/漂移/父仓被动过 ⇒ 红",
    why: "隔离判据被放宽成恒真——没建盘、没提交、父仓被动过也报绿",
  },
  {
    feature: "判据：黑板腿的 ok 条件",
    file: "scripts/verdicts.ts",
    from: '    ok: failures.length === 0,\n    detail: failures.length ? failures.join("；") : `黑板判据全部符合（笔记=${notes.length}）`,',
    to: '    ok: true,\n    detail: failures.length ? failures.join("；") : `黑板判据全部符合（笔记=${notes.length}）`,',
    test: "test/verdicts.test.ts",
    red: "判断·黑板：板号不同 / trust 被改 / canary 缺失 / 收据为 0 ⇒ 红",
    why: "黑板判据被放宽成恒真——板号不同、信任被标成已核实也报绿",
  },
  {
    feature: "判据：隔离退回的 ok 条件",
    file: "scripts/verdicts.ts",
    from: "    ok: records.length === 0,\n    detail: `隔离退回后记录数=${records.length}`,",
    to: "    ok: true,\n    detail: `隔离退回后记录数=${records.length}`,",
    test: "test/verdicts.test.ts",
    red: "判断·隔离退回：零记录 ⇒ 绿，有记录 ⇒ 红",
    why: "退回判据被放宽成恒真——非 git 仓里隔离照样被放行也报绿",
  },
  // ── 运行中转向 ──────────────────────────────────────────────────────────
  {
    feature: "转向只受理 running",
    file: "src/core/steer.ts",
    from: '  if (input.status !== "running")',
    to: "  if (false)",
    test: "test/steer.test.ts",
    red: "转向：受理计划只认 running、4096/4097 边界、16 条与续号",
    why: "queued/终态任务也收转向，孩子永远读不到",
  },
  {
    feature: "转向正文 4096 放行、4097 拒绝",
    file: "src/core/steer.ts",
    from: "  if (trimmed.length > MAX_STEER_CHARS)",
    to: "  if (trimmed.length >= MAX_STEER_CHARS)",
    test: "test/steer.test.ts",
    red: "转向：受理计划只认 running、4096/4097 边界、16 条与续号",
    why: "边界被改成 >=，4096 字符的合法转向被拒",
  },
  {
    feature: "一个任务最多 16 条转向",
    file: "src/core/steer.ts",
    from: "  if (input.existing.length >= MAX_STEERS)",
    to: "  if (input.existing.length > MAX_STEERS)",
    test: "test/steer.test.ts",
    red: "转向：受理计划只认 running、4096/4097 边界、16 条与续号",
    why: "第 17 条也写进去，孩子收到超量转向",
  },
  {
    feature: "转向：C0 正文拒收",
    file: "src/core/steer.ts",
    from: '  if (hasC0(trimmed)) return { ok: false, error: "steer message contains control characters" };',
    to: '  if (false) return { ok: false, error: "steer message contains control characters" };',
    test: "test/steer.test.ts",
    red: "转向：C0 正文拒（JSON 转义会把信箱撑爆）",
    why: "C0 在 JSON 里转义成 6 字节：16 条就能撑爆信箱读上限，任务转向永久失效",
  },
  {
    feature: "转向：JSON 体积上限只拒 6 倍转义与超长",
    file: "src/core/steer.ts",
    from: '  if (Buffer.byteLength(JSON.stringify(trimmed), "utf8") > MAX_STEER_JSON_BYTES)',
    to: "  if (false)",
    test: "test/steer.test.ts",
    red: "转向：4096 中文字符放行，孤立代理项按 JSON 体积拒",
    why: "体积闸被删，16 条孤立代理项 = 393KB 撑爆 256 KiB 读上限，该任务转向永久失效",
  },
  {
    feature: "已有信箱续号而不是从 1 重开",
    file: "src/core/steer.ts",
    from: "  const seq = last ? last.seq + 1 : 1;",
    to: "  const seq = last ? 1 : 1;",
    test: "test/steer.test.ts",
    red: "转向：受理计划只认 running、4096/4097 边界、16 条与续号",
    why: "重启后 seq 撞车，孩子按游标丢信",
  },
  {
    feature: "attach-steer 同 seq 保留正文与时刻",
    file: "src/core/registry.ts",
    from: "      previous ? { ...previous, ...steer, state, text: previous.text, at: previous.at } : steer,",
    to: "      previous ? { ...previous, ...steer, text: steer.text, at: steer.at } : steer,",
    test: "test/core-logic.test.ts",
    red: "状态机：attach-steer 按 seq upsert，保留正文/时刻，终态静默丢弃",
    why: "退出对账用收到的时间覆盖原文，账本与信箱不一致",
  },
  {
    feature: "孩子真的以 steer 投递",
    file: "src/index.ts",
    from: '        pi.sendUserMessage(steerWire(line.seq, line.text), { deliverAs: "steer" });',
    to: "        pi.sendUserMessage(steerWire(line.seq, line.text), {});",
    test: "test/adapter.test.ts",
    red: "适配层：孩子 turn_end 增量读信箱，失败不推进游标",
    why: "消息排成 followUp/nextTurn，孩子本轮看不到转向",
  },
  {
    feature: "发送失败不推进游标",
    file: "src/index.ts",
    from: "        cursor.lastSeq = line.seq;",
    to: "        void line.seq;",
    test: "test/adapter.test.ts",
    red: "适配层：孩子 turn_end 增量读信箱，失败不推进游标",
    why: "失败的那条永远丢掉，重试还会重投旧条",
  },
  {
    feature: "报告早于最后一次送达才算 stale",
    file: "src/core/steer.ts",
    from: "    evidence.reportLine !== undefined && delivered !== undefined && delivered > evidence.reportLine",
    to: "    evidence.reportLine !== undefined && delivered !== undefined && delivered < evidence.reportLine",
    test: "test/steer.test.ts",
    red: "转向：isReportStale 只在报告行早于最后送达时为 true",
    why: "报告晚于转向也被标 stale，小窗资格被误取消",
  },
  {
    feature: "坏行不毒化整批",
    file: "src/core/steer.ts",
    from: "      continue; // 半行/坏 JSON：跳过，不毒化整批",
    to: '      throw new Error("bad steer line");',
    test: "test/steer.test.ts",
    red: "转向：坏行/半行/纯空白不毒化，有效行按 seq 升序且同 seq 只取一次",
    redKeyword: "bad steer line",
    why: "半个 JSON 行让整个信箱不可读，后续转向全丢",
  },
  {
    feature: "信箱按 seq 升序投递",
    file: "src/core/steer.ts",
    from: "  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);",
    to: "  return [...bySeq.values()].sort((a, b) => b.seq - a.seq);",
    test: "test/steer.test.ts",
    red: "转向：坏行/半行/纯空白不毒化，有效行按 seq 升序且同 seq 只取一次",
    why: "后写的先投，孩子看到的方向顺序反了",
  },
  {
    feature: "同 seq 只取第一条",
    file: "src/core/steer.ts",
    from: "    if (!bySeq.has(seq)) bySeq.set(seq, { seq, text, at });",
    to: "    bySeq.set(seq, { seq, text, at });",
    test: "test/steer.test.ts",
    red: "转向：坏行/半行/纯空白不毒化，有效行按 seq 升序且同 seq 只取一次",
    why: "重复 seq 覆盖原文，账本与孩子看到的不一致",
  },
  {
    feature: "afterSeq 之后才算新增",
    file: "src/core/steer.ts",
    from: '    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= afterSeq || seq <= 0)',
    to: '    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < afterSeq || seq <= 0)',
    test: "test/steer.test.ts",
    red: "转向：坏行/半行/纯空白不毒化，有效行按 seq 升序且同 seq 只取一次",
    why: "已投过的 seq 再投一次，孩子重复执行同一条转向",
  },
  {
    feature: "queue_update 是 queued 证据",
    file: "src/core/child.ts",
    from: '    if (event.type === "queue_update") {',
    to: "    if (false) {",
    test: "test/child.test.ts",
    red: "转向：queue_update → user 回显 → assistant 记 queued/delivered/seen",
    why: "孩子进了队列也当没进，收据永远 undelivered",
  },
  {
    feature: "列表只在转向过时才带 steers",
    file: "src/index.ts",
    from: "          ...(r.steers && r.steers.length > 0 ? { steers: steerRows(r.steers) } : {}),",
    to: "          ...(r.steers && r.steers.length > 0 ? { steers: steerRows(r.steers) } : { steers: [] }),",
    test: "test/adapter.test.ts",
    red: "适配层：dispatch_list 对默认关记录的序列化与冻结基线逐字节相等（G14）",
    why: "默认关的记录多一个 steers 键，列表逐字节基线（每轮重发的体积）失效",
  },
  {
    feature: "列表不把 false 的 reportStale 写出来",
    file: "src/index.ts",
    from: "          ...(r.reportStale ? { reportStale: r.reportStale } : {}),",
    to: "          ...(r.reportStale !== undefined ? { reportStale: r.reportStale } : {}),",
    test: "test/adapter.test.ts",
    red: "适配层：dispatch_list 只回转向收据字段，缺正文、不 stale 不留键",
    why: "报告不 stale 的任务也带 reportStale:false，跟「缺席即没事」的约定打架",
  },
  {
    feature: "坏记录被跳过时列表明说条数",
    file: "src/index.ts",
    from: "        ...(skipped > 0 ? { skippedRecords: skipped } : {}),",
    to: "        ...(false ? { skippedRecords: skipped } : {}),",
    test: "test/adapter.test.ts",
    red: "适配层：坏记录被跳过时 dispatch_list 要明说条数",
    why: "账上少了几笔却不吭声：父方以为记录全在，缺的那几笔永远无人知道",
  },
  {
    feature: "终态通知带转向收据",
    file: "src/index.ts",
    from: '          n.steers ? steerHint(n.steers) : "",',
    to: '          "",',
    test: "test/adapter.test.ts",
    red: "deliver：转向收据写进终态通知（送达 = 进了孩子 transcript）",
    why: "父方收不到「送达几条 / 生效几条」，转向变成看不见的黑洞",
  },
  {
    feature: "dispatch_steer 描述钉住不打断与证据口径",
    file: "src/index.ts",
    from: '"孩子还在跑时插一句话，它在下一个回合看到后调整方向继续干（不打断在飞工具）。只受理 running；≤4096 字符，一个任务最多 16 条。sent 只代表已写进信箱，送达/生效的证据看 dispatch_list 的 steers。",',
    to: '"孩子还在跑时插一句话，它在下一个回合看到后调整方向继续干。只受理 running；≤4096 字符，一个任务最多 16 条。",',
    test: "test/adapter.test.ts",
    red: "适配层：dispatch_steer 的 schema 与描述钉住不打断/证据口径",
    why: "口径退回旧文案：模型不知道 sent≠送达，会把已写盘当证据",
  },
  {
    feature: "退出时最终态入记录",
    file: "src/core/engine.ts",
    from: "    if (currentSteers && currentSteers.length > 0) {",
    to: "    if (false) {",
    test: "test/engine.test.ts",
    red: "转向：退出按真机证据把 sent 对成 seen，报告在回显后不 stale",
    why: "退出不落最终收据，账上永远停在 sent，父方看不出送没送到",
  },
  {
    feature: "孩子环境擦掉继承信箱",
    file: "src/core/engine.ts",
    from: "  delete env.PI_DISPATCH_STEER_FILE;",
    to: "  void 0;",
    test: "test/engine.test.ts",
    red: "转向：孩子环境擦掉继承信箱，注入本任务路径",
    why: "孙任务继承爷爷的信箱，读到别人的转向",
  },
  {
    feature: "转向判断要求 seen 且正文改向",
    file: "scripts/verdicts.ts",
    from: '  if (steer.state !== "seen") return { ok: false, detail: `state=${steer.state}` };',
    to: "  if (false) return { ok: false, detail: `state=${steer.state}` };",
    test: "test/verdicts.test.ts",
    red: "判断·转向：收据说 sent 但 stdout 有 seen 证据 ⇒ 红",
    why: "sent/undelivered 也当成功，真机腿把没送达的转向判绿",
  },
  {
    feature: "标记只认整行精确匹配",
    file: "src/core/steer.ts",
    from: "const STEER_MARKER_RE = /^\\[pi-dispatch-steer #(\\d+)\\]$/;",
    to: "const STEER_MARKER_RE = /^\\[pi-dispatch-steer #(\\d+)\\]/;",
    test: "test/steer.test.ts",
    red: "转向：标记只认首行，正文里的伪造不算",
    why: "标记后带额外文本也被认成转向，正文可能伪装成方向",
  },
  {
    feature: "wire 带一句不是新任务的框架语",
    file: "src/core/steer.ts",
    from: "  return `${steerTag(seq)}\\n父方在你运行期间调整了方向；这是对当前任务的补充/修正，不是新任务：\\n${text}`;",
    to: "  return `${steerTag(seq)}\\n${text}`;",
    test: "test/steer.test.ts",
    red: "转向：wire 首行是标记，正文原样另起一行",
    why: "孩子把一条带陌生标记的 user 消息当新任务或直接忽略",
  },
  {
    feature: "回显必须有同 seq 的队列证据",
    file: "src/core/child.ts",
    from: "  if (!acc.queuedSteers.some((entry) => entry.seq === seq)) return;",
    to: "  if (false) return;",
    test: "test/child.test.ts",
    red: "转向：初始 prompt 首行伪造标记，没有 queue_update 也不算 delivered/seen",
    why: "任务正文首行写标记就能伪造送达证据，报告提前或正文误判",
  },
  {
    feature: "sent 直接升 seen 也补 deliveredAt",
    file: "src/core/steer.ts",
    from: "        return { ...record, state, deliveredAt: record.deliveredAt ?? now, seenAt: now };",
    to: "        return { ...record, state, seenAt: now };",
    test: "test/steer.test.ts",
    red: "转向：退出对账 seen > delivered > queued > undelivered，保留正文与时刻",
    why: "最终收据缺 deliveredAt，真机腿和父方读不到送达时刻",
  },
  {
    feature: "judgeSteer 看收据不看散文",
    file: "scripts/verdicts.ts",
    from: "  if (!parsed.steerEvidence.seen.some((entry) => entry.seq === steer.seq))",
    to: "  if (false)",
    test: "test/verdicts.test.ts",
    red: "判断·转向：收据说 seen 但 stdout 无证据 ⇒ 红",
    why: "转向收据不看送达证据，散文里写一句 STEERED 就能冒充改向",
  },
  {
    feature: "通知只在 reportStale 为 true 时带警告",
    file: "src/core/notifications.ts",
    from: "        ...(next.reportStale ? { reportStale: true as const } : {}),",
    to: "        ...(false ? { reportStale: true as const } : {}),",
    test: "test/engine.test.ts",
    red: "通知：reportStale 只在 true 时出现，false 不留键",
    why: "父方看不到「报告早于最后一次转向」，把旧报告当最终结论",
  },
  // ── 成本控制：预算（§2.1） ──────────────────────────────────────────────
  {
    feature: "预算到点进软门（两个上限任一越线，OR 语义）",
    file: "src/core/budget.ts",
    from: "  if (overUsd || overTokens) {",
    to: "  if (overUsd && overTokens) {",
    test: "test/budget.test.ts",
    red: "预算：两个上限都给了 ⇒ 任一越线即到点",
    why: "只给了一个上限越线时预算不触发，超支没人管",
  },
  {
    feature: "硬门倍数生效（evaluateBudget）",
    file: "src/core/budget.ts",
    from: "  const factor = budget.hardFactor ?? DEFAULT_HARD_FACTOR;",
    to: "  const factor = budget.hardFactor ?? DEFAULT_HARD_FACTOR * 2;",
    test: "test/budget.test.ts",
    red: "预算：超过硬门倍数 ⇒ 进硬门",
    why: "硬门要到 4 倍才触发，超支上界翻倍",
  },
  {
    feature: "软门后宽限期到点进硬门（evaluateBudget）",
    file: "src/core/budget.ts",
    from: "  const hardByTime = input.softAt !== undefined && input.now - input.softAt >= grace;",
    to: "  const hardByTime = input.softAt !== undefined && input.now - input.softAt > grace;",
    test: "test/budget.test.ts",
    red: "预算：软门后超过宽限期 ⇒ 进硬门（不靠新用量）",
    why: "宽限期恰好到点时不收尸，孩子卡在长工具里永远不结束",
  },
  {
    feature: "token 口径含 cacheRead（totalTokens）",
    file: "src/core/budget.ts",
    from: "(usage.cacheRead ?? 0)",
    to: "(0)",
    test: "test/budget.test.ts",
    red: "预算：token 口径含 cacheRead（缓存型子代理的账不失真）",
    why: "缓存型子代理在账上几乎不花钱，预算形同虚设",
  },
  {
    feature: "token 口径含 cacheWrite（totalTokens）",
    file: "src/core/budget.ts",
    from: "(usage.cacheWrite ?? 0)",
    to: "(0)",
    test: "test/budget.test.ts",
    red: "预算：token 口径含 cacheWrite",
    why: "写缓存的量漏出账本",
  },
  {
    feature: "没有 cost 时按 0 算（usdOf）",
    file: "src/core/budget.ts",
    from: "  return usage.cost ?? 0;",
    to: "  return usage.cost ?? 1;",
    test: "test/budget.test.ts",
    red: "预算：美元口径取累计 cost（没有 cost 时按 0 算）",
    why: "provider 不上报 cost 时凭空记 1 美元，美元上限立刻误触发",
  },
  {
    feature: "到点判定用 >= 不是 >（evaluateBudget）",
    file: "src/core/budget.ts",
    from: "  const overUsd = budget.maxUsd !== undefined && input.spentUsd >= budget.maxUsd;",
    to: "  const overUsd = budget.maxUsd !== undefined && input.spentUsd > budget.maxUsd;",
    test: "test/budget.test.ts",
    red: "预算：恰好等于上限 ⇒ 进软门（>= 不是 >）",
    why: "恰好花到上限时不触发，再多花一轮才管",
  },
  {
    feature: "低于上限不动（evaluateBudget）",
    file: "src/core/budget.ts",
    from: "  const overTokens = budget.maxTokens !== undefined && input.spentTokens >= budget.maxTokens;",
    to: "  const overTokens = budget.maxTokens !== undefined && input.spentTokens >= 0;",
    test: "test/budget.test.ts",
    red: "预算：低于上限 ⇒ 不动",
    why: "有 token 上限就立刻到点，预算变成「一跑就收」",
  },
  {
    feature: "没到硬门倍数仍是软门（evaluateBudget）",
    file: "src/core/budget.ts",
    from: "  const hardByUsd = budget.maxUsd !== undefined && input.spentUsd >= budget.maxUsd * factor;",
    to: "  const hardByUsd = budget.maxUsd !== undefined && input.spentUsd >= budget.maxUsd;",
    test: "test/budget.test.ts",
    red: "预算：没到硬门倍数 ⇒ 仍是软门",
    why: "到点即硬收，软门的收尾转向被跳过",
  },
  {
    feature: "硬收过就一直硬门（evaluateBudget 的 hard 入参）",
    file: "src/core/budget.ts",
    from: '  if (input.hard) return { phase: "hard", reason: "已经硬收过" };',
    to: '  if (input.hard) return { phase: "soft", reason: "已经硬收过" };',
    test: "test/budget.test.ts",
    red: "预算：已经硬收过就一直是硬门（不回到软门）",
    why: "硬收过又报软门，父方以为还能继续干",
  },
  {
    feature: "没给预算 ⇒ phase ok（evaluateBudget）",
    file: "src/core/budget.ts",
    from: '  if (!budget) return { phase: "ok" };',
    to: '  if (!budget) return { phase: "soft" };',
    test: "test/budget.test.ts",
    red: "预算：没给预算 ⇒ phase ok",
    why: "没设预算的任务也被判到点，白插收尾转向",
  },
  {
    feature: "硬门先于软门成立（evaluateBudget）",
    file: "src/core/budget.ts",
    from: "  if (hardByUsd || hardByTokens || hardByTime) {",
    to: "  if (hardByTokens || hardByTime) {",
    test: "test/budget.test.ts",
    red: "预算：硬门先于软门成立时直接进硬门（不先软门）",
    why: "美元已超硬门却只报软门，孩子被允许继续烧钱",
  },
  {
    feature: "hardFactor=1 ⇒ 跳过软门直接进硬门（evaluateBudget）",
    file: "src/core/budget.ts",
    from: "  const factor = budget.hardFactor ?? DEFAULT_HARD_FACTOR;",
    to: "  const factor = (budget.hardFactor ?? DEFAULT_HARD_FACTOR) * 2;",
    test: "test/budget.test.ts",
    red: "预算：hardFactor=1 ⇒ 跳过软门直接进硬门",
    why: "hardFactor=1 的语义是「到点就收掉」——倍数被改写后软门又回来了，父方以为还有降级交付",
  },
  {
    feature: "预算闸：至少一个上限（usageBudgetGate）",
    file: "src/core/gates.ts",
    from: "  if (budget.maxUsd === undefined && budget.maxTokens === undefined)",
    to: "  if (false)",
    test: "test/core-logic.test.ts",
    red: "安检 17：usageBudget 至少要给一个上限（maxUsd / maxTokens）",
    why: "空预算对象被当成设了预算，父方以为有上限",
  },
  {
    feature: "上限必须是正的有限数（usageBudgetGate）",
    file: "src/core/gates.ts",
    from: "  if (budget.maxUsd !== undefined && (!Number.isFinite(budget.maxUsd) || budget.maxUsd <= 0))",
    to: "  if (false)",
    test: "test/core-logic.test.ts",
    red: "安检 17b：usageBudget 的上限必须是正的有限数（0 / 负数 / NaN 都拒）",
    why: "0 / 负数 / NaN 被 coerce 成有效上限，预算永不触发",
  },
  {
    feature: "maxTokens 也必须是正的有限数（usageBudgetGate）",
    file: "src/core/gates.ts",
    from: "    (!Number.isFinite(budget.maxTokens) || budget.maxTokens <= 0)",
    to: "    budget.maxTokens <= 0",
    test: "test/core-logic.test.ts",
    red: "安检 17b：usageBudget 的上限必须是正的有限数（0 / 负数 / NaN 都拒）",
    why: "NaN / Infinity 的 token 上限被放行，预算永不触发",
  },
  {
    feature: "hardFactor < 1 要拒（usageBudgetGate）",
    file: "src/core/gates.ts",
    from: "    (!Number.isFinite(budget.hardFactor) || budget.hardFactor < 1)",
    to: "    (!Number.isFinite(budget.hardFactor) || false)",
    test: "test/core-logic.test.ts",
    red: "安检 17c：usageBudget 的 hardFactor 必须是 ≥1 的有限数（NaN / Infinity / 字符串都拒）",
    why: "hardFactor < 1 让硬门早于软门，孩子被立刻收掉",
  },
  {
    feature: "hardFactor 非有限数要拒（usageBudgetGate）",
    file: "src/core/gates.ts",
    from: "    (!Number.isFinite(budget.hardFactor) || budget.hardFactor < 1)",
    to: "    (budget.hardFactor < 1)",
    test: "test/core-logic.test.ts",
    red: "安检 17c：usageBudget 的 hardFactor 必须是 ≥1 的有限数（NaN / Infinity / 字符串都拒）",
    why: "NaN / Infinity / 字符串绕过校验，硬门用量条件失效",
  },
  {
    feature: "hardGraceMs 不超过 setTimeout 上限（usageBudgetGate）",
    file: "src/core/gates.ts",
    from: "      budget.hardGraceMs > MAX_TIMEOUT_MS",
    to: "      false",
    test: "test/core-logic.test.ts",
    red: "安检 17d：usageBudget 的 hardGraceMs 必须是正的有限数，且不超过 setTimeout 上限",
    why: "超过 2^31-1 会被 Node 夹成 1ms，软门后立刻收尸",
  },
  {
    feature: "usageBudget null / 非对象要拒（usageBudgetGate）",
    file: "src/core/gates.ts",
    from: '  if (raw === null || typeof raw !== "object" || Array.isArray(raw))',
    to: "  if (false)",
    test: "test/core-logic.test.ts",
    red: "安检 17e：usageBudget=null / 非对象要拒（不能当没设预算）",
    redKeyword: "TypeError",
    why: "null 被当成没设预算，任务无上限运行",
  },
  {
    feature: "user message 体积闸 ≤ 64 KiB（messageBytesGate）",
    file: "src/core/gates.ts",
    from: '  if (Buffer.byteLength(message, "utf8") > MAX_TEXT_BYTES)',
    to: "  if (false)",
    test: "test/core-logic.test.ts",
    red: "安检 18：user message 超过 64 KiB 要拒（拼进一个 argv 装不下）",
    why: "合并后的位置参数撞 MAX_ARG_STRLEN ⇒ spawn E2BIG ⇒ 记 failed 而不是 rejected",
  },
  {
    feature: "user message 不能以 @ 开头（messageBytesGate）",
    file: "src/core/gates.ts",
    from: '  if (message.startsWith("@"))',
    to: "  if (false)",
    test: "test/core-logic.test.ts",
    red: "安检 18b：user message 不能以 @ 开头（pi 会把它当文件读）",
    why: "@ 开头被 pi 当文件路径，任务正文丢弃",
  },
  {
    feature: "新闸接在默认闸序末尾（defaultGates）",
    file: "src/core/gates.ts",
    from: "    usageBudgetGate,",
    to: "    messageBytesGate,",
    test: "test/core-logic.test.ts",
    red: "安检 10：默认闸序含隔离/黑板两道值闸",
    why: "第 13 道位置被顶掉：档位与体积闸没挂上",
  },
  {
    feature: "增量用量与终局口径一致（createUsageTracker）",
    file: "src/core/child.ts",
    from: "    usage = addUsage(usage, takeUsage(message.usage));",
    to: "    usage = takeUsage(message.usage);",
    test: "test/child.test.ts",
    red: "收件：增量用量累加 = 终局 parseChildStream 的口径（同一段流，两条路同数）",
    why: "运行中只算最后一轮，预算按偏小的数判",
  },
  {
    feature: "增量用量跨 chunk 的半行不丢（createUsageTracker）",
    file: "src/core/child.ts",
    from: '      consume(buffer.slice(0, index));\n      buffer = buffer.slice(index + 1);\n      index = buffer.indexOf("\\n");\n    }\n    if (final && buffer) {',
    to: '      consume(buffer.slice(0, index));\n      buffer = "";\n      index = buffer.indexOf("\\n");\n    }\n    if (final && buffer) {',
    test: "test/child.test.ts",
    red: "收件：增量用量跨 chunk 的半行不丢（usage 事件被切成两半也要算进去）",
    why: "同一 chunk 里的多条事件只算第一条，用量漏账",
  },
  {
    feature: "只认 assistant 的 message_end（createUsageTracker）",
    file: "src/core/child.ts",
    from: '    if (message.role !== "assistant") return;',
    to: "    if (false) return;",
    test: "test/child.test.ts",
    red: "收件：增量用量只认 assistant 的 message_end（user / system 的 usage 不计）",
    why: "user/system 的用量混进来，账比终局大",
  },
  {
    feature: "预算到点 ⇒ 降级交付（#checkBudget 的软门分支）",
    file: "src/core/engine.ts",
    from: '  if (decision.phase === "soft" && state.softAt === undefined) {',
    to: '  if (decision.phase === "ok" && state.softAt === undefined) {',
    test: "test/engine.test.ts",
    red: "引擎：预算到点 ⇒ 降级交付（不 failed，回执标 budgetExhausted）",
    why: "软门永远不触发，到点后账上不标 budgetExhausted",
  },
  {
    feature: "硬门走 stop（#checkBudget）",
    file: "src/core/engine.ts",
    from: '        await this.stop(taskId, `budget exhausted: ${decision.reason ?? "用量到点"}`);',
    to: "        await Promise.resolve();",
    test: "test/engine.test.ts",
    red: "引擎：硬门 ⇒ 收掉孩子（SIGTERM），部分正文照交",
    why: "硬门只记账不收尸，孩子继续烧到自然退出",
  },
  {
    feature: "运行中用量检查不依赖报告通道（#pump）",
    file: "src/core/engine.ts",
    from: "        void this.#checkBudget(taskId, input, snap.usage).catch(() => {});",
    to: "        void Promise.resolve();",
    test: "test/engine.test.ts",
    red: "引擎：没交报告时预算照样判（账上也有数）",
    why: "运行中不判预算，没交报告的孩子超支也没人管",
  },
  {
    feature: "孩子没起来不带 budget 回执（#resultFromRecord）",
    file: "src/core/engine.ts",
    from: "      ...(record.budget && startedAt > 0 ? { budget: record.budget } : {}),",
    to: "      ...(record.budget ? { budget: record.budget } : {}),",
    test: "test/engine.test.ts",
    red: "引擎：孩子没起来 ⇒ 不带 budget 字段",
    why: "spawn 失败也回一份 spent=0 的假预算账，父方以为跑过",
  },
  {
    feature: "受理时钉死预算（#dispatchReady 克隆入参）",
    file: "src/core/engine.ts",
    from: "      ...(rawInput.usageBudget ? { usageBudget: { ...rawInput.usageBudget } } : {}),",
    to: "      ...(rawInput.usageBudget ? { usageBudget: rawInput.usageBudget } : {}),",
    test: "test/engine.test.ts",
    red: "引擎：受理时钉死预算（排队期间改参数不生效）",
    why: "排队期间调用方改预算对象，直接改到已受理任务的账上",
  },
  {
    feature: "报告旗标与预算旗标不互相掩盖（#resultFromRecord）",
    file: "src/core/engine.ts",
    from: "      ...(record.budgetExhausted && startedAt > 0 ? { budgetExhausted: true as const } : {}),",
    to: '      ...(record.budgetExhausted && record.reportChannel === "none" ? { budgetExhausted: true as const } : {}),',
    test: "test/engine.test.ts",
    red: "引擎：软门后孩子交了差 ⇒ 报告旗标与预算旗标不互相掩盖",
    why: "交了报告就把预算到点旗标吞掉，父方把降级交付当正常完成",
  },
  {
    feature: "软门写收尾转向（#checkBudget）",
    file: "src/core/engine.ts",
    from: "      const outcome = await this.steer(taskId, BUDGET_STEER_TEXT);",
    to: '      const outcome = await this.steer(taskId, "");',
    test: "test/engine.test.ts",
    red: "引擎：预算到点 ⇒ 给孩子写一条收尾转向（软门，收据里看得见）",
    why: "到点不给孩子收尾指令（空文案被拒），孩子继续干",
  },
  {
    feature: "没给预算就不动作（#checkBudget）",
    file: "src/core/engine.ts",
    from: "    const budget = input.usageBudget;\n    if (!budget) return;\n    const state = this.#budgetStates.get(taskId) ?? { hard: false };",
    to: "    const budget = input.usageBudget ?? { maxUsd: 0 };\n    if (!budget) return;\n    const state = this.#budgetStates.get(taskId) ?? { hard: false };",
    test: "test/engine.test.ts",
    red: "引擎：没给预算 ⇒ 不写转向也不收尸",
    why: "没设预算的任务也按 0 上限判，一有用量就收尸",
  },
  {
    feature: "软门后 arm 硬门定时器（#checkBudget）",
    file: "src/core/engine.ts",
    from: "      this.#armBudgetTimer(taskId, input);",
    to: "      void 0;",
    test: "test/engine.test.ts",
    red: "引擎：软门后宽限期到点 ⇒ 收掉孩子（没有新用量也收）",
    why: "软门后不 arm 定时器，孩子卡在长工具里永远没人收尸",
  },
  {
    feature: "arm 在 steer 之前（#checkBudget 不 await 拖死硬门）",
    file: "src/core/engine.ts",
    from:
      "      state.softAt = this.#now();\n" +
      "      this.#budgetStates.set(taskId, state);\n" +
      "      // 先 arm 再 await：steer / attach 卡住或抛错时，硬门的时间兜底不能跟着失效。\n" +
      "      this.#armBudgetTimer(taskId, input);\n" +
      "      // 软门走现成的转向通道：写一条「收尾交付」指令，不打断在飞工具。\n" +
      "      // 没装孩子扩展 / 没留痕目录 ⇒ 写不进去 ⇒ 只记 exhausted，靠硬门兜底。\n" +
      "      const outcome = await this.steer(taskId, BUDGET_STEER_TEXT);\n" +
      "      if (!outcome.ok) this.#budgetSteerFailed.add(taskId);\n" +
      "      await this.#attachBudget(taskId, input, usage, state);",
    to:
      "      state.softAt = this.#now();\n" +
      "      this.#budgetStates.set(taskId, state);\n" +
      "      // 软门走现成的转向通道：写一条「收尾交付」指令，不打断在飞工具。\n" +
      "      // 没装孩子扩展 / 没留痕目录 ⇒ 写不进去 ⇒ 只记 exhausted，靠硬门兜底。\n" +
      "      const outcome = await this.steer(taskId, BUDGET_STEER_TEXT);\n" +
      "      if (!outcome.ok) this.#budgetSteerFailed.add(taskId);\n" +
      "      await this.#attachBudget(taskId, input, usage, state);\n" +
      "      this.#armBudgetTimer(taskId, input);",
    test: "test/engine.test.ts",
    red: "引擎：软门转向卡住时，宽限定时器仍会收掉孩子（arm 在 await 之前）",
    why: "steer 卡住时定时器还没 arm，硬门的时间兜底跟着失效",
  },
  {
    feature: "硬门记账失败也收掉孩子（try/finally）",
    file: "src/core/engine.ts",
    from:
      "      try {\n" +
      "        await this.#attachBudget(taskId, input, usage, state);\n" +
      "      } finally {\n" +
      "        // 记账失败也要收掉孩子：硬门不能依赖回执写盘成功。\n" +
      '        await this.stop(taskId, `budget exhausted: ${decision.reason ?? "用量到点"}`);\n' +
      "      }",
    to:
      "      await this.#attachBudget(taskId, input, usage, state);\n" +
      '      await this.stop(taskId, `budget exhausted: ${decision.reason ?? "用量到点"}`);',
    test: "test/engine.test.ts",
    red: "引擎：预算记账失败也要收掉孩子（硬门不依赖回执）",
    why: "回执写盘失败时孩子继续跑到自然退出，硬门形同虚设",
  },
  {
    feature: "预算检查的拒绝不冒成 unhandledRejection",
    file: "src/core/engine.ts",
    from: "        void this.#checkBudget(taskId, input, snap.usage).catch(() => {});",
    to: "        void this.#checkBudget(taskId, input, snap.usage);",
    test: "test/engine.test.ts",
    red: "引擎：预算记账失败也要收掉孩子（硬门不依赖回执）",
    redKeyword: "disk full",
    why: "预算检查抛错时在宿主里制造未处理拒绝",
  },
  {
    feature: "回执带上限与已花的钱和 token（#attachBudget）",
    file: "src/core/engine.ts",
    from: "      spentUsd: usage ? usdOf(usage) : 0,\n      spentTokens: usage ? totalTokens(usage) : 0,\n      ...(state.softAt !== undefined ? { softAt: state.softAt } : {}),",
    to: "      spentUsd: usage ? usdOf(usage) : 0,\n      spentTokens: 0,\n      ...(state.softAt !== undefined ? { softAt: state.softAt } : {}),",
    test: "test/engine.test.ts",
    red: "引擎：预算回执带上限、已花的钱与 token",
    why: "回执里的 token 恒 0，父方看不到真实消耗",
  },
  {
    feature: "回执带上已花的美元（#attachBudget）",
    file: "src/core/engine.ts",
    from: "      spentUsd: usage ? usdOf(usage) : 0,\n      spentTokens: usage ? totalTokens(usage) : 0,\n      ...(state.softAt !== undefined ? { softAt: state.softAt } : {}),",
    to: "      spentUsd: 0,\n      spentTokens: usage ? totalTokens(usage) : 0,\n      ...(state.softAt !== undefined ? { softAt: state.softAt } : {}),",
    test: "test/engine.test.ts",
    red: "引擎：预算回执带上限、已花的钱与 token",
    why: "回执里的美元恒 0，父方看不到真实花费",
  },
  {
    feature: "工具 schema 带 usageBudget（DISPATCH_TASK_SCHEMA）",
    file: "src/index.ts",
    from: '        maxUsd: { type: "number", description: "累计成本上限（美元）。必须 > 0。" },',
    to: '        maxUsdTypo: { type: "number", description: "累计成本上限（美元）。必须 > 0。" },',
    test: "test/adapter.test.ts",
    red: "适配层：dispatch_task 的 schema 带 usageBudget",
    why: "模型看不到 maxUsd 字段，永远设不了美元上限",
  },
  {
    feature: "列表三列（dispatch_list 的行）",
    file: "src/index.ts",
    from: "          budget: r.budget,",
    to: "          budget: undefined,",
    test: "test/adapter.test.ts",
    red: "适配层：dispatch_list 的行带 budget / thinking / budgetExhausted 三列",
    why: "列表里看不到预算账，父方只能靠通知",
  },
  {
    feature: "终态通知带预算/档位提示（deliver 的文案）",
    file: "src/index.ts",
    from: '          n.budgetExhausted ? "｜预算到点（降级交付）" : "",',
    to: '          "",',
    test: "test/adapter.test.ts",
    red: "适配层：终态通知在预算到点时带「降级交付」、降档时带「high→low」",
    why: "降级交付被当成正常完成，父方不知道结果被截短",
  },
  // ── 成本控制：thinking（§2.2） ──────────────────────────────────────────
  {
    feature: "支持的档位原样发（resolveThinkingLevel）",
    file: "src/core/thinking.ts",
    from: "  if (supported.includes(requested)) {\n    return {\n      requested,\n      effective: requested,",
    to: '  if (supported.includes(requested)) {\n    return {\n      requested,\n      effective: "low",',
    test: "test/thinking.test.ts",
    red: "思考档位：模型支持该档 ⇒ 原样发（不降级）",
    why: "支持的档位也被降成 low，质量白丢",
  },
  {
    feature: "模型不在目录里 ⇒ 未校验（resolveThinkingLevel）",
    file: "src/core/thinking.ts",
    from: "      modelKnown: false,",
    to: "      modelKnown: true,",
    test: "test/thinking.test.ts",
    red: "思考档位：模型不在目录里 ⇒ 原样透传并说明未校验",
    why: "没校验却报「已认出来」，父方误信实际档位",
  },
  {
    feature: "非思考模型 ⇒ off（resolveThinkingLevel）",
    file: "src/core/thinking.ts",
    from: '  if (!model.reasoning) {\n    return {\n      requested,\n      effective: "off",',
    to: '  if (!model.reasoning) {\n    return {\n      requested,\n      effective: "high",',
    test: "test/thinking.test.ts",
    red: "思考档位：非思考模型 ⇒ 不发后缀（= off）",
    why: "非思考模型被报成 high，父方以为它在深思",
  },
  {
    feature: "缺键 ⇒ 最接近的一档（resolveThinkingLevel）",
    file: "src/core/thinking.ts",
    from: "    effective: nearest,",
    to: '    effective: "low",',
    test: "test/thinking.test.ts",
    red: "思考档位：xhigh/max 缺键 ⇒ 按 pi 口径落到最接近的一档（不静默降成 low）",
    why: "缺键被静默降成 low，比 pi 的 clamp 更激进",
  },
  {
    feature: "裸 id 唯一命中（findThinkingModel）",
    file: "src/core/thinking.ts",
    from: "  if (hits.length === 1) return hits[0];",
    to: "  if (hits.length === 0) return hits[0];",
    test: "test/thinking.test.ts",
    red: "思考档位：裸 id 唯一命中也能找到模型",
    why: "裸 id 查不到模型 ⇒ 不校验，白丢降级机会",
  },
  {
    feature: "裸 id 撞多个 ⇒ 不校验（findThinkingModel）",
    file: "src/core/thinking.ts",
    from: "  if (hits.length > 1) return undefined;",
    to: "  if (hits.length > 1) return hits[0];",
    test: "test/thinking.test.ts",
    red: "思考档位：裸 id 撞多个 ⇒ 不校验（原样透传）",
    why: "撞多个时瞎挑一个，可能按别家模型的档位图校验",
  },
  {
    feature: "回执说明降级原因（resolveThinkingLevel 的 reason）",
    file: "src/core/thinking.ts",
    from: "      reason: `该模型没有 ${requested} 档（thinkingLevelMap=null）⇒ 降到 ${effective}`,",
    to: '      reason: "",',
    test: "test/thinking.test.ts",
    red: "思考档位：回执说明实际生效档位与降级原因",
    why: "降级没有理由，父方无法判断是配置错还是模型不支持",
  },
  {
    feature: "降级到 low（downgradeTarget）",
    file: "src/core/thinking.ts",
    from: '  if (cheaper.includes("low")) return "low";',
    to: '  if (cheaper.includes("low")) return "off";',
    test: "test/thinking.test.ts",
    red: "思考档位：thinkingLevelMap 显式 null ⇒ 降到 low（vendor-local 的 medium）",
    why: "该降到 low 的档位被降到 off，能力被砍光",
  },
  {
    feature: "降级只往下不往上（downgradeTarget）",
    file: "src/core/thinking.ts",
    from: "  const cheaper = supported.filter((level) => costIndex(level) <= requestedIndex);",
    to: "  const cheaper = supported.filter((level) => costIndex(level) >= requestedIndex);",
    test: "test/thinking.test.ts",
    red: "思考档位：降级只往下不往上（生效档位的成本序不得高于请求档位）",
    why: "「降级」反而升档，重演 pi 把 medium 抬成 high 的涨价",
  },
  {
    feature: "只发 supported 里的档位（resolveThinkingLevel）",
    file: "src/core/thinking.ts",
    from: "  if (supported.includes(requested)) {",
    to: "  if (true) {",
    test: "test/thinking.test.ts",
    red: "思考档位：只发 supported 里的档位 ⇒ pi 的 clamp 不会再改它（档位必在支持集里）",
    why: "不支持的档位照样发，pi 的 clamp 再把价格抬上去",
  },
  {
    feature: "没有 thinkingLevelMap 也不炸（resolveThinkingLevel）",
    file: "src/core/thinking.ts",
    from: "  const mapped = model.thinkingLevelMap?.[requested];",
    to: "  const mapped = model.thinkingLevelMap![requested];",
    test: "test/thinking.test.ts",
    red: "思考档位：reasoning=true 但没有 thinkingLevelMap ⇒ xhigh 落到 high（不炸）",
    redKeyword: "TypeError",
    why: "reasoning 模型没给档位图时读 undefined 直接抛 TypeError，派发整个失败",
  },
  {
    feature: "降级后的档位进 --model 后缀（buildPiArgv）",
    file: "src/core/child.ts",
    from: "    const modelArg = thinking ? `${model}:${thinking}` : model;",
    to: "    const modelArg = model;",
    test: "test/child.test.ts",
    red: "拼命令：降级后的档位进 --model 后缀（a/b:low）",
    why: "校验出来的档位没进 argv，孩子仍按会话默认跑",
  },
  {
    feature: "没给档位时不拼后缀（buildPiArgv）",
    file: "src/core/child.ts",
    from: "    const modelArg = thinking ? `${model}:${thinking}` : model;",
    to: '    const modelArg = `${model}:${thinking ?? "high"}`;',
    test: "test/child.test.ts",
    red: "拼命令：没给档位时不拼后缀（a/b 不带冒号）",
    why: "没给档位时擅自拼 high，替父方选了更贵的档",
  },
  {
    feature: "引擎回执带 thinking（受理时写进初始记录）",
    file: "src/core/engine.ts",
    from: "      ...(thinking ? { thinking: thinking.receipt } : {}),",
    to: "      ...(thinking ? { thinking: undefined } : {}),",
    test: "test/engine.test.ts",
    red: "引擎：thinking 降级写进回执（requested/effective/reason）",
    why: "回执里没有档位，父方不知道实际跑了哪一档",
  },
  {
    feature: "引擎 argv 用校验后的档位（#buildArgv）",
    file: "src/core/engine.ts",
    from:
      "    const resolved = this.#thinkingSuffixes.get(taskId);\n" +
      "    const thinkingLevel = this.#thinkingSuffixes.has(taskId)\n" +
      "      ? resolved\n" +
      "      : (input.thinkingLevel ?? undefined);",
    to: "    const thinkingLevel = input.thinkingLevel ?? undefined;",
    test: "test/engine.test.ts",
    red: "引擎：thinking 降级进 argv（medium ⇒ --model regex:test-vendor/group/main:low）",
    why: "argv 直接用请求档位（medium），降级结果没进 --model",
  },
  {
    feature: "引擎受理时钉死模型（#dispatchReady）",
    file: "src/core/engine.ts",
    from:
      "    const acceptedModel = effectiveModel({\n" +
      "      model: input.model,\n" +
      "      sessionModel: this.#sessionModel?.(),\n" +
      "    });\n" +
      "    if (acceptedModel !== undefined) input.model = acceptedModel;",
    to:
      "    const acceptedModel = effectiveModel({\n" +
      "      model: input.model,\n" +
      "      sessionModel: this.#sessionModel?.(),\n" +
      "    });\n" +
      "    if (false) input.model = acceptedModel;",
    test: "test/engine.test.ts",
    red: "引擎：受理时钉死模型（排队期间会话模型变了也不换）",
    why: "排队期间父会话换模型，argv 用新模型配旧档位",
  },
  {
    feature: "没给 model 时用会话模型查目录（effectiveModel）",
    file: "src/core/child.ts",
    from: "  const model = nonEmpty(options.model) ?? nonEmpty(options.sessionModel);",
    to: "  const model = nonEmpty(options.model);",
    test: "test/thinking.test.ts",
    red: "思考档位：没给 model 时用会话模型查目录",
    why: "继承会话模型时查不到目录 ⇒ 不校验",
  },
  // ── 成本控制：前缀稳定化（§2.3） ────────────────────────────────────────
  {
    feature: "附加块恒定（buildPiArgv）",
    file: "src/core/child.ts",
    from: '  argv.push("--append-system-prompt", CONTRACT_BLOCK);',
    to: '  argv.push("--append-system-prompt", CONTRACT_BLOCK + (options.why ?? ""));',
    test: "test/child.test.ts",
    red: "拼命令：附加块恒定（why 不进系统提示词）",
    why: "why 回到系统提示词，每个子代理的前缀都不同",
  },
  {
    feature: "why 进 user message（buildUserMessage）",
    file: "src/core/child.ts",
    from: '    options.why ? `<pi-dispatch-why>${escapeXmlText(options.why)}</pi-dispatch-why>` : "",',
    to: '    "",',
    test: "test/child.test.ts",
    red: "拼命令：why 进 user message",
    why: "why 丢了：孩子不知道动机",
  },
  {
    feature: "隔离契约进 user message（buildUserMessage）",
    file: "src/core/child.ts",
    from: '    options.isolation === "worktree" ? WORKTREE_CONTRACT_BLOCK : "",',
    to: '    "",',
    test: "test/child.test.ts",
    red: "拼命令：隔离契约进 user message，不进系统提示词",
    why: "隔离契约丢了：孩子不自建分支/不提交",
  },
  {
    feature: "user message 顺序是 任务 → why → 隔离契约",
    file: "src/core/child.ts",
    from:
      "    options.task,\n" +
      '    options.why ? `<pi-dispatch-why>${escapeXmlText(options.why)}</pi-dispatch-why>` : "",\n' +
      '    options.isolation === "worktree" ? WORKTREE_CONTRACT_BLOCK : "",',
    to:
      "    options.task,\n" +
      '    options.isolation === "worktree" ? WORKTREE_CONTRACT_BLOCK : "",\n' +
      '    options.why ? `<pi-dispatch-why>${escapeXmlText(options.why)}</pi-dispatch-why>` : "",',
    test: "test/child.test.ts",
    red: "拼命令：user message 的顺序是 任务 → why → 隔离契约",
    why: "隔离契约跑到 why 前面，孩子先看到环境约束、后看到任务动机",
  },
  {
    feature: "没有 why 也没有隔离时 user message == 任务原文（buildUserMessage）",
    file: "src/core/child.ts",
    from: "    options.task,",
    to: "    `${options.task}\\n`,",
    test: "test/child.test.ts",
    red: "拼命令：没有 why 也没有隔离时，user message 就是任务原文（argv 与今天逐字节相同）",
    why: "任务末尾多一个换行：argv 与今天不再逐字节相同",
  },
  {
    feature: "附加块逐字节冻结（CONTRACT_BLOCK）",
    file: "src/core/child.ts",
    from: 'export const CONTRACT_BLOCK = [SUBAGENT_CONTEXT_BLOCK, REPORT_CONTRACT_BLOCK].join("\\n");',
    to: 'export const CONTRACT_BLOCK = [SUBAGENT_CONTEXT_BLOCK, REPORT_CONTRACT_BLOCK].join("\\n\\n");',
    test: "test/child.test.ts",
    red: "golden：附加块逐字节等于冻结字面量（上下文 + 报告契约）",
    why: "契约块分隔符变了，跨子代理前缀不再逐字节相同",
  },
  {
    feature: "user message 逐字节冻结（buildUserMessage 的分隔符）",
    file: "src/core/child.ts",
    from: '    .filter(Boolean)\n    .join("\\n\\n");',
    to: '    .filter(Boolean)\n    .join("\\n");',
    test: "test/child.test.ts",
    red: "golden：user message 逐字节等于冻结字面量（任务 + why + 隔离契约）",
    why: "块间分隔符从两行变一行，冻结字面量对不上",
  },
  {
    feature: "理由里的 XML 实体被转义（buildUserMessage）",
    file: "src/core/child.ts",
    from: '    options.why ? `<pi-dispatch-why>${escapeXmlText(options.why)}</pi-dispatch-why>` : "",',
    to: '    options.why ? `<pi-dispatch-why>${options.why}</pi-dispatch-why>` : "",',
    test: "test/child.test.ts",
    red: "拼命令：理由里的 XML 实体被转义（不会伪造标签）",
    why: "why 里的 </pi-dispatch-why> 能伪造块边界",
  },
  // ── 成本控制：缓存复用可观测（cache-metrics） ─────────────────────────
  {
    feature: "首轮复用率只看第 0 轮",
    file: "src/core/cache-metrics.ts",
    from: "const first = turns[0]",
    to: "const first = turns[turns.length - 1]",
    test: "test/cache-metrics.test.ts",
    red: "缓存：只看首轮判判定，后续轮不参与",
    why: "后续轮天然复用高，判成「机制生效」——首轮冷启动被掩盖",
  },
  {
    feature: "增量命中率的分母取上下两轮较小值",
    file: "src/core/cache-metrics.ts",
    from: "Math.min(prev.promptTokens, cur.promptTokens)",
    to: "prev.promptTokens",
    test: "test/cache-metrics.test.ts",
    red: "缓存：增量命中率的上限是上下两轮 prompt 的较小值",
    why: "本轮 prompt 比上轮短时命中率被低估——compaction 后看着像没共享",
  },
  {
    feature: "健康判定用 0.5 阈值",
    file: "src/core/cache-metrics.ts",
    from: "reuse >= HEALTHY_REUSE",
    to: "reuse >= 0.99",
    test: "test/cache-metrics.test.ts",
    red: "缓存：首轮复用率高于 0.5 判 healthy",
    why: "0.9 的首轮复用被判成 partial——健康线失守，机制生效也报警",
  },
  {
    feature: "形状分组按工具名单排序",
    file: "src/core/cache-metrics.ts",
    from: "tools: [...shape.tools].sort()",
    to: "tools: [...shape.tools]",
    test: "test/cache-metrics.test.ts",
    red: "缓存：工具名单顺序不影响分组",
    why: "同一组工具换个顺序就算不同前缀组，组数 G 被高估",
  },
  {
    feature: "tracker 累加总额也记明细",
    file: "src/core/child.ts",
    from: "turns.push(turnUsageOf(takeUsage(message.usage)));\n    usage = addUsage(usage, takeUsage(message.usage));",
    to: "usage = addUsage(usage, takeUsage(message.usage)); /* 不记明细 */",
    test: "test/child.test.ts",
    red: "用量：tracker 留住逐轮明细",
    why: "只剩总额没有逐轮——首轮复用率算不出来，缓存观测整个瞎掉",
  },
  // ── 成本控制：关掉预热（§2.4） ──────────────────────────────────────────
  {
    feature: "孩子侧关预热（cacheWarmingDecision）",
    file: "src/core/cache-warming.ts",
    from: '  return depth > 0 ? { action: "stop" } : undefined;',
    to: "  return depth > 0 ? undefined : undefined;",
    test: "test/budget.test.ts",
    red: "成本：depth>0 的孩子关掉 cache 预热（action=stop）",
    why: "孩子的预热照跑，为没人用的热缓存花钱",
  },
  {
    feature: "父会话不表态（cacheWarmingDecision）",
    file: "src/core/cache-warming.ts",
    from: '  return depth > 0 ? { action: "stop" } : undefined;',
    to: '  return depth > 0 ? { action: "stop" } : { action: "stop" };',
    test: "test/budget.test.ts",
    red: "成本：父会话（depth=0）不表态（不返回 action，预热照旧）",
    why: "父会话的预热被关掉（父会话长命，预热对它有用）",
  },
  {
    feature: "depth=2 也关预热（cacheWarmingDecision）",
    file: "src/core/cache-warming.ts",
    from: '  return depth > 0 ? { action: "stop" } : undefined;',
    to: '  return depth === 1 ? { action: "stop" } : undefined;',
    test: "test/budget.test.ts",
    red: "成本：depth=2 的孩子也关掉 cache 预热",
    why: "套娃子代理漏关，整棵子树没关干净",
  },
  {
    feature: "适配层注册预热钩子（工厂层）",
    file: "src/index.ts",
    from: '      pi.on("cache_warming_decision", () => cacheWarmingDecision(depth));',
    to: '      pi.on("cache_warming_decision", () => undefined);',
    test: "test/adapter.test.ts",
    red: "适配层：子代理进程（depth>0）注册 cache_warming_decision 并返回 stop",
    why: "钩子注册了却不说 stop，孩子照样预热",
  },
  {
    feature: "父进程不注册钩子（工厂层的 depth 判断）",
    file: "src/index.ts",
    from: "    if (depth > 0) {",
    to: "    if (true) {",
    test: "test/adapter.test.ts",
    red: "适配层：父进程不注册 cache_warming_decision",
    redKeyword: "父会话预热照旧",
    why: "父会话的预热也被关掉",
  },
  {
    feature: "老版本 pi 注册未知事件不炸（工厂层的 try/catch）",
    file: "src/index.ts",
    from: '      pi.on("cache_warming_decision", () => cacheWarmingDecision(depth));\n    }\n  } catch {',
    to: '      pi.on("cache_warming_decision", () => cacheWarmingDecision(depth));\n    }\n  } finally {',
    test: "test/adapter.test.ts",
    red: "适配层：pi 不认识 cache_warming_decision 时不炸",
    why: "老版本 pi 上注册未知事件抛出，整条派发链断掉",
  },
  {
    feature: "空跑不算交付（判词 absent）",
    file: "src/core/child.ts",
    from: '  if (!record.report && (record.delivery?.textChars ?? 0) === 0) return "absent";',
    to: '  if (!record.report && (record.delivery?.textChars ?? 0) === 0) return "unverified";',
    test: "test/core-logic.test.ts",
    red: "状态机：判词取核对结果，不取退出码——空跑退 0 是 succeeded + absent",
    why: "空跑被记成「有正文没报告」，账上又只剩含糊的一档",
  },
  {
    feature: "判词真的落账（单一收口在 registry）",
    file: "src/core/registry.ts",
    from: '  return to === "succeeded" ? { deliverable: deliverableOf(current) } : {};',
    to: '  return to === "succeeded" ? { deliverable: "verified" as const } : {};',
    test: "test/core-logic.test.ts",
    red: "状态机：判词取核对结果，不取退出码——空跑退 0 是 succeeded + absent",
    why: "所有退 0 的任务一律上报可信",
  },
  {
    feature: "一条对上不能洗白整张表（改动覆盖度）",
    file: "src/core/child.ts",
    from: "  return hit.length > 0 && hit.length < claims.length",
    to: "  return hit.length > 0 && hit.length < 0",
    test: "test/child.test.ts",
    red: "交付核对：五条自述只对上一条 ⇒ 部分覆盖（一条对上不能洗白整张表）",
    why: "部分命中不报，塞一条对上的就能把五条自述洗成全绿",
  },
  {
    feature: "一条对上不能洗白整张表（自检覆盖度）",
    file: "src/core/child.ts",
    from: "  return seen.length > 0 && seen.length < claims.length",
    to: "  return seen.length > 0 && seen.length < 0",
    test: "test/child.test.ts",
    red: "自检对质：五条声称只对上一条 ls ⇒ 部分覆盖（塞一条跑过的命令不能洗白）",
    why: "跑一条 ls 就洗白五条自检",
  },
  {
    feature: "读过不算改过（读类工具不进收据）",
    file: "src/core/child.ts",
    from: "  if (READ_ONLY_TOOLS.includes(toolName)) return;",
    to: "  if (READ_ONLY_TOOLS.includes(toolName) && false) return;",
    test: "test/child.test.ts",
    red: "收件：读不算改过——read/grep 的 path 不进收据，bash 的也不进",
    why: "把声称改过的文件读一遍就能对上，覆盖度再严也没用",
  },
  {
    feature: "收据截断过就不判对不上",
    file: "src/core/child.ts",
    from: "  if (claims.length === 0 || !delivery || delivery.pathsTruncated) return false;",
    to: "  if (claims.length === 0 || !delivery) return false;",
    test: "test/child.test.ts",
    red: "收据：截断过就不判对不上——丢的是证据，不是罪证",
    why: "收据被上限挤掉的条目被当成「没改过」，冤枉真干活的孩子",
  },
  {
    feature: "小窗只认判词（不是有报告就给）",
    file: "src/index.ts",
    from: '  return result.deliverable === "verified" || result.deliverable === "unclaimed";',
    to: "  return Boolean(result.report);",
    test: "test/adapter.test.ts",
    red: "归约：小窗只认判词——报告齐全但判词没到（或不是 verified/unclaimed）⇒ 大窗",
    why: "未核实的报告也能换到 8KB 信任档，主动洗白",
  },
  {
    feature: "tarball 只发运行件（files 不漏入口）",
    file: "package.json",
    from: '    "dist/**/*.js",',
    to: '    "src/**/*.ts",',
    test: "test/packaging.test.ts",
    red: "打包：只发运行件——dist 在，src/test/scripts 不在",
    why: "files 漏了 dist，装出来是空包；塞 src 则用户背一份跑不了的源码",
  },
  {
    feature: "清扫带宽限（粗粒度 mtime 的 fs 上不误杀刚建的桶）",
    file: "scripts/test.ts",
    from: "export const SWEEP_SLACK_MS = 2000;",
    to: "export const SWEEP_SLACK_MS = 0;",
    test: "test/test-runner.test.ts",
    red: "门禁清扫：只删上一轮遗留的临时桶，本轮的不动（mutate 并行时不许误杀）",
    why: "CI 的 overlayfs mtime 只到秒，半秒前建的桶被当成上一轮遗留删掉",
  },
  {
    feature: "截断的收据不给盖章（有自述就没法对质）",
    file: "src/core/child.ts",
    from: "    (record.delivery?.pathsTruncated && (record.report.files_touched?.length ?? 0) > 0) ||",
    to: "    false ||",
    test: "test/child.test.ts",
    red: "交付判词：五档全钉住",
    why: "攒满 20 条收据后随便写就能换到 verified（21 条命令是正常工作强度）",
  },
  {
    feature: "README 的安装名不指向别人的同名包",
    file: "README.md",
    from: "pi install git:github.com/a1121611810/pi-dispatch",
    to: "pi install npm:pi-dispatch",
    test: "test/packaging.test.ts",
    red: "打包：README 不用 npm 上的同名包（那个名字是别人的项目）",
    why: "照 README 装会装上别人的扩展（npm 上 pi-dispatch 归 vincenthopf）",
  },
];

/** 数一个子串在文本里出现几次。 */
function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** TAP 里是否有一条以该标题通过的用例（必须锚行首，"not ok" 里也含 "ok 1 -"）。 */
function isGreen(tap: string, title: string): boolean {
  return new RegExp(`^ok \\d+ - ${escapeRe(title)}$`, "m").test(tap);
}

/** TAP 里是否有一条以该标题失败的用例。 */
function isRed(tap: string, title: string): boolean {
  return new RegExp(`^not ok \\d+ - ${escapeRe(title)}`, "m").test(tap);
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** TAP 里指名用例的失败块（not ok 段）。找不到就返回空串。 */
function failureBlock(tap: string, title: string): string {
  const lines = tap.split("\n");
  const start = lines.findIndex(
    (line) => line.startsWith(`not ok `) && line.includes(`- ${title}`),
  );
  if (start < 0) return "";
  const end = lines.findIndex((line, index) => index > start && line.trimEnd() === "  ...");
  return lines.slice(start, end > start ? end : lines.length).join("\n");
}

/** 单条指名用例的超时：挂死也要变红，不能把单实例门禁拖死。 */
export const RUN_TIMEOUT_MS = 120_000;

/** 跑一条指名用例，返回 TAP 原文。环境要擦干净：在测试进程/子代理里否则一条用例都不跑。 */
export function runOne(file: string, red: string, timeoutMs = RUN_TIMEOUT_MS): string {
  try {
    return execFileSync(
      process.execPath,
      ["--test", "--test-reporter=tap", `--test-name-pattern=${escapeRe(red)}`, file],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: scrubbedEnv(),
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      },
    );
  } catch (error) {
    // 非零退出也可能带着 TAP 输出——照读，归属判断只看文本
    const e = error as { stdout?: string; stderr?: string; code?: string };
    // 超时 = 子进程挂死（读 FIFO、死循环）：返回空 TAP ⇒ check 自然判 bad-title / wrong-red，
    // 不新增 outcome（挂死不是「红在断言上」，更不是通过）。
    if (e.code === "ETIMEDOUT") return "";
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

export type Outcome =
  | "killed"
  | "survived"
  | "wrong-red"
  | "bad-anchor"
  | "bad-title"
  | "bad-syntax";

export function check(bp: Breakpoint): { outcome: Outcome; note: string } {
  const source = readFileSync(bp.file, "utf8");

  // 锚点必须恰好出现一次
  const hits = countOf(source, bp.from);
  if (hits !== 1) return { outcome: "bad-anchor", note: `锚点出现 ${hits} 次` };

  // 前置：不改源码时，指名用例必须存在且是绿的
  const before = runOne(bp.test, bp.red);
  if (!isGreen(before, bp.red)) {
    const zeroMatch = isGreen(before, bp.test);
    return { outcome: "bad-title", note: zeroMatch ? "标题 0 命中（写错）" : "原本不是绿的" };
  }

  try {
    writeFileSync(bp.file, source.replace(bp.from, bp.to), "utf8");
    const after = runOne(bp.test, bp.red);
    if (isGreen(after, bp.red)) return { outcome: "survived", note: "改了还是绿的" };
    if (isRed(after, bp.red)) {
      // 红在指名用例上还不够：得红在**断言**上（或该 case 声明的关键字上）。
      // 无关的 TypeError 让用例炸掉，也会输出 "not ok 1 - <标题>"——
      // 那不是这个功能点坏了，是别的坏了 ⇒ 记 wrong-red。
      // 块只取本用例那一段：吃到 TAP 末尾会把下一条的断言算成自己的。
      const block = failureBlock(after, bp.red);
      const killed =
        block.includes("ERR_ASSERTION") ||
        (bp.redKeyword !== undefined && block.includes(bp.redKeyword));
      if (!killed)
        return {
          outcome: "wrong-red",
          note: bp.redKeyword
            ? `失败消息既不是断言失败，也不含锚点关键字「${bp.redKeyword}」`
            : "红在无关异常上（不是断言失败）",
        };
      return { outcome: "killed", note: "" };
    }
    if (isGreen(after, bp.test)) return { outcome: "bad-title", note: "变异后 0 命中" };
    return { outcome: "wrong-red", note: "红了，但不是指名的那条" };
  } catch (error) {
    return { outcome: "bad-syntax", note: (error as Error).message.split("\n")[0] ?? "" };
  } finally {
    writeFileSync(bp.file, source, "utf8"); // 无论成败都复原
  }
}

function main(): void {
  const filter = process.argv.slice(2);
  const cases = filter.length
    ? CASES.filter((c) => filter.some((f) => c.feature.includes(f)))
    : CASES;
  if (cases.length === 0) {
    console.error("没有匹配的功能点");
    process.exit(2);
  }

  const bad: Array<{ bp: Breakpoint; outcome: Outcome; note: string }> = [];
  for (const bp of cases) {
    const { outcome, note } = check(bp);
    const mark = outcome === "killed" ? "✅" : "❌";
    console.log(`${mark} ${outcome.padEnd(11)} ${bp.feature}${note ? ` — ${note}` : ""}`);
    if (outcome !== "killed") bad.push({ bp, outcome, note });
  }

  console.log(`\n${cases.length - bad.length}/${cases.length} 红在该红的测试用例上`);
  if (bad.length > 0) {
    console.log("不通过：");
    for (const { bp, outcome, note } of bad) {
      console.log(`  ❌ [${outcome}] ${bp.feature} — ${note}`);
      console.log(`     ${bp.file}`);
      console.log(`     该红：${bp.red}`);
    }
    process.exit(3);
  }
}

if (isDirectInvocation(process.argv[1], fileURLToPath(import.meta.url))) main();
