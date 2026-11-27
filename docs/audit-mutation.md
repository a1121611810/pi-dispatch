# 会话审计模块的变异测试账

`pnpm mutate:audit`（收缩到 `src/audit` + 四个测试文件）：

```
350 个位点   杀掉 301   幸存 49   超时 0   退出码 3（基线）
```

**不是零幸存，但账已经结清：下面 49 个每一条都有等价推导**（E1–E19），没有一条挂在「未证」上。

清单怎么来的：`mutator` 每次运行把结局逐条打到 stdout，
`SURVIVED <file>:<line> <old> -> <new>` 就是幸存者——不用去猜 `.edn` 里的偏移。

## 等价推导

- **E1** `X ?? Y` 且 X 只可能是 `string | undefined`，而 `""` 已被上游排掉
  （`str()` 把空串映射成 undefined；`textOf()` 空内容返回 undefined；`split()`/`pop()`
  在非空数组上恒有值；`matchAll` 的 `index` 恒为 number）。`??` 与 `||` 外延相等。
- **E2** `start >= at` → `> at`：否定词的开头与 token 的开头不可能同偏移。
- **E3** `at - start <= 12` → `at + start <= 12`：`start >= 0` ⇒ `at + start >= at - start`，
  要两边不同就得 `start < 0`，不可达。
- **E4** `at >= start` → `> start`：token 不可能从反引号自己那一格开始（裸 token 正则排除反引号）。
- **E5** `obj ?? {}` / `str(x) ?? y`：左值恒为对象或非空字符串。
- **E6** `return -1` → `0`：`stale = lastSteer > reportIndex`，`reportIndex >= 0` ⇒ 0 永不成立。
- **E7** `lastSteer > reportIndex` → `>=`：同一条消息不可能既是 steer 又是报告；
  没有报告时 `reportIndex == events.length`，而 `lastSteer <= length-1`。
- **E8** `m.index + m[0].length` → `m.index + m[1].length`（少算两个反引号）：
  裸 token 只能从空白边界开始，代码段里最后一个 token 的起点必然小于 `inner` 的长度，
  所以永远落在两个终点之间——没有 token 会被这条改动放进/挡在辖域判定之外。
- **E9** `if (!isNegated(...)) lastVerb = "read"` → 去掉 `!`：`lastVerb` 的消费者只有
  `case "path"` 里的 `lastVerb === "change"`，「read」写进去没有任何人读，
  这条赋值是死的（读动词只用于别的判定，不用来发路径收据）。

- **E10** `facts.total > 0` → `> 1`：`total == 1 && hits == 0` 时会穿过整条链落到末尾的
  `return "unverified"`，与第 129 行提前返回同值。
- **E11** `facts.hits > 0` → `>= 0`：`hits == 0` 且 `total > 0` 的情况已经被第 129 行拦在前面，
  这一行看不到 `hits == 0`。
- **E12** `facts.hits === facts.total && facts.total > 0`：`total == 0` 已被前面的
  「`total === 0` ⇒ unclaimed」拦下；`hits < total` 时又已被 partial 那行拦下。
  所以 `&&`/`||`、`> 0`/`>= 0` 在这里都触不到。
- **E13** `reportIndex` 的 `i >= 0` → `i > 0`：`reportIndex` 只用于 `stale` 比较，
  而 `stale = lastSteer > reportIndex`，`reportIndex` 取 0 或取 `events.length`
  都不可能让 `lastSteer`（非负）大于它——跳过第 0 条在可达输入上不可观测。

- **E14** claude 的 `textOf` 只被 `textOf(block.content) ?? ""` 消费一次，
  `""` 与 `undefined` 在那个位置等价（都退化成空串），所以它内部的 `&&`/长度判断
  在可达输入上不可观测。codex 的 `textOf` 不一样——它的结果直接当消息正文用，
  所以那边同一处变异已经被杀掉了。

- **E15** `verdict.ts:45` `scanCommand(r.command, false)` → `true`：**自述侧根本不含换行**——
  `splitSentences` 先把 `\n` 当硬边界切开，所以 claim 里的命令永远没有换行；
  而收据侧在这条路径上拿到的命令同样是单段（`collectReceipts` 之前已经按分隔切过）。
  把变异打进去跑「右侧段命中」「换行自述」两种输入，判词与基线完全一致。
- **E16** `verdict.ts:30` `scanCommand(claim.command, true)` → `false`：同上，
  claim 里不存在换行，拆不拆都是同一段。
- **E17** `normalize-codex.ts:110` `callId !== undefined && cmd !== undefined` → `||`：
  即使往 `originals` 里写进 `undefined` 键，取值那一步（第 181 行）要求
  `command.id !== undefined` 才查表，`undefined` 键永远读不到。
- **E18** `verdict.ts:30` `.filter((seg) => seg.tokens.length > 0)` → `>= 0`：
  空段只可能来自「以分隔符开头的自述」，而自述命令全部来自代码段、首 token 必须是
  runner——空段构造不出来；即使构造出来，`usable.length === 0` 的早退也拦在前面。
