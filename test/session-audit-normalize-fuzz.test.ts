// 归一化层的行为指纹：确定性生成的日志，逐份比归一化结果。
// 补的是手写用例覆盖不到的字段组合（缺 id、两种信封、数组/对象 changes、
// 退出码错类型、后台与 hook 拦截、侧链）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeClaude, normalizeCodex } from "../src/audit/index.ts";

const ITEM_TYPES = [
  "CommandExecution",
  "command_execution",
  "FileChange",
  "file_change",
  "AgentMessage",
  "agent_message",
  "UserMessage",
];

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function hash(value: unknown): string {
  const json = JSON.stringify(value);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16);
}

function codexCorpus(): string[][] {
  const rnd = makeRng(7);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)]!;
  const out: string[][] = [];
  for (let i = 0; i < 24; i++) {
    const type = pick(ITEM_TYPES);
    const lower = type.toLowerCase();
    const item: Record<string, unknown> = { type };
    if (lower.includes("command")) {
      item.command = pick([["/bin/sh", "-c", `cmd${i}`], `/bin/zsh -lc "cmd${i}"`, `cmd${i}`]);
      item.exit_code = pick([0, 1, 2]);
      if (rnd() < 0.6) item.id = `call_${i}`;
      if (rnd() < 0.4) item.cwd = "file:///repo";
    } else if (lower.includes("file")) {
      item.changes = pick([{ [`/repo/f${i}.ts`]: { type: "add" } }, [{ path: `/repo/g${i}.ts` }]]);
    } else if (lower.includes("agent")) {
      item.text = `第 ${i} 段`;
      if (rnd() < 0.5) item.phase = "final_answer";
    } else {
      item.content = [{ type: "text", text: `用户 ${i}` }];
    }
    const envelope = pick(["top", "event"]);
    out.push([
      JSON.stringify(
        envelope === "top"
          ? { type: "item.completed", item }
          : { type: "event_msg", payload: { type: "item_completed", item } },
      ),
    ]);
  }
  return out;
}

function claudeCorpus(): string[][] {
  const rnd = makeRng(11);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)]!;
  const out: string[][] = [];
  for (let i = 0; i < 24; i++) {
    const name = pick(["Bash", "Write", "Edit", "NotebookEdit", "Read", "Grep"]);
    const input: Record<string, unknown> =
      name === "Bash"
        ? { command: `cmd${i}` }
        : name === "NotebookEdit"
          ? { notebook_path: `/n${i}.ipynb` }
          : { file_path: `/f${i}.ts` };
    if (rnd() < 0.2) input.run_in_background = true;
    const output = pick([
      `Exit code ${i % 3}\nok`,
      "普通输出",
      "Command running in background",
      "",
    ]);
    const isError = rnd() < 0.25;
    out.push([
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: `t${i}`, name, input }] },
      }),
      JSON.stringify({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: `t${i}`, content: output, is_error: isError },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: `第 ${i} 段` }] },
      }),
    ]);
  }
  return out;
}

const EXPECTED_CODEX: string[] = [
  "fd3acfde",
  "7fd0fd0a",
  "f10e4783",
  "ad84dd4",
  "19f03508",
  "60fd7fbe",
  "b87fa955",
  "37c9bc07",
  "f9cab3a",
  "5629c3f1",
  "cacc95b6",
  "741764b3",
  "766bfe8b",
  "bc668825",
  "4a942d0",
  "59869bcf",
  "a5e44c02",
  "51327f26",
  "c322042f",
  "3a7443cb",
  "9a9cef35",
  "95b1df04",
  "d732589b",
  "14ac5c43",
];
const EXPECTED_CLAUDE: string[] = [
  "f46ab47f",
  "48e9ae8d",
  "357b2a5d",
  "5ba65b59",
  "3fb4d57",
  "f50d20f1",
  "35e82dab",
  "62979fd1",
  "ca9b9d3c",
  "d74b1645",
  "7a0c21c3",
  "c91d296c",
  "7c38c8a0",
  "9ebcb88f",
  "6a59c30d",
  "e79c993",
  "a3fd018d",
  "51327f26",
  "8d11a5e3",
  "7d621214",
  "f997a19b",
  "c157fdbb",
  "3eed8bda",
  "e4c94421",
];

test("归一化指纹：codex 24 种形状不漂移", () => {
  const actual = codexCorpus().map((lines) => hash(normalizeCodex(lines).events));
  assert.deepEqual(actual, EXPECTED_CODEX);
});

test("归一化指纹：claude 24 种形状不漂移", () => {
  const actual = claudeCorpus().map((lines) => hash(normalizeClaude(lines).events));
  assert.deepEqual(actual, EXPECTED_CLAUDE);
});
