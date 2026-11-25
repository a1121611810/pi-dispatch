// 思考档位校验：按 pi 的 getSupportedThinkingLevels 口径，只降不升、降级目标是 low、
// 只发 supported 里的档位（这样 pi 的 clamp 不再插手）。
// 纯函数层：不 import pi 运行时。模型目录是适配层摊平的纯数据。
//
// 等价变异（mutator 杀不掉，也不该杀）：
//   resolveThinkingLevel 里 `args.requested?.trim() || undefined` → `?? undefined`：
//   trim() 对非空串返回非空串 ⇒ 只有空白串时两者都 undefined；`?.` 已先挡掉 undefined ⇒ 等价。
//   supportedThinkingLevels 里 `mapped === null` → `mapped == null`：thinkingLevelMap 的值类型是
//   string | null（undefined 只在缺键时出现，缺键走另一条分支）⇒ 可达输入上等价。
//   findThinkingModel 里 `hits.length > 1` → `>= 1`：两分支都返回 undefined（唯一命中在上一行已返回）
//   ⇒ 等价。
//   COST_ORDER.indexOf(level as never) 的比较方向 `>=` / `<=`：**不是**等价变异——
//   由「降级只往下不往上」杀掉，不要写进等价段。
//   costIndex 的 `index < 0` → `index < 1`：**不是**等价变异——它把 off（下标 0）也当
//   未知档（最贵），请求 low 且只有 off/minimal 可用时会从 off 升到 minimal。
//   由「思考档位：只支持 off/minimal 时请求 low ⇒ 落到 off」杀掉。
//   costIndex 未知档的 `length - 1` → `length` / `length - 0` / `length + 1`：都大于所有已知档
//   下标；未知档只走 downgradeTarget，过滤阈值饱和 ⇒ 同向 ⇒ 可达输入上等价。
//   downgradeTarget 里 `costIndex(level) <= requestedIndex` → `<`：能走到降级就说明请求档不在
//   supported 里，只有「未知档与最贵档共用下标」那一种输入能差一格，而该分支最终从
//   low / off / cheaper[0] 里挑，差的那一格不是它们 ⇒ 可达输入上等价。
//   nearestLevel 末尾 `supported[0]` → `supported[1]`：兜底只在 supported 为空时走到（非空时
//   两轮循环必先命中某一档），此时两者都 undefined ⇒ 等价。
//   nearestLevel 的 `< length` → `<=`、`i >= 0` → `> 0` / `>= 1`、`requestedIndex - 1` → `+ 1` /
//   `- 0`：多比一个越界候选（includes(undefined) 恒 false）或跳过 off；请求档本身在降级分支
//   已确定不支持，第二轮从它自己 / 更高一位起仍先向下扫到同一档；off 若唯一可用，末尾
//   `supported[0] ?? "off"` 兜底同值 ⇒ 等价。
//   `supported[0] ?? "off"` → `||`：supported 元素是档位字符串（非空）；undefined 两向都给
//   "off" ⇒ 等价。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COST_ORDER,
  findThinkingModel,
  resolveThinkingLevel,
  supportedThinkingLevels,
  type ThinkingModelInfo,
} from "../src/core/thinking.ts";
import { effectiveModel } from "../src/core/child.ts";

/** 本机 vendor-local 的真实档位图：medium / minimal / xhigh 是显式 null（不支持）。 */
const MAGPIE: ThinkingModelInfo = {
  provider: "test-vendor",
  id: "group/main",
  reasoning: true,
  thinkingLevelMap: {
    high: "high",
    low: "low",
    max: "max",
    medium: null,
    minimal: null,
    off: "none",
    xhigh: null,
  },
};

/** 一个「没提 xhigh / max」的模型（缺键 ⇒ 按 pi 口径这两档不支持）。 */
const NO_EXTENDED: ThinkingModelInfo = {
  provider: "acme",
  id: "m1",
  reasoning: true,
  thinkingLevelMap: { off: "none", low: "low", medium: "medium", high: "high" },
};

/** 非思考模型。 */
const NO_REASONING: ThinkingModelInfo = {
  provider: "acme",
  id: "plain",
  reasoning: false,
};

