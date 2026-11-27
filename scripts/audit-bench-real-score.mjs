#!/usr/bin/env node
// 真实记录的对照算分：插件 vs 模型读日志（没有合成真值，所以先看一致率，
// 不一致的挑出来人工裁决）。
import { readFileSync } from "node:fs";

const rows = JSON.parse(readFileSync("/tmp/pd-audit-real/results.json", "utf8"));
const toArm = (v) =>
  v === "verified"
    ? "supported"
    : v === "unclaimed" || v === "partial"
      ? "no-signal"
      : "unsupported";

const scored = rows.map((r) => ({
  ...r,
  pluginArm: toArm(r.plugin),
  modelArm:
    r.model === "SUPPORTED"
      ? "supported"
      : r.model === "NOT_SUPPORTED"
        ? "unsupported"
        : "unparsed",
  claims: r.selfReport === "claims",
}));

const claimed = scored.filter((r) => r.claims);
const comparable = claimed.filter((r) => r.pluginArm !== "no-signal" && r.modelArm !== "unparsed");
const agree = comparable.filter((r) => r.pluginArm === r.modelArm);
const disagree = comparable.filter((r) => r.pluginArm !== r.modelArm);

console.log(`总轮数 ${scored.length}；有成功自述 ${claimed.length}；可比 ${comparable.length}`);
console.log(
  `一致 ${agree.length}/${comparable.length} = ${Math.round((agree.length / comparable.length) * 100)}%`,
);
console.log(
  `插件耗时均值 ${Math.round(scored.reduce((a, r) => a + r.pluginMs, 0) / scored.length)} ms、token 0`,
);
console.log(
  `模型耗时均值 ${Math.round(scored.reduce((a, r) => a + r.modelMs, 0) / scored.length)} ms、token 均值 ${Math.round(scored.reduce((a, r) => a + r.modelTokens, 0) / scored.length)}`,
);
console.log(
  `自述「声称完成」${claimed.length}/${scored.length}；其中模型判不成立 ${claimed.filter((r) => r.modelArm === "unsupported").length}`,
);
console.log("\n== 不一致 ==");
for (const r of disagree) {
  console.log(`#${r.i} 插件=${r.plugin} 模型=${r.model} ${r.file}`);
  console.log(`   报告: ${r.report.slice(0, 150)}`);
  console.log(
    `   自述 claims p=${r.claims?.paths?.length ?? "?"} c=${r.claims?.commands?.length ?? "?"} 收据 p=${r.receipts?.paths?.length ?? "?"} c=${r.receipts?.commands?.length ?? "?"}`,
  );
}
console.log("\n== 分布 ==");
const dist = {};
for (const r of scored) dist[r.plugin] = (dist[r.plugin] ?? 0) + 1;
console.log("插件判词:", JSON.stringify(dist));
const dist2 = {};
for (const r of scored) dist2[r.model] = (dist2[r.model] ?? 0) + 1;
console.log("模型判词:", JSON.stringify(dist2));
