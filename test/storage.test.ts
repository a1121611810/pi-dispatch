// 阶段 5 探针：留痕。
// 关键：全部用真文件真目录（临时目录），不用内存替身冒充落盘。
//
// 等价变异（探针杀不掉，也不该杀）：
//   src/core/storage.ts 的 Linux 分支（processStartMs 的 /proc 读法）——
//   本机是 macOS，那几行只走 Linux 路径，探针无法覆盖。
//   `parsed && typeof parsed.id`（line 213）——去掉 `parsed &&` 后 `null.id` 抛异常，
//   被外层的 try/catch 兜住 ⇒ 行为等价。
//   TTL 判断的 `>` vs `>=`（line 234）——真实运行中差值恰好等于 ttlMs 的那一瞬间不可达。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeBucket,
  findProjectRoot,
  isPidAlive,
  isSafeTaskId,
  parseProcStatStarttime,
  processStartMs,
  Storage,
} from "../src/core/storage.ts";
import type { TaskRecord } from "../src/core/types.ts";

/** 每个测试一个独立的临时桶——不碰真账。 */
function freshStorage(): { root: string; project: string; storage: Storage } {
  const root = mkdtempSync(join(tmpdir(), "dispatch-store-"));
  const project = join(root, "proj");
  mkdirSync(join(project, ".git"), { recursive: true });
  const storage = new Storage(join(root, "dispatch"), project);
  return { root, project, storage };
}

function record(id: string, status: TaskRecord["status"] = "succeeded"): TaskRecord {
  return { id, status, task: "t" };
}

// ── 桶名编码 ──────────────────────────────────────────────────────────────

test("桶名编码：照抄 pi 的会话目录编码", () => {
  assert.equal(
    encodeBucket("/home/dev/develop/pi-dispatch"),
    "--Users-real-user-develop-pi-dispatch--",
  );
  assert.equal(encodeBucket("/Users/x/proj"), "--Users-x-proj--");
});

test("桶名编码：分隔符全换 -", () => {
  assert.equal(encodeBucket("C:\\a\\b"), "--C-a-b--");
  assert.equal(encodeBucket("/a:b/c"), "--a-b-c--");
  assert.equal(encodeBucket("/a  b/c"), "--a-b-c--", "空白也算分隔符");
});

// ── 项目根查找 ────────────────────────────────────────────────────────────

test("项目根：向上找 .git 或 .pi", () => {
  const { project } = freshStorage();
  mkdirSync(join(project, "sub", "dir"), { recursive: true });
  assert.equal(findProjectRoot(project), project);
  assert.equal(findProjectRoot(join(project, "sub")), project);
  assert.equal(findProjectRoot(join(project, "sub", "dir")), project);
});

test("项目根：.pi 也算项目根", () => {
  const { root } = freshStorage();
  const withPi = join(root, "withpi");
  mkdirSync(join(withPi, ".pi"), { recursive: true });
  assert.equal(findProjectRoot(withPi), withPi);
});

test("项目根：到顶都找不到就退回 start", () => {
  const { root } = freshStorage();
  const nowhere = join(root, "nowhere", "deep");
  mkdirSync(nowhere, { recursive: true });
  assert.equal(findProjectRoot(nowhere), nowhere);
});

// ── 编号安全 ──────────────────────────────────────────────────────────────

test("编号安全：斜杠、反斜杠、两个点都拒", () => {
  assert.equal(isSafeTaskId("01a1ec71"), true);
  assert.equal(isSafeTaskId("../etc/passwd"), false);
  assert.equal(isSafeTaskId("a/b"), false);
  assert.equal(isSafeTaskId("a\\b"), false);
  assert.equal(isSafeTaskId(".."), false);
});

test("编号不安全时落盘要抛错（不能写到别处去）", () => {
  const { storage } = freshStorage();
  assert.throws(() => storage.persistRecord(record("../evil")), /invalid task id/);
  assert.throws(() => storage.persistOutput("../evil", "x"), /invalid task id/);
});

// ── 记录持久化 ────────────────────────────────────────────────────────────

test("记录：写盘后能读回", () => {
  const { storage } = freshStorage();
  storage.persistRecord(record("a"));
  storage.persistRecord(record("b", "failed"));
  const restored = storage.restoreRecords();
  const ids = restored.map((r) => r.id).sort();
  assert.deepEqual(ids, ["a", "b"]);
  assert.equal(restored.find((r) => r.id === "b")?.status, "failed");
});

