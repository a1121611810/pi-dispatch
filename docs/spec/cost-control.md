# pi-dispatch 成本控制方案

> 基线：本机 233 条真实派发记录（`~/.pi/dispatch/**/records/*.json`），实测非估算。
> 定价基准：`regex:test-vendor/group/main`（input $0.15/M、output $0.6/M、cacheRead $0.015/M、cacheWrite $0）。

## 一、实测成本构成

| 桶         | token     | 占比  | 折算        | 成本占比  |
| ---------- | --------- | ----- | ----------- | --------- |
| input      | 438,071   | 23.6% | $0.0657     | **43.9%** |
| output     | 107,307   | 5.8%  | $0.0644     | **43.0%** |
| cacheRead  | 1,309,696 | 70.6% | $0.0196     | 13.1%     |
| cacheWrite | 0         | 0%    | $0          | 0%        |
| **合计**   | 1,855,074 |       | **$0.1497** |           |

**反直觉点**：token 数量上 cacheRead 占七成，但**成本上只占 13%**（cacheRead 单价是 input 的 1/10）。
真正要砍的是 **input（首轮 prompt 固定税）** 和 **output（含 thinking）**。

单条中位数：input 1,968 / output 381 / cacheRead 4,864 / max cost $0.0036。

## 二、四档真机 A/B 实测

同任务「用一句话回答：为什么测试重要？」，`--no-extensions --no-skills --no-context-files`：

| 档位             | input | output | cacheRead | cost          | 工具表               |
| ---------------- | ----- | ------ | --------- | ------------- | -------------------- |
| A 默认减量档     | 1     | 108    | 1,580     | $0.000089     | read,bash,edit,write |
| B thinking=low   | 1     | **63** | 1,580     | $0.000062     | 同上                 |
| C 带 codemode    | 101   | 29     | **2,048** | $0.000063     | +codemode            |
| D free-tier-code 模型 | 1,609 | 31     | 0         | **$0.000000** | 同上                 |

- B vs A：**output −42%**（thinking token 计入 output）
- C vs A：**多背 468 token**（codemode 声明），且 D 档实测工具表里 codemode 不在默认集
- D：**成本归零**，cacheRead 归零、input 全价（该 provider 无缓存价）

多轮实测（读文件任务，2 轮）：

| 档位             | turn1            | turn2            | 合计          |
| ---------------- | ---------------- | ---------------- | ------------- |
| main-tier(max) | in 1472 / cr 189 | in 653 / cr 1660 | $0.000385     |
| free-tier-code        | in 1624 / cr 0   | in 725 / cr 1536 | **$0.000000** |

→ free-tier-code 在第 2 轮**照样命中缓存**，只是缓存读不计费。缓存机制与免费不冲突。

## 三、质量对照（3 类任务 × 3 模型，全部答对）

| 任务                           | main-tier(max) | main-tier(low) | free-tier-code |
| ------------------------------ | ---------------- | ---------------- | --------- |
| 代码理解（读 package.json）    | ✓ 正确           | ✓ 正确           | ✓ 正确    |
| 逻辑推理（NaN 边界修复）       | ✓ 正确           | ✓ 正确           | ✓ 正确    |
| 遵循约束（不用工具、只一句话） | ✓ 遵守           | ✓ 遵守           | ✓ 遵守    |

**结论**：free-tier-code 组在简单任务上与付费组**质量等价**。

## 四、机制清单（按收益/风险比排序）

### 1. 子代理默认用免费/低价模型 —— 收益最大

本机 `~/.pi/agent/models.json` 中 cost 为 0 的模型：

- `vendor-local/group/free-tier`、`free-general`、`free-hard`
- `vendor-local/group/other-code`、`oc-general`、`oc-hard`

低价梯队：`anthropic/claude-haiku-5-5`（$0.1/M，1M 窗口）、`regex:test-vendor/group/main`（$0.15/M）、
`minimax-cn/MiniMax-M3.1-Flash`（$0.1494/M）、`deepseek/deepseek-flash`（$0.3/M，cacheRead 仅 $0.006/M）。

