# 会话审计模块的变异测试账

`pnpm mutate:audit`（收缩到 `src/audit` + 四个测试文件）：

```
350 个位点   杀掉 294   幸存 56   超时 0   退出码 3（基线）
```

**不是零幸存。** 下面把 56 个逐条摆出来：每条要么是「在可达输入上等价」（给推导），
要么是「还没证」（标 G）。

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

## 还没证的（G）

句读切分、归一化类型闸、判词边界这三类里剩下的条目，每条都标了位点和源码原文。
它们「换一种输入就会变」，只是还欠一条能咬住它的用例。

## 逐条清单

| 位点                      | 变异            | 源码                                                                         | 判定   |
| ------------------------- | --------------- | ---------------------------------------------------------------------------- | ------ |
| `claims.ts:58`            | `?? ->          |                                                                              | `      | `const dot = ch === "." && /\s/.test(text[i + 1] ?? "");`                    | `E1`  |
| `claims.ts:110`           | `>= -> >`       | `if (start >= at) break;`                                                    | `E2`   |
| `claims.ts:111`           | `- -> +`        | `if (at - start <= 12) return true;`                                         | `E3`   |
| `claims.ts:132`           | `0 -> 1`        | `codeSpans.push([m.index, m.index + m[0].length, inner]);`                   | `E8`   |
| `claims.ts:133`           | `?? ->          |                                                                              | `      | `const head = inner.split(/\s+/)[0] ?? "";`                                  | `E1`  |
| `claims.ts:137`           | `>= -> >`       | `const inSpan = (at: number): boolean => codeSpans.some(([start, end]) => a` | `E4`   |
| `claims.ts:143`           | `?? ->          |                                                                              | `      | `if (inSpan(m2.index ?? 0)) continue;`                                       | `E1`  |
| `claims.ts:143`           | `0 -> 1`        | `if (inSpan(m2.index ?? 0)) continue;`                                       | `E1`   |
| `claims.ts:144`           | `?? ->          |                                                                              | `      | `toks.push({ t: "path", v: raw, at: m2.index ?? 0 });`                       | `E1`  |
| `claims.ts:144`           | `0 -> 1`        | `toks.push({ t: "path", v: raw, at: m2.index ?? 0 });`                       | `E1`   |
| `claims.ts:147`           | `?? ->          |                                                                              | `      | `for (const m3 of clause.matchAll(CHANGE_VERB)) toks.push({ t: "verb-change` | `E1`  |
| `claims.ts:147`           | `0 -> 1`        | `for (const m3 of clause.matchAll(CHANGE_VERB)) toks.push({ t: "verb-change` | `E1`   |
| `claims.ts:148`           | `?? ->          |                                                                              | `      | `for (const m4 of clause.matchAll(READ_VERB)) toks.push({ t: "verb-read", a` | `E1`  |
| `claims.ts:148`           | `0 -> 1`        | `for (const m4 of clause.matchAll(READ_VERB)) toks.push({ t: "verb-read", a` | `E1`   |
| `claims.ts:149`           | `?? ->          |                                                                              | `      | `for (const m5 of clause.matchAll(FAIL_WORD)) toks.push({ t: "fail", at: m5` | `E1`  |
| `claims.ts:149`           | `0 -> 1`        | `for (const m5 of clause.matchAll(FAIL_WORD)) toks.push({ t: "fail", at: m5` | `E1`   |
| `claims.ts:150`           | `?? ->          |                                                                              | `      | `for (const m6 of clause.matchAll(DONE_WORD)) toks.push({ t: "done", at: m6` | `E1`  |
| `claims.ts:150`           | `0 -> 1`        | `for (const m6 of clause.matchAll(DONE_WORD)) toks.push({ t: "done", at: m6` | `E1`   |
| `claims.ts:162`           | `?? ->          |                                                                              | `      | `const last = raw.split("/").pop() ?? "";`                                   | `E1`  |
| `claims.ts:205`           | `delete !`      | `if (!isNegated(clause, tok.at)) lastVerb = "read";`                         | `E9`   |
| `normalize-claude.ts:31`  | `&& ->          |                                                                              | `      | `if (block && typeof block === "object") {`                                  | `G`   |
| `normalize-claude.ts:33`  | `&& ->          |                                                                              | `      | `if (typeof b.text === "string" && b.text !== "") parts.push(b.text);`       | `G`   |
| `normalize-claude.ts:36`  | `> -> >=`       | `return parts.length > 0 ? parts.join("\n") : undefined;`                    | `G`    |
| `normalize-claude.ts:76`  | `?? ->          |                                                                              | `      | `const message = (record.message ?? {}) as { content?: unknown };`           | `E5`  |
| `normalize-claude.ts:111` | `               |                                                                              | -> &&` | `if (id === undefined                                                        |       | name === undefined) continue;` | `G` |
| `normalize-claude.ts:112` | `?? ->          |                                                                              | `      | `const input = (block.input ?? {}) as {`                                     | `E5`  |
| `normalize-claude.ts:134` | `&& ->          |                                                                              | `      | `if (kind === "tool_result" && type === "user") {`                           | `G`   |
| `normalize-claude.ts:140` | `?? ->          |                                                                              | `      | `const output = textOf(block.content) ?? "";`                                | `E1`  |
| `normalize-codex.ts:89`   | `?? ->          |                                                                              | `      | `const payload = (record.payload ?? {}) as {`                                | `E5`  |
| `normalize-codex.ts:110`  | `&& ->          |                                                                              | `      | `if (callId !== undefined && cmd !== undefined) originals.set(callId, cmd);` | `G`   |
| `normalize-codex.ts:116`  | `?? ->          |                                                                              | `      | `topType === "item.completed" ? ((record as { item?: Raw }).item ?? undefin` | `E5`  |
| `normalize-codex.ts:117`  | `?? ->          |                                                                              | `      | `const item = envelopeItem ?? topItem;`                                      | `E5`  |
| `normalize-codex.ts:121`  | `?? ->          |                                                                              | `      | `const type = (item.type ?? "").toLowerCase().replace(/[_-]/g, "");`         | `E1`  |
| `normalize-codex.ts:150`  | `?? ->          |                                                                              | `      | `const text = str(item.text) ?? textOf(item.content);`                       | `E1`  |
| `normalize-codex.ts:155`  | `!== -> ===`    | `...(str(item.phase) !== undefined ? { phase: str(item.phase)! } : {}),`     | `G`    |
| `normalize-codex.ts:161`  | `?? ->          |                                                                              | `      | `const text = textOf(item.content) ?? str(item.text);`                       | `E1`  |
| `normalize-codex.ts:168`  | `&& ->          |                                                                              | `      | `if (topType === "response_item" && payloadType === "message") {`            | `G`   |
| `normalize-codex.ts:181`  | `?? ->          |                                                                              | `      | `(command.id !== undefined ? originals.get(command.id) : undefined) ?? comm` | `E1`  |
| `normalize-codex.ts:204`  | `=== -> !==`    | `.find((m) => m.role === "assistant" && m.phase === "final_answer");`        | `G`    |
| `normalize-codex.ts:204`  | `&& ->          |                                                                              | `      | `.find((m) => m.role === "assistant" && m.phase === "final_answer");`        | `G`   |
| `verdict.ts:30`           | `true -> false` | `const segs = scanCommand(claim.command, true).filter((seg) => seg.tokens.l` | `G`    |
| `verdict.ts:30`           | `> -> >=`       | `const segs = scanCommand(claim.command, true).filter((seg) => seg.tokens.l` | `G`    |
| `verdict.ts:45`           | `false -> true` | `scanCommand(r.command, false).some(`                                        | `G`    |
| `verdict.ts:46`           | `true -> false` | `(os) => (claim.wantOk ? os.known : true) && segmentsMatch(seg.tokens, os.t` | `G`    |
| `verdict.ts:46`           | `false -> true` | `(os) => (claim.wantOk ? os.known : true) && segmentsMatch(seg.tokens, os.t` | `G`    |
| `verdict.ts:129`          | `0 -> 1`        | `if (facts.total > 0 && facts.hits === 0) return "unverified";`              | `E10`  |
| `verdict.ts:131`          | `> -> >=`       | `if (facts.hits > 0 && facts.hits < facts.total) return "partial";`          | `E11`  |
| `verdict.ts:133`          | `&& ->          |                                                                              | `      | `if (facts.hits === facts.total && facts.total > 0) return "verified";`      | `E12` |
| `verdict.ts:133`          | `> -> >=`       | `if (facts.hits === facts.total && facts.total > 0) return "verified";`      | `E12`  |
| `verdict.ts:139`          | `>= -> >`       | `for (let i = events.length - 1; i >= 0; i--) {`                             | `E13`  |
| `verdict.ts:139`          | `0 -> 1`        | `for (let i = events.length - 1; i >= 0; i--) {`                             | `E13`  |
| `verdict.ts:159`          | `>= -> >`       | `for (let i = events.length - 1; i >= 0; i--) {`                             | `E6`   |
| `verdict.ts:159`          | `0 -> 1`        | `for (let i = events.length - 1; i >= 0; i--) {`                             | `E6`   |
| `verdict.ts:163`          | `1 -> 0`        | `return -1;`                                                                 | `E6`   |
| `verdict.ts:188`          | `?? ->          |                                                                              | `      | `const claims = opts.claims ?? extractClaims(text);`                         | `E5`  |
| `verdict.ts:212`          | `> -> >=`       | `stale: lastSteerIndex(events) > reportIndex(events),`                       | `E7`   |

合计：**41 条给了等价推导，15 条未证**。

## 已有的守备

- 1045 条测试（其中审计 173 条），160 条是确定性语料的行为指纹
- 376 条破坏点全 killed（`pnpm check:breakpoints`）
- 真机跨流门 `pnpm test:audit-cross`：codex / claude 同判词
