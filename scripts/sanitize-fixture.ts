// 把真机样本脱敏：路径、模型路由名、会话 id、绝对时间戳全换成占位符。
//
// 为什么要有这个脚本：脱敏得可复现、可复查。手改 158KB 的 JSONL 没人能审；
// 这个脚本是「规则清单」，改规则就跑一次，diff 一眼能看出改了哪儿。
//
// 用法：node scripts/sanitize-fixture.ts <in.jsonl> <out.jsonl>

import { readFileSync, writeFileSync } from "node:fs";

/** 替换规则：按顺序应用。 */
export const REPLACEMENTS: readonly { from: RegExp; to: string; why: string }[] = [
  {
    from: /\/Users\/real-user/g,
    to: "/home/dev",
    why: "家目录路径",
  },
  {
    // project_context 整块：作者的全局 agent 规则 + 仓库规则全文。真机上它就是这么大，
    // 但内容不该跟出去——留结构（两个 project_instructions + 收尾），不留内容。
    from: /<project_context>[\s\S]*?<\/project_context>/g,
    to: '<project_context>\\nProject-specific instructions and guidelines:\\n\\n<project_instructions path="/home/dev/.pi/agent/AGENTS.md">\\n# Global Agent Rules\\n\\n[REDACTED]\\n</project_instructions>\\n\\n<project_instructions path="/home/dev/develop/pi-dispatch/AGENTS.md">\\n# AGENTS.md — pi-dispatch\\n\\n[REDACTED]\\n</project_instructions>\\n\\n</project_context>',
    why: "全局/仓库 agent 配置全文",
  },
  {
    from: /"model":"group\/[a-z-]+"/g,
    to: '"model":"test/model"',
    why: "模型路由分组名",
  },
  {
    from: /"provider":"[a-z]+"/g,
    to: '"provider":"test/provider"',
    why: "供应商名",
  },
  {
    from: /"id":"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/g,
    to: '"id":"00000000-0000-4000-8000-000000000000"',
    why: "会话 uuid",
  },
  {
    from: /"call_[A-Za-z0-9]{16,}"/g,
    to: '"call_test000000000000"',
    why: "工具调用 id",
  },
  {
    from: /"timestamp":1[0-9]{12}/g,
    to: '"timestamp":1700000000000',
    why: "绝对时刻",
  },
  {
    from: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g,
    to: "2026-01-01T00:00:00.000Z",
    why: "绝对时刻",
  },
];

/** 对一段文本应用全部替换规则。 */
export function sanitize(text: string): string {
  let out = text;
  for (const { from, to } of REPLACEMENTS) out = out.replace(from, to);
  return out;
}

function main(): void {
  const [, , input, output] = process.argv;
  if (!input || !output) {
    console.error("用法：node scripts/sanitize-fixture.ts <in.jsonl> <out.jsonl>");
    process.exit(2);
  }
  const before = readFileSync(input, "utf8");
  const after = sanitize(before);
  writeFileSync(output, after, "utf8");
  const changed = before === after ? "无变化" : "已脱敏";
  console.log(`${input} → ${output}：${changed}（${before.length} → ${after.length} 字节）`);
}

if (process.argv[1]?.endsWith("sanitize-fixture.ts")) main();