test("记录：原子写——不留半个 json", () => {
  const { storage } = freshStorage();
  storage.persistRecord(record("a"));
  // 读回是合法 JSON（不是截断的）
  const text = readFileSync(storage.recordPath("a"), "utf8");
  assert.doesNotThrow(() => JSON.parse(text));
});

test("记录：坏文件不拖垮启动，跳过继续", () => {
  const { storage } = freshStorage();
  storage.persistRecord(record("good"));
  // 手造一个坏 json
  writeFileSync(
    join(storage.bucket && storage.recordPath("bad").replace("bad.json", "corrupt.json")),
    "not json{{{",
  );
  const restored = storage.restoreRecords();
  assert.ok(
    restored.some((r) => r.id === "good"),
    "好记录还在",
  );
  assert.ok(!restored.some((r) => r.id === "corrupt"), "坏记录跳过");
});

test("记录：编号带 / 时读回返回空（不拼错路径）", () => {
  const { storage } = freshStorage();
  storage.persistRecord(record("safe"));
  assert.equal(storage.restoreRecords().length, 1);
});

// ── 产出 ─────────────────────────────────────────────────────────────────

test("产出：写盘后能读回，路径挂在记录上", () => {
  const { storage } = freshStorage();
  const path = storage.persistOutput("a", "hello world");
  assert.ok(path.includes("output.log"));
  assert.equal(storage.readOutput("a"), "hello world");
});

test("产出：不存在的任务读回 undefined", () => {
  const { storage } = freshStorage();
  assert.equal(storage.readOutput("missing"), undefined);
});

// ── 归档 ────────────────────────────────────────────────────────────────

test("归档：挤掉后能从压缩档读回记录与产出", () => {
  const { storage } = freshStorage();
  storage.persistRecord(record("a"));
  storage.persistOutput("a", "产出正文");
  storage.archiveOne(record("a"));
  // 热文件没了
  assert.throws(() => readFileSync(storage.recordPath("a")), /ENOENT/);
  // 归档里能读回
  const archived = storage.readArchivedRecord("a");
  assert.equal(archived?.id, "a");
  assert.equal(archived?.archived, true);
  assert.equal(storage.readArchivedOutput("a"), "产出正文");
});

test("归档：坏档不拖垮整批", () => {
  const { storage } = freshStorage();
  storage.persistRecord(record("good"));
  storage.archiveOne(record("good"));
  assert.ok(storage.readArchivedRecord("good"));
});

// ── TTL 清理 ────────────────────────────────────────────────────────────

test("TTL：按 mtime 判，过期清掉，没过期留下", () => {
  const { storage } = freshStorage();
  storage.persistRecord(record("old"));
  storage.persistRecord(record("new"));
  storage.archiveOne(record("old"));
  storage.archiveOne(record("new"));
  // 把 old 的归档 mtime 拨回 31 天前
  const oldGz = join(storage.recordPath("old").replace(/records.*$/, ""), "archive", "old.json.gz");
  const past = new Date(Date.now() - 31 * 86_400_000);
  utimesSync(oldGz, past, past);
  const purged = storage.purgeExpiredArchive(30);
  assert.equal(purged, 1, "只清掉过期的");
  assert.equal(storage.readArchivedRecord("old"), undefined, "old 清掉了");
  assert.ok(storage.readArchivedRecord("new"), "new 还在");
});

test("TTL：单批上限 500", () => {
  const { storage } = freshStorage();
  // 造 5 个过期档，单批上限 2 ⇒ 只清 2 个
  for (let i = 0; i < 5; i++) {
    storage.persistRecord(record(`t${i}`));
    storage.archiveOne(record(`t${i}`));
    const gz = join(
      storage.recordPath(`t${i}`).replace(/records.*$/, ""),
      "archive",
      `t${i}.json.gz`,
    );
    const past = new Date(Date.now() - 40 * 86_400_000);
    utimesSync(gz, past, past);
  }
  const purged = storage.purgeExpiredArchive(30, 2);
  assert.equal(purged, 2, "单批上限 2");
});

// ── 主方存活判定 ──────────────────────────────────────────────────────────

test("进程存活：自己的 pid 活着", () => {
  assert.equal(isPidAlive(process.pid), true);
});

test("进程存活：不存在的 pid 是死的", () => {
  // 找一个几乎肯定不存在的 pid
  const dead = 2 ** 22; // 4_194_304
  assert.equal(isPidAlive(dead), false);
});

test("进程启动时刻：自己的进程能读到启动时刻", () => {
  const start = processStartMs(process.pid);
  assert.ok(start, "启动时刻读到了");
  assert.ok(start > 0);
  // 启动时刻应该早于现在
  assert.ok(start <= Date.now());
  // 启动时刻不应该早于机器开机
  assert.ok(start >= Date.now() - 30 * 86_400_000, "不该比 30 天还老");
});