风险：免费组是内部路由，**质量在复杂任务上未验证**。见 §五 分层策略。

### 2. thinkingLevel 降档 —— 省 output，不省 input

`thinkingBudgets` 默认 `{minimal:1024, low:2048, medium:8192, high:16384}`。
**注意 `xhigh`/`max` 被 clamp 到 `high`（同为 16384）——`max` 与 `high` 零成本差异**，别为 `max` 多付钱。

⚠️ 本机 `~/.pi/agent/models.json` 的 vendor-local `thinkingLevelMap`：
`{high,low,max,off}` 有值，**`medium`/`minimal`/`xhigh` 全为 `null`**。

**更正（2026-11-24，经 pi 1.5.2 源码核对）**：这不是「白以为省了」，而是**涨价**。
`clampThinkingLevel()`（`pi-ai/dist/models.js:714-731`）从请求档位**向上**找可用档位：
vendor-local 的 `medium` 是显式 `null`（不支持）⇒ 落到 `high`（16384 token 预算）。
**不校验就等于替父方选了最贵的档。** 派发前必须校验，只发模型支持的档位
（这样 pi 的 clamp 不再插手）。方案见 `cost-control-plan.md` §2.2。

### 3. `--no-context-files` —— 省首轮 input 的固定税

本项目 AGENTS.md = 515 token，全局 `~/.pi/agent/AGENTS.md` ≈ 416 token。
**但只适合侦察/只读档**——实施档关掉会违反仓库规则（AGENTS.md 里写着改动收尾流程）。

### 4. `allowScripts` 是 codemode 的成本源 —— 默认别开

codemode 声明 3,000 token 预算（`codemode.inlineBudget` 默认 3000），实测多背 468 token/请求。
**它只在确实需要脚本批量调工具时才值。**

### 5. 工具表收窄 —— 别为省 token 做

实测收窄到 read-only（427 token）比 coding 组合（382 token）**还多 45 token**——grep/find 的 schema 比 bash/write 大。
省的是三位数，砍的是真能力。**收益微乎其微，质量风险真实。**

### 6. compaction —— 对本项目根本不是杠杆，别动

触发点 = `contextWindow − reserveTokens`（`dist/core/compaction/compaction.js:173-177`）。
本机模型 contextWindow = 1,048,576，默认 reserveTokens = 16,384 → **要涨到 1,032,192 token 才触发**。
子代理跑几千到几万 token，**永远不会触发**。
而且 compaction 自己要调模型做摘要（实测一次 $0.32），**是净成本**。

### 7. cacheWarming —— 子代理场景应关

`cacheWarming: "idle"` 默认会做预热请求，续接概率 0.15，经济性判定 `0.15 × missCost > warmCost`。
短命子代理跑完就没了，不需要「保持热」——预热是纯浪费。

### 8. `--no-prompt-templates` / `--no-themes` —— **不要为省 token 加**

两者都**完全不进 system prompt**（prompt template 只在斜杠命令时展开，theme 是纯终端渲染）。
收益 0 token，价值在启动速度。

## 五、推荐方案：按任务角色分层（便宜模型做量、贵模型做判断）

```
侦察/搜索/单点核对  → free-tier-code + thinking low    → $0
批量实施/重构      → main-tier + thinking low  → $0.15/M
评审/仲裁/架构决策  → 继承父会话模型 + thinking high
```

依据：社区 `nicobailon/pi-subagents` 的 agent 角色表（scout=low / worker=high / reviewer=high / oracle=high）
与 pi 作者 `badlogic/pi-subagent` 的建议（"a faster model for simple investigation or a stronger model for difficult review"）。

## 六、要落地的代码改动

### 改动 1：`dispatch_task` 加 `usageBudget`（硬预算）

口径**必须含 cacheRead**——本机 27505 回合实测 cacheRead 占 prompt token 的 97.7%。
社区 `nicobailon` 的 `usageBudget` 用 `inputTokens + outputTokens`，**照抄会让缓存型子代理的账失真**。

