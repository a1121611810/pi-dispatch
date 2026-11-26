# 会话审计模块的变异测试账

`pnpm mutate:audit`（收缩到 `src/audit` + 四个测试文件）：

```
350 个位点   杀掉 282   幸存 68   超时 0   退出码 3（基线）
```

**不是零幸存。** 下面把 68 个逐条摆出来：每条是「在可达输入上等价」还是「还没证」。

怎么拿到这份清单的：`mutator` 每次运行会把结局逐条打到 stdout，
`SURVIVED <file>:<line> <old> -> <new>` 就是幸存者——不用去猜 `.edn` 里的偏移。

## 等价判定（编号见下表最后一列）

- **E1** `X ?? Y` 且 X 只可能是 `string | undefined`，而 `""` 已被上游排掉
  （`str()` 把空串映射成 undefined；`textOf()` 空内容返回 undefined；`split()`/`pop()`
  在非空数组上恒有值；`matchAll` 的 `index` 恒为 number）。`??` 与 `||` 外延相等。
- **E2** `start >= at` → `> at`：否定词的开头与 token 的开头不可能同偏移
  （token 是动词/路径/失败词/完成词，都不是否定词本身），所以 `>=`/`>` 无差别。
- **E3** `at - start <= 12` → `at + start <= 12`：因为 `start >= 0`，`at + start >= at - start`。
  两边同真同假的唯一可能是「`at-start > 12` 但 `at+start <= 12`」，这要求 `start < 0`，不可达。
- **E4** `at >= start` → `> start`：token 不可能从反引号自己的位置开始（裸 token 正则排除反引号）。
- **E5** `obj ?? {}` / `str(x) ?? y`：左值恒为对象或非空字符串。
- **E6** `return -1` → `0`：`stale = lastSteer > reportIndex`，而 `reportIndex >= 0`，
  所以当作 0 时永远不成立，与 -1 同效。
- **E7** `lastSteer > reportIndex` → `>=`：同一条消息不可能既是 steer 又是报告；
  没有报告时 `reportIndex == events.length`，而 `lastSteer <= length-1`，等号不可达。

## 未证的（真缺口，G）

`G` 的那些位点都是「换一种输入就会变」的：句读切分（`claims.ts:79/132/153/199/205`）、
归一化的类型闸（`normalize-claude.ts:31/33/36/108/111/127/134/147/173`、
`normalize-codex.ts:104/110/155/168/204`）、判词边界（`verdict.ts:30/45/46/66/129/131/133/139/159`）。
每一条都还需要一条能咬住它的用例，或者一段等价推导。

## 逐条清单

