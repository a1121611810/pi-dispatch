import { execFile } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import type { WorktreeInfo } from "./types.ts";

// worktree 隔离：把子代理放进独立的 git 工作区。
//   建：git worktree add -b <branch> <path> <baseCommit>（base 在受理时钉死，排队期间不漂移）
//   观：孩子跑完后看它留下了什么（脏不脏、提交了几个、还在不在那个分支上）
//   扫：没有账本（没人认领）且过了 TTL ⇒ 非强制地清掉
//
// 三条硬规矩：
//   ① 观测永不抛——观测失败只记 captureError，不回改终态（孩子已经跑完，终态是既成事实）。
//   ② 清扫只用非强制（worktree remove / branch -d）——脏的、未合并的一律留下：
//      宁可留垃圾，不可删证据。
//   ③ 严禁 git worktree prune（全局清理）——那会动到用户自己的 worktree。
//      只按目录逐个清，且只清受管根下的。

/** git 调用的超时（毫秒）：挂死的 git 不许拖住整个流程。 */
export const GIT_TIMEOUT_MS = 30_000;

/** git 输出的上限（字节）：worktree list 之类的输出很小，但保险。 */
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

/** 受管分支的前缀（refs 形式，与 git worktree list --porcelain 的输出一致）。 */
const MANAGED_BRANCH_PREFIX = "refs/heads/pi-dispatch/";

/** 受管分支的短名前缀。 */
const MANAGED_BRANCH_NAME = "pi-dispatch/";

export interface GitResult {
  /** 退出码；0 = 成功。 */
  code: number;
  stdout: string;
  stderr: string;
}

/** 跑 git 的口子：参数数组、无 shell。测试注入假实现。 */
export type GitRunner = (args: string[], cwd: string, timeoutMs?: number) => Promise<GitResult>;

/**
 * 真跑 git：execFile 参数数组（不经 shell ⇒ 路径里的空格、引号不作妖）。
 * 失败也返回结果（不抛）——调用方按 code 自己判。
 */
export const execFileGit: GitRunner = (args, cwd, timeoutMs = GIT_TIMEOUT_MS) =>
  new Promise<GitResult>((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd,
        timeout: timeoutMs,
        encoding: "utf8",
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      },
    );
  });

/** 受管分支名：pi-dispatch/<taskId>。 */
export function branchNameFor(taskId: string): string {
  return `${MANAGED_BRANCH_NAME}${taskId}`;
}

/** 读仓库当前的 HEAD（受理时钉 base 用）。读不到就抛——引擎据此退回，不留痕。 */
export async function resolveHead(git: GitRunner, repoRoot: string): Promise<string> {
  const result = await git(["rev-parse", "--verify", "HEAD"], repoRoot);
  if (result.code !== 0) {
    const why = result.stderr.trim() || `code ${result.code}`;
    throw new Error(`git rev-parse --verify HEAD 失败：${why}`);
  }
  const head = result.stdout.trim();
  if (head === "") throw new Error("git rev-parse --verify HEAD 没有输出");
  return head;
}

/** 建 worktree 的结果。ok=false 时 error 说明为什么。 */
export interface CreateWorktreeResult {
  /** 建好了吗 */
  ok: boolean;
  /** 没建成的理由（建成了就没有） */
  error?: string;
}

/**
 * 建一个 worktree：git worktree add -b <branch> <path> <baseCommit>。
 * base 是受理时钉死的那个提交——排队期间父仓 HEAD 前进也不漂移。
 */
export async function createWorktree(
  git: GitRunner,
  o: { repoRoot: string; path: string; branch: string; baseCommit: string },
): Promise<CreateWorktreeResult> {
  const { repoRoot, path, branch, baseCommit } = o;
  const args = ["worktree", "add", "-b", branch, path];
  args.push(baseCommit);
  const result = await git(args, repoRoot);
  if (result.code === 0) return { ok: true };
  const why = result.stderr.trim() || `code ${result.code}`;
  return { ok: false, error: `git worktree add 失败：${why}` };
}

/** porcelain 里非空行数 = 脏文件数（改了的 + 没跟上的）。 */
export function countDirtyLines(porcelain: string): number {
  let count = 0;
  for (const line of porcelain.split("\n")) {
    if (line.trim() === "") continue;
    count++;
  }
  return count;
}

/**
 * 观测一个 worktree：孩子跑完后留下了什么。
 * 永不抛——观测失败只记 captureError（终态是既成事实，不能被观测改掉）。
 * 观测不到的字段留 undefined：不填 0、不填 false（填了就成了「干净」的谎报）。
 */
export async function observeWorktree(
  git: GitRunner,
  o: { path: string; branch: string; baseCommit: string },
): Promise<WorktreeInfo> {
  const fallback: WorktreeInfo = { path: o.path, branch: o.branch, baseCommit: o.baseCommit };
  try {
    if (!existsSync(o.path)) return { ...fallback, missing: true };
    const head = await git(["rev-parse", "--verify", "HEAD"], o.path);
    const branchName = await git(["rev-parse", "--abbrev-ref", "HEAD"], o.path);
    const status = await git(["status", "--porcelain"], o.path);
    const ahead = await git(["rev-list", "--count", `${o.baseCommit}..HEAD`], o.path);
    return {
      ...fallback,
      headCommit: head.code === 0 ? head.stdout.trim() : undefined,
      onExpectedBranch: branchName.code === 0 ? branchName.stdout.trim() === o.branch : undefined,
      dirty: status.code === 0 ? countDirtyLines(status.stdout) : undefined,
      commitsAhead: ahead.code === 0 ? Number(ahead.stdout.trim()) : undefined,
    };
  } catch (error) {
    return { ...fallback, captureError: messageOf(error) };
  }
}

