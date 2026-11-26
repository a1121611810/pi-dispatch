// CLI 层：退出码是给 CI 用的契约，必须稳定。
// 只测三条：可信退 0、对不上退 1、解析不了退 2。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

function run(args: string[]): { status: number | null; stdout: string } {
  const child = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "src/bin/session-audit.ts", ...args],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  return { status: child.status, stdout: child.stdout };
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

test("CLI：`--format` 不认识 ⇒ 退出 2（含 pi，v1 不做）", () => {
  withFixture(["{}"], (path) => {
    assert.equal(run([path, "--format", "pi"]).status, 2);
  });
});

test("CLI：`--strict` 把 unclaimed 也当对不上", () => {
  const lines = [claude("assistant", [{ type: "text", text: "看完了，没有改动。" }])];
  withFixture(lines, (path) => {
    assert.equal(run([path, "--format", "claude"]).status, 0, "默认不罚只读分析");
    assert.equal(run([path, "--format", "claude", "--strict"]).status, 1, "--strict 下算不可信");
  });
});
