# 裁决集 v22（第二十轮投票后修订）

12 条，编号不变。`OBJECT` 必须带可复现证据；给不出证据的标 `NOTE`。

## v21 → v22 改了什么

| 条目 | 改动                                                                                                     | 提出者     |
| ---- | -------------------------------------------------------------------------------------------------------- | ---------- |
| 11   | #14/#15 的用例把**夹具写死**（报告原文 + 收据的 exitCode），否则删掉相应分支测试仍绿——那是假绿，不是测试 | pi         |
| 盲区 | 补一行：跨句兜底可能把「失败。已修复。后来全部通过」判 unverified（保守方向的有意代价）                  | pi（NOTE） |

---

## 1. 范围

- 本仓加第二个入口 + 一个 `bin`；**不新建 npm 包**、**不接 pi**、**不做全库索引**、**不 spawn**、**不联网**、**不写盘**。
- 新代码：`src/audit/{types,claims,normalize-codex,normalize-claude,verdict,index}.ts` + `src/bin/session-audit.ts`（每个 ≤600 行）。
- `src/core/child.ts` 只加 3 个 `export`（`scanCommand` / `segmentsMatch` / `CommandSegment`）。**不导出、也不用 `claimSatisfied`**——它内部有一条无条件的整串快路（`child.ts:1166-1170`，在任何 `known` 检查之前），且 `wantOk` 是从 `claim.exitCode` 推出来的（`:1158`），两条都表达不了本裁决的策略。匹配逻辑放在 `verdictOf` 里，只复用 `scanCommand` 与 `segmentsMatch`。
- **提交顺序**：① 第 6 条的 `||` 修复（只改 `known`，带测试与破坏点，可单独 revert）→ ② 导出 → ③ audit 模块。

## 2. 判词实现方式

- **不调用 `deliverableOf`**（旗标消费者：不给旗标时对「声称 pnpm test、收据只有 pnpm lint」返回 `verified`；旗标在 `engine.ts:1118` 才算）。
- 自写 `verdictOf`，复用原语。
- 文件头写清 **4 处**与 core 的已知分歧：
  1. `stale + partial`：core `partial`（`child.ts:1316`），本裁决 `unverified`。
  2. 整维零命中（路径 1/1 命中、命令 0/1）：core `unverified`，本裁决 `partial`。
  3. `receiptGap` 在 `partial` 之后（`child.ts:1318` vs `:1321`）：core `partial`，本裁决 `unverified`。
  4. 零自述但**有路径收据或报告有完成词**：core `unclaimed`（`child.ts:1325`），本裁决 `unverified`。

## 3. 判定链（精确顺序，每条 return）

```
absent      ⟸ !hasBody ∧ receipts.paths.length===0 ∧ !pathsTruncated
unverified  ⟸ !hasBody
unverified  ⟸ stale            // 同时产出 notes:["report predates last steer"]
unverified  ⟸ vagueBoundMissed   // 完成词绑到「没命中」或「跑过但失败（wantOk=false）」的命令（任何 total）
unverified  ⟸ total===0 ∧ (receipts.paths.length>0 ∨ vagueUnbound)
unverified  ⟸ total>0 ∧ hits===0
unverified  ⟸ truncated ∧ hits<total
partial     ⟸ 0<hits<total
unclaimed   ⟸ total===0
verified    ⟸ hits===total ∧ total>0
```

- `total = claims.paths.length + claims.commands.length`（自述数）
- `hasBody = (report 非空) ∨ (最后一条主链 assistant 文本非空)`
- `hits = 路径命中数 + 命令命中数`
  - 路径命中：`claims.paths` 里任一被 `receipts.paths` 命中
  - `claimHit(claim, receipts)` 的规则：
    1. `segs = scanCommand(claim.command, true)`；为空 ⇒ 不命中。
    2. **整串快路**：仅当自述不含任何分隔符（`|` `||` `;` `&` 换行）时启用——存在 `exitCode===0` 且逐字相等（空白归一）的收据 ⇒ 命中。
    3. **否则逐段**：声称成功 ⇒ 每一段都要在某条 `exitCode===0` 的观测里找到 `known===true` 的对应段；声称跑过 ⇒ 每一段都要在某条 `exitCode` 为数字的观测里找到对应段（不看 `known`）。
- `truncated = pathsTruncated ∨ commandsTruncated`
- `stale = 最后一条 steer 序号 > 报告序号`
- 链尾没有隐式 `return "verified"`

## 4. 自述抽取（claims）

**三级粒度。**

