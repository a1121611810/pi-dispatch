// CLI 层：退出码是给 CI 用的契约，必须稳定。
// 只测三条：可信退 0、对不上退 1、解析不了退 2。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const child = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "src/bin/session-audit.ts", ...args],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

function withFixture(lines: string[], fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "session-audit-cli-"));
  const path = join(dir, "s.jsonl");
  writeFileSync(path, lines.join("\n"), "utf8");
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const claude = (type: string, blocks: unknown[]): string =>
  JSON.stringify({ type, message: { content: blocks } });

test("CLI：verified ⇒ 退出 0", () => {
  const lines = [
    claude("assistant", [
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/repo/src/a.ts" } },
    ]),
    claude("user", [{ type: "tool_result", tool_use_id: "t1", content: "ok" }]),
    claude("assistant", [{ type: "text", text: "改了 `src/a.ts`。" }]),
  ];
  withFixture(lines, (path) => {
    const result = run([path, "--format", "claude", "--json"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /"deliverable": "verified"/);
  });
});

test("CLI：unverified ⇒ 退出 1", () => {
  const lines = [claude("assistant", [{ type: "text", text: "改了 `src/b.ts`。" }])];
  withFixture(lines, (path) => {
    assert.equal(run([path, "--format", "claude"]).status, 1);
  });
});

test("CLI：解析不了 ⇒ 退出 2（一条事件都没认出来）", () => {
  withFixture(["not json", "still not json"], (path) => {
    assert.equal(run([path, "--format", "claude"]).status, 2);
  });
});

test("CLI：`--format` 不认识 ⇒ 退出 2", () => {
  withFixture(["{}"], (path) => {
    assert.equal(run([path, "--format", "nope"]).status, 2);
  });
});

test("CLI：`--format pi` 能读 pi 的事件流", () => {
  const lines = [
    JSON.stringify({
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "2",
      args: { command: "pnpm test" },
    }),
    JSON.stringify({ type: "tool_execution_end", toolCallId: "2", isError: false }),
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "`pnpm test` 跑通了。" }] },
    }),
  ];
  withFixture(lines, (path) => {
    const result = run([path, "--format", "pi", "--json"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /"deliverable": "verified"/);
  });
});

test("CLI：`--strict` 把 unclaimed 也当对不上", () => {
  const lines = [claude("assistant", [{ type: "text", text: "看完了，没有改动。" }])];
  withFixture(lines, (path) => {
    assert.equal(run([path, "--format", "claude"]).status, 0, "默认不罚只读分析");
    assert.equal(run([path, "--format", "claude", "--strict"]).status, 1, "--strict 下算不可信");
  });
});

test("CLI：`--max` 能放宽收据上限（长会话默认只留 20 条）", () => {
  const J = JSON.stringify;
  const lines = [
    J({
      type: "item.completed",
      item: { type: "command_execution", command: "pnpm test", exit_code: 0 },
    }),
    J({
      type: "item.completed",
      item: { type: "command_execution", command: "pnpm lint", exit_code: 0 },
    }),
  ];
  withFixture(lines, (path) => {
    const tight = run([path, "--format", "codex", "--max", "1", "--json"]);
    assert.match(tight.stdout, /"truncated": true/);
    const loose = run([path, "--format", "codex", "--max", "50", "--json"]);
    assert.match(loose.stdout, /"truncated": false/);
  });
});

test("CLI：`--max` 非正整数 ⇒ 退出 2", () => {
  withFixture(["{}"], (path) => {
    assert.equal(run([path, "--format", "codex", "--max", "0"]).status, 2);
  });
});

test("CLI：零自述 + 路径收据 ⇒ 退 1（默认就红，不靠 --strict）", () => {
  const J = JSON.stringify;
  const lines = [
    J({
      type: "item.completed",
      item: { type: "file_change", changes: { "/repo/a.ts": { type: "add" } } },
    }),
    J({ type: "item.completed", item: { type: "agent_message", text: "先看日志，再改代码。" } }),
  ];
  withFixture(lines, (path) => {
    const result = run([path, "--format", "codex"]);
    assert.equal(result.status, 1, "动过手却没给可核对自述");
    assert.match(result.stdout, /unclaimed/);
  });
});

test("CLI：零自述 + 没有收据 ⇒ 退 0", () => {
  const J = JSON.stringify;
  const lines = [
    J({ type: "item.completed", item: { type: "agent_message", text: "先看日志，再改代码。" } }),
  ];
  withFixture(lines, (path) => {
    assert.equal(run([path, "--format", "codex"]).status, 0);
  });
});