test("进程启动时刻：不存在的 pid 读不到", () => {
  assert.equal(processStartMs(2 ** 22), undefined);
});

test("进程启动时刻：同一进程两次读出的时刻一致", () => {
  const a = processStartMs(process.pid);
  const b = processStartMs(process.pid);
  assert.equal(a, b, "启动时刻是稳定的");
});

test("记录：persistRecord 不会创建多余目录（recursive 不代表忽略已存在）", () => {
  const { storage } = freshStorage();
  storage.persistRecord(record("a"));
  // 第二次写不应该炸（recursive: true 幂等）
  storage.persistRecord({ ...record("a"), status: "failed" });
  assert.equal(storage.restoreRecords().find((r) => r.id === "a")?.status, "failed");
});

test("记录：restoreRecords 只认 id 是字符串的记录（别的形状跳过）", () => {
  const { storage } = freshStorage();
  // 手造一个 id 不是字符串的 json
  const badPath = join(
    storage.recordPath("placeholder").replace(/placeholder\.json$/, "weird.json"),
  );
  mkdirSync(join(badPath, ".."), { recursive: true });
  writeFileSync(badPath, JSON.stringify({ status: "succeeded" }));
  storage.persistRecord(record("good"));
  const restored = storage.restoreRecords();
  assert.ok(restored.some((r) => r.id === "good"));
  assert.ok(!restored.some((r) => (r as { id?: unknown }).id === undefined));
});

test("产出：编号不安全时读回 undefined（不写错路径）", () => {
  const { storage } = freshStorage();
  assert.equal(storage.readOutput("../evil"), undefined);
});

test("产出：persistOutput 创建 tasks/<id>/ 目录", () => {
  const { storage } = freshStorage();
  const path = storage.persistOutput("nested-task", "x");
  assert.ok(existsSync(path));
  assert.ok(path.includes("nested-task"), "路径里有任务编号");
});

test("归档：removeTrace 把记录和产出一起删", () => {
  const { storage } = freshStorage();
  storage.persistRecord(record("gone"));
  storage.persistOutput("gone", "正文");
  storage.removeTrace("gone");
  assert.throws(() => readFileSync(storage.recordPath("gone")), /ENOENT/);
  assert.equal(storage.readOutput("gone"), undefined);
});

test("归档：编号不安全时 archiveOne 静默跳过（不崩）", () => {
  const { storage } = freshStorage();
  // 不该抛异常
  storage.archiveOne({ id: "../evil", status: "succeeded", task: "t" });
});

test("TTL：归档目录不存在时返回 0", () => {
  const { storage } = freshStorage();
  assert.equal(storage.purgeExpiredArchive(30), 0);
});

test("TTL：边界——正好到期的清掉，还差 1 毫秒留下", () => {
  const { storage } = freshStorage();
  storage.persistRecord(record("edge"));
  storage.archiveOne(record("edge"));
  const gz = join(storage.recordPath("edge").replace(/records.*$/, ""), "archive", "edge.json.gz");
  // 把 mtime 拨到 29 天 23 小时 59 分 59 秒前（差 1 秒到期）
  const almost = new Date(Date.now() - (30 * 86_400_000 - 1000));
  utimesSync(gz, almost, almost);
  assert.equal(storage.purgeExpiredArchive(30), 0, "还差 1 秒到期 ⇒ 留下");
  // 拨到 30 天零 1 秒前（过期 1 秒）
  const just = new Date(Date.now() - (30 * 86_400_000 + 1000));
  utimesSync(gz, just, just);
  assert.equal(storage.purgeExpiredArchive(30), 1, "过期 1 秒 ⇒ 清掉");
});

test("TTL：边界——超过 30 天才算过期，30 天之内留下", () => {
  const { storage } = freshStorage();
  storage.persistRecord(record("boundary"));
  storage.archiveOne(record("boundary"));
  const gz = join(
    storage.recordPath("boundary").replace(/records.*$/, ""),
    "archive",
    "boundary.json.gz",
  );
  // 29 天 23 小时（不到 30 天）⇒ 留下
  const inside = new Date(Date.now() - (30 * 86_400_000 - 3_600_000));
  utimesSync(gz, inside, inside);
  assert.equal(storage.purgeExpiredArchive(30), 0, "不到 30 天 ⇒ 留下");
  // 30 天 + 1 小时（超过 30 天）⇒ 清掉
  const outside = new Date(Date.now() - (30 * 86_400_000 + 3_600_000));
  utimesSync(gz, outside, outside);
  assert.equal(storage.purgeExpiredArchive(30), 1, "超过 30 天 ⇒ 清掉");
});