| 位点                      | 变异            | 源码                                                                                  | 判定   |
| ------------------------- | --------------- | ------------------------------------------------------------------------------------- | ------ |
| `claims.ts:58`            | `?? ->          |                                                                                       | `      | `const dot = ch === "." && /\s/.test(text[i + 1] ?? "");` `E1`                        |
| `claims.ts:79`            | `=== -> !==`    | `if (ch === "`") inCode = !inCode;`  `G`                                              |
| `claims.ts:110`           | `>= -> >`       | `if (start >= at) break;` `E2`                                                        |
| `claims.ts:111`           | `- -> +`        | `if (at - start <= 12) return true;` `E3`                                             |
| `claims.ts:132`           | `0 -> 1`        | `codeSpans.push([m.index, m.index + m[0].length, inner]);` `G`                        |
| `claims.ts:133`           | `?? ->          |                                                                                       | `      | `const head = inner.split(/\s+/)[0] ?? "";` `E1`                                      |
| `claims.ts:137`           | `>= -> >`       | `const inSpan = (at: number): boolean => codeSpans.some(([start, end]) => at >=` `E4` |
| `claims.ts:143`           | `?? ->          |                                                                                       | `      | `if (inSpan(m2.index ?? 0)) continue;` `E1`                                           |
| `claims.ts:143`           | `0 -> 1`        | `if (inSpan(m2.index ?? 0)) continue;` `E1`                                           |
| `claims.ts:144`           | `?? ->          |                                                                                       | `      | `toks.push({ t: "path", v: raw, at: m2.index ?? 0 });` `E1`                           |
| `claims.ts:144`           | `0 -> 1`        | `toks.push({ t: "path", v: raw, at: m2.index ?? 0 });` `E1`                           |
| `claims.ts:147`           | `?? ->          |                                                                                       | `      | `for (const m3 of clause.matchAll(CHANGE_VERB)) toks.push({ t: "verb-change", a` `E1` |
| `claims.ts:147`           | `0 -> 1`        | `for (const m3 of clause.matchAll(CHANGE_VERB)) toks.push({ t: "verb-change", a` `E1` |
| `claims.ts:148`           | `?? ->          |                                                                                       | `      | `for (const m4 of clause.matchAll(READ_VERB)) toks.push({ t: "verb-read", at: m` `E1` |
| `claims.ts:148`           | `0 -> 1`        | `for (const m4 of clause.matchAll(READ_VERB)) toks.push({ t: "verb-read", at: m` `E1` |
| `claims.ts:149`           | `?? ->          |                                                                                       | `      | `for (const m5 of clause.matchAll(FAIL_WORD)) toks.push({ t: "fail", at: m5.ind` `E1` |
| `claims.ts:149`           | `0 -> 1`        | `for (const m5 of clause.matchAll(FAIL_WORD)) toks.push({ t: "fail", at: m5.ind` `E1` |
| `claims.ts:150`           | `?? ->          |                                                                                       | `      | `for (const m6 of clause.matchAll(DONE_WORD)) toks.push({ t: "done", at: m6.ind` `E1` |
| `claims.ts:150`           | `0 -> 1`        | `for (const m6 of clause.matchAll(DONE_WORD)) toks.push({ t: "done", at: m6.ind` `E1` |
| `claims.ts:153`           | `>= -> >`       | `if (at >= 0) toks.push({ t: "done", at });` `G`                                      |
| `claims.ts:153`           | `0 -> 1`        | `if (at >= 0) toks.push({ t: "done", at });` `G`                                      |
| `claims.ts:162`           | `?? ->          |                                                                                       | `      | `const last = raw.split("/").pop() ?? "";` `E1`                                       |
| `claims.ts:199`           | `=== -> !==`    | `const notRun = tok.t === "cmd" && NOT_RUN.test(clause.slice(0, tok.at));` `G`        |
| `claims.ts:199`           | `0 -> 1`        | `const notRun = tok.t === "cmd" && NOT_RUN.test(clause.slice(0, tok.at));` `G`        |
| `claims.ts:205`           | `delete !`      | `if (!isNegated(clause, tok.at)) lastVerb = "read";` `G`                              |
| `normalize-claude.ts:31`  | `&& ->          |                                                                                       | `      | `if (block && typeof block === "object") {` `G`                                       |
| `normalize-claude.ts:33`  | `&& ->          |                                                                                       | `      | `if (typeof b.text === "string" && b.text !== "") parts.push(b.text);` `G`            |
| `normalize-claude.ts:36`  | `> -> >=`       | `return parts.length > 0 ? parts.join("\n") : undefined;` `G`                         |
| `normalize-claude.ts:76`  | `?? ->          |                                                                                       | `      | `const message = (record.message ?? {}) as { content?: unknown };` `E5`               |
| `normalize-claude.ts:108` | `&& ->          |                                                                                       | `      | `if (kind === "tool_use" && type === "assistant") {` `G`                              |
| `normalize-claude.ts:111` | `               |                                                                                       | -> &&` | `if (id === undefined                                                                 |     | name === undefined) continue;`  `G` |
| `normalize-claude.ts:112` | `?? ->          |                                                                                       | `      | `const input = (block.input ?? {}) as {` `E5`                                         |
| `normalize-claude.ts:127` | `true -> false` | `...(input.run_in_background === true ? { runInBackground: true } : {}),` `G`         |
| `normalize-claude.ts:127` | `true -> false` | `...(input.run_in_background === true ? { runInBackground: true } : {}),` `G`         |
| `normalize-claude.ts:134` | `&& ->          |                                                                                       | `      | `if (kind === "tool_result" && type === "user") {` `G`                                |
| `normalize-claude.ts:140` | `?? ->          |                                                                                       | `      | `const output = textOf(block.content) ?? "";` `E1`                                    |
| `normalize-claude.ts:147` | `true -> false` | `const exitCode = exitCodeOf(output, isError, tool.input.runInBackground === tr` `G`  |
| `normalize-claude.ts:173` | `true -> false` | `...(message.sidechain ? { sidechain: true as const } : {}),` `G`                     |
| `normalize-codex.ts:89`   | `?? ->          |                                                                                       | `      | `const payload = (record.payload ?? {}) as {` `E5`                                    |
| `normalize-codex.ts:104`  | `&& ->          |                                                                                       | `      | `if (cwd === undefined && metaCwd !== undefined) cwd = metaCwd;` `G`                  |
| `normalize-codex.ts:110`  | `&& ->          |                                                                                       | `      | `if (callId !== undefined && cmd !== undefined) originals.set(callId, cmd);` `G`      |
| `normalize-codex.ts:116`  | `?? ->          |                                                                                       | `      | `topType === "item.completed" ? ((record as { item?: Raw }).item ?? undefined) ` `E5` |
| `normalize-codex.ts:117`  | `?? ->          |                                                                                       | `      | `const item = envelopeItem ?? topItem;` `E5`                                          |
| `normalize-codex.ts:121`  | `?? ->          |                                                                                       | `      | `const type = (item.type ?? "").toLowerCase().replace(/[_-]/g, "");` `E1`             |
| `normalize-codex.ts:150`  | `?? ->          |                                                                                       | `      | `const text = str(item.text) ?? textOf(item.content);` `E1`                           |
| `normalize-codex.ts:155`  | `!== -> ===`    | `...(str(item.phase) !== undefined ? { phase: str(item.phase)! } : {}),` `G`          |
| `normalize-codex.ts:161`  | `?? ->          |                                                                                       | `      | `const text = textOf(item.content) ?? str(item.text);` `E1`                           |
| `normalize-codex.ts:168`  | `&& ->          |                                                                                       | `      | `if (topType === "response_item" && payloadType === "message") {` `G`                 |
| `normalize-codex.ts:181`  | `?? ->          |                                                                                       | `      | `(command.id !== undefined ? originals.get(command.id) : undefined) ?? command.` `E1` |
| `normalize-codex.ts:204`  | `=== -> !==`    | `.find((m) => m.role === "assistant" && m.phase === "final_answer");` `G`             |
| `normalize-codex.ts:204`  | `&& ->          |                                                                                       | `      | `.find((m) => m.role === "assistant" && m.phase === "final_answer");` `G`             |
| `verdict.ts:30`           | `true -> false` | `const segs = scanCommand(claim.command, true).filter((seg) => seg.tokens.lengt` `G`  |
| `verdict.ts:30`           | `> -> >=`       | `const segs = scanCommand(claim.command, true).filter((seg) => seg.tokens.lengt` `G`  |
| `verdict.ts:45`           | `false -> true` | `scanCommand(r.command, false).some(` `G`                                             |
| `verdict.ts:46`           | `true -> false` | `(os) => (claim.wantOk ? os.known : true) && segmentsMatch(seg.tokens, os.token` `G`  |
| `verdict.ts:46`           | `false -> true` | `(os) => (claim.wantOk ? os.known : true) && segmentsMatch(seg.tokens, os.token` `G`  |
| `verdict.ts:66`           | `               |                                                                                       | -> &&` | `if (typeof raw !== "string"                                                          |     | raw === "") continue;`  `G`         |
| `verdict.ts:129`          | `0 -> 1`        | `if (facts.total > 0 && facts.hits === 0) return "unverified";` `G`                   |
| `verdict.ts:131`          | `> -> >=`       | `if (facts.hits > 0 && facts.hits < facts.total) return "partial";` `G`               |
| `verdict.ts:133`          | `&& ->          |                                                                                       | `      | `if (facts.hits === facts.total && facts.total > 0) return "verified";` `G`           |
| `verdict.ts:133`          | `> -> >=`       | `if (facts.hits === facts.total && facts.total > 0) return "verified";` `G`           |
| `verdict.ts:139`          | `>= -> >`       | `for (let i = events.length - 1; i >= 0; i--) {` `G`                                  |
| `verdict.ts:139`          | `0 -> 1`        | `for (let i = events.length - 1; i >= 0; i--) {` `G`                                  |
| `verdict.ts:159`          | `>= -> >`       | `for (let i = events.length - 1; i >= 0; i--) {` `G`                                  |
| `verdict.ts:159`          | `0 -> 1`        | `for (let i = events.length - 1; i >= 0; i--) {` `G`                                  |
| `verdict.ts:163`          | `1 -> 0`        | `return -1;` `E6`                                                                     |
| `verdict.ts:188`          | `?? ->          |                                                                                       | `      | `const claims = opts.claims ?? extractClaims(text);` `E5`                             |
| `verdict.ts:212`          | `> -> >=`       | `stale: lastSteerIndex(events) > reportIndex(events),` `E7`                           |

## 已有的守备

- 1034 条测试（审计 162 条），其中 160 条是确定性语料的行为指纹
- 376 条破坏点全 killed（`pnpm check:breakpoints`）
- 真机跨流门 `pnpm test:audit-cross`：codex / claude 同判词
