// worktree 隔离：建 / 观测 / 清扫。
// 关键：真 git 仓（`git init` 出来的），不是 mkdir .git 的假仓——worktree 只有真仓才有。
//
// 变异：core.worktree 命名空间零幸存（.metrics/mutate/core.worktree.edn）——本片新代码
// 没有杀不掉的等价变异。（`messageOf` 的 `error instanceof Error ? error.message : String(error)`
// 在本仓只有「抛 Error」这一条可达路径 ⇒ 两支等价；变异器不改写三元分支，本来也不产变异点。）
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  branchNameFor,
  countDirtyLines,
  createWorktree,
  execFileGit,
  GIT_TIMEOUT_MS,
  managedBranch,
  OBSERVE_TIMEOUT_MS,
  observeWorktree,
  parseWorktreeList,
  removeWorktree,
  resolveHead,
  sweepWorktrees,
  type GitRunner,
} from "../src/core/worktree.ts";

/**
 * 真 git 仓夹具：init + 本地 user + 基线提交。
 * 系统级 git 配置一律不看（GIT_CONFIG_NOSYSTEM=1），免得被机器上的怪配置带偏。
 */
function withGitProject<T>(fn: (dir: string, base: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-git-"));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd: dir, env, encoding: "utf8" });
  try {
    git(["init", "-b", "main"]);
  } catch {
    git(["init"]);
    git(["checkout", "-b", "main"]);
  }
  git(["config", "user.email", "verify@example.invalid"]);
  git(["config", "user.name", "verify"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["config", "core.hooksPath", join(dir, ".no-hooks")]);
  writeFileSync(join(dir, "README.md"), "base\n");
  git(["add", "-A"]);
  git(["commit", "-m", "base"]);
  const base = git(["rev-parse", "HEAD"]).trim();
  return fn(dir, base);
}

/** 在夹具仓里跑一条 git。 */
function gitIn(dir: string, args: string[]): string {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  return execFileSync("git", args, { cwd: dir, env, encoding: "utf8" });
}

/** 假 git runner：按「子命令 + 参数」喂结果，顺便记调用。 */
function fakeGit(handlers: { [key: string]: { code: number; stdout?: string; stderr?: string } }): {
  runner: GitRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner: GitRunner = async (args) => {
    calls.push(args);
    for (const [key, result] of Object.entries(handlers)) {
      const [cmd, sub] = key.split(" ");
      if (args[0] === cmd && args[1] === sub) {
        return {
          code: result.code,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
        };
      }
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

// ── 分支名 ────────────────────────────────────────────────────────────────

test("分支名：受管分支是 pi-dispatch/<任务编号>", () => {
  assert.equal(branchNameFor("abc-123"), "pi-dispatch/abc-123");
});

// ── 建 ────────────────────────────────────────────────────────────────────

test("建：worktree 建在钉死的 base 上，分支是 pi-dispatch/<编号>", async () => {
  await withGitProject(async (dir, base) => {
    const path = join(dir, "wt", "task-1");
    const created = await createWorktree(execFileGit, {
      repoRoot: dir,
      path,
      branch: branchNameFor("task-1"),
      baseCommit: base,
    });
    assert.equal(created.ok, true, created.error ?? "");
    assert.ok(existsSync(join(path, ".git")), "worktree 里有个 .git 文件");
    assert.equal(gitIn(path, ["rev-parse", "HEAD"]).trim(), base, "HEAD 就是钉死的 base");
    assert.equal(
      gitIn(path, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
      branchNameFor("task-1"),
      "在受管分支上",
    );
  });
});

test("worktree：分支建在受理时钉死的 baseCommit 上", async () => {
  await withGitProject(async (dir, base) => {
    // 父仓往前走一笔
    writeFileSync(join(dir, "README.md"), "moved\n");
    gitIn(dir, ["add", "-A"]);
    gitIn(dir, ["commit", "-m", "parent moved"]);
    const moved = gitIn(dir, ["rev-parse", "HEAD"]).trim();
    assert.notEqual(moved, base, "父仓 HEAD 确实前进了");
    // 但 worktree 还是建在受理时钉死的 base 上
    const path = join(dir, "wt", "task-1");
    const created = await createWorktree(execFileGit, {
      repoRoot: dir,
      path,
      branch: branchNameFor("task-1"),
      baseCommit: base,
    });
    assert.equal(created.ok, true, created.error ?? "");
    assert.equal(gitIn(path, ["rev-parse", "HEAD"]).trim(), base, "还是那个 base");
  });
});

test("建：base 不存在 ⇒ 建不出来，带理由", async () => {
  await withGitProject(async (dir) => {
    const created = await createWorktree(execFileGit, {
      repoRoot: dir,
      path: join(dir, "wt", "task-1"),
      branch: branchNameFor("task-1"),
      baseCommit: "0000000000000000000000000000000000000000",
    });
    assert.equal(created.ok, false);
    assert.ok((created.error ?? "").length > 0, "要说明为什么");
  });
});

// ── 观测 ──────────────────────────────────────────────────────────────────

test("观测：干净的工作区 ⇒ dirty 0、还在受管分支上、没领先", async () => {
  await withGitProject(async (dir, base) => {
    const path = join(dir, "wt", "task-1");
    await createWorktree(execFileGit, {
      repoRoot: dir,
      path,
      branch: branchNameFor("task-1"),
      baseCommit: base,
    });
    const info = await observeWorktree(execFileGit, {
      path,
      branch: branchNameFor("task-1"),
      baseCommit: base,
    });
    assert.equal(info.dirty, 0);
    assert.equal(info.onExpectedBranch, true);
    assert.equal(info.commitsAhead, 0);
    assert.equal(info.headCommit, base);
    assert.equal(info.missing, undefined);
    assert.equal(info.captureError, undefined);
  });
});

test("观测：有未提交改动 ⇒ dirty 1", async () => {
  await withGitProject(async (dir, base) => {
    const path = join(dir, "wt", "task-1");
    await createWorktree(execFileGit, {
      repoRoot: dir,
      path,
      branch: branchNameFor("task-1"),
      baseCommit: base,
    });
    writeFileSync(join(path, "canary.txt"), "x\n");
    const info = await observeWorktree(execFileGit, {
      path,
      branch: branchNameFor("task-1"),
      baseCommit: base,
    });
    assert.equal(info.dirty, 1);
  });
});

test("观测：未跟踪目录里的 3 个文件 ⇒ dirty 3（不折叠成目录一行）", async () => {
  await withGitProject(async (dir, base) => {
    const path = join(dir, "wt", "task-1");
    await createWorktree(execFileGit, {
      repoRoot: dir,
      path,
      branch: branchNameFor("task-1"),
      baseCommit: base,
    });
    mkdirSync(join(path, "newdir"));
    for (const name of ["a", "b", "c"]) writeFileSync(join(path, "newdir", `${name}.txt`), "x\n");
    const info = await observeWorktree(execFileGit, {
      path,
      branch: branchNameFor("task-1"),
      baseCommit: base,
    });
    assert.equal(info.dirty, 3, "数文件不数目录：3 个未跟踪文件就是 3");
  });
});

test("观测：孩子自己提交了 ⇒ commitsAhead 1、dirty 0", async () => {
  await withGitProject(async (dir, base) => {
    const path = join(dir, "wt", "task-1");
    await createWorktree(execFileGit, {
      repoRoot: dir,
      path,
      branch: branchNameFor("task-1"),
      baseCommit: base,
    });
    writeFileSync(join(path, "canary.txt"), "x\n");
    gitIn(path, ["add", "-A"]);
    gitIn(path, ["commit", "-m", "child"]);
    const info = await observeWorktree(execFileGit, {
      path,
      branch: branchNameFor("task-1"),
      baseCommit: base,
    });
    assert.equal(info.commitsAhead, 1);
    assert.equal(info.dirty, 0);
  });
});

test("观测：目录被手工删了 ⇒ missing，不抛", async () => {
  await withGitProject(async (dir, base) => {
    const path = join(dir, "wt", "task-1");
    await createWorktree(execFileGit, {
      repoRoot: dir,
      path,
      branch: branchNameFor("task-1"),
      baseCommit: base,
    });
    rmSync(path, { recursive: true, force: true });
    const info = await observeWorktree(execFileGit, {
      path,
      branch: branchNameFor("task-1"),
      baseCommit: base,
    });
    assert.equal(info.missing, true);
    assert.equal(info.dirty, undefined, "观测不到 ≠ 干净");
    assert.equal(info.captureError, undefined, "目录不在不是观测失败");
  });
});

test("观测：孩子换了分支 ⇒ onExpectedBranch false", async () => {
  await withGitProject(async (dir, base) => {
    const path = join(dir, "wt", "task-1");
    await createWorktree(execFileGit, {
      repoRoot: dir,
      path,
      branch: branchNameFor("task-1"),
      baseCommit: base,
    });
    gitIn(path, ["checkout", "-b", "other"]);
    const info = await observeWorktree(execFileGit, {
      path,
      branch: branchNameFor("task-1"),
      baseCommit: base,
    });
    assert.equal(info.onExpectedBranch, false);
  });
});

test("worktree：观测失败只记 captureError，不回改终态", async () => {
  const boom: GitRunner = async () => {
    throw new Error("git 炸了");
  };
  const info = await observeWorktree(boom, {
    path: tmpdir(),
    branch: branchNameFor("t"),
    baseCommit: "abc",
  });
  assert.equal(info.captureError, "git 炸了");
  assert.equal(info.dirty, undefined, "观测不到 ≠ 干净");
  assert.equal(info.path, tmpdir());
});

test("观测：四连 git 各自 5s 超时、建盘仍 30s（不拖住座位归还）", async () => {
  const timeouts: Array<number | undefined> = [];
  const runner: GitRunner = async (_args, _cwd, timeoutMs) => {
    timeouts.push(timeoutMs);
    return { code: 0, stdout: "", stderr: "" };
  };
  await observeWorktree(runner, { path: tmpdir(), branch: branchNameFor("t"), baseCommit: "abc" });
  assert.deepEqual(
    timeouts,
    [OBSERVE_TIMEOUT_MS, OBSERVE_TIMEOUT_MS, OBSERVE_TIMEOUT_MS, OBSERVE_TIMEOUT_MS],
    "观测四次都用独立的 5s 上限",
  );
  assert.equal(OBSERVE_TIMEOUT_MS, 5_000);
  assert.equal(GIT_TIMEOUT_MS, 30_000, "建盘仍用 30s");
});

test("观测：命令失败但目录在 ⇒ 那个字段留空（dirty 不填 0）", async () => {
  await withGitProject(async (dir, base) => {
    const path = join(dir, "wt", "task-1");
    await createWorktree(execFileGit, {
      repoRoot: dir,
      path,
      branch: branchNameFor("task-1"),
      baseCommit: base,
    });
    const { runner } = fakeGit({
      "status --porcelain": { code: 1, stderr: "boom" },
    });
    const info = await observeWorktree(runner, {
      path,
      branch: branchNameFor("t"),
      baseCommit: base,
    });
    assert.equal(info.dirty, undefined, "观测不到 ≠ 干净：不能填 0");
    assert.equal(info.captureError, undefined, "命令失败不是抛异常");
  });
});

test("观测：rev-list 给出小数或负数 ⇒ commitsAhead 留空，不谎报", async () => {
  for (const stdout of ["1.5", "-1"]) {
    const { runner } = fakeGit({ "rev-list --count": { code: 0, stdout } });
    const info = await observeWorktree(runner, {
      path: tmpdir(),
      branch: branchNameFor("t"),
      baseCommit: "abc",
    });
    assert.equal(info.commitsAhead, undefined, `${JSON.stringify(stdout)} 不是合法计数`);
  }
});

// ── 观测的解析器 ──────────────────────────────────────────────────────────

test("解析：porcelain 的干扰行不是一条工作区", () => {
  const porcelain = [
    "worktree /repo/main",
    "HEAD abc",
    "branch refs/heads/main",
    "",
    "worktreesomething",
    "worktree /repo/wt",
    "HEAD def",
    "branch refs/heads/pi-dispatch/t1",
    "prunable gitdir file points to non-existent location",
  ].join("\n");
  const entries = parseWorktreeList(porcelain);
  assert.equal(entries.length, 2, "干扰行不算一条工作区");
  assert.equal(entries[0]!.path, "/repo/main");
  assert.equal(entries[0]!.branch, "refs/heads/main");
  assert.equal(entries[1]!.path, "/repo/wt");
  assert.equal(entries[1]!.branch, "refs/heads/pi-dispatch/t1");
});

test("解析：受管分支才认，用户自己的分支不认", () => {
  assert.equal(managedBranch("refs/heads/pi-dispatch/t1"), "pi-dispatch/t1");
  assert.equal(managedBranch("refs/heads/main"), undefined);
  assert.equal(managedBranch("refs/heads/pi-dispatch/"), undefined);
  assert.equal(managedBranch("refs/heads/pi-dispatch-other/t1"), undefined);
  assert.equal(managedBranch(undefined), undefined);
});

test("解析：porcelain 的脏行数就是脏文件数", () => {
  assert.equal(countDirtyLines(""), 0);
  assert.equal(countDirtyLines(" M src/a.ts\n"), 1);
  assert.equal(countDirtyLines(" M src/a.ts\n?? src/b.ts\n"), 2);
  assert.equal(countDirtyLines(" M src/a.ts\n\n"), 1, "空行不算");
});

// ── 清扫 ──────────────────────────────────────────────────────────────────

test("回收：目录本就不在 ⇒ removed 0（没删的不能算成删了）", async () => {
  const parent = mkdtempSync(join(tmpdir(), "dispatch-gone-"));
  const missing = join(parent, "never-created");
  const { runner } = fakeGit({}); // worktree remove 退出 0，但目录从来不在
  const result = await removeWorktree(runner, parent, missing);
  assert.deepEqual(result, { removed: 0, pruned: 0 });
  assert.equal(existsSync(missing), false);
});

test("清扫：无账本且过期 ⇒ 非强制地清掉目录与分支", async () => {
  await withGitProject(async (dir, base) => {
    const worktreesDir = join(dir, "bucket", "worktrees");
    const path = join(worktreesDir, "task-1");
    await createWorktree(execFileGit, {
      repoRoot: dir,
      path,
      branch: branchNameFor("task-1"),
      baseCommit: base,
    });
    const past = new Date(Date.now() - 31 * 86_400_000);
    utimesSync(path, past, past);
    const result = await sweepWorktrees({
      git: execFileGit,
      repoRoot: dir,
      worktreesDir,
      ttlMs: 30 * 86_400_000,
      hasLedger: () => false,
    });
    assert.equal(result.removed, 1, "目录清掉了");
    assert.equal(existsSync(path), false);
    assert.equal(
      gitIn(dir, ["branch", "--list", branchNameFor("task-1")]).trim(),
      "",
      "分支也清掉了（已合并 ⇒ -d 成功）",
    );
  });
});

test("清扫：有账本的 worktree 不删", async () => {
  await withGitProject(async (dir, base) => {
    const worktreesDir = join(dir, "bucket", "worktrees");
    const path = join(worktreesDir, "task-1");
    await createWorktree(execFileGit, {
      repoRoot: dir,
      path,
      branch: branchNameFor("task-1"),
      baseCommit: base,
    });
    const past = new Date(Date.now() - 31 * 86_400_000);
    utimesSync(path, past, past);
    const result = await sweepWorktrees({
      git: execFileGit,
      repoRoot: dir,
      worktreesDir,
      ttlMs: 30 * 86_400_000,
      hasLedger: (id) => id === "task-1",
    });
    assert.equal(result.removed, 0);
    assert.ok(existsSync(path), "有账本 ⇒ 不删");
  });
});

test("清扫：没到期 ⇒ 不删", async () => {
  await withGitProject(async (dir, base) => {
    const worktreesDir = join(dir, "bucket", "worktrees");
    const path = join(worktreesDir, "task-1");
    await createWorktree(execFileGit, {
      repoRoot: dir,
      path,
      branch: branchNameFor("task-1"),
      baseCommit: base,
    });
    const result = await sweepWorktrees({
      git: execFileGit,
      repoRoot: dir,
      worktreesDir,
      ttlMs: 30 * 86_400_000,
      hasLedger: () => false,
    });
    assert.equal(result.removed, 0);
    assert.ok(existsSync(path), "没到期 ⇒ 不删");
  });
});

test("清扫：脏 worktree 不强删（git 拒绝就留）", async () => {
  await withGitProject(async (dir, base) => {
    const worktreesDir = join(dir, "bucket", "worktrees");
    const path = join(worktreesDir, "task-1");
    await createWorktree(execFileGit, {
      repoRoot: dir,
      path,
      branch: branchNameFor("task-1"),
      baseCommit: base,
    });
    writeFileSync(join(path, "dirty.txt"), "x\n");
    const past = new Date(Date.now() - 31 * 86_400_000);
    utimesSync(path, past, past);
    const result = await sweepWorktrees({
      git: execFileGit,
      repoRoot: dir,
      worktreesDir,
      ttlMs: 30 * 86_400_000,
      hasLedger: () => false,
    });
    assert.equal(result.removed, 0, "git 拒了 ⇒ 留下");
    assert.ok(existsSync(path), "脏的目录留着（证据不丢）");
  });
});

test("清扫：未合并分支不强删", async () => {
  await withGitProject(async (dir, base) => {
    const worktreesDir = join(dir, "bucket", "worktrees");
    const path = join(worktreesDir, "task-1");
    await createWorktree(execFileGit, {
      repoRoot: dir,
      path,
      branch: branchNameFor("task-1"),
      baseCommit: base,
    });
    // 孩子提交了一笔父仓没有的提交 ⇒ 分支未合并
    writeFileSync(join(path, "canary.txt"), "x\n");
    gitIn(path, ["add", "-A"]);
    gitIn(path, ["commit", "-m", "child"]);
    const past = new Date(Date.now() - 31 * 86_400_000);
    utimesSync(path, past, past);
    const result = await sweepWorktrees({
      git: execFileGit,
      repoRoot: dir,
      worktreesDir,
      ttlMs: 30 * 86_400_000,
      hasLedger: () => false,
    });
    assert.equal(result.removed, 1, "干净的工作区删得掉");
    assert.equal(result.pruned, 0, "未合并的分支删不掉");
    assert.ok(
      gitIn(dir, ["branch", "--list", branchNameFor("task-1")]).includes("pi-dispatch/task-1"),
      "分支留着（证据不丢）",
    );
  });
});

test("清扫：孩子换过分支的受管目录照收（目录删、分支保留）", async () => {
  await withGitProject(async (dir, base) => {
    const worktreesDir = join(dir, "bucket", "worktrees");
    const path = join(worktreesDir, "task-1");
    await createWorktree(execFileGit, {
      repoRoot: dir,
      path,
      branch: branchNameFor("task-1"),
      baseCommit: base,
    });
    // 孩子自己换了分支：worktree list 里那条的 branch 不再是 pi-dispatch/* ⇒ 分支认不出
    gitIn(path, ["checkout", "-b", "wip"]);
    const past = new Date(Date.now() - 31 * 86_400_000);
    utimesSync(path, past, past);
    const result = await sweepWorktrees({
      git: execFileGit,
      repoRoot: dir,
      worktreesDir,
      ttlMs: 30 * 86_400_000,
      hasLedger: () => false,
    });
    assert.equal(result.removed, 1, "分支认不出也回收目录（不然永远留成孤儿）");
    assert.equal(existsSync(path), false);
    assert.equal(result.pruned, 0, "分支未知 ⇒ 不碰分支");
    assert.ok(
      gitIn(dir, ["branch", "--list", branchNameFor("task-1")]).includes("pi-dispatch/task-1"),
      "受管分支保留（证据不丢）",
    );
    assert.ok(gitIn(dir, ["branch", "--list", "wip"]).includes("wip"), "孩子换到的分支也保留");
  });
});

test("清扫：detached 的受管目录照收（目录删、无分支可删）", async () => {
  await withGitProject(async (dir, base) => {
    const worktreesDir = join(dir, "bucket", "worktrees");
    const path = join(worktreesDir, "task-1");
    await createWorktree(execFileGit, {
      repoRoot: dir,
      path,
      branch: branchNameFor("task-1"),
      baseCommit: base,
    });
    gitIn(path, ["checkout", "--detach"]);
    const past = new Date(Date.now() - 31 * 86_400_000);
    utimesSync(path, past, past);
    const result = await sweepWorktrees({
      git: execFileGit,
      repoRoot: dir,
      worktreesDir,
      ttlMs: 30 * 86_400_000,
      hasLedger: () => false,
    });
    assert.equal(result.removed, 1);
    assert.equal(result.pruned, 0);
    assert.equal(existsSync(path), false);
    assert.ok(
      gitIn(dir, ["branch", "--list", branchNameFor("task-1")]).includes("pi-dispatch/task-1"),
      "受管分支保留",
    );
  });
});

test("清扫：用户自己的 worktree 不被误清", async () => {
  await withGitProject(async (dir, base) => {
    const worktreesDir = join(dir, "bucket", "worktrees");
    mkdirSync(worktreesDir, { recursive: true });
    // 用户自己在受管根旁边建的（路径前缀相同但不是子目录）
    const sibling = join(dir, "bucket", "worktreesomething");
    await createWorktree(execFileGit, {
      repoRoot: dir,
      path: sibling,
      branch: "pi-dispatch/user-owned",
      baseCommit: base,
    });
    // 用户自己在别处建的
    const elsewhere = join(dir, "user-wt");
    await createWorktree(execFileGit, {
      repoRoot: dir,
      path: elsewhere,
      branch: "pi-dispatch/user-owned-2",
      baseCommit: base,
    });
    const past = new Date(Date.now() - 31 * 86_400_000);
    utimesSync(sibling, past, past);
    utimesSync(elsewhere, past, past);
    const result = await sweepWorktrees({
      git: execFileGit,
      repoRoot: dir,
      worktreesDir,
      ttlMs: 30 * 86_400_000,
      hasLedger: () => false,
    });
    assert.equal(result.removed, 0, "一个都不该动");
    assert.ok(existsSync(sibling), "worktreesomething 不是受管根下的目录");
    assert.ok(existsSync(elsewhere), "用户自己的 worktree 不动");
  });
});

test("清扫：手工删掉的目录不重建，只清元数据", async () => {
  await withGitProject(async (dir, base) => {
    const worktreesDir = join(dir, "bucket", "worktrees");
    const path = join(worktreesDir, "task-1");
    await createWorktree(execFileGit, {
      repoRoot: dir,
      path,
      branch: branchNameFor("task-1"),
      baseCommit: base,
    });
    rmSync(path, { recursive: true, force: true });
    const result = await sweepWorktrees({
      git: execFileGit,
      repoRoot: dir,
      worktreesDir,
      ttlMs: 30 * 86_400_000,
      hasLedger: () => false,
    });
    assert.equal(result.removed, 0, "目录本来就不在 ⇒ 我们没删过目录");
    assert.equal(existsSync(path), false, "不重建");
    assert.ok(!gitIn(dir, ["worktree", "list", "--porcelain"]).includes(path), "git 元数据清掉了");
  });
});

test("清扫：单批上限生效（maxPerBatch）", async () => {
  const worktreesDir = mkdtempSync(join(tmpdir(), "dispatch-batch-"));
  const porcelain = ["task-1", "task-2", "task-3"]
    .map((id) => `worktree ${join(worktreesDir, id)}\nbranch refs/heads/pi-dispatch/${id}\n`)
    .join("\n");
  const { runner, calls } = fakeGit({ "worktree list": { code: 0, stdout: porcelain } });
  const result = await sweepWorktrees({
    git: runner,
    repoRoot: "/nope",
    worktreesDir,
    ttlMs: 0,
    hasLedger: () => false,
    maxPerBatch: 1,
  });
  const removes = calls.filter((c) => c[0] === "worktree" && c[1] === "remove");
  assert.equal(removes.length, 1, "一批最多清 maxPerBatch 个");
  assert.equal(result.pruned, 1, "只清了一个分支");
});

test("清扫：maxPerBatch 显式给 0 ⇒ 这一批一个都不清（0 不是缺省）", async () => {
  const worktreesDir = mkdtempSync(join(tmpdir(), "dispatch-batch-zero-"));
  const porcelain = `worktree ${join(worktreesDir, "task-1")}\nbranch refs/heads/pi-dispatch/task-1\n`;
  const { runner, calls } = fakeGit({ "worktree list": { code: 0, stdout: porcelain } });
  const result = await sweepWorktrees({
    git: runner,
    repoRoot: "/nope",
    worktreesDir,
    ttlMs: 0,
    hasLedger: () => false,
    maxPerBatch: 0,
  });
  const removes = calls.filter((c) => c[0] === "worktree" && c[1] === "remove");
  assert.equal(removes.length, 0, "显式的 0 就是一批都不做，不落回缺省 500");
  assert.equal(result.removed, 0);
  assert.equal(result.pruned, 0);
});

test("清扫：没有受管根目录 ⇒ 一个 git 都不调", async () => {
  const { runner, calls } = fakeGit({});
  const result = await sweepWorktrees({
    git: runner,
    repoRoot: "/nope",
    worktreesDir: join(tmpdir(), "dispatch-git-never-created"),
    ttlMs: 0,
    hasLedger: () => false,
  });
  assert.equal(result.removed, 0);
  assert.equal(result.pruned, 0);
  assert.equal(calls.length, 0, "默认关时零 git 调用");
});

test("清扫：git 报错 ⇒ 什么都不清", async () => {
  const { runner } = fakeGit({ "worktree list": { code: 128, stderr: "not a git repository" } });
  const result = await sweepWorktrees({
    git: runner,
    repoRoot: "/nope",
    worktreesDir: tmpdir(),
    ttlMs: 0,
    hasLedger: () => false,
  });
  assert.equal(result.removed, 0);
  assert.equal(result.pruned, 0);
});

test("清扫：绝不用全局 prune（只逐条 remove）", async () => {
  const { runner, calls } = fakeGit({
    "worktree list": { code: 0, stdout: "" },
  });
  await sweepWorktrees({
    git: runner,
    repoRoot: "/nope",
    worktreesDir: tmpdir(),
    ttlMs: 0,
    hasLedger: () => false,
  });
  for (const call of calls) {
    assert.ok(!(call[0] === "worktree" && call[1] === "prune"), "不许全局 prune");
  }
});

// ── 真跑 git ──────────────────────────────────────────────────────────────

test("真跑 git：读得到 HEAD，读不到就报失败", async () => {
  await withGitProject(async (dir, base) => {
    const head = await resolveHead(execFileGit, dir);
    assert.equal(head, base);
    // 非 git 目录 ⇒ 抛（引擎据此退回，不留痕）
    await assert.rejects(
      () => resolveHead(execFileGit, join(tmpdir(), "dispatch-not-a-repo-" + Date.now())),
      /HEAD/,
    );
  });
});

test("真跑 git：失败也给结果（不抛），code 非 0", async () => {
  const result = await execFileGit(["rev-parse", "--verify", "HEAD"], tmpdir());
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.length > 0 || result.stdout.length > 0);
});

test("真跑 git：起不来（cwd 不存在）⇒ code 1，不是 0", async () => {
  const result = await execFileGit(
    ["rev-parse", "--verify", "HEAD"],
    join(tmpdir(), "dispatch-no-such-dir-" + Date.now()),
  );
  assert.equal(result.code, 1, "起不来 ⇒ 非 0（0 会被当成成功）");
});

test("真跑 git：stdout 拿得到", async () => {
  await withGitProject(async (dir, base) => {
    const result = await execFileGit(["rev-parse", "HEAD"], dir);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), base);
  });
});

// ── 假 runner 的解析器边界 ────────────────────────────────────────────────

test("假 runner：命令失败 ⇒ 该字段留空，不是 0", async () => {
  const { runner } = fakeGit({
    "rev-parse --verify": { code: 128, stderr: "bad" },
    "status --porcelain": { code: 0, stdout: " M a\n" },
  });
  const info = await observeWorktree(runner, {
    path: tmpdir(),
    branch: "pi-dispatch/t",
    baseCommit: "abc",
  });
  assert.equal(info.headCommit, undefined, "读不到 HEAD ⇒ 留空，不填 0");
  assert.equal(info.dirty, 1, "别的字段照常");
});

test("假 runner：commitsAhead 不是非负整数 ⇒ undefined（不落 null）", async () => {
  const { runner } = fakeGit({
    "rev-list --count": { code: 0, stdout: "not-a-number\n" },
  });
  const info = await observeWorktree(runner, {
    path: tmpdir(),
    branch: "pi-dispatch/t",
    baseCommit: "abc",
  });
  assert.equal(info.commitsAhead, undefined, "非法输出给 undefined，不给 NaN");
  assert.equal(
    JSON.stringify(info).includes('"commitsAhead":null'),
    false,
    "序列化后没有 null——「没观测到」不许变成「0 个提交」的谎报",
  );
});