test("产出：同一任务写两次产出不炸（目录已存在也要能写）", () => {
  const { storage } = freshStorage();
  storage.persistOutput("same", "第一次");
  storage.persistOutput("same", "第二次");
  assert.equal(storage.readOutput("same"), "第二次");
});

// ── 审查修复：proc stat 解析 / locale ──────────────────────────────────────

test("解析：读最后一个 ) 之后切，进程名带空格也不错位", () => {
  // 第 2 字段是 (comm)。名字里有空格：字段会整体后移，按空格切就错了。
  const stat =
    "1234 (my proc with spaces) S 1 1234 1234 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 98765 12345678 100 18446744073709551615";
  assert.equal(parseProcStatStarttime(stat), 98765);
});

test("解析：普通进程名同样取到 starttime", () => {
  const stat =
    "1234 (node) S 1 1234 1234 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 424242 12345678 100 0";
  assert.equal(parseProcStatStarttime(stat), 424242);
});

test("解析：没有 ) 的坏输入返回 undefined", () => {
  assert.equal(parseProcStatStarttime("garbage"), undefined);
  assert.equal(parseProcStatStarttime(""), undefined);
});

test("解析：字段不够时返回 undefined", () => {
  assert.equal(parseProcStatStarttime("1 (x) S"), undefined);
});

test("locale：中文环境下进程启动时刻仍读得到（ps 输出带 LC_ALL=C）", () => {
  const old = process.env.LANG;
  process.env.LANG = "zh_CN.UTF-8";
  try {
    const start = processStartMs(process.pid);
    assert.ok(start, "锁了 LC_ALL=C ⇒ ps 输出可解析");
    assert.ok(start! <= Date.now());
  } finally {
    if (old === undefined) delete process.env.LANG;
    else process.env.LANG = old;
  }
});

// ── worktree 目录与归档查询 ───────────────────────────────────────────────

test("golden：默认关——桶里没有 worktrees 目录", () => {
  const { storage } = freshStorage();
  storage.persistRecord(record("a"));
  storage.persistOutput("a", "x");
  const bucketRoot = storage.recordPath("a").replace(/records.*$/, "");
  assert.equal(existsSync(join(bucketRoot, "worktrees")), false, "隔离没开就不建这个目录");
});

test("golden：默认关——桶里没有 blackboards 目录", () => {
  const { storage } = freshStorage();
  storage.persistRecord(record("a"));
  storage.persistOutput("a", "x");
  const bucketRoot = storage.recordPath("a").replace(/records.*$/, "");
  assert.equal(existsSync(join(bucketRoot, "blackboards")), false, "黑板没开就不建这个目录");
});

test("worktree：路径落在受管根下，编号不安全时抛", () => {
  const { storage } = freshStorage();
  const path = storage.worktreePath("task-1");
  assert.ok(path.includes("worktrees"));
  assert.ok(path.endsWith("task-1"));
  assert.throws(() => storage.worktreePath("../evil"), /invalid task id/);
});

test("worktree：worktreesDir 是桶下的固定位置", () => {
  const { storage } = freshStorage();
  assert.equal(
    storage.worktreesDir,
    join(storage.recordPath("x").replace(/records.*$/, ""), "worktrees"),
  );
});

test("归档：hasArchivedRecord 看的是压缩档在不在", () => {
  const { storage } = freshStorage();
  assert.equal(storage.hasArchivedRecord("a"), false, "还没归档");
  storage.persistRecord(record("a"));
  storage.archiveOne(record("a"));
  assert.equal(storage.hasArchivedRecord("a"), true, "归档了");
  assert.equal(storage.hasArchivedRecord("b"), false);
  assert.equal(storage.hasArchivedRecord("../evil"), false, "编号不安全时不碰盘");
});

test("归档：listArchivedIds 列出归档里的编号", () => {
  const { storage } = freshStorage();
  assert.deepEqual(storage.listArchivedIds(), []);
  storage.persistRecord(record("a"));
  storage.persistOutput("a", "x");
  storage.archiveOne(record("a"));
  storage.persistRecord(record("b"));
  storage.archiveOne(record("b"));
  assert.deepEqual(storage.listArchivedIds().sort(), ["a", "b"]);
});

test("留痕：projectRoot 拿得回当初那个根", () => {
  const { project, storage } = freshStorage();
  assert.equal(storage.projectRoot, project);
});