- **句子**：按 `[。！？!?\n;；]` 与「句点+空白」（`. `）切；不切裸 `.`；**反引号 / 围栏内部不切**。
- **小句**：句子内按 `[，,、]` 与转折/顺承**多字词**（`但是|但|不过|然而|却|而是|然后|之后|随后|but|however|then`）切；**反引号 / 围栏内部不切**；单字 `就|并|且|再` **不切**（会切在词内）。
- **否定辖域（唯一一条规则）**：**计算辖域时**先把 `未通过|没通过|没有通过|not ok` 四个失败短语整体剔除（它们是失败词，不是否定；**剔除只影响「找否定词起点」，失败词匹配仍在原文上做**），再从否定词（中文：`没有|没|未(?!来|知|必|免)|无|不是|并非|不算`；英文：`\bnot\b|\bno\b|\bnever\b|\bdidn't\b|\bwithout\b`，必须带词边界，否则 `node` 里的 `no` 会误伤；**不含裸 `0`/`零`**）开始，到 **min(小句末, 否定词后第 12 个字符)** 为止。辖域内：不产出自述、动词不算、失败/完成词不算。**不再有第二条「前方 6 字」规则。**

**动词两组，逐个路径做「最近前置动词」绑定。**

- 改动动词：`改|修改|新增|新建|删除|写入|implemented|changed|added|created|wrote|updated|fixed`
- 只读动词：`读|看了|查看|检查|搜索|grep|read|inspected|checked|reviewed|scanned`
- 对每个路径出现，在同一**句子**内向前找最近的动词（两组都算）；**最近动词属于改动闭集且不在否定窗口内**，该路径才算改动自述。
  - 「修改了 `a`、`b`」⇒ a、b 的最近动词都是「修改」⇒ 两条都算。
  - 「读了 `a` 并修改了 `b`」⇒ a 的最近动词是「读」⇒ 不算；b 算。
  - 「我读了 `a`，未改动」⇒ a 的最近动词是「读」⇒ 不算。

**命令**：围栏代码块首行，或反引号 span；首 token 命中 runner 闭集（`pnpm|npm|npx|yarn|bun|node|tsc|vitest|jest|pytest|cargo|go|make|git`）。`cd sub && pnpm test` 这类整串写在反引号里时，`cd` 不是 runner ⇒ 抽不到命令自述（写进盲区）。

**失败词 / 完成词**：先去掉句子里的反引号 span 与路径 token，再在剩余文本上匹配；出现位置若落在某个否定辖域内 ⇒ 不算。**失败词绑定到「同一句子里最近的前置命令」**；**完成词先在本句找，找不到则绑到上一句的最后一条命令**（跨句兜底）：`a 通过，b 失败` ⇒ 只有 `b` 是 `wantOk=false`；没有前置命令的失败词不生效（如「失败：`pnpm test`」这种倒装写法，记入盲区）。`wantOk` 是「命令自述」的属性，作用域是这条命令，不是小句、也不是整段报告。

- 失败词 ⇒ `wantOk=false`：`失败|报错|挂了|failed|error|failing|not ok|未通过|没通过|没有通过`（裸「红」不算）。
- 完成词 ⇒ 绑定「最近的前置命令」，再分两种结果：
  - 绑到一条**声称成功且命中**（`wantOk===true` ∧ 命中）的命令 ⇒ 不扣分；
  - 绑到一条**没命中**的命令，或绑到的是一条**跑过但失败**（`wantOk=false`）的命令 ⇒ `notes:["vague success claim"]` + `unverified`（**任何 `total` 都生效**，会盖过 `partial`）；
  - **绑不到任何命令**（含该命令前紧邻 `没跑|未跑|未执行|没有运行|didn't run`）⇒ 记 `notes:["vague success claim"]`；只有 `total===0` 时才升为 `unverified`，否则只留 note、不降档。
  - 词表：`已实现|已修复|已通过|全部通过|测试通过|全绿|fixed|implemented|passed|all tests pass`；`完成` 单独不算，除非同句有 `实现|修复|改动`。

**`opts.claims` 是结构化主入口**：给了就不跑散文抽取。
**盲区**：比喻、间接引用、非英文动词、代词指代；祈使/政策句里的命令会被误当自述；路径写在动词前面（「`a.ts` 里加了个函数」）抽不到。

## 5. 路径匹配

- 复用 `pathMatches`（后缀 + 分隔符对齐）。
- **只对含 `..` 的路径**做 `path.posix.resolve(base, p)`；不含 `..` 的相对路径保持相对。
- `base = path.posix.isAbsolute(cwd ?? "") ? cwd : "/"`。相对 cwd 一律当 `/`，并记 `notes:["relative cwd ignored"]`。
- **禁止** `process.cwd()` / `resolve("")` / `resolve(undefined, …)`。
- `..` 越过根就停在根；归一化只做去尾斜杠、去 `./`、反斜杠转 `/`。