test("思考档位：模型支持该档 ⇒ 原样发（不降级）", () => {
  const result = resolveThinkingLevel({ requested: "high", model: MAGPIE });
  assert.equal(result.effective, "high");
  assert.equal(result.adjusted, false);
  assert.equal(result.modelKnown, true);
});

test("思考档位：thinkingLevelMap 显式 null ⇒ 降到 low（vendor-local 的 medium）", () => {
  const result = resolveThinkingLevel({ requested: "medium", model: MAGPIE });
  assert.equal(result.effective, "low", "显式 null 的档位降级目标是 low");
  assert.equal(result.adjusted, true);
  assert.equal(result.modelKnown, true, "模型在目录里 ⇒ 回执不许自称未校验");
  // 同一个模型上 xhigh 也是 null ⇒ 同样降到 low（省钱 8 倍）
  assert.equal(resolveThinkingLevel({ requested: "xhigh", model: MAGPIE }).effective, "low");
  // minimal 比 low 还便宜 ⇒ 不能「降级」成更贵的 low（只降不升）
  assert.equal(resolveThinkingLevel({ requested: "minimal", model: MAGPIE }).effective, "off");
});

test("思考档位：只支持 off/minimal 时请求 low ⇒ 落到 off（costIndex 的 off 不是最贵）", () => {
  const onlyOffMinimal: ThinkingModelInfo = {
    provider: "acme",
    id: "off-minimal",
    reasoning: true,
    thinkingLevelMap: {
      off: "none",
      minimal: "minimal",
      low: null,
      medium: null,
      high: null,
      xhigh: null,
      max: null,
    },
  };
  const result = resolveThinkingLevel({ requested: "low", model: onlyOffMinimal });
  assert.equal(result.effective, "off", "off 是比 low 便宜的档，不能被当成最贵");
  assert.equal(result.adjusted, true);
  assert.equal(result.modelKnown, true);
});

test("思考档位：降级只往下不往上（生效档位的成本序不得高于请求档位）", () => {
  // 目录只有 off / low 两档，请求 minimal（比 low 便宜）⇒ 不能「降级」成 low
  const onlyOffLow: ThinkingModelInfo = {
    provider: "acme",
    id: "m2",
    reasoning: true,
    thinkingLevelMap: { off: "none", low: "low", minimal: null },
  };
  const result = resolveThinkingLevel({ requested: "minimal", model: onlyOffLow });
  assert.equal(result.effective, "off", "比 low 便宜的请求只能落到更便宜的档");
  assert.ok(
    COST_ORDER.indexOf(result.effective as never) <= COST_ORDER.indexOf("minimal"),
    "生效档位的成本序不得高于请求档位",
  );
  // low / off 都不可用 ⇒ 取目录里最便宜的一档（medium），不是更贵的 high
  const noLow: ThinkingModelInfo = {
    provider: "acme",
    id: "m3",
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: null,
      medium: "medium",
      high: "high",
      xhigh: null,
    },
  };
  assert.equal(
    resolveThinkingLevel({ requested: "xhigh", model: noLow }).effective,
    "medium",
    "没有更便宜的可用档 ⇒ 取最便宜的一档",
  );
  // 目录里一档都不支持（全 null）⇒ 退 off，不能返回 undefined
  const empty: ThinkingModelInfo = {
    provider: "acme",
    id: "m4",
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: null,
      max: null,
    },
  };
  assert.equal(
    resolveThinkingLevel({ requested: "medium", model: empty }).effective,
    "off",
    "没有可用档 ⇒ off",
  );
});

