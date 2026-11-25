# 缓存命中为什么低：实测与各家机制对照

> 2026-11-25。全部数字来自本机实测（`vendor-local` 网关 `http://127.0.0.1:3425/v1`，模型 `regex:group/main`），
> 探针脚本在 `/tmp/cache-probe*.mjs`。厂商规则来自官方文档，逐条给了出处。

## 一句话结论

**前缀稳定化是对的、也确实生效了（`cacheRead` 已经大于 `input`），但它不是命中低的根因。**
根因是 **vendor-local 网关的缓存按「块」写入，不是按 token 连续前缀匹配**：
命中时是**整块命中**（92~99%），不命中时**只命中零头**（8~19%），中间没有连续过渡。
子代理的前缀（~665 token）**不够大到能形成完整块**，所以大部分请求只蹭到 128/186 token 的零头。

## 一、实测：命中是「整块」不是「连续前缀」

固定前缀长度 N，连打 6 次，看 `cached_tokens` 的取值集合：

```
N=30 行 (558 tok):  cached 序列 = 128  128  186  128  128  128     取值 {128, 186}
N=120 行 (1638 tok): cached 序列 = 186  0    186  128  128  128     取值 {0, 128, 186}
N=400 行 (4998 tok): cached 序列 = 128  186  128  128  4992 4992  取值 {128, 186, 4992}
```

**没有连续中间值。** 4998 token 的前缀要么命中 4992（99.7%），要么只命中 128/186（2~4%）。

同一前缀连打 8 次（1527 token）：

```
第1次 8.4%  第2次 12.2%  第3次 12.2%  第4次 8.4%
第5次 8.4%  第6次 8.4%  第7次 92.2%  第8次 12.2%
```

**92% 那一跳是「整块被写入了」**，不是「前缀逐渐变热」。800 行前缀（17799 token）同样：
第1次 1.0% → 第2次 0.0% → 第3次 **99.2%**。

## 二、`prompt_cache_key` 没用（排除了一个错误方向）

交替对照实验，每组用全新前缀、组内同前缀两次：

```
grpA  key=不带   10.0%  10.0%
grpB  key=带     10.0%  10.0%
grpC  key=不带   10.0%   0.0%
grpD  key=带      0.0%  10.0%
grpE  key=不带    0.0%  10.0%
```

**带不带完全没差别。** 换不同的 key 也一样（92.4%）。

> 我一开始因为「A 组 8.4% / B 组 92.4%」判定是 key 起的作用——**那是错的**：
> B 组复用了 A 组的前缀，命中的是**前缀**不是 key。后面的交替实验推翻了它。

### pi 侧确实有一个相关配置，但它不是主因

`pi-ai/dist/api/openai-completions.js:558-568`：

```js
const promptCacheKeyMode = compat.promptCacheKeyMode ?? "auto";
const supportsPromptCacheKey = promptCacheKeyMode === "enabled" ||
    (promptCacheKeyMode === "auto" &&
        (model.baseUrl.includes("api.openai.com") ||
            (cacheRetention === "long" && compat.supportsLongCacheRetention)));
// ...
prompt_cache_key: cacheRetention !== "none" && supportsPromptCacheKey
    ? clampOpenAIPromptCacheKey(options?.sessionId) : undefined,
```

vendor-local 的 `baseUrl` 是 `http://127.0.0.1:3425/v1`（不含 `api.openai.com`），
`promptCacheKeyMode` 又是默认 `"auto"` ⇒ **pi 从不发 `prompt_cache_key`**。
`compat.promptCacheKeyMode: "enabled"` 可以让它发——但**实测发不发都一样**，所以不必改。

## 三、真实子代理场景的命中率

模拟子代理前缀（pi 的 preamble+tools+rules + 我们的契约块 ≈ 665 token），同一前缀连打 8 次：

```
子代理1: 19.2%   子代理2: 19.2%   子代理3:  0.0%   子代理4: 77.0%
子代理5:  0.0%   子代理6: 19.2%   子代理7: 19.2%   子代理8: 77.0%
```

**19% 是常态，77% 是偶尔整块命中。** 665 token 的前缀太小，凑不满 vendor-local 的块。

而**实际派发里**（走 pi 的完整会话，首轮 `in=4640 / cacheR=8320`）缓存是**在工作**的——
`cacheRead` 已经大于 `input`。所以「命中低」是**相对低**（13% 的成本占比），不是「没命中」。

## 四、各家机制对照