## 6. 命令分段与信任传播

- 判定层不自己重算，直接用修好的 `scanCommand(...)` 的 `known`。下面的闭式是**修复规格 + 测试 oracle**：

结构定义（必须按这个写，否则 oracle 会锁死错行为）：

- **分词不在这里定义**：先用 `scanCommand` 的引号/重定向感知规则切成 token（`2>&1`、`&>`、`>`、`>>`、heredoc 正文都不产生分隔符）。本节只定义**分组结构**。
- 把 token 流按 shell 解析成四类节点，**优先级从高到低**：
  1. `Pipe`（`|`）
  2. `And`（`&&`）/ `Or`（`||`）——同优先级，左结合
  3. `Seq`（`;`、`&`、未加引号换行）——最低，左结合
- `known` 用**自顶向下**的遍历定义（前提：该条命令的收据 `exitCode === 0`）：

```
visit(node, trusted):
  if (!trusted) { 该子树下所有叶子 known = false; return }
  And(l,r)             -> visit(l,true); visit(r,true)
  Or(l,r)              -> visit(l,false); visit(r,false)
  Seq(l,r) / Pipe(l,r) -> visit(r,true); visit(l,false)
  叶子                  -> known = true
入口：visit(root, true)
```

关键点：**父节点不可信时，整棵子树一律 false**——不是「And 两边都 true」那样局部推。

- 八个必测输入的期望值（就是 oracle，测试里逐条断言）：

| 命令                   | known                       |
| ---------------------- | --------------------------- |
| `a \|\| b`             | a=false, b=false            |
| `a & b`                | a=false, b=true             |
| `true \|\| b && c`     | true=false, b=false, c=true |
| `a \|\| b; c`          | a=false, b=false, c=true    |
| `a; b \|\| c`          | 全 false                    |
| `a && b; c`            | a=false, b=false, c=true    |
| `pnpm test; echo done` | pnpm test=false, echo=true  |
| `a && b \| c`          | a=true, b=false, c=true     |

即 `a && b` ⇒ a、b 都 known；`a | b` ⇒ 末段 known、首段不 known。

- **`known` 是纯语法属性，绝不含 `exitCode`**：`hasMaskingSeparator`（`child.ts:1455`）把 `known === false` 读作「成败被掩码」；折进退出码会让跑挂的正常命令被当成掩码。`exitCode === 0` 只在判词层加。
- **不要引入 `reachable`**：`claimSatisfied` 的 `wantOk=false` 分支不消费它（`child.ts:1180` 的 `(!wantOk || os.known)` 恒真）。
- **整串快路只在自述不含任何分隔符时启用**：自述与观测逐字相等（空白归一）、该收据 `exitCode===0`、且自述里没有 `|` `||` `;` `&` 或未加引号换行，才算命中。**只要含分隔符就走段级校验**。
  - 理由：`pnpm test 2>&1 | tail -30` 是子代理省上下文的常规写法，测试挂了整串退出码仍为 0；byte-equal 会把它判成 `verified`。这也消除第 3 条与第 6 条对管道给出相反判词的自相矛盾。
  - 代价（写进盲区）：引用带管道的整条命令会判 `unverified`；要兑现就只引用被验证的那一段。
- **POSIX 左结合**：`true || b && c` = `(true || b) && c`，只有 `c` 可信。
- 必测八输入（期望值见上表）：`a || b`、`a & b`、`true || b && c`、`a || b; c`、`a; b || c`、`a && b; c`、`pnpm test; echo done`、`a && b | c`。

## 7. 截断

- **paths 保最先 20 条，commands 保最近 20 条**（都与 core 一致；样本 4 依赖 paths 保最先）。
- 单纯截断不罚；`truncated ∧ hits<total` ⇒ `unverified`。
- `absent` 只排除 `pathsTruncated`。

## 8. codex 归一化

