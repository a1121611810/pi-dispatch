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
    // 家目录：把 /Users/<任何用户名> 换成 /home/dev（不写死某个用户名——规则本身不该带真名）
    from: /\/Users\/[A-Za-z0-9._-]+/g,
    to: "/home/dev",
    why: "家目录路径",
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
  {
    // claude 的会话链字段：sessionId / uuid / parentUuid，以及 codex 的 session_id / thread_id。
    // 只按 `"id"` 一条规则盖不住它们，而会话 id 本身也是家目录之外的第二条身份线索。
    from: /"(sessionId|uuid|parentUuid|session_id|thread_id)":\s*"[0-9a-fA-F-]{8,}"/g,
    to: '"$1":"00000000-0000-4000-8000-000000000000"',
    why: "会话 / 消息 / 工具 id",
  },
];

/**
 * project_context 整块：作者的全局 agent 规则 + 仓库规则全文。真机上它就是这么大，
 * 但内容不该跟出去——留结构（两个 project_instructions + 收尾），不留内容。
 *
 * 写法上有个坑踩过两次：这里的换行必须是 JSON 转义（两个字符 \n），写成真换行会把
 * 整行变成非法 JSON；而且它嵌在**双引号**的 TS 字符串里，oxfmt 可能把它改成单引号，
 * 里面的 \" 就不再是转义、JSON 直接坏掉。解析器把坏行当 malformed 跳过，所以
 * 「转向」那条用例照样绿——脱敏脚本自己造了假绿。
 *
 * 所以这里用 String.raw + 反引号模板：内容里的 \n 原样交给 JSON.stringify 处理，
 * 格式化器碰不到它。
 */
export const PROJECT_CONTEXT_REPLACEMENT = String.raw`<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path=\"/home/dev/.pi/agent/AGENTS.md\">\n# Global Agent Rules\n\n[REDACTED]\n</project_instructions>\n\n<project_instructions path=\"/home/dev/develop/pi-dispatch/AGENTS.md\">\n# AGENTS.md — pi-dispatch\n\n[REDACTED]\n</project_instructions>\n\n</project_context>`;

/** 对一段文本应用全部替换规则。 */
export function sanitize(text: string): string {
  let out = text;
  for (const { from, to } of REPLACEMENTS) out = out.replace(from, to);
  out = out.replace(/<project_context>[\s\S]*?<\/project_context>/g, PROJECT_CONTEXT_REPLACEMENT);
  return out;
}

/**
 * 逐行脱敏，并把每行重新 JSON.stringify 一遍。
 *
 * 为什么不直接用 sanitize() 的文本输出：文本替换可能产出非法 JSON（见上），而解析器
 * 会静默跳过坏行 ⇒ 假绿。这里改成「解析 → 改字段 → 序列化」，输出必然合法。
 * 解析不了的行原样保留（它本来就是坏的，脱敏不该改变它的性质）。
 */
export function sanitizeJsonl(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (!line.trim()) return line;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return line;
      }
      return JSON.stringify(scrub(parsed));
    })
    .join("\n");
}

/** 递归改字段：路径、模型名、供应商名、uuid、时刻。 */
/** 同一个原值 → 同一个占位值。脱敏不能打断配对（tool_use.id ↔ tool_use_id）。 */
const uuidMap = new Map<string, string>();
let uuidSeq = 0;
function scrubUuid(value: string): string {
  const hit = uuidMap.get(value);
  if (hit !== undefined) return hit;
  uuidSeq += 1;
  const next = `00000000-0000-4000-8000-${String(uuidSeq).padStart(12, "0")}`;
  uuidMap.set(value, next);
  return next;
}

const callMap = new Map<string, string>();
let callSeq = 0;
function scrubCall(value: string): string {
  const hit = callMap.get(value);
  if (hit !== undefined) return hit;
  callSeq += 1;
  const next = `call_test${String(callSeq).padStart(12, "0")}`;
  callMap.set(value, next);
  return next;
}

const ID_KEYS = new Set([
  "id",
  "call_id",
  "tool_use_id",
  "sessionId",
  "uuid",
  "parentUuid",
  "session_id",
  "thread_id",
]);

function scrub(value: unknown): unknown {
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "project_context") {
        out[key] = PROJECT_CONTEXT_REPLACEMENT;
        continue;
      }
      // 这些键的值是标识符（模型路由名 / 供应商 / uuid / 工具调用 id / 绝对时刻），
      // 规则里的正则带引号匹配的是 `"key":"value"` 整体——但值在这里是独立的字符串，
      // 不带引号，所以按键名改，别指望那条正则。
      if (key === "model") {
        out[key] = typeof item === "string" ? item.replace(/^group\/[a-z-]+$/, "test/model") : item;
        continue;
      }
      if (key === "provider") {
        out[key] = typeof item === "string" ? item.replace(/^[a-z]+$/, "test/provider") : item;
        continue;
      }
      // 一切「标识符」字段都走**同一张映射表**：同一个原值永远换成同一个占位值。
      // 否则会打断配对（tool_use.id ↔ tool_result.tool_use_id、codex id ↔ call_id），
      // 收据凭空消失——那是脱敏脚本自己造的假绿。
      if (typeof item === "string" && ID_KEYS.has(key)) {
        if (item.startsWith("call_")) {
          out[key] = scrubCall(item);
          continue;
        }
        if (/^[0-9a-f-]{8,}$/i.test(item)) {
          out[key] = scrubUuid(item);
          continue;
        }
      }
      // 正文同理：样本只用来验「抽不抽得出自述」，不需要几百 KB 的散文。
      if ((key === "text" || key === "content") && typeof item === "string" && item.length > 2000) {
        out[key] = `${item.slice(0, 2000)}…`;
        continue;
      }
      // 工具输出是样本里最大的一块，而审计只数「有没有这条命令 / 退出码是多少」，
      // 不看正文。截断它能把样本从几百 KB 压到几十 KB，不影响任何一条断言。
      if (
        (key === "aggregated_output" || key === "output") &&
        typeof item === "string" &&
        item.length > 120
      ) {
        out[key] = `${item.slice(0, 120)}…`;
        continue;
      }
      if (key === "timestamp" && typeof item === "number" && item > 1_000_000_000_000) {
        out[key] = 1_700_000_000_000;
        continue;
      }
      out[key] = scrub(item);
    }
    return out;
  }
  return value;
}

function scrubString(text: string): string {
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
  const after = sanitizeJsonl(before);
  // 自检：产物必须每行都是合法 JSON——不然解析器会静默跳过，测试照样绿
  let bad = 0;
  for (const [index, line] of after.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      JSON.parse(line);
    } catch {
      bad += 1;
      console.error(`第 ${index + 1} 行不是合法 JSON`);
    }
  }
  if (bad > 0) {
    console.error(`脱敏产物有 ${bad} 行非法 JSON，不许提交`);
    process.exit(1);
  }
  writeFileSync(output, after, "utf8");
  console.log(
    `${input} → ${output}：已脱敏（${before.length} → ${after.length} 字节，每行 JSON 合法）`,
  );
}

if (process.argv[1]?.endsWith("sanitize-fixture.ts")) main();