test("思考档位：请求 off 但目录没有 off ⇒ 兜底到最便宜的一档", () => {
  // off 显式 null（这个 provider 没有关档）；minimal / medium 缺键按 pi 口径算**支持**
  // （只有 xhigh / max 缺键才算不支持）⇒ supported = [minimal, low, medium, high]。
  // 注意：请求 off 而 off 不可用时，兜底必然比 off 贵——这是「off 已是最便宜档」的
  // 必然结果，不是降级逻辑的 bug。这条只守「兜底取最便宜，不是随便挑一档」。
  const noOff: ThinkingModelInfo = {
    provider: "acme",
    id: "no-off",
    reasoning: true,
    thinkingLevelMap: { off: null, low: "low", high: "high" },
  };
  const supported = supportedThinkingLevels(noOff);
  assert.deepEqual(
    supported,
    ["minimal", "low", "medium", "high"],
    "缺键档算支持（pi 口径：只有 xhigh / max 缺键才算不支持）",
  );
  const result = resolveThinkingLevel({ requested: "off", model: noOff });
  assert.equal(result.effective, supported[0], "兜底取最便宜的一档，不是库里的第二档");
  assert.equal(result.effective, "minimal", "最便宜的一档是 minimal，不是 low");
  assert.equal(result.adjusted, true);
  assert.ok(
    COST_ORDER.indexOf(result.effective as never) <= COST_ORDER.indexOf("minimal"),
    "兜底档不许比 supported[0] 更贵",
  );
});

test("思考档位：模型不在目录里 ⇒ 原样透传并说明未校验", () => {
  const result = resolveThinkingLevel({ requested: "medium", model: undefined });
  assert.equal(result.effective, "medium", "查不到就不猜，原样发");
  assert.equal(result.modelKnown, false);
  assert.equal(result.adjusted, false, "未校验不等于被调整");
  assert.match(result.reason ?? "", /未校验|不在目录/);
});

test("思考档位：非思考模型 ⇒ 不发后缀（= off）", () => {
  const result = resolveThinkingLevel({ requested: "high", model: NO_REASONING });
  assert.equal(result.effective, "off", "非思考模型：实际生效档位是 off");
  assert.equal(result.adjusted, true);
  assert.equal(result.modelKnown, true);
  assert.match(result.reason ?? "", /off/);
  // 传进来的 off 本身不算「被调整」
  assert.equal(resolveThinkingLevel({ requested: "off", model: NO_REASONING }).adjusted, false);
});

test("思考档位：xhigh/max 缺键 ⇒ 按 pi 口径落到最接近的一档（不静默降成 low）", () => {
  const xhigh = resolveThinkingLevel({ requested: "xhigh", model: NO_EXTENDED });
  assert.equal(xhigh.effective, "high", "缺键不是显式 null：落到最接近的一档，不是 low");
  const max = resolveThinkingLevel({ requested: "max", model: NO_EXTENDED });
  assert.equal(max.effective, "high");
  assert.match(xhigh.reason ?? "", /high/);
  assert.equal(xhigh.modelKnown, true, "模型在目录里 ⇒ 回执不许自称未校验");
  assert.equal(max.modelKnown, true);
});

test("思考档位：reasoning=true 但没有 thinkingLevelMap ⇒ xhigh 落到 high（不炸）", () => {
  const noMap: ThinkingModelInfo = { provider: "acme", id: "no-map", reasoning: true };
  const result = resolveThinkingLevel({ requested: "xhigh", model: noMap });
  assert.equal(result.effective, "high");
  assert.equal(result.modelKnown, true);
});

test("思考档位：裸 id 唯一命中也能找到模型", () => {
  const catalog = [MAGPIE, NO_EXTENDED];
  assert.equal(findThinkingModel(catalog, "group/main"), MAGPIE, "裸 id 唯一命中");
  assert.equal(
    findThinkingModel(catalog, "test-vendor/group/main"),
    MAGPIE,
    "provider/id 精确命中",
  );
  assert.equal(findThinkingModel(catalog, "nope"), undefined);
});

test("思考档位：裸 id 撞多个 ⇒ 不校验（原样透传）", () => {
  const a: ThinkingModelInfo = { provider: "p1", id: "same", reasoning: true };
  const b: ThinkingModelInfo = { provider: "p2", id: "same", reasoning: true };
  const catalog = [a, b];
  assert.equal(findThinkingModel(catalog, "same"), undefined, "撞多个 ⇒ 不猜");
  assert.equal(findThinkingModel(catalog, "p2/same"), b, "精确命中仍然能用");
});