- 信封两种：`event_msg` → `payload.type==="item_completed"`（历史），顶层 `item.completed`（实时，snake_case）。`item.type` **按显式清单认四种**：`CommandExecution`/`command_execution`、`FileChange`/`file_change`、`AgentMessage`/`agent_message`、`UserMessage`/`user_message`（历史 PascalCase，实时 snake_case；「大小写双认」覆盖不了下划线）。
- **连接键 `CommandExecution.id === function_call.call_id`**（CE 没有 `call_id` 字段）。
- 命令串：① 同 id 的 FC 存在 ⇒ `JSON.parse(payload.arguments).cmd`；② 否则 `CE.command`；③ 数组取最后一项，字符串只剥一层 `/bin/(zsh|bash|sh) -lc "…"`。
- 退出码取 `CE.exit_code`；只有 FC 没有 CE ⇒ 不是收据。
- 路径收据：`item.type==="FileChange"` 的 `changes` 是**对象**，取键；**不解析** `apply_patch` 文本。
- 报告：实时 `agent_message.text` 直取；历史 `AgentMessage.content[]` 的 `{type:"Text",text}`；**取最后一条** `phase==="final_answer"`，没有则取最后一条 `AgentMessage`（同一会话可能有多条 final_answer，正文不同）。
- 角色：统一从 `response_item/message` 取；以 `<` 开头的合成消息不算转向。

## 9. claude 归一化

- 只认顶层 `assistant` / `user`；历史无 `result` 行。
- `tool_use.id` 配对 `tool_result.tool_use_id`；未配对不产收据。
- 写类白名单：`Write` / `Edit` / `NotebookEdit`；`Read` / `Grep` / `Glob` / `LS` 不算。
- **`tool_result` 永不变成 user 消息**；`isSidechain:true` 不算主链。
- 退出码四分法（只对 `Bash`）：
  1. `^Exit code (\d+)` ⇒ `N`
  2. `is_error===true` 且无标记 ⇒ **整条丢弃**
  3. `is_error===false` ∧ 配对 ∧ `run_in_background !== true` ∧ 结果文本**不以**这三个短语之一开头/包含 ⇒ `0`：`Command running in background` / `did not complete within` / `moved to the background`（不用宽正则，否则正文里出现 `background`/`timed out` 的正常成功输出会被误判）
  4. 其余 ⇒ `undefined`
- 不在非 Bash 的 result 里找 `Exit code`。
- 判词只用 `exitCode===0` 判成功，不维护 `failedCommands`。

## 10. 退出码

| 码  | 含义                                                                  |
| --- | --------------------------------------------------------------------- |
| 0   | `verified`；或 `unclaimed`（默认）                                    |
| 1   | `partial` / `unverified` / `absent`；`--strict` 时 `unclaimed` 也归此 |
| 2   | 解析失败：文件不可读 / 0 条可解析事件 / 未知 `--format`（含 `pi`）    |

## 11. 测试与破坏点

- 15 条假绿测试 + **九条**验收样本逐条配测试 + 产量断言（精确条数，人工核过）。
- 破坏点锚点在 `pnpm fmt` 之后取；唯一性用 **node 数出现次数**（`s.split(from).length - 1 === 1`，与仓里 `countOf` 同口径），**不要用 `grep -c`**（它数行不数次数）。
- 第 6 条的 `||` 修复单独提交、单独破坏点、可单独回滚。
- 纯函数性：`Date.now` / `Math.random` 换成抛错；**源码白名单只扫 `src/audit/**`**（禁 `node:fs` / `child_process` / `performance.now` / `process.cwd`）；`src/bin/**` 豁免（它是唯一读盘入口）。`cwd` 缺省 / 相对 / 空串三种情况**彼此等价**（都当 `/`），判词一致；`cwd` 为绝对路径时按它解析——所以纯函数性断言写成「同一绝对 cwd 下重复运行结果相同」，**不**写成「所有 cwd 判词都一样」（含 `..` 的路径本来就会不同）。
- 每文件 ≤600 行。

十五条假绿测试：