软门语义（借鉴 `QuintinShaw/pi-dynamic-workflows` 的 phased-budgets）：
**预算耗尽不抛错，而是降级交付**（已有结果照交，标记 `budgetExhausted`）——符合「质量不能丢」。

### 改动 2：thinkingLevel 派发前按模型校验

当前 `buildPiArgv`（`src/core/child.ts:273-277`）直接拼 `--model x:thinking`，
在 vendor-local 上派 `medium` 是无效的（thinkingLevelMap 为 null）。需要：
读目标模型的 `thinkingLevelMap` → 无效档位降级到 `low` → 在回执里说明实际生效档位。

### 改动 3：`--append-system-prompt` 前缀稳定化

现在每次派发都拼一个含 taskId/why 的块（`src/core/child.ts:263`）。
**子代理跑多轮时，内容每轮不变的契约块（上下文块 + 报告契约）应当固定在前缀，
变的部分（taskId/why）挪到 user message 里**——
否则上一轮的完整 request 不再是下一轮的前缀，缓存全废
（依据 `boadij/pi-herdsman` ADR 0009）。

实测依据：子代理第 2 轮 cacheRead 1,660 / input 653——前缀稳定时这 1,660 本该全部命中。

### 改动 4：默认关掉 cacheWarming（子代理侧）

**更正（2026-11-24，经 pi 1.5.2 源码核对）**：原方案「给子代理工作目录放 `.pi/settings.json` 写
`{"cacheWarming":"off"}`，项目级优先」**不成立**——
`SettingsManager.getCacheWarmingMode()`（`dist/core/settings-manager.js:725-728`）**只读 `globalSettings`**
（= `<agent-dir>/settings.json`），注释原文 "Read from global settings only because warming costs money"；
`docs/settings.md` 的 cacheWarming 行也标着 "Global setting only"。
**项目级 `.pi/settings.json` 里的 `cacheWarming` 不生效。**

替代机制：走扩展钩子 `cache_warming_decision`（`pi-ai` 的 `CacheWarmingDecisionEvent`，
扩展可返回 `action: "stop"` 终止预热）。附带好处：不用往父方工作区写文件 ⇒ 没有 `.gitignore` 问题、
没有隔离档的落点问题。

另注：预热的续接概率**运行中是 1**（不是 0.15——0.15 是闲置期的常量，`pi-ai/dist/cache-warming.js:52-69`）。
孩子在跑的时候 pi 判定「预热划算」的概率极高，预热是**真花钱**的。

## 七、不要做的事（清单）

- ❌ 加 `--no-prompt-templates` / `--no-themes` —— 0 token 收益
- ❌ 为省 token 收窄工具表 —— 省三位数，砍真能力
- ❌ 调 compaction 阈值 —— 1M 窗口下不触发，且压缩本身花钱
- ❌ 用 `max` thinking 期待更强 —— 它和 `high` 预算相同
- ❌ 给 vendor-local 派 `medium`/`minimal` —— thinkingLevelMap 是 null，不降预算
- ❌ 把 `--append-system-prompt` 内容每次都改 —— 破缓存前缀

## 八、预估收益

以 233 条历史派发（$0.1497）为基线：

| 方案                          | 预估成本 | 降幅 | 质量                 |
| ----------------------------- | -------- | ---- | -------------------- |
| 现状（全部 main-tier(max)） | $0.1497  | —    | 基线                 |
| + thinking 降 low             | ~$0.100  | −33% | 实测等价             |
| + 侦察档走 free-tier-code          | ~$0.045  | −70% | 实测等价（简单任务） |
| + 评审档保留父模型            | ~$0.045  | −70% | 不降                 |

**关键前提**：free 组在**复杂任务**上的质量未验证。§五 的分层策略保证只有简单任务走 free，
复杂任务仍在付费模型上——这是「省 70% 且质量不丢」能同时成立的原因。