test("CLI：--help 的退出码说明与实现一致", () => {
  const help = run(["--help"]);
  assert.match(help.stdout, /unclaimed 但动过手/);
  assert.doesNotMatch(help.stdout, /--strict 时 unclaimed 算 1/);
});

// kimi：入参可以是 wire.jsonl，也可以是会话目录四层下面的那一条。
const kimiLines = (): string[] => [
  JSON.stringify({
    type: "context.append_loop_event",
    event: { type: "tool.call", toolCallId: "t1", name: "Write", args: { path: "src/a.ts" } },
  }),
  JSON.stringify({
    type: "context.append_loop_event",
    event: { type: "tool.result", toolCallId: "t1", result: { output: "ok" } },
  }),
  JSON.stringify({
    type: "context.append_loop_event",
    event: {
      type: "content.part",
      turnId: 0,
      step: 1,
      part: { type: "text", text: "改了 `src/a.ts`。" },
    },
  }),
];

function withKimiDir(build: (dir: string) => void, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "session-audit-kimi-"));
  try {
    build(dir);
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("CLI：`--format kimi` 能读 wire.jsonl", () => {
  withFixture(kimiLines(), (path) => {
    const result = run([path, "--format", "kimi", "--json"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /"deliverable": "verified"/);
  });
});

test("CLI：`--format kimi` 收会话目录，解析 agents/main/wire.jsonl", () => {
  withKimiDir(
    (dir) => {
      mkdirSync(join(dir, "agents", "main"), { recursive: true });
      writeFileSync(join(dir, "agents", "main", "wire.jsonl"), kimiLines().join("\n"), "utf8");
      // 子代理的 wire 不许被并进来
      mkdirSync(join(dir, "agents", "agent-0"), { recursive: true });
      writeFileSync(join(dir, "agents", "agent-0", "wire.jsonl"), "not json", "utf8");
    },
    (dir) => {
      const result = run([dir, "--format", "kimi", "--json"]);
      assert.equal(result.status, 0, "目录形式要能解析主代理那一条");
      assert.match(result.stdout, /"deliverable": "verified"/);
    },
  );
});

test("CLI：kimi 目录里没有 agents/main/wire.jsonl ⇒ 2", () => {
  withKimiDir(
    () => {},
    (dir) => {
      assert.equal(run([dir, "--format", "kimi"]).status, 2);
    },
  );
});

test("CLI：kimi 只有 append_message ⇒ 2 且点名原因", () => {
  const lines = [
    JSON.stringify({
      type: "context.append_message",
      message: { role: "assistant", content: [{ type: "text", text: "改了 `src/a.ts`。" }] },
    }),
  ];
  withFixture(lines, (path) => {
    const result = run([path, "--format", "kimi"]);
    assert.equal(result.status, 2, "认不出事件不能装作判过");
    assert.match(result.stdout + result.stderr, /append_message/, "文案要说清为什么不支持");
  });
});

test("CLI：--json 走管道不被截断（128 KiB 之后还在）", () => {
  const lines: string[] = [];
  const tail = "x".repeat(200);
  for (let i = 0; i < 800; i++) {
    lines.push(
      JSON.stringify({
        type: "context.append_loop_event",
        event: {
          type: "tool.call",
          toolCallId: `t${i}`,
          name: "Bash",
          args: { command: `pnpm run task-${i}-${tail}` },
        },
      }),
    );
    lines.push(
      JSON.stringify({
        type: "context.append_loop_event",
        event: { type: "tool.result", toolCallId: `t${i}`, result: { output: "ok" } },
      }),
    );
  }
  // 给一句没人任何自述的正文：不然判词是 absent（退 1），测不到截断
  lines.push(
    JSON.stringify({
      type: "context.append_loop_event",
      event: {
        type: "content.part",
        turnId: 0,
        step: 1,
        part: { type: "text", text: "先看日志，再改代码。" },
      },
    }),
  );
  withFixture(lines, (path) => {
    const result = run([path, "--format", "kimi", "--json"]);
    assert.equal(result.status, 0);
    assert.ok(result.stdout.length > 140_000, `管道里只有 ${result.stdout.length} 字节`);
    const parsed = JSON.parse(result.stdout) as { receipts: { commands: unknown[] } };
    assert.equal(parsed.receipts.commands.length, 800, "一条都不能丢");
  });
});
