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

type Breakpoint = {
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
  /** 弄坏之后什么表现坏掉 */
  why: string;
};

// 写不出单行破坏点的功能点（不静默缺）：
//   听 close 不听 exit —— 实测 1MB 输出在 exit 事件前已读空；shell 造不出确定性差异。
//                        实现仍按规格用 close；这条只能靠读代码守。
//   座位上限不超发 —— 座位数与池子两道上限互为备份，单行破坏点打不破，行为不变。
//   定终态先于还座位 —— 缺陷是语句顺序，文本替换表达不了。
//   收件四样一起收 —— 顺序无关。

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
    feature: "派发开关关着要退回",
    file: "src/core/gates.ts",
    from: '    isEnabled() ? null : rejection("dispatch is disabled：不再收新的派发，在飞任务不受影响");',
    to: "    isEnabled() ? null : null;",
    test: "test/core-logic.test.ts",
    red: "安检 2：派发开关是谓词不是值——中途改要立刻生效",
    why: "关掉派发后仍然接新任务",
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
    from: '      ? rejection("task 不能以 - 开头：pi 会把它当命令行选项")',
    to: "      ? null",
    test: "test/core-logic.test.ts",
    red: "安检 6：以横线开头的任务要拒（pi 会当命令行选项）",
    why: "pi 把任务当命令行选项，可能假装成功",
  },
  {
    feature: "超时必须是正数",
    file: "src/core/gates.ts",
    from: '  (typeof input.timeoutMs !== "number" || !Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0)',
    to: '  (typeof input.timeoutMs !== "number" || !Number.isFinite(input.timeoutMs) || input.timeoutMs < 0)',
    test: "test/core-logic.test.ts",
    red: "安检：timeoutMs 必须是正数",
    why: "timeoutMs 0 被当成有效时限",
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
    to: "    const current = this.#require(id);\n    if (!ALLOWED_TRANSITIONS[current.status].includes(to)) {",
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
    from: '          return this.#move(command.id, command.exitCode === 0 ? "succeeded" : "failed", {',
    to: '          return this.#move(command.id, command.exitCode === 1 ? "succeeded" : "failed", {',
    test: "test/core-logic.test.ts",
    red: "状态机：queued → running → succeeded 走通",
    why: "跑成功却记成失败",
  },
  {
    feature: "叫停过的收完算取消",
    file: "src/core/registry.ts",
    from: '        if (current.status === "stopping") return this.#move(command.id, "canceled", {});',
    to: '        if (current.status === "stopping") return this.#move(command.id, "failed", {});',
    test: "test/core-logic.test.ts",
    red: "状态机：stopping 的子代理收完算 canceled",
    why: "用户主动停的显示成失败",
  },
  {
    feature: "只有排队中的能被抽掉",
    file: "src/core/registry.ts",
    from: '        if (current.status !== "queued")',
    to: "        if (false)",
    test: "test/core-logic.test.ts",
    red: "状态机：cancel-queued 只对 queued 生效",
    why: "在跑的任务被 cancel-queued 改名，实际还在跑",
  },
  {
    feature: "挤掉时最老先出",
    file: "src/core/registry.ts",
    from: "      if (at !== bt) return at - bt;",
    to: "      if (at !== bt) return bt - at;",
    test: "test/core-logic.test.ts",
    red: "状态机：挤掉的是最老的那条（按结束时刻）",
    why: "挤掉的是最新的，取证价值最高的先没",
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
    from: '  return !taskId.includes("/") && !taskId.includes("\\\\") && !taskId.includes("..");',
    to: '  return !taskId.includes("/");',
    test: "test/storage.test.ts",
    red: "编号安全：斜杠、反斜杠、两个点都拒",
    why: "路径穿越，写到桶外",
  },
  {
    feature: "坏记录不拖垮启动",
    file: "src/core/storage.ts",
    from: "      } catch {\n        // 单条坏记录不拖垮启动\n      }",
    to: "      } catch (error) {\n        throw error;\n      }",
    test: "test/storage.test.ts",
    red: "记录：坏文件不拖垮启动，跳过继续",
    why: "一条坏记录让整个会话起不来",
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
    from: '        env: { ...process.env, LC_ALL: "C" },',
    to: "        env: process.env,",
    test: "test/storage.test.ts",
    red: "locale：中文环境下进程启动时刻仍读得到（ps 输出带 LC_ALL=C）",
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
    from: '    const tools = options.allowScripts ? [...READ_ONLY_TOOLS, "codemode"] : READ_ONLY_TOOLS;',
    to: "    const tools = READ_ONLY_TOOLS;",
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
    feature: "allowScripts 缺省用会话默认值",
    file: "src/core/engine.ts",
    from: "      allowScripts: rawInput.allowScripts ?? this.#allowScriptsDefault(),",
    to: "      allowScripts: rawInput.allowScripts ?? false,",
    test: "test/engine.test.ts",
    red: "引擎：allowScripts 缺省用会话默认值",
    why: "会话默认开着却用不上",
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
    from: '  const declared = childLog.includes("- codemode");',
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
    from: '  if (candidate && typeof candidate.summary === "string")\n    acc.toolReport = normalizeReport(candidate);',
    to: '  if (candidate && typeof candidate.summary === "string")\n    acc.toolReport = candidate;',
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
    from: '        const hint = n.deliveryUnverified\n          ? "｜报告里的改动没有实测支撑（查 dispatch_list 复核）"\n          : "";',
    to: '        const hint = "";',
    test: "test/adapter.test.ts",
    red: "deliver：未核实的交付在通知里写出警告",
    why: "标记随通知到了，但父方看不见",
  },
  {
    feature: "通知警告不许恒显",
    file: "src/index.ts",
    from: '        const hint = n.deliveryUnverified\n          ? "｜报告里的改动没有实测支撑（查 dispatch_list 复核）"\n          : "";',
    to: '        const hint = "｜报告里的改动没有实测支撑（查 dispatch_list 复核）";',
    test: "test/adapter.test.ts",
    red: "deliver：把待投递的通知发成一条 custom 消息（编号前缀 + 状态）",
    why: "每条完成通知都带警告，标注本身失去意义",
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

/** 跑一条指名用例，返回 TAP 原文。 */
function runOne(file: string, red: string): string {
  try {
    return execFileSync(
      process.execPath,
      ["--test", "--test-reporter=tap", `--test-name-pattern=${escapeRe(red)}`, file],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    // 非零退出也可能带着 TAP 输出——照读，归属判断只看文本
    const e = error as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

type Outcome = "killed" | "survived" | "wrong-red" | "bad-anchor" | "bad-title" | "bad-syntax";

function check(bp: Breakpoint): { outcome: Outcome; note: string } {
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
    if (isRed(after, bp.red)) return { outcome: "killed", note: "" };
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

main();