test("思考档位：回执说明实际生效档位与降级原因", () => {
  const result = resolveThinkingLevel({ requested: "medium", model: MAGPIE });
  assert.equal(result.requested, "medium");
  assert.equal(result.effective, "low");
  assert.equal(result.adjusted, true);
  assert.equal(result.modelKnown, true);
  assert.match(result.reason ?? "", /medium/);
  assert.match(result.reason ?? "", /low/);
});

test("思考档位：只发 supported 里的档位 ⇒ pi 的 clamp 不会再改它（档位必在支持集里）", () => {
  for (const model of [MAGPIE, NO_EXTENDED]) {
    for (const requested of COST_ORDER) {
      const result = resolveThinkingLevel({ requested, model });
      const supported = supportedThinkingLevels(model);
      assert.ok(
        result.effective !== undefined && supported.includes(result.effective),
        `${model.provider}/${model.id} 请求 ${requested} ⇒ 生效 ${result.effective} 必须在支持集 [${supported}] 里`,
      );
    }
  }
});

test("思考档位：没给档位 ⇒ 沿用会话默认（不擅自替父方降档）", () => {
  const result = resolveThinkingLevel({ model: MAGPIE });
  assert.equal(result.effective, undefined);
  assert.equal(result.adjusted, false);
  assert.equal(result.requested, undefined);
  assert.equal(result.modelKnown, true, "给了模型（已命中目录）⇒ 回执要说已认出来");
  assert.equal(resolveThinkingLevel({}).modelKnown, false, "连模型都没给 ⇒ 不许自称已认出来");
});

test("思考档位：没给 model 时用会话模型查目录", () => {
  const catalog = [MAGPIE];
  const model = effectiveModel({ model: undefined, sessionModel: "test-vendor/group/main" });
  const found = findThinkingModel(catalog, model);
  const result = resolveThinkingLevel({ requested: "medium", model: found });
  assert.equal(result.modelKnown, true, "会话模型要真的拿去查目录");
  assert.equal(result.effective, "low", "查到了才能校验出 medium 不支持");
});

test("思考档位：空串当没给（不拼后缀）", () => {
  const result = resolveThinkingLevel({ requested: "  ", model: MAGPIE });
  assert.equal(result.effective, undefined);
  assert.equal(result.requested, undefined);
});

test("思考档位：supportedThinkingLevels 与 pi 口径一致（reasoning 假 ⇒ 只有 off）", () => {
  assert.deepEqual(supportedThinkingLevels(NO_REASONING), ["off"]);
  assert.deepEqual(supportedThinkingLevels(MAGPIE), ["off", "low", "high", "max"]);
  assert.deepEqual(supportedThinkingLevels(NO_EXTENDED), [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
  ]);
});

test("思考档位：认不出的档位不升到最贵（降级方向安全）", () => {
  const result = resolveThinkingLevel({ requested: "turbo", model: MAGPIE });
  assert.equal(result.effective, "low", "认不出的档位按最贵处理 ⇒ 降级目标是 low");
  assert.equal(result.adjusted, true, "认不出的档位被改了就必须标 adjusted");
  assert.equal(result.modelKnown, true, "模型在目录里 ⇒ 回执不许自称未校验");
});

test("思考档位：模型已命中目录的五个分支，回执都必须说「已认出来」", () => {
  // modelKnown: true 在 resolveThinkingLevel 里有五处（不支持思考 / 支持该档 /
  // 认不出的档位 / 显式 null / 缺键兜底）。漏掉任何一处，父方都会把
  // 「校验过了」误读成「没校验」——所以五个分支各钉一次，一次遍历覆盖五个位点。
  const plain: ThinkingModelInfo = { provider: "acme", id: "plain", reasoning: false };
  const cases = [
    { name: "不支持思考", model: plain, requested: "high" },
    { name: "支持该档", model: MAGPIE, requested: "low" },
    { name: "认不出的档位", model: MAGPIE, requested: "turbo" },
    { name: "显式 null", model: MAGPIE, requested: "medium" },
    { name: "缺键兜底", model: NO_EXTENDED, requested: "xhigh" },
  ] as const;
  for (const c of cases) {
    const r = resolveThinkingLevel({ requested: c.requested, model: c.model });
    assert.equal(r.modelKnown, true, `${c.name}：模型已命中目录，modelKnown 必须是 true`);
  }
});