/** git worktree list --porcelain 的一条。 */
export interface WorktreeEntry {
  /** 工作区绝对路径 */
  path: string;
  /** refs/heads/<name> */
  branch?: string;
  /** 目录已被手工删（git 说 prunable） */
  prunable: boolean;
}

/**
 * 解析 `git worktree list --porcelain`。
 * 只认 "worktree " 开头的行——别的行（HEAD / branch / prunable）是修饰。
 * 前缀要带空格：worktreesomething 这种行不是一条工作区。
 */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length).trim(), prunable: false };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).trim();
      continue;
    }
    if (line.startsWith("prunable")) current.prunable = true;
  }
  return entries;
}

/** 我们管的分支（refs/heads/pi-dispatch/<taskId>）⇒ 短名；别的（用户自己的）不碰。 */
export function managedBranch(ref: string | undefined): string | undefined {
  if (ref === undefined) return undefined;
  if (!ref.startsWith(MANAGED_BRANCH_PREFIX)) return undefined;
  const name = ref.slice(MANAGED_BRANCH_PREFIX.length);
  if (name === "") return undefined;
  return `${MANAGED_BRANCH_NAME}${name}`;
}

/** 路径归一：把已存在祖先的 realpath 拼回去（macOS 上 /tmp → /private/tmp）。 */
export function realish(path: string): string {
  let current = path;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(current), ...tail);
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

/** 目录的 mtime（毫秒）；目录不在了 ⇒ undefined（没有 mtime 可判）。 */
function mtimeOf(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

/** 清一个工作区：非强制 remove → 非强制删分支。 */
async function removeWorktree(
  git: GitRunner,
  repoRoot: string,
  path: string,
  branch: string,
): Promise<{ removed: number; pruned: number }> {
  // 目录本来在不在：我们只把自己删掉的算进 removed（手工删过的不算）
  const existed = existsSync(path);
  // 非强制 remove：脏的工作区 git 自己会拒（退出 128）⇒ 留下，不强删
  const result = await git(["worktree", "remove", path], repoRoot);
  if (result.code !== 0) return { removed: 0, pruned: 0 };
  // 非强制删分支：未合并的 git 会拒（退出 1）⇒ 分支留下（证据不丢）
  const branchResult = await git(["branch", "-d", branch], repoRoot);
  return { removed: existed ? 1 : 0, pruned: branchResult.code === 0 ? 1 : 0 };
}

export interface SweepOptions {
  /** 跑 git */
  git: GitRunner;
  /** git 仓库根（worktree remove / branch -d 都要在仓里跑） */
  repoRoot: string;
  /** 受管工作区的根目录 */
  worktreesDir: string;
  /** 过期阈值（毫秒） */
  ttlMs: number;
  /** 有账本吗（热记录或归档）——有就保护，不看 mtime */
  hasLedger: (taskId: string) => boolean;
  /** 单批上限 */
  maxPerBatch?: number;
}

export interface SweepResult {
  /** 我们删掉的工作区目录数 */
  removed: number;
  /** 我们删掉的分支数 */
  pruned: number;
}

/**
 * 清扫受管工作区：
 *   有账本（热记录或归档）⇒ 保护，不看 mtime；
 *   无账本且 mtime 过了 TTL ⇒ 非强制地清（worktree remove → branch -d）；
 *   单条失败跳过，下轮再收；只碰受管根下的，用户自己的 worktree 不动。
 * 严禁 git worktree prune（全局清理）——那会动到用户自己的 worktree。
 */
export async function sweepWorktrees(options: SweepOptions): Promise<SweepResult> {
  const { git, repoRoot, worktreesDir, ttlMs, hasLedger } = options;
  const maxPerBatch = options.maxPerBatch ?? 500;
  let removed = 0;
  let pruned = 0;
  let handled = 0;
  // 没有受管根目录 ⇒ 从来没用过隔离 ⇒ 连 git 都不必问（默认关时零调用）
  if (!existsSync(worktreesDir)) return { removed, pruned };
  const listed = await git(["worktree", "list", "--porcelain"], repoRoot);
  if (listed.code !== 0) return { removed, pruned };
  const root = realish(worktreesDir);
  const now = Date.now();
  for (const entry of parseWorktreeList(listed.stdout)) {
    // 只碰受管根下的工作区：用户自己建的 worktree 不该被误清
    if (!realish(entry.path).startsWith(root + sep)) continue;
    const taskId = basename(entry.path);
    // 有账本（热记录或归档）⇒ 保护，不看 mtime
    if (hasLedger(taskId)) continue;
    const branch = managedBranch(entry.branch);
    if (branch === undefined) continue;
    const mtime = mtimeOf(entry.path);
    // 没到期 ⇒ 留（目录不在了 ⇒ 没有 mtime 可判 ⇒ 当过期：只剩元数据要清，没有工作数据会丢）
    if (mtime !== undefined && now - mtime <= ttlMs) continue;
    if (handled >= maxPerBatch) break;
    handled++;
    const outcome = await removeWorktree(git, repoRoot, entry.path, branch);
    removed += outcome.removed;
    pruned += outcome.pruned;
  }
  return { removed, pruned };
}

/** 异常消息（只抛 Error 时就是 message）。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