1. 零自述 + 路径收据 ⇒ `unverified`（样本 8 的空跑变体）
2. 「我读了 `src/a.ts`，未改动」⇒ `unclaimed`、claims 空
3. 「已实现路由注册，测试全部通过」⇒ `unverified` + `vague success claim`
4. 「测试未通过」⇒ 不算 vague success；「已改 `src/a.ts`，未跑测试」仍保留路径自述；「修改了 `src/a.ts`、`src/b.ts`」⇒ 两条路径自述
5. `pnpm test || true` 声称跑通 ⇒ `unverified`
6. `true || pnpm test:unit`，自述「跑了 `pnpm test:unit`」⇒ `unverified`（**「跑了 X」也按「声称成功」处理**——本裁决对散文一律保守处理，所以走规则 3 的**声称成功**分支（要求 `known`））
7. 路径 1/1 + 命令 0/1 ⇒ `partial`
8. 截断 + 一条对不上 ⇒ `unverified`
9. claude `run_in_background` / `is_error` 无标记 ⇒ 不是收据
10. 跨流：同一 report 串 + 两条归一化流 ⇒ `deliverable` 相等
11. 管道：`pnpm test 2>&1 | tail -30` 测试挂了、整串 exit 0，自述声称成功 ⇒ `unverified`
12. cwd：claim `../lib/a.ts`、`--cwd /repo/sub`、收据 `/repo/lib/a.ts` ⇒ `verified`；**断言 `receipts.paths` 解析后的值**，不是只看判词
13. stale：报告之后还有一条 steer ⇒ `unverified`，且 `notes` 精确含 `report predates last steer`
14. 完成词绑到「跑过但失败」：**夹具写死** = 报告原文「`pnpm test` 失败了，已修复。」+ 收据 `pnpm test` `exitCode: 1` ⇒ `unverified`。删掉 `vagueBoundMissed` 的 `wantOk=false` 分支 ⇒ 该用例转 `verified`，破坏点才咬得住
15. 跨句兜底：**夹具写死** = 报告原文「`pnpm test` 失败。已修复。」+ 收据 `pnpm test` `exitCode: 1` ⇒ `unverified`。删掉跨句兜底 ⇒ `已修复` 绑不到命令、`total>0` 只留 note ⇒ 转 `verified`，破坏点才咬得住

## 12. spec 修订（16 条）

1. 定义自述抽取（第 4 条 + **三级**粒度：句子 / 小句 / 否定辖域 + 盲区）。
2. 加「完成词但零可核对项、**或完成词绑到「未命中 / 跑过但失败」的命令** ⇒ `unverified`」。
3. **规则 1 的 codex 整行改写**：删掉 `apply_patch` / 写文件 `exec_command` / `sed -i` / `> file` / `>>` / `tee` 全部枚举，改成「codex 的路径收据只来自 `FileChange.changes` 的键」；规则 3 补「`||` 两侧都不可推」。
4. `unverified` 的「无收据」改成「有自述但零收据」。
5. `absent` 的截断条件收窄成 `pathsTruncated`。
6. `SessionEvent.message` 加 `role` + `isSidechain`。
7. **样本 1、2、5 的自述都写成反引号里的真实 runner 命令**（样本 1 自述写 `pnpm test`；样本 2 自述写 `pnpm lint` / `pnpm test`，**观测命令同步改成 `pnpm lint; pnpm test`**；样本 5 自述写 `pnpm test`），并同步改期望说明：**删掉样本 5 的「（需按 cwd 解析）」和「路径要对齐」两句**；样本 5 保持 `cd sub && pnpm test` 的 `&&` 语义不变；**另加样本 9**：claim `../lib/a.ts`、`--cwd /repo/sub`、收据 `/repo/lib/a.ts` ⇒ `verified`；样本 6 补判词列；样本 4 写明「第 21 条」并依赖 paths 保最先。
8. 数据源表事实更正（codex 两信封 + argv + `file://`；**`~/.claude` 历史文件无 `result` 行，实时 `-p` 流有**）。
9. 退出码表补 `--strict`。
10. 删掉「自评空转」。
11. 补「零自述但有路径收据 ⇒ `unverified`」。
12. CLI 签名加 `--strict`；`--format` 去掉 `pi`（或写明退 2）。
13. 输入契约 `opts` 加 `claims?`。
14. `unverified` 的「有正文但无 report」改成「无正文」。
15. 交付形态改成「一个包、两个入口」。
16. **spec 里所有「八条样本」统一改成「九条」**（表、标题、验收清单三处）。

## 已知盲区（写进 spec，不阻塞共识）

- 只用 shell 写文件的会话拿不到路径收据。
- 非英文改动动词、代词指代、比喻抽不到；祈使/政策句里的命令会误当自述。
- 「跑过但失败」的自述若落在 `||` 右段且实际没跑，仍可能被算作跑过（本裁决不引入 `reachable`）。
- 引用带管道的整条命令（`a | b`）一律判 `unverified`；要兑现就只引用被验证的那一段。
- 「0 errors」「零报错」这类写法会被当成失败标记（否定词表不含裸 `0`/`零`），诚实报告可能被降一档。
- 「没跑测试就改了 `a.ts`」这类单字顺承句不切分，路径自述可能被吞（单字 `就/并/且/再` 不作边界）。
- 跨句兜底会把「`pnpm test` 失败。已修复。后来 `pnpm test` 全部通过。」判 `unverified`——保守方向的有意代价。
- 抽取的召回/精确率未标定；S0 之后用 20 份真实报告量一次。