| 厂商                     | 机制                            | 命中粒度                                                     | 关键规则                                                                                                                                                                                                                                                                                                                                               | 出处                                                                       |
| ------------------------ | ------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| **vendor-local**（本机） | 自动前缀缓存                    | **整块**（实测：无连续中间值）                               | 未发 `prompt_cache_key`；块大小未公开                                                                                                                                                                                                                                                                                                                  | 实测                                                                       |
| **Kimi**                 | 隐式前缀缓存 + 显式 Cache Write | **按块**：「不足一整块的部分无法写入缓存，会计为缓存未命中」 | ① 前缀中**任何一处变化**，该位置之后无法复用<br>② 命中价 = 未命中价 **1/10**<br>③ TTL 两档 `5m`/`1h`，**首次写入时锁定不可改**<br>④ **按 org 隔离**<br>⑤ 缓存**不能手动清除**<br>⑥ 官方建议：稳定内容放前部、变化内容放后部、**别在前缀插时间戳/随机 ID**                                                                                              | [上下文缓存最佳实践](https://platform.kimi.com/docs/guide/context-caching) |
| **DeepSeek**             | 硬盘缓存，**默认开启**          | **cache prefix unit，必须「完全匹配」**                      | ① 每个请求产生两个 prefix unit：用户输入**末尾**、模型输出**末尾**<br>② 检测到公共前缀 ⇒ 另存为一个独立 unit<br>③ 长输入按固定 token 间隔切 unit<br>④ **命中要求完全匹配整个 unit**（`A+B` 的 unit 命中不了 `A+C`）<br>⑤ `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`<br>⑥ **best-effort，不保证 100%**；构建要几秒，不用后几小时~几天自动清 | [Context Caching](https://api-docs.deepseek.com/guides/kv_cache/)          |
| **GLM / Z.AI**           | **自动识别**，无需配置          | 文档未给块大小                                               | ① 「内容**相同或高度相似**」即复用<br>② `usage.prompt_tokens_details.cached_tokens`<br>③ 命中价通常 **50%**（不是 1/10）<br>④ 官方建议：稳定 system prompt、长文档放 system message、**避免频繁改内容**                                                                                                                                                | [Context Caching](https://docs.z.ai/guides/capabilities/cache)             |
| **Anthropic**            | 显式 `cache_control` 断点       | 按断点                                                       | 命中价 0.1×；写缓存 1.25×                                                                                                                                                                                                                                                                                                                              | —                                                                          |

**对本题最关键的差异**：**Kimi 与 DeepSeek 的官方文档都印证了「块」这个概念**——
Kimi 直接说「不足一整块的部分无法写入缓存」，DeepSeek 说「命中要求完全匹配一个 prefix unit」。
vendor-local 走的是 openai-completions 兼容层（`cached_tokens` 语义），行为与它们一致：**整块命中**。

## 五、结论与建议

### 1. 前缀稳定化做对了，但不是命中低的根因

它的收益体现在 `cacheRead` 占比（本机 70.6% 的 token 是 cacheRead，成本占比 13%）。
它**不能**让命中率从 19% 跳到 99%——那是块大小决定的。

### 2. 要提高命中率，方向是「把前缀做大」而不是「把前缀做稳」

- 契约块只有 600 token，加上 pi 的 preamble/tools/rules 才 665 token ⇒ **凑不满块**
- 实测 4998 token 的前缀能 99.7% 命中，17799 token 能 99.2%
- **可行的做法**：让子代理共享一段**更大的稳定前缀**（比如统一的「工具使用规范 + 仓库约定 + 常见任务模板」），把前缀推到几千 token 量级
- 但这与「减量」直接冲突（更大的前缀 = 更多的 cacheRead token）。**好在 cacheRead 单价是 input 的 1/10**（0.015 vs 0.15），所以「大前缀 + 高命中」在成本上可能反而更便宜——但需要实测。

### 3. `prompt_cache_key` 不用改

实测发不发命中一样。`compat.promptCacheKeyMode: "enabled"` 无收益，不动。

### 4. Kimi 那个「interleaved thinking 会破坏缓存」对本项目**可能**有影响，但本机验证不了

Kimi 论坛明确说：K2.5 架构下前缀缓存要求**逐字节对齐整个上下文，包括 hidden `reasoning_content`**，
工具交错 thinking 会让缓存掉。
本机走 vendor-local（openai-completions 兼容层），**实测没有这个现象**——但如果哪天切到 Kimi 直连，
**工具调用交错 + thinking** 就会毁掉缓存。这是一个「切模型前要先验」的坑。

### 5. 还有一个未验证的可能：vendor-local 网关的实现

它是本地网关（`127.0.0.1:3425`），转发到 vendor-local 自己的 provider。
「整块命中 + 偶尔跳到 92%」这个行为，**可能是网关自己的实现**，不一定是上游 provider 的规则。
`~/.config/vendor-local` 下可能有它的配置或日志可以查。**这是下一步该挖的地方。**

## 附：探针脚本

- `/tmp/cache-probe.mjs` —— A/B：同前缀两次、带不带 key
- `/tmp/cache-probe3.mjs` —— 交替对照（每组全新前缀）
- `/tmp/cache-probe4.mjs` —— 同前缀连打 8 次 / 长前缀
- `/tmp/cache-probe5.mjs` —— 命中粒度（cached 取值集合）
- `/tmp/cache-probe6.mjs` —— 模拟真实子代理前缀

**复现方式**：`node /tmp/cache-probe5.mjs`（需要 vendor-local 网关在跑）。

---

# 附二：该不该用提示词引导模型选低的 thinking 档位？

## 结论

**不该。** 有三条理由，前两条是硬事实，第三条是设计原则。

## 理由一：档位不是「选模型」，是「选同一模型想多久」

Claude Code 的 subagent 有独立的 `model` 与 `effort` 两个 frontmatter 字段
（`effort` 选项 `low`/`medium`/`high`/`xhigh`/`max`，与 pi 的 `thinkingLevel` 同构）。
它把两件事分开：**用哪个模型**（决定能力与单价）与**想多久**（决定 output token）。

本机 vendor-local 的档位表（`~/.pi/agent/models.json` 实测）：

```
regex:group/main: {high:"high", low:"low", max:"max", medium:null, minimal:null, off:"none", xhigh:null}
```

**关键：`max` 与 `high` 预算完全相同（都 16384）**，而 `max` 在本机是**默认值**
（`defaultThinkingLevel = "max"`）。

所以「引导模型选低的」在这个 provider 上只能降到 `low`（2048，**省 8 倍**）或 `off`。
`medium`/`minimal`/`xhigh` 都是显式 `null`（不支持）——**引导模型去选它们，
pi 的 clamp 会把它抬回 `high`（16384），反而是最贵的**。

> 这正是我们这次改造要防的：`resolveThinkingLevel` 现在做的是「只降不升 + 只发 supported 里的档位」。
> 提示词引导会让模型说出 `medium`，pi 会抬到 `high` —— 除非 core 层拦住。

## 理由二：档位是父方的成本决策，不是子代理的判断

`thinkingLevel` 决定的是**子代理自己**要想多久。子代理不知道父方这次派它的预算、
不知道这个任务在整体里多重要、也不知道父方的默认档位是什么。

让它自己选档位，会出现两个坏方向：

- **一律选低**（省了钱，复杂任务做不好）
- **一律选高**（"我觉得这题需要深思" ⇒ 挑 `high`/`max` ⇒ 16384 预算）

Claude Code 的做法也是**静态配置**：用 `description` 让父模型判断「该不该委派」，
**档位由 frontmatter 固定**。父模型不选档位，它只选「派哪个 agent」。

## 理由三：引导会破坏「只降不升」这条不变量

现在的设计是：**父方给上限，core 只做校验与降级，不做推荐**（方案 §2.2 明确写了这条）。

一旦在提示词里写「简单任务请用 low」，就变成：

- 模型可能不照做（提示词是建议，不是约束）
- 模型可能**选一个比父方指定的更低**的档位 ⇒ 父方想 `high` 的活儿被降成 `low` ⇒ **质量静默下降**
- 更糟：父方**显式**指定了 `high`（"这个要深思"），模型在提示词引导下改成 `low` ⇒ **父方的显式意图被覆盖**

第三条是最要命的——**显式参数必须压过提示词**。现在的实现正好相反地安全：
不给档位 → 沿用会话默认；给了无效档位 → 降到 `low` 并在回执里说明原因。

## 那正确的做法是什么

要让子代理跑得便宜，**不是引导它选档位，是父方在派发时就定好**：

| 场景               | 父方该怎么做                                                   |
| ------------------ | -------------------------------------------------------------- |
| 批量、简单、可并行 | `dispatch_task({ thinkingLevel: "low" })` 显式指定             |
| 复杂、要深思       | `dispatch_task({ thinkingLevel: "high" })`，或不给（沿用默认） |
| 想省、又怕降坏     | 不给档位，让 core 按目标模型校验（无效档位自动降到 `low`）     |

**工具 schema 的描述是关键**——它就是父模型读到的「引导」。现在的描述是：
`"覆盖子代理的思考深度。"` —— 太弱，父模型不知道什么时候该给 low。

建议改成（**本轮只做分析，不改代码**）：

```
thinkingLevel: "子代理的思考档位。simple 任务用 low 省成本（vendor-local 上省 8 倍）；
复杂任务用 high 或不给（不给=沿用会话默认）。给了无效档位会自动降到 low，回执里会说明实际生效的档位。"
```

这样父模型**有明确的、可执行的依据**（省 8 倍），而不是模糊的「省点成本」。
它仍然是在**显式参数**层面做决策，不违反「显式压过提示词」。

## 一个顺带的发现

Claude Code 的 `description` 有个 15000 token 的上限警告
（"Claude Code shows a warning at startup with the total token count"）——
**子代理的描述是要花父方 context 的**。

对本项目的启示：`dispatch_task` 的参数描述也是父模型每次都要读的。
现在 10 个参数的描述加起来不小，如果以后加更多参数要注意这个账。

---

# 附三：挖 vendor-local 网关的缓存实现（最后一块拼图）

> 全部数字来自 `~/.config/vendor-local/affinity.json`（905KB，4096 条），
> 以及直接打网关 `http://127.0.0.1:3425/v1` 的探针。

## 一、vendor-local 的会话亲和表

`~/.config/vendor-local/affinity.json` 是 vendor-local 自己的**会话亲和映射表**：

```json
{
  "regex:group/main|0033a675c56d4d3e6b959dcf|01a20c6a-...": {
    "rest": "deepseek", // 实际路由到哪个上游
    "who": "deepseek#8ac7dd506a", // 上游的账号/实例
    "model": "deepseek-flash",
    "turn": 1,
    "at": "2026-11-23T01:24:07+08:00",
    "cacheRead": 2432
  }
}
```

**键是三段**：`请求的模型 | 会话指纹 | pi 的会话 id`。
**值记着**：实际落到哪个上游（`rest`）、上游的哪个实例（`who`）、命中了多少缓存（`cacheRead`）。

表正好 **4096 条 = 2¹² ⇒ LRU 定容**，跨 2026-11-22 至今。

## 二、关键发现：`regex:group/main` 是个**路由组**，会分流到三个上游

3138 条 `regex:group/main` 会话的路由分布：

| 上游（`rest`） | 会话数     | cacheRead 中位 | 128 的倍数占比 |
| -------------- | ---------- | -------------- | -------------- |
| **deepseek**   | 2423 (77%) | **6912**       | **100%**       |
| kimi           | 350 (11%)  | 3840           | 87%            |
| minimax-code   | 365 (12%)  | 3081           | 57%            |

**三个上游的缓存粒度不一样**：

- **deepseek**：100% 是 128 的倍数 ⇒ **严格按 128 token 分块**（与官方文档的「cache prefix unit」一致）
- **kimi**：87% 是 128 倍数，混有连续值 ⇒ 块为主但不严格
- **minimax-code**：只有 57% 是 128 倍数，取值散在 186/187/188… ⇒ **接近连续前缀匹配**

## 三、实测：同一个网关、同一个前缀，只因路由不同，命中差 10 倍

固定前缀（1520 token），同一会话连打 4 次：

```
regex:group/main                  128/1519  128/1519   186/1519   186/1519
group/free-tier                       0/1885     0/1885     0/1885     0/1885
group/analysis                      128/1493  128/1493  128/1493  128/1493
group/quality                    0/1539  1280/1539 1280/1539 1280/1539
deepseek/deepseek-flash           1280/1473 1280/1473 1280/1473 1280/1473
```

- `group/quality` 与 `deepseek` 直连：**1280/1539 = 83%**
- `regex:group/main`：**128~186/1519 = 8~12%**

**同样的前缀，命中差 10 倍。** 差异不在提示词、不在 `prompt_cache_key`、不在前缀长度——
**在 vendor-local 把请求路由到了哪个上游。**

## 四、为什么「main-tier」反而命中低

`affinity.json` 里 `regex:group/main` 的 3138 条会话：
**turn=1 有 2836 条（90%），turn=2 只有 68 条，turn=3 有 186 条。**

而**轮数越多，前缀越长，命中越高**：

| turn  | 会话数 | 有缓存比例 | cacheRead 中位 |
| ----- | ------ | ---------- | -------------- |
| 1     | 2836   | 99%        | 5248           |
| 2     | 68     | 100%       | 4224           |
| **3** | 186    | 99%        | **40401**      |
| 4     | 7      | 100%       | 177024         |
| 5     | 15     | 100%       | 35072          |

**90% 的会话只有 1 轮。** 单轮请求没有「上一轮的前缀」可复用，
只能靠**跨会话共享**（别的会话写过同样的前缀）——这就撞上了块大小：
665 token 的子代理前缀**凑不满 deepseek 的 128 块**（不对，128 块是很小），
更准确地说：**单轮会话的前缀太短，写入缓存的块少，与其它会话共享同一段前缀的概率也低**。

## 五、结论（修正前面「块大小」的说法）

前面我说「命中低是因为前缀凑不满块」——**这个说法不准确**。真实机制是三层：

1. **块大小确实存在**（deepseek 严格 128，minimax 接近连续），但它决定的是「能命中多少」，
   不是「为什么不命中」。

2. **真正的主因是：90% 的子代理会话只有 1 轮。** 单轮没有轮内前缀复用，
   只能跨会话共享 ⇒ 依赖「恰好别的会话写过同一段前缀」⇒ 命中是**运气**。

3. **路由到哪个上游，决定了运气好不好**：
   - 落到 deepseek（77%）：严格 128 块 ⇒ 稳定命中整块
   - 落到 minimax-code（12%）：连续匹配 ⇒ 命中零碎（186/187/188…）
   - `group/quality` 直连能拿 83%，`main-tier` 只有 8~12% ⇒ **路由组内部的转发逻辑在吃掉缓存**

## 六、下一步该查什么（本次已挖到的边界）

1. **vendor-local 的路由策略**：`regex:group/main` 什么时候分给 minimax-code？
   `~/.config/vendor-local/` 下有 `auto-picks.json`、`applied.json`、`bili-plugins.json` 等，
   可能记录了路由决策与缓存亲和规则。**这是最后一块拼图**。

2. **`who` 字段的复用率**：同一 `who`（上游实例）拿到相同前缀才可能命中。
   如果路由每次都换实例，缓存永远不共享。

3. **子代理能不能指定上游**：`regex:group/main` 是路由组；
   `deepseek/deepseek-flash` 直连实测 83% 命中 —— 但价格不同（见 models.json）。

## 七、对 pi-dispatch 的直接含义

**前缀稳定化仍然是对的**（它让「同一个子代理的多轮」能复用），
但**单轮子代理占 90%** 意味着：

- 真正的收益来自**跨子代理共享同一段前缀** ⇒ 需要**更大的稳定前缀**（几千 token 量级）
  才能让不同子代理落在同一个块里 —— 这与「减量」直接冲突，
  但 cacheRead 单价是 input 的 1/10，可能反而更便宜（**待实测**）
- 或者**减少子代理数量**（一次派一个干更多活）—— 轮数多反而命中高

---

# 附四：挖 vendor-local 的 usage.jsonl —— 推翻前面的判断

> `~/.config/vendor-local/usage.jsonl`（63MB，86972 条请求），
> 字段：`t / agent / provider / host / model / req / in / out / cache_read / cache_write / ms / status / ep / kind / source`。

## 一、整体命中率是 **96.4%**，不是 12%

```
provider       model                    n      有缓存%   cacheRead       input    命中%
deepseek       deepseek-flash       54729       96.4%  4312700796   157204502    96.5%
minimax-code   MiniMax-M3.1-Flash   12688       97.7%  2703247231    74171014    97.3%
kimi           kimi-for-coding       13622       97.8%  2089842613    39874239    98.1%
minimax-cn     MiniMax-M3.1-Flash    2877       97.6%   742089063    25579002    96.7%
--------------------------------------------------------------------------------
总请求 86972   总 cacheRead 10,011,227,889   总 input 371,602,742   整体命中 96.4%
```

**缓存工作得很好。** 我前面那些「19%」「8%」的探针数字**全部是错的**——它们打的是**裸网关**，
没带 vendor-local 的会话亲和头。

## 二、决定性实验：亲和头有没有带，差 8 倍

固定前缀（1518 token），同一会话连打 3 次：

```
A 无亲和头                            0/1518   186/1518    0/1518     ← 12%
B x-session-affinity (pi 现在发的)  1408/1518 1517/1518 1280/1518   ← 93%
C session_id (OpenAI 格式)          1408/1518 1517/1518 1280/1518   ← 93%
D x-session-id (OpenRouter 格式)     1408/1518 1517/1518 1280/1518   ← 93%
```

**vendor-local 对三种头格式都认**（宽松匹配），但**带头与不带头差 8 倍**：
vendor-local 用亲和头把同一个会话**路由到同一个上游实例**⇒ 上游的 KV cache 才可能复用。

`pi-ai/dist/api/openai-completions.js:527-537` 正好发这三种之一：
`compat.sessionAffinityFormat` = `openrouter` → `x-session-id`；
= `openai` → `session_id`；
默认 → `x-client-request-id` + `x-session-affinity`。

**本机 `~/.pi/agent/models.json` 的 vendor-local provider 只配了 `sendSessionAffinityHeaders: true`，
没配 `sessionAffinityFormat`** ⇒ 走默认分支，发 `x-session-affinity` ⇒ **实测能被 vendor-local 认（B 组 93%）**。

## 三、所以「命中低」的真实原因是什么

**不是块大小、不是 `prompt_cache_key`、不是路由到哪个上游。**
是「**请求有没有带亲和头**」这一个开关。

而我们的 pi-dispatch **子代理已经带了**（继承会话的 `sessionId`）——
所以真实派发里缓存是**工作正常**的。实测首轮 `in=4640 / cacheR=8320`，`cacheRead` 已经大于 `input`。

## 四、修正前面几节的结论

| 前面说的                                                | 实测真相                                                                   |
| ------------------------------------------------------- | -------------------------------------------------------------------------- |
| 「命中是整块不是连续前缀」（基于 128 倍数分析）         | **成立但不重要** —— 那是上游实现的细节，vendor-local 亲和路由后 96.4% 命中 |
| 「`prompt_cache_key` 没用」                             | **成立**（带不带命中一样）—— 因为亲和头已经起效                            |
| 「前缀太小凑不满块」                                    | **错** —— 真因是没有亲和头                                                 |
| 「`regex:group/main` 路由到 minimax-code 导致命中零碎」 | **部分对但不是主因** —— 亲和头能纠正路由                                   |
| 「90% 会话只有 1 轮」                                   | **事实成立**，但不是命中低的原因                                           |

## 五、真正值得做的三件事

### ① 确认子代理一定带上了亲和头

`pi-dispatch` 派子代理时走 `pi` 的 CLI 通道，`sessionId` 会不会被传下去？
**这是唯一要验的事** —— 如果子代理没带亲和头，那它的 cacheRead 就会掉到 12%。
实测：子代理首轮 `cacheR=8320 > in=4640` ⇒ **带了，且工作正常**。

### ② 把 `sessionAffinityFormat` 显式写成 `"openai"`

本机现在靠 vendor-local 的宽松匹配兜住（实测 B 组能用）。
但这是**运气**——vendor-local 换实现就可能只认一种格式。显式写死更稳：

```json
"vendor-local": { "compat": { "sendSessionAffinityHeaders": true, "sessionAffinityFormat": "openai" } }
```

### ③ 一个可观测性缺口：pi-dispatch 的回执里没有「亲和头是否生效」

现在子代理的用量回执有 `cacheRead`，但**看不出它是靠亲和命中的还是靠前缀碰巧相同**。
建议在回执里加一个「首轮 cacheRead 占比」的派生值，或至少在成本分析时区分：

- 首轮 cacheRead ≈ 0 ⇒ 前缀没共享（亲和头没生效或前缀不同）
- 首轮 cacheRead 高 ⇒ 亲和生效

## 六、附带发现：`applied.json` 显示各 harness 用的模型

```json
"alma":       { "model": "regex:test-vendor/group/main" },
"claude":     { "model": "regex:group/main[1m]" },
"codex":      { "model": "regex:group/main" },
"omp":        { "model": "regex:test-vendor/group/main:high" },   ← 唯一显式带档位的
"kimi":       { "model": "regex:test-vendor/group/main" },
```

**`omp` 是唯一用 `:high` 的**——这解释了为什么 omp 的成本比别的 harness 高。
而我们刚做的 thinking 改造，作用就在这里：`main-tier:high` → 校验后仍是 high（vendor-local 支持），
但如果是 `:medium` 就会被 pi 抬到 high，`:low` 才会真降。

---

# 附五：精确的缓存命中算法（替代粗略的 cacheRead 占比）

> 目标：判断「缓存到底有没有起作用」，而不是笼统地看 cacheRead 占 input 的比例。
> 依据：OpenAI 官方文档 + 本机 190 条真实回合的 usage 数据。

## 一、为什么「cacheRead 占比」太粗

三个具体问题：

### ① 分母是错的

`cacheRead / (input + cacheRead)` 把**本轮新增的 input**也算进分母。但本轮的 input 里
包含了「上一轮 assistant 的输出 + 工具结果」——**这些本来就该是新的**。
一个跑了 5 轮的任务，第 5 轮的 input 天然很大、cacheRead 占比天然低，
但缓存其实**工作得很好**。

### ② 跨轮不可比

不同轮次的 prompt 长度不同、工具调用密度不同。汇总成一个比率会互相抵消：
「首轮命中差」被「后续轮命中好」平均掉。

### ③ 丢失了「谁命中了什么」

`UsageTracker` 现在只累加总额（`src/core/child.ts:688`：`usage = addUsage(usage, takeUsage(...))`），
**逐轮的 usage 明细被丢掉了**。想做精确分析，必须先留住它。

## 二、口径先钉死（实测确认）

从本机 190 条真实回合的 usage 数据：

```
input= 2689  cacheRead=  189  totalTokens= 3078   差 = 200 = output
input=  216  cacheRead= 2878  totalTokens= 3158   差 =  64 = output
input= 9592  cacheRead=  128  totalTokens= 9935   差 = 215 = output
```

**`totalTokens = input + cacheRead + output`**（`cacheWrite` 恒为 0，本机 provider 不收写入费）。

OpenAI 官方口径（[Prompt caching](https://platform.openai.com/docs/guides/prompt-caching)）：

> "Reported `cached_tokens` is calculated by subtracting the hidden system tokens from the last
> matched breakpoint, then rounding down to the nearest multiple of 128."

**两个要点**：

1. `cached_tokens` **已经扣掉了 hidden system tokens** ⇒ 它是「用户侧可见前缀」的命中量
2. **向下取整到 128 的倍数** ⇒ 命中量有 128 的量化误差

但本机实测 `cacheRead` 有 **189 / 188 / 9523** 这些**不是 128 倍数**的值
（190 条里 147 条是 128 倍数，43 条不是）⇒
**vendor-local 链路上至少有两个不同的上游实现**（deepseek 严格 128、minimax 连续），粒度不统一。

## 三、精确算法：三个指标，分工不同

### 指标 A：前缀复用率（Prefill Reuse Ratio）— 判断「缓存机制有没有生效」

**不是** cacheRead 占比，而是**「这次请求的 prompt 里，有多少是复用来的」**：

```
promptTotal   = input + cacheRead        // 本轮的 prompt token 总量
reuseRatio    = cacheRead / promptTotal  // 复用的比例
```

但要用**首轮**来判（后续轮会自然升高），而且要**和期望值比**：

```
首轮期望命中 ≈ 0（子代理是独立会话，没有"上一轮"可复用）
首轮实际命中 > 0 ⇒ 说明跨会话/跨子代理共享了前缀 ⇒ 前缀稳定化在起作用
```

**判读表**：

| 首轮 reuseRatio | 含义                   | 该查什么                   |
| --------------- | ---------------------- | -------------------------- |
| **> 0.5**       | 前缀共享成功           | ✅ 健康                    |
| **0.05 ~ 0.5**  | 部分共享（落在块边界） | 看前缀长度是否够整块       |
| **≈ 0**         | 完全没共享             | 亲和头？前缀是否真的恒定？ |

### 指标 B：增量命中率（Incremental Hit Rate）— 判断「轮与轮之间有没有接上」

对第 N 轮，**能复用的上限**是上一轮的 prompt 总量：

```
prevPrompt   = 上一轮的 (input + cacheRead)
curPrompt    = 本轮的 (input + cacheRead)
maxReusable  = min(prevPrompt, curPrompt)     // 理论上最多能复用多少
incremental  = cacheRead / maxReusable       // 实际复用了理论上限的百分之多少
```

**这是判断「前缀稳定化做对没有」的精确指标**：

- `incremental ≈ 1` ⇒ 轮与轮完美接上，前缀真的恒定
- `incremental ≈ 0` ⇒ 每轮都从零开始 ⇒ **前缀在轮内就变了**（工具结果插在前面了？）

**关键**：`maxReusable` 用 `min(prevPrompt, curPrompt)` 而不是 `prevPrompt`——
因为本轮 prompt 可能比上轮短（compaction 截断），此时上轮全部都可能被复用。

### 指标 C：预期缺口（Prefix Gap）— 定位「差多少、差在哪」

```
expected = 本轮 prompt 总量（如果前缀完全恒定，理论上全部可复用）
actual   = cacheRead
gap      = expected - actual
```

`gap` 大 ⇒ 有东西在破坏前缀。但**光看 gap 不知道是什么破坏的**。

**要定位破坏点，得有前缀的内容指纹。** 方案见 §四。

## 四、定位「什么破坏了前缀」：前缀指纹

OpenAI 官方给的诊断思路是 **Prompt Cache Diagnostics**：

> "Compare a request with an earlier response to identify changes to the..."

具体做法（不需要 OpenAI 的工具，自己能算）：

### 做法：记录每轮的「前缀指纹」

在 `UsageTracker` 里，**每轮记一个指纹**：

```ts
interface TurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  /** 本轮 prompt 的前缀指纹：把「到目前为止的 user/system 内容」哈希掉。 */
  prefixHash: string; // 前 N 轮的稳定内容哈希
  /** 本轮 prompt 尾部（变化部分）的哈希。 */
  tailHash: string;
}
```

**指纹怎么算**（不需要改 pi 的协议）：
子代理的 argv 是**我们自己拼的**（`src/core/child.ts` 的 `buildPiArgv`），
所以**子代理侧知道自己的前缀长什么样**：

- `prefixHash` = hash(契约块 + 工具定义 + 系统提示词) —— 这部分**每轮都相同**
- 变化的部分 = user message + 工具结果 —— 每轮都不同

**于是能算出**：

| 现象                                                  | 判定                                               |
| ----------------------------------------------------- | -------------------------------------------------- |
| 首轮 `cacheRead` ≈ 0 且 `prefixHash` 与别的子代理相同 | 前缀恒定但**没被共享** ⇒ 亲和头/路由问题           |
| 首轮 `cacheRead` ≈ 0 且 `prefixHash` 每次都不同       | 前缀**不恒定** ⇒ 前缀稳定化没做对                  |
| 轮 2 的 `incremental` ≈ 0                             | 轮内前缀被破坏（工具结果插到前面 / thinking 交错） |

## 五、要动代码的地方（很小）

### 改动 1：`UsageTracker` 留住逐轮明细（必要）

现在（`src/core/child.ts:677-689`）只累加总额。改成同时保留逐轮数组：

```ts
export interface UsageTracker {
  push(chunk: string): void;
  finish(): void;
  snapshot(): { usage: ChildUsage | null; turns: number };
  /** 逐轮明细——做命中分析要它。 */
  turns: TurnUsage[]; // 新增
}
```

代价：每个子代理多存 N 条记录（N = 轮数，通常 < 10）。可接受。

### 改动 2：新增一个纯函数模块 `src/core/cache-metrics.ts`（新增，不碰别的）

```ts
export interface CacheMetrics {
  /** 指标 A：前缀复用率（首轮） */
  firstTurnReuse: number | null;
  /** 指标 B：逐轮增量命中率 */
  incremental: Array<{ turn: number; rate: number; maxReusable: number }>;
  /** 指标 C：总缺口 */
  gap: number;
  /** 判定 */
  verdict: "healthy" | "partial" | "not-reusing";
}

export function computeCacheMetrics(turns: TurnUsage[]): CacheMetrics { ... }
```

**纯函数，不 import pi ⇒ 可独立单测**（跟 `budget.ts` / `thinking.ts` 同一层）。

### 改动 3：回执里加一个「健康判定」而不是一堆数字

**不要**把 firstTurnReuse / incremental / gap 三个数全塞进回执——父方的 context 有限
（Claude Code 专门警告过 subagent 描述超 15000 token 会告警）。

只放**一个判定 + 一个数**：

```ts
cache?: {
  /** "healthy" | "partial" | "not-reusing" */
  verdict: "healthy" | "partial" | "not-reusing";
  /** 首轮前缀复用率（0~1）——唯一给父模型看的数 */
  reuse: number;
}
```

**为什么值得加**：这是唯一能把「缓存静默失效」变响的东西。
今天 96.4% 的命中率是「vendor-local 宽松匹配 + pi 自动检测推导出 openai」两个巧合叠出来的。
哪天 vendor-local 改实现，**没有任何东西会告诉你**——你只会看到成本悄悄涨 8 倍。

## 六、判据的可执行化（符合仓库纪律）

「约束写进检查，不写成段落」——这个指标要变成**可测的判据**，不是文档里的一句话：

| 判据                                    | 形式                                                          |
| --------------------------------------- | ------------------------------------------------------------- |
| 首轮 `cacheRead == 0` 且 `input > 阈值` | ⇒ 派发结果里带一行提示「前缀未共享：cacheRead=0，检查亲和头」 |
| `incremental` 连续两轮 < 0.3            | ⇒ 提示「轮间前缀未接上：检查工具结果是否插在 system 之前」    |

阈值取值：`input > 2000`（低于这个值的请求本来就不该指望缓存命中——
本机 provider 的最小可缓存长度未公开，但实测 128/189 这种小命中说明下限很低）。

## 七、明确不做的事

- **不做前缀内容比对**（把两次请求的 prompt 逐字节 diff）：子代理的 prompt 里有
  工具结果、时间戳等不可控内容，diff 噪音大且要存敏感数据。
  只做**指纹比对**（哈希，不存原文）。
- **不引入 OpenAI 的 Prompt Cache Diagnostics**：那是 OpenAI 平台侧的工具，我们走 vendor-local 网关，
  拿不到它的 trace。
- **不在回执里放逐轮明细**：父方不需要看每一轮，只看判定 + 首轮率。
- **不改 vendor-local 配置**：按你的要求，① 不做。

## 八、验证方式

1. 用 `test/fixtures/` 加一份**真实 usage 样本**（从本机 190 条里挑代表性的），
   喂给 `computeCacheMetrics`，断言三个指标的值 —— 这是纯函数，快。
2. 造**三种退化场景**的夹具：全命中 / 部分命中 / 零命中，断言 verdict 分别是什么。
3. 配破坏点：`computeCacheMetrics` 的三条判据各一条。
4. **真机验证**：派两个只有 `why` 不同的子代理，看首轮 `cacheRead`：
   改造前（why 在 system 里）≈ 0；改造后（why 在 user message 里）应 > 0。
   这是「前缀稳定化到底有没有用」的直接证据 —— **目前还没有这条证据**。

---

# 附六：DeepSeek Harness 的「改 system prompt 不破 KV Cache」— 我们能不能用上

> 线索来源：微信公众号文章（微信墙挡住，用官方仓库与文档站取证）：
>
> - `deepseek-ai/deepseek-harness`（GitHub）
> - `deepseek-ai/deepseek-harness` Discussion #14184：
>   _"[Bug] KV cache never hits: per-turn top-level system prompt breaks DeepSeek prefix cache"_
> - 官方文档站 `deepseek-harness-docs.com/en/runtime/system-prompt`
> - `deepseek-ai/dsh-system-prompt` 仓库摘要

## 一、他们怎么做到的

**核心是把「系统提示词」拆成两类**：

| 概念            | 是什么                                            | 与缓存的关系                            |
| --------------- | ------------------------------------------------- | --------------------------------------- |
| `PromptSection` | 系统提示词的**静态段**（注册契约，按 order 拼接） | **进前缀** ⇒ 必须逐字节恒定             |
| `PromptContext` | **动态模型上下文，物化成持久化的 user-role 快照** | **不进 system prompt** ⇒ 改动它不破前缀 |

官方原文：

> "`PromptContext` is the **cache-safe counterpart** to `PromptSection`."
> `/** Dynamic model context materialized as a durable user-role snapshot. */`

**所以「保留 KV Cache 的同时更新 system prompt」不是靠某个魔法参数**，
而是靠**不让动态内容进 system prompt**。

### 那篇文章说的「更新 system prompt」到底更新了什么

Discussion #14184 的 bug 是：

> "**per-turn top-level system prompt** breaks DeepSeek prefix cache"

⇒ 每轮都重写顶层 system prompt ⇒ 每轮前缀都变了 ⇒ 缓存永不命中。

**修法**：把每轮变化的内容从 top-level system prompt 里挪走，
改成 **user-role 的持久化快照**。system prompt 只保留恒定段。

文档站的另一句摘要印证了这条路线：

> "KV Cache effect. **Ordinary updates preserve earlier messages.**
> Route changes, resume, explicit request-series starts, and tool-schema changes **do not** [preserve]."

⇒ **普通的内容更新（放进 user 消息）保缓存**；
**换路由 / 恢复会话 / 工具 schema 变了 / 显式开新请求序列 ⇒ 破缓存**。

## 二、跟我们改造③ 是不是一回事

**是同一个思路，我们做得更朴素。**

|               | DeepSeek Harness                           | 我们的 pi-dispatch 改造③                |
| ------------- | ------------------------------------------ | --------------------------------------- |
| 静态段        | `PromptSection`（按 order 拼接）           | `CONTRACT_BLOCK`（上下文块 + 报告契约） |
| 动态内容落点  | `PromptContext` → **user-role 快照**       | why + 隔离契约 → **user message**       |
| system prompt | 每轮恒定                                   | 每轮恒定（实测逐字节相同）              |
| 破缓存的雷    | route change / resume / tool-schema change | 同左（工具名单变了就破）                |

**我们的改造方向和 DeepSeek 官方一致。** 这是个很强的背书。

## 三、能不能进一步用上？—— 有三个可借鉴点

### ① 我们比他们少做了「动态上下文的分层」

DeepSeek 有 `PromptSection`（静态，系统提示词）与 `PromptContext`（动态，user 快照）**两个注册通道**，
还有 `suppressRuntimeContext()` 用来在某个 scope 里**整体压制**动态上下文。

我们现在是**一刀切**：`why` 和隔离契约都塞进同一条 user message。

**可借鉴**：把「每轮都会变的」和「这个子代理特有的」分开。
比如：

- 隔离契约（`isolation=worktree`）—— **同一个子代理内恒定** ⇒ 可以放进静态前缀（不进 user message）
  （我们现在是放 user message 的，因为它条件出现 → 会让前缀在「隔离/非隔离」之间分叉）
- `why` —— **每个子代理都不同** ⇒ 只能放 user message（我们做对了）

**这可能是个真实的优化点**：如果隔离契约能进静态前缀，
那「隔离组」和「非隔离组」就能各自共享一整块前缀。

### ② `suppressRuntimeContext()` 的思想：给子代理「按需注入」

DeepSeek 有一个「在当前 scope 里压制全部动态上下文」的能力。

对我们：**只读/侦察档**的子代理其实不需要 why（它只是执行一个查询）。
如果这类子代理能**完全不带动态上下文**，它的 user message 就是纯任务 ⇒
前缀更短更规整 ⇒ 更容易命中整块。

### ③ 最重要的一条：他们明确列出了「什么会破缓存」

> Route changes, resume, explicit request-series starts, and **tool-schema changes** do not [preserve].

**「tool-schema changes」这条我们要特别注意**：

我们改造③ 里有 `readOnly: "strict"` 档会收窄工具名单（`--tools read,grep,find,ls,child_report`）。
**工具名单变了 ⇒ 工具 schema 变了 ⇒ 前缀变了 ⇒ 缓存不共享。**

也就是说：

- 普通档（read,bash,edit,write）的子代理之间：**能**共享前缀
- strict 档（只读工具）的子代理之间：**能**共享前缀（另一组）
- 但 strict 档和普通档之间：**不能**共享（工具 schema 不同）

**当前我们的前缀稳定化没有考虑这一点。** 如果同时派了普通档和 strict 档，
它们会落在**两个不同的前缀**上，各自的命中率都降低。

## 四、我们的实测印证

我们实测过（`/tmp/cache-probe6.mjs`，模拟真实子代理前缀）：

```
子代理1: 19.2%   子代理2: 19.2%   子代理3:  0.0%   子代理4: 77.0%
```

同一前缀 8 次里有 2 次是 77%、3 次是 19%、1 次是 0% —— **同一前缀不同命中率**，
说明**命中与否取决于「刚好有没有别的会话写过同一段前缀 + 落在哪个块边界」**。

DeepSeek 官方文档说的「cache prefix unit 必须完全匹配」正好解释这个。

## 五、结论与建议

### 结论

**我们改造③的方向与 DeepSeek 官方一致，可以继续沿着这条路优化。**
但「保留 KV Cache 更新 system prompt」**没有可移植的魔法参数**——
它是**架构约束**（动态内容不进 system prompt），不是 API 特性。

### 三个具体可做的（按性价比）

| #   | 做什么                                                                       | 收益                                   | 代价                                                 |
| --- | ---------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------- |
| 1   | **隔离契约按「组」拆前缀**：同组共享一段恒定前缀（隔离组一份、非隔离组一份） | 同组子代理之间的前缀共享率↑            | 两种前缀各占一点缓存                                 |
| 2   | **只读/侦察档不带 `why`**（它对执行查询没用）                                | user message 更短更规整 ⇒ 更易命中整块 | 要想清楚「侦察类任务为什么需要 why」——**也许不需要** |
| 3   | **在回执里区分「工具档位」**                                                 | 父方能知道哪些子代理可以共享前缀       | 一个字段                                             |

### 但这些都要先有观测

**没有 §附五 的「精确命中算法」（逐轮明细 + 前缀指纹），
上面三条都是猜。** 先把观测做出来，再决定改哪一条。

**所以顺序是：**

1. 先做精确命中算法（附五）—— 让「前缀有没有共享」变成可测的数字
2. 再做真机验证：普通档 vs strict 档的两个子代理，看 cacheRead 差多少
3. **有数据了**再决定要不要做上面三条

### 一个明确的「不要做」

**不要去找「保留 KV Cache 更新 system prompt 的 API 参数」。** DeepSeek 那边没有这个参数——
Chat Prefix Completion（Beta）是「让模型续写你的前缀」，不是这个。
它靠的是**架构**：动态内容进 user 快照，不进 system prompt。
我们已经在正确的路上了。

---

# 附七：六 harness 评审 + 「why 不破缓存」的决定性实测

> 本轮派发 codex / pi / omp / claude / kimi / mcode 六个 harness 独立评审，
> 评审中发现了**改造③ 的一个未被怀疑的前提**，并用对照实验做了决定性验证。

## 一、DeepSeek 的真机制（claude 挖到，此前我判错了方向）

claude 在 DeepSeek 官方仓库找到实现笔记：
`.agents/notes/implemented/feature/2026-09-02-in-history-system-prompt-replacement.md`

### 真机制：**in-history system prompt replacement**

> "A DeepSeek model ... **accepts a `system` message at any position of the conversation and
> treats the latest one as the complete effective system prompt, replacing the leading one.**
> Tool schemas remain part of the cached prefix"

**这不是「把动态内容挪到 user 消息」，而是「把新的 system 消息追加在历史后面，
让模型把最后一条 system 当作生效的 prompt」。**

能力声明：`SystemPromptUpdate = 'in-history'`，挂在 `LlmResolvedModelInfo` /
`PreparedLlmCall` 上，按**模型**声明（`dsh-llm-deepseek` 里只有 `deepseek-flash` 声明了）。

决策规则（官方表格，摘要）：

| Route capability | Prefix state         | Operation                                                  |
| ---------------- | -------------------- | ---------------------------------------------------------- |
| none             | 非空渲染             | 重写第一个 system 节点（**破缓存**）                       |
| `in-history`     | 当前请求序列继续     | **在 step 的 user 消息前追加新的 system 节点**（不破缓存） |
| `in-history`     | 新序列开始且文本不同 | 折叠回 node 0（**破缓存**，但那时缓存已丢）                |

关键工程细节：

- **首轮 / resume / route 变更 / capability 变更** 用「实际服务该次调用的 adapter」的能力
- `startsSeries` 为真的三种情况：`agent/pre-step` 声明、**compaction 或任何替换导致 generation 移动**、
  **可见 tool-schema 集合变化（且该 route 不支持 toolUpdate）**
- **provider/model 切换本身不算 series start**——因为换 route 反正要破缓存，追加 prompt 不额外花钱
- 官方明确：**「Send only the changed sections as a delta」被否决**——
  因为模型把最后一条 system 当作完整 prompt，delta 会静默丢掉所有未变更的段

### ⇒ 我之前附六的结论「没魔法参数」**是错的**

DeepSeek 有能力开关，但**前提是模型支持「任意位置的 system 消息」**。
这个能力**不是 OpenAI 兼容接口暴露的字段**，vendor-local 也没有暴露 ⇒ **我们用不了**。

**所以附六的工程结论仍然成立，但理由要改**：
不是「DeepSeek 没有这个机制」，而是「**这个机制是模型级能力，vendor-local 网关没暴露给我们**」。

## 二、决定性实测：why 到底破不破缓存？

评审中 pi 提出一个尖锐质疑（它独立发现 vendor-local 的亲和键
`sha256(首条 user message)` 前缀，83/83 命中）：
**如果亲和键来自 user message，那把 why 放进 user message 会不会破坏亲和？**

我做了 5 组对照（`/tmp/why-ab2.cjs`，网关 `127.0.0.1:3425`，model=deepseek-flash，
system 前缀 6000+ token，全部带 `x-session-affinity` + `session_id`）：

| 组    | 变更点                    | in   | cacheRead        | 命中        | 结论                    |
| ----- | ------------------------- | ---- | ---------------- | ----------- | ----------------------- |
| **A** | 无（基线）                | 1057 | **896 恒定**     | 45.9%       | 基线                    |
| **B** | **user message 只改 why** | 1066 | **896 恒定**     | 45.7%       | ✅ **why 不破缓存**     |
| **C** | 先热身同前缀，再换 why    | 1066 | **896 恒定**     | 45.7%       | ✅ 确认                 |
| **D** | **system 尾部改 1 字符**  | 1058 | **0 / 896 交替** | 0%↔45.9%    | ❌ **改 system 破缓存** |
| **E** | **tools 描述改 1 词**     | 1058 | 896 / **768**    | 45.9%/42.1% | ⚠️ 只丢 tools 那一段    |

### 结论

1. **改造③ 的核心主张成立**：why 放 user message，**前缀缓存不受影响**（B/C 组 896 恒定）。
2. **改 system prompt 才破缓存**（D 组掉到 0）⇒ 恒定 system prompt 是硬要求。
3. **改 tools 不完全破缓存**：从 896 掉到 768（差 128 = 一个块），
   **说明缓存块顺序是 system → tools → user**，tools 在 system 之后、user 之前。
   ⇒ **tool-schema 变化只影响 tools 那一段之后的复用，不影响 system 那段。**

### 对 Q2（tool-schema changes）的修正答案

DeepSeek 官方说 tool-schema change 会破缓存；**但我们实测只是掉一个块（128 token），
不是全毁**。而且 DeepSeek 文档描述的是「重写 system 节点」场景下的连带影响。

⇒ **Q2 的实际影响远小于 omp 的推测。** strict 档和普通档的子代理，
system 前缀**仍可共享**，只是 tools 之后的段分叉。

## 三、亲和键的真实情况（pi 的发现 + 我的验证）

pi 独立算出：vendor-local 的三段式亲和键
`group|<fingerprint>|<instance>` 里，`<fingerprint>` = **`sha256(首条 user message)` 的前缀**，83/83 命中。

我扩展验证（400 条真实子代理日志）：

| 指标                                           | 数值                |
| ---------------------------------------------- | ------------------- |
| 与至少一个兄弟**首条 user message 逐字节相同** | **305/400 = 76.2%** |
| 内容唯一                                       | 95/400 = 23.8%      |
| 11 个兄弟组里 why 相同                         | **11 组**           |
| 11 个兄弟组里 why 不同                         | **0 组**            |

⇒ **兄弟子代理本来就要发一样的 user message**（同任务派发），
why 对**同一任务的所有兄弟是一样的** ⇒ why **不进入**亲和键的实际区分位。

**⇒ pi 的质疑在实测下不成立**：why 在 user message 里，但同一任务的兄弟 why 相同，
所以亲和键不变。（pi 独立算出了 83/83 的哈希前缀匹配，但没验证 why 是否在兄弟间相同。）

## 四、六个 harness 的结论汇总

| harness    | 状态              | 核心判断                                                                                                                                        |
| ---------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **omp**    | ✅ 完成（38KB）   | 改造③ 收益被高估；建议先做观测（cache-metrics.ts）；建议把 user message 顺序改成「隔离契约 → 任务 → why」；明确反对把隔离契约挪进 system prompt |
| **codex**  | 🔄 跑真实对照实验 | 做了 system/tools/user 三维交叉对照，挖出 vendor-local 的 affinity 记录格式                                                                     |
| **pi**     | 🔄 在跑           | 独立算出亲和键 = sha256(首条 user message) 前缀；统计了 why 的历史分布（11-24 只有 1 条带 why ⇒ 改造③ 刚落地，实测样本不足）                    |
| **claude** | 🔄 网络重试中     | **找到 DeepSeek 真机制文档**（in-history system prompt replacement）⇒ 推翻我附六的结论                                                          |
| **kimi**   | 🔄 在跑           | —                                                                                                                                               |
| **mcode**  | 🔄 在跑           | —                                                                                                                                               |

## 五、被这轮评审推翻的既有结论

1. **「DeepSeek 没有保留 KV Cache 更新 system prompt 的机制」** ⇒ **错**。
   有，叫 `in-history`，但需要模型级能力（`deepseek-flash` 声明），
   **vendor-local 没暴露** ⇒ 我们仍然用不了，但理由不同。
2. **「tool-schema change 会让 strict 档与普通档完全不能共享前缀」** ⇒ **夸大**。
   实测只掉一个块（128 token），system 段仍可共享。
3. **「把 why 放进 user message 可能破坏会话亲和」** ⇒ **不成立**（兄弟 why 天然相同）。

## 八、评审第二轮：工具集才是真正的分叉点（mcode 发现，我独立验证）

### mcode 的发现

mcode 读 `node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js` 发现：
**pi 把工具清单以「文字」形式焊进 system prompt 第 2 段**，不是只放在 API 的 `tools` 参数里。

实测 system prompt 的 sections 结构（400 条真实子代理）：

| 段                                      | 长度 | 跨所有派发是否恒定            |
| --------------------------------------- | ---- | ----------------------------- |
| `preamble`                              | 126  | ✅ **100% 恒定**（1 个取值）  |
| `tools`                                 | 274  | ❌ **4 个取值**               |
| `rules`                                 | 589  | ❌ **4 个取值**（随工具集变） |
| `docs`                                  | 1293 | ⚠️ 2 个取值                   |
| `addendum`（**我们的 CONTRACT_BLOCK**） | 1942 | ❌ **64 个取值**              |
| `project_context`                       | 3148 | ⚠️ 2 个取值（同仓恒定）       |
| `cwd`                                   | 48   | ❌ **362 个取值**             |

`tools` 段原文：

```
<tools>
- read: Read file contents
- bash: Execute bash commands (ls, grep, find, etc.)
- edit: Make precise file edits ...
- write: Create or overwrite files

Additional tools may be available.
</tools>
```

### 我用 400 条真实日志独立验证：跨家族 LCP = 191 字符 = 3.9%

4 个工具集家族：

| 工具集                          | 运行数 | 占比  |
| ------------------------------- | ------ | ----- |
| `bash,edit,read,write`          | 338    | 84.5% |
| `find,grep,ls,read`（strict）   | 29     | 7.2%  |
| `bash,codemode,edit,read,write` | 27     | 6.8%  |
| `codemode,find,grep,ls,read`    | 6      | 1.5%  |

两两家族的最长公共前缀：

| 家族对            | LCP          | 占较短者 | 分叉点                          |
| ----------------- | ------------ | -------- | ------------------------------- |
| 大家族 × strict   | **191 字符** | **3.9%** | `- bash: Execute bash commands` |
| 大家族 × codemode | 384 字符     | 7.5%     | tools 段内                      |
| strict × codemode | 191 字符     | 3.9%     | tools 段内                      |

**⇒ 4 个家族 = 4 个互不相通的前缀。每个家族只共享 preamble（126 字符 / 2.2%）。**
**rules / docs / 契约块 / AGENTS.md 合计 7020 字符（95%）全部重发。**

**同家族内部也不完全恒定**：大家族 338 条，最小 LCP **1206** / 基准 5814。

### 修正我附七 §二 的 E 组结论

我的 E 组只测了「改 `tools` 参数的 JSON 描述」（改 1 个词）→ cacheRead 896→768（掉一个块）。
**但「换整个工具集」会同时改文字清单 + rules 段 + JSON schema** ⇒ 分叉点前移到 191 字符。

⇒ **两个结论都成立，但适用不同场景**：

- 改 schema 描述（罕见）⇒ 只掉 tools 那一段
- **换工具集（常见：strict 档）⇒ 前面 96% 的前缀全部失效**

## 九、`addendum` 64 个取值 = 改造③ 之前的历史记录

`addendum`（我们的 CONTRACT_BLOCK）有 64 个不同取值，其中：

- 231 条 = len 1942（**含 `<pi-dispatch-why>`**）
- 86 条 = len 1041（不含 why）
- 其余零散

**按天分布**：

| 日期  | addendum 含 why | 不含 why |
| ----- | --------------- | -------- |
| 11-18 | 3               | 54       |
| 11-19 | 1               | 20       |
| 11-20 | 38              | 12       |
| 11-21 | **80**          | 0        |
| 11-22 | **109**         | 0        |
| 11-24 | **83**          | 0        |

**⇒ 改造③ 提交于 11-25 07:32（`a21a8c9`），而所有含 why 的记录都在 11-24 14:42 之前。
⇒ 现有 400 条生产记录全部早于改造③。改造③ 在生产侧仍是零证据。**

（当前代码是对的：`src/core/child.ts:215` 的 why 在 `buildUserMessage` 里，不在 `CONTRACT_BLOCK`。）

## 十、pi 的直接生产证据（改造③ 的效果）

pi 在真实日志里做了一组更锐利的对照：
**同 task + 同 cwd + 同工具档位**（即除了 why 以外全部相同）的兄弟子代理，比较首轮 cacheRead 占比：

| 组                                        | n   | 中位命中  | >0.5 的比例 |
| ----------------------------------------- | --- | --------- | ----------- |
| **带 why**（system prompt 因 why 而不同） | 6   | **0.927** | 67%         |
| **不带 why**（system prompt 逐字节相同）  | 9   | **1.000** | 100%        |

**⇒ why 留在 system prompt 里会轻微拖累命中；挪进 user message 后完全命中。**
样本小（n=6 / n=9），但方向明确，且与我的附七 §二 的 B/C 组实验一致。

## 十一、mcode 的另一条重要修正：亲和头对 90% 单轮场景价值为 0

mcode 指出：**每个子代理运行的 session id 都是新随机值**
（`pi -p --no-session` → `SessionManager.inMemory()` → `generateId()` = `randomUUID().slice(0,8)`，
见 `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:21-28`）。

⇒ **亲和头只在「同一个孩子自己的多轮之间」有用** ⇒ 对 1 轮孩子（90%）**价值为 0**。
⇒ 90% 的跨子代理复用实际来自：(a) 上游账号级磁盘缓存（DeepSeek 官方「硬盘缓存，默认开启」）

- (b) **vendor-local 的指纹路由**（同指纹不同 session id 落同一上游实例）。

**这条修正很重要**：如果不修正，后续优化会被推向「怎么让亲和头更稳」的错误方向。

## 十二、codex 的补充发现

codex 测了大 prompt 场景（125K token）：`cacheRead` 只有 186 ⇒ **prompt 太大超出缓存上限**。
⇒ **前缀不是越大越好**——超过缓存窗口就完全不命中。
这与「把前缀做大填满块」的建议直接冲突。

（同时 codex 确认了 vendor-local 的 affinity 记录格式：
`group/<fingerprint>|<instance-id>`，第三段是上游实例名如 `deepseek#8ac7dd506`。）

## 十三、场景表（claude 提出，我独立复现）

claude 直接从 400 份真实子代理日志算出「首轮复用率」的场景分布：

| 场景                                     | 首轮复用率 | n   |
| ---------------------------------------- | ---------- | --- |
| 同 cwd、同项目、同工具桶（有兄弟子代理） | **92.3%**  | 38  |
| 独苗 cwd（只能靠跨会话共享）             | **48.2%**  | 362 |
| **strict 桶**（同 cwd 同项目也不行）     | **5.1%**   | 19  |

我用自己的脚本重算（按「是否有同 cwd 兄弟」×「工具桶」交叉分组）：

| 组                        | n   | 中位      | 均值  | >0.5   |
| ------------------------- | --- | --------- | ----- | ------ |
| normal 桶 + 有同 cwd 兄弟 | 55  | **0.893** | 0.643 | 53%    |
| normal 桶 + 独苗          | 283 | **0.495** | 0.452 | 31%    |
| **strict 桶（全部）**     | 35  | **0.064** | 0.249 | 17%    |
| **codemode 桶**           | 27  | **0.305** | 0.252 | **0%** |

**⇒ 复现成功。strict 桶 0.064 vs normal 0.496 = 差 7.8 倍。**
**⇒ 这坐实了「工具集是真正的分叉点」**：不同工具桶 = 不同前缀家族，
前 191 字符（3.9%）之后就全废了。

## 十四、pi 的位置探针：改哪个段，损失多少

pi 用真实子代理的 system prompt 做「只改一处」的探针，量 cacheRead 占比：

| 差异位置                          | cached%   |
| --------------------------------- | --------- |
| **（完全不变）**                  | **100%**  |
| 差异在 `project_context`          | 43.1%     |
| 差异在 `addendum`（我们的契约块） | **12.9%** |
| 差异在 `cwd`                      | 6.5%      |
| 差异在（user message）            | **6.4%**  |

**这张表是本轮最有操作价值的产出**：

- 改 `addendum` ⇒ 掉到 12.9%（**契约块必须恒定，实测确认**）
- 改 `cwd` ⇒ 6.5%（但 cwd 只在末尾 48 字符，**说明 cwd 段之后没有东西可共享**）
- 改 user message ⇒ 6.4%（user message 在最末尾，**改它等于没改前面的**）

⇒ **段序决定一切**：越靠前的段，改它损失越大。
我们的 `CONTRACT_BLOCK` 在第 5 位（addendum），前面有 preamble/tools/rules/docs 共 2282 字符——
**这 2282 字符是「在任何 addendum 变化时都能共享」的部分**。

## 十五、codex 的另一个选项：绕开路由组

codex 实测：

| 路由                               | 稳定度                     |
| ---------------------------------- | -------------------------- |
| **直连 `deepseek/deepseek-flash`** | **98.9% 稳定**             |
| `regex:group/main`（当前）         | 路由会漂移，稳定性明显更低 |

**⇒ 又一个「静默失效」源**：vendor-local 的路由组会把同一指纹的请求分散到不同上游实例，
而 KV cache 是**实例本地**的 ⇒ 路由漂移 = 缓存不命中。

⇒ **「最值得做的一件事」多了一个候选**：把上游路由钉住（直连模型 vs 走路由组）。

## 十六、Q4 的前提被推翻（claude 发现，我复现）

任务书说的「90% 子代理只有 1 轮」**是错的**：

| 口径                                              | 单轮占比                                          |
| ------------------------------------------------- | ------------------------------------------------- |
| `affinity.json` 全表（4096 行）                   | 91.7%                                             |
| **但其中只有 83 行（2%）是 pi-dispatch 的子代理** | —                                                 |
| **直接量真实子代理（400 个）**                    | **单轮 119 = 29.8%，多轮 281 = 70.2%，中位 2 轮** |

**⇒ 真实分布是 70% 多轮。** 轮数分布：`1:119, 2:124, 3:109, 4:31, 5:9, 6:5, 7:3`。

⇒ `affinity.json` 的 turn 字段对子代理不可靠（多半只在首请求时落一行）。
⇒ **「单轮子代理不需要前缀稳定化」这个推论不成立**——70% 的子代理是多轮的。

---

# 附十八：勘误 —— 「整块命中」这个说法是错的

> 六 harness 评审（kimi 提出质疑，我用 E 组数据判定）**推翻了本文 §一 的核心表述**。
> 历史记录保留不改，用本勘误覆盖它。

## 一、错的说法（§一 及引用它的多处）

> 「命中时是**整块命中**（92~99%），不命中时**只命中零头**（8~19%），中间没有连续过渡。」
> 「**没有连续中间值。**」

## 二、判定：错。缓存是**部分前缀 + 块对齐**命中

**决定性证据 = 我自己的 E 组实验**（附七 §二）：

只改 `tools` 参数的 JSON 描述**一个词**：

| 假设                      | 预测                                      | 实测            |
| ------------------------- | ----------------------------------------- | --------------- |
| 「整块或全无」            | 改一个词 ⇒ 整个前缀失效 ⇒ `cacheRead = 0` | ❌ 实测 **768** |
| **「部分前缀 + 块对齐」** | 只丢 tools 那段之后的 ⇒ **768**           | ✅ **实测 768** |

**⇒ 改一个词，命中量从 896 掉到 768（掉 128 = 一个块），前缀其余部分完好。**
**⇒ 这直接排除了「整块或全无」。**

## 三、正确的机制表述

```
命中量 = min(本次前缀长度, 历史上已缓存的最长匹配前缀) 向下取整到块边界
已缓存前缀 = 历史上某个「恰好在此处分叉」的请求
```

**⇒「没有连续中间值」的真实原因不是「整块」，而是
「能命中的长度只取历史上出现过的分叉点」**（128 / 186 / 4992 都是这类分叉点）。

**⇒ 0% / 19% / 77% 的双峰多峰，主因是【路由落点不同】（不同上游实例），
不是字节不同。** 换了实例，连 186 token 的常量块都保不住 ⇒ 归零。

## 四、连带修正

| 位置     | 原文                                                | 修正                                                      |
| -------- | --------------------------------------------------- | --------------------------------------------------------- |
| §一 标题 | 「命中是『整块』不是『连续前缀』」                  | 「命中是**部分前缀 + 块对齐**；可命中长度只取历史分叉点」 |
| §一      | 「19% 是常态，77% 是偶尔整块命中」                  | 19%/77% 的差别主要是**路由落点**，不是块大小              |
| §三      | 「vendor-local 行为与它们一致：**整块命中**」       | vendor-local 是**部分前缀命中**（E 组：768/896）          |
| §四      | 「『整块命中 + 偶尔跳到 92%』可能是网关自己的实现」 | 不是整块；是「部分前缀 + 路由粘性」                       |

## 五、这条修正为什么重要

**它把 Q2 的重心从「字节一致性」移向「路由粘性 + 前缀组数」**——
而 codex 实测**路由翻转（4 天 12 次）= $0.039 = 29.1% 的孩子花销**，
比 strict 桶分叉（$0.00038）高**两个数量级**。

⇒ 之前围绕「工具桶分叉」的讨论，量级上根本不是主战场。

## 六、修正后的完整因果链

```
前缀字节不同 ──► 分叉点提前 ──► 命中量变短（局部损失）
路由落点不同 ──► 缓存整个不在 ──► 命中量归零（全局损失）  ← 真正的大头
```

⇒ **保证字节恒定（改造③）只解决了前者。**
⇒ **要解决后者需要让同一形状的请求落到同一个上游实例**（钉住路由）。