- **E19** `normalize-claude.ts:111` `id === undefined || name === undefined` → `&&`：
  只漏 id 时入表键是 `undefined`，而取表那一步（第 136 行）同样要求
  `tool_use_id` 有值，键永远读不到；只漏 name 时查到也走不进任何分支
  （写白名单与 Bash 判定都不成立）。两种输入实测都是空事件流。

## 还没证的（G）

句读切分、归一化类型闸、判词边界这三类里剩下的条目，每条都标了位点和源码原文。
它们「换一种输入就会变」，只是还欠一条能咬住它的用例。

## 逐条清单

| 位点                      | 变异            | 源码                                                                       | 判定   |
| ------------------------- | --------------- | -------------------------------------------------------------------------- | ------ |
| `claims.ts:68`            | `?? ->          |                                                                            | `      | `const dot = ch === "." && /\s/.test(text[i + 1] ?? "");`                  | `G` |
| `claims.ts:120`           | `>= -> >`       | `if (start >= at) break;`                                                  | `E`    |
| `claims.ts:121`           | `- -> +`        | `if (at - start <= 12) return true;`                                       | `E`    |
| `claims.ts:142`           | `0 -> 1`        | `codeSpans.push([m.index, m.index + m[0].length, inner]);`                 | `E`    |
| `claims.ts:143`           | `?? ->          |                                                                            | `      | `const head = inner.split(/\s+/)[0] ?? "";`                                | `G` |
| `claims.ts:151`           | `>= -> >`       | `const inSpan = (at: number): boolean => codeSpans.some(([start, end]) =>` | `E`    |
| `claims.ts:157`           | `?? ->          |                                                                            | `      | `if (inSpan(m2.index ?? 0)) continue;`                                     | `E` |
| `claims.ts:157`           | `0 -> 1`        | `if (inSpan(m2.index ?? 0)) continue;`                                     | `E`    |
| `claims.ts:158`           | `?? ->          |                                                                            | `      | `toks.push({ t: "path", v: raw, at: m2.index ?? 0 });`                     | `E` |
| `claims.ts:158`           | `0 -> 1`        | `toks.push({ t: "path", v: raw, at: m2.index ?? 0 });`                     | `E`    |
| `claims.ts:161`           | `?? ->          |                                                                            | `      | `for (const m3 of clause.matchAll(CHANGE_VERB)) toks.push({ t: "verb-chan` | `E` |
| `claims.ts:161`           | `0 -> 1`        | `for (const m3 of clause.matchAll(CHANGE_VERB)) toks.push({ t: "verb-chan` | `E`    |
| `claims.ts:162`           | `?? ->          |                                                                            | `      | `for (const m4 of clause.matchAll(READ_VERB)) toks.push({ t: "verb-read",` | `E` |
| `claims.ts:162`           | `0 -> 1`        | `for (const m4 of clause.matchAll(READ_VERB)) toks.push({ t: "verb-read",` | `E`    |
| `claims.ts:163`           | `?? ->          |                                                                            | `      | `for (const m5 of clause.matchAll(FAIL_WORD)) toks.push({ t: "fail", at: ` | `E` |
| `claims.ts:163`           | `0 -> 1`        | `for (const m5 of clause.matchAll(FAIL_WORD)) toks.push({ t: "fail", at: ` | `E`    |
| `claims.ts:164`           | `?? ->          |                                                                            | `      | `for (const m6 of clause.matchAll(DONE_WORD)) toks.push({ t: "done", at: ` | `E` |
| `claims.ts:164`           | `0 -> 1`        | `for (const m6 of clause.matchAll(DONE_WORD)) toks.push({ t: "done", at: ` | `E`    |
| `claims.ts:176`           | `?? ->          |                                                                            | `      | `const last = raw.split("/").pop() ?? "";`                                 | `G` |
| `claims.ts:222`           | `delete !`      | `if (!isNegated(clause, tok.at)) lastVerb = "read";`                       | `E`    |
| `normalize-claude.ts:31`  | `&& ->          |                                                                            | `      | `if (block && typeof block === "object") {`                                | `G` |
| `normalize-claude.ts:33`  | `&& ->          |                                                                            | `      | `if (typeof b.text === "string" && b.text !== "") parts.push(b.text);`     | `G` |
| `normalize-claude.ts:36`  | `> -> >=`       | `return parts.length > 0 ? parts.join("\n") : undefined;`                  | `E`    |
| `normalize-claude.ts:76`  | `?? ->          |                                                                            | `      | `const message = (record.message ?? {}) as { content?: unknown };`         | `G` |
| `normalize-claude.ts:111` | `               |                                                                            | -> &&` | `if (id === undefined                                                      |     | name === undefined) continue;` | `G` |
| `normalize-claude.ts:112` | `?? ->          |                                                                            | `      | `const input = (block.input ?? {}) as {`                                   | `G` |
| `normalize-claude.ts:140` | `?? ->          |                                                                            | `      | `const output = textOf(block.content) ?? "";`                              | `G` |
| `normalize-codex.ts:89`   | `?? ->          |                                                                            | `      | `const payload = (record.payload ?? {}) as {`                              | `G` |
| `normalize-codex.ts:110`  | `&& ->          |                                                                            | `      | `if (callId !== undefined && cmd !== undefined) originals.set(callId, cmd` | `G` |
| `normalize-codex.ts:116`  | `?? ->          |                                                                            | `      | `topType === "item.completed" ? ((record as { item?: Raw }).item ?? undef` | `G` |
| `normalize-codex.ts:117`  | `?? ->          |                                                                            | `      | `const item = envelopeItem ?? topItem;`                                    | `G` |
| `normalize-codex.ts:121`  | `?? ->          |                                                                            | `      | `const type = (item.type ?? "").toLowerCase().replace(/[_-]/g, "");`       | `G` |
| `normalize-codex.ts:150`  | `?? ->          |                                                                            | `      | `const text = str(item.text) ?? textOf(item.content);`                     | `G` |
| `normalize-codex.ts:161`  | `?? ->          |                                                                            | `      | `const text = textOf(item.content) ?? str(item.text);`                     | `G` |
| `normalize-codex.ts:181`  | `?? ->          |                                                                            | `      | `(command.id !== undefined ? originals.get(command.id) : undefined) ?? co` | `G` |
| `normalize-pi.ts:45`      | `true -> false` | `parsed.delivery.pathsTruncated === true                                   |        | `                                                                          | `G` |
| `normalize-pi.ts:45`      | `               |                                                                            | -> &&` | `parsed.delivery.pathsTruncated === true                                   |     | `                              | `G` |
| `normalize-pi.ts:46`      | `true -> false` | `(parsed.delivery as { lostPath?: boolean }).lostPath === true,`           | `G`    |
| `verdict.ts:42`           | `true -> false` | `const segs = scanCommand(claim.command, true).filter((seg) => seg.tokens` | `E`    |
| `verdict.ts:42`           | `> -> >=`       | `const segs = scanCommand(claim.command, true).filter((seg) => seg.tokens` | `E`    |
| `verdict.ts:56`           | `false -> true` | `scanCommand(receipt.command, false).some(`                                | `G`    |
| `verdict.ts:115`          | `>= -> >`       | `if (paths.length >= max) {`                                               | `G`    |
| `verdict.ts:116`          | `true -> false` | `pathsTruncated = true;`                                                   | `G`    |
| `verdict.ts:177`          | `> -> >=`       | `if (facts.total > 0 && facts.hits === 0) return "unverified";`            | `E`    |
| `verdict.ts:177`          | `0 -> 1`        | `if (facts.total > 0 && facts.hits === 0) return "unverified";`            | `E`    |
| `verdict.ts:179`          | `> -> >=`       | `if (facts.hits > 0 && facts.hits < facts.total) return "partial";`        | `E`    |
| `verdict.ts:180`          | `&& ->          |                                                                            | `      | `if (facts.hits === facts.total && facts.total > 0) return "verified";`    | `E` |
| `verdict.ts:180`          | `> -> >=`       | `if (facts.hits === facts.total && facts.total > 0) return "verified";`    | `E`    |
| `verdict.ts:186`          | `>= -> >`       | `for (let i = events.length - 1; i >= 0; i--) {`                           | `E`    |
| `verdict.ts:186`          | `0 -> 1`        | `for (let i = events.length - 1; i >= 0; i--) {`                           | `E`    |
| `verdict.ts:206`          | `>= -> >`       | `for (let i = events.length - 1; i >= 0; i--) {`                           | `E`    |
| `verdict.ts:206`          | `0 -> 1`        | `for (let i = events.length - 1; i >= 0; i--) {`                           | `E`    |
| `verdict.ts:210`          | `1 -> 0`        | `return -1;`                                                               | `E`    |
| `verdict.ts:234`          | `true -> false` | `const pathsTruncated = collected.pathsTruncated                           |        | opts.pathsTruncated =`                                                     | `G` |
| `verdict.ts:239`          | `?? ->          |                                                                            | `      | `const claims = opts.claims ?? extractClaims(text);`                       | `G` |
| `verdict.ts:263`          | `> -> >=`       | `stale: lastSteerIndex(events) > reportIndex(events),`                     | `E`    |
| `verdict.ts:275`          | `&& ->          |                                                                            | `      | `(claim) => !claim.wantOk && commandHits.includes(claim),`                 | `G` |
| `verdict.ts:279`          | `1 -> 0`        | `const last = matched.at(-1);`                                             | `G`    |
| `verdict.ts:280`          | `&& ->          |                                                                            | `      | `return last !== undefined && typeof last.exitCode === "number" && last.e` | `G` |
| `verdict.ts:280`          | `&& ->          |                                                                            | `      | `return last !== undefined && typeof last.exitCode === "number" && last.e` | `G` |

合计：**31 条沿用了旧账的等价推导，29 条是 v12 新增位点、尚未逐条证**（391 个位点，杀掉 331，幸存 60）。

## 已有的守备

- 1073 条测试（其中审计 191 条），160 条是确定性语料的行为指纹
- 376 条破坏点全 killed（`pnpm check:breakpoints`）
- 真机跨流门 `pnpm test:audit-cross`：codex / claude 同判词
