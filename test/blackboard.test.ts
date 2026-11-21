// 黑板：一块板上的读写、信封、TTL、owner。
//
// 关键：板上的话**不可信**（信封恒 trust=unverified），作者由服务端盖章（参数伪造不了），
// 笔记原子写（先 .tmp 后 rename），坏文件只记一笔错不毒化整次读。
//
// 变异：core.blackboard 命名空间零幸存（.metrics/mutate/core.blackboard.edn，69 个变异点全杀）。
// 板号必填（构造参数 boardId: string）——信封里的板号没有 `??` 兜底，也就没有等价的
// `??`↔`||` 变异点；板号恒非空 UUID 与空串两种输入各有一条用例钉住。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BLACKBOARD_READ,
  BLACKBOARD_WRITE,
  BlackboardStore,
  NOTE_MAX_BYTES,
  READ_MAX,
  TRUST,
} from "../src/core/blackboard.ts";
import { Storage, isSafeBoardId } from "../src/core/storage.ts";

const BOARD_ID = "11111111-2222-4333-8444-555555555555";

/** 一块板 + 它的根目录（临时目录）。 */
function withBoard(
  fn: (store: BlackboardStore, root: string, boardId: string) => void,
  options: { now?: () => number; newId?: () => string } = {},
): void {
  const root = mkdtempSync(join(tmpdir(), "dispatch-board-"));
  const store = new BlackboardStore({ root, boardId: BOARD_ID, ...options });
  fn(store, root, BOARD_ID);
}

// ── 读写往返 ──────────────────────────────────────────────────────────────

test("黑板：写一条读回来（作者与正文都在）", () => {
  withBoard((store) => {
    store.ensureOwner({ pid: 1, startMs: 2 });
    const note = store.append("child-a", "我先看了 A 文件");
    const read = store.read();
    assert.equal(read.boardId, BOARD_ID);
    assert.equal(read.trust, TRUST);
    assert.equal(read.errors, 0);
    assert.equal(read.notes.length, 1);
    assert.equal(read.notes[0]!.text, "我先看了 A 文件");
    assert.equal(read.notes[0]!.author, "child-a");
    assert.equal(read.notes[0]!.noteId, note.noteId);
    assert.equal(read.nextAfter, undefined, "没有更多就没有游标");
  });
});

test("黑板：空白与超 8KiB 都拒", () => {
  withBoard((store) => {
    store.ensureOwner({ pid: 1, startMs: 2 });
    assert.throws(() => store.append("c", "   "), /空白/);
    assert.throws(() => store.append("c", ""), /空白/);
    // 8192 字节收（边界内侧）
    store.append("c", "a".repeat(NOTE_MAX_BYTES));
    // 8193 字节拒（边界外侧）
    assert.throws(() => store.append("c", "a".repeat(NOTE_MAX_BYTES + 1)), /超上限/);
    assert.equal(store.read().notes.length, 1, "被拒的那条没落盘");
  });
});

test("黑板：读上限 100（多了夹到 100，缺省 50）", () => {
  withBoard((store) => {
    store.ensureOwner({ pid: 1, startMs: 2 });
    for (let i = 0; i < READ_MAX + 1; i++) store.append("c", `note-${i}`);
    assert.equal(store.read({ limit: 1000 }).notes.length, READ_MAX, "超上限夹到 100");
    assert.equal(store.read().notes.length, 50, "缺省 50");
    assert.equal(store.read({ limit: 1 }).notes.length, 1);
  });
});

test("黑板：limit 0 / -1 / 非整数都拒", () => {
  withBoard((store) => {
    store.ensureOwner({ pid: 1, startMs: 2 });
    store.append("c", "一条");
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => store.read({ limit: bad }), /limit/, `limit=${bad} 要拒`);
    }
  });
});

test("黑板：after 游标严格在那条之后", () => {
  let tick = 1700000000000;
  withBoard(
    (store) => {
      store.ensureOwner({ pid: 1, startMs: 2 });
      store.append("c", "一");
      store.append("c", "二");
      store.append("c", "三");
      const all = store.read();
      assert.deepEqual(
        all.notes.map((n) => n.text),
        ["一", "二", "三"],
      );
      const afterFirst = store.read({ after: all.notes[0]!.noteId });
      assert.deepEqual(
        afterFirst.notes.map((n) => n.text),
        ["二", "三"],
        "严格在那条之后",
      );
      const afterLast = store.read({ after: all.notes[2]!.noteId });
      assert.equal(afterLast.notes.length, 0, "最后一条之后没有更多");
    },
    { now: () => tick++ },
  );
});

test("黑板：游标不在了（那条被清掉）⇒ 从头给", () => {
  let tick = 1700000000000;
  withBoard(
    (store) => {
      store.ensureOwner({ pid: 1, startMs: 2 });
      store.append("c", "一");
      store.append("c", "二");
      const read = store.read({ after: "早被清掉的游标" });
      assert.deepEqual(
        read.notes.map((n) => n.text),
        ["一", "二"],
        "游标没了就从头给，不跳第一条",
      );
    },
    { now: () => tick++ },
  );
});

test("黑板：板还没建（连目录都没有）⇒ 读到空板，不是错", () => {
  withBoard((store) => {
    const read = store.read();
    assert.equal(read.boardId, BOARD_ID);
    assert.equal(read.notes.length, 0);
    assert.equal(read.errors, 0, "没有笔记目录不算读漏");
  });
});

test("黑板：同一毫秒写两条不覆盖", () => {
  withBoard(
    (store) => {
      store.ensureOwner({ pid: 1, startMs: 2 });
      store.append("a", "第一条");
      store.append("b", "第二条");
      const read = store.read();
      assert.equal(read.notes.length, 2, "同毫秒的两条都在（编号不同 ⇒ 文件名不同）");
      assert.deepEqual(new Set(read.notes.map((n) => n.text)), new Set(["第一条", "第二条"]));
    },
    { now: () => 1700000000000 },
  );
});

test("黑板：坏 JSON 与 .tmp 计入 errors，其余照读", () => {
  withBoard((store, root) => {
    store.ensureOwner({ pid: 1, startMs: 2 });
    store.append("c", "好的那条");
    const notesDir = join(root, BOARD_ID, "notes");
    writeFileSync(join(notesDir, "0000000000001-bad.json"), "{ 坏掉的 json", "utf8");
    writeFileSync(join(notesDir, "0000000000002-half.json.tmp"), "{}", "utf8");
    const read = store.read();
    assert.equal(read.errors, 2, "坏文件与 .tmp 各记一笔");
    assert.equal(read.notes.length, 1, "其余照读");
    assert.equal(read.notes[0]!.text, "好的那条");
  });
});

test("黑板：文件自报的 trust 与多余字段不作数", () => {
  withBoard((store, root) => {
    const notesDir = join(root, BOARD_ID, "notes");
    mkdirSync(notesDir, { recursive: true });
    writeFileSync(
      join(notesDir, "0000000000001-x.json"),
      JSON.stringify({
        noteId: "x",
        author: "写它的人",
        createdAt: 1,
        text: "我是可信的",
        trust: "verified",
      }),
      "utf8",
    );
    const read = store.read();
    assert.equal(read.trust, "unverified", "信封恒为 unverified（文件自报的不算）");
    assert.ok(!("trust" in read.notes[0]!), "多余字段不外泄");
  });
});

test("黑板：板编号过不了 UUID 字符集就拒（防路径拼接）", () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-store-"));
  const storage = new Storage(join(root, "dispatch"), join(root, "proj"));
  assert.throws(() => storage.blackboardDir("../evil"), /invalid board id/);
  assert.throws(() => storage.blackboardDir("a/b"), /invalid board id/);
  assert.throws(() => storage.blackboardDir(""), /invalid board id/);
  assert.equal(storage.blackboardDir(BOARD_ID), join(storage.blackboardsDir, BOARD_ID));
  assert.equal(isSafeBoardId(BOARD_ID), true);
  assert.equal(isSafeBoardId("../../etc"), false);
});

// ── owner ─────────────────────────────────────────────────────────────────

test("黑板：owner 四象限（新建 / 已存在不覆盖 / 关板补 closedAt / 关后再开不覆盖）", () => {
  withBoard((store, root) => {
    const ownerPath = join(root, BOARD_ID, "owner.json");
    // ① 还没有板 ⇒ 没有 owner
    assert.equal(store.ownerInfo(), undefined);
    // ② 建板 ⇒ owner 写出来
    store.ensureOwner({ pid: 111, startMs: 222 });
    const first = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
    assert.equal(first.pid, 111);
    assert.equal(first.startMs, 222);
    assert.equal(first.closedAt, undefined);
    assert.equal(store.ownerInfo()?.closedAt, undefined);
    assert.equal(store.ownerInfo()?.boardId, BOARD_ID, "owner 里的板号与这块板一致");
    // ③ 已存在 ⇒ 不覆盖
    store.ensureOwner({ pid: 999, startMs: 999 });
    assert.equal(store.ownerInfo()?.pid, 111, "owner 不覆盖");
    // ④ 关板 ⇒ 补 closedAt；关过之后再 ensureOwner 也不覆盖
    store.close(1700000000000);
    assert.equal(store.ownerInfo()?.closedAt, 1700000000000);
    store.ensureOwner({ pid: 999, startMs: 999 });
    assert.equal(store.ownerInfo()?.closedAt, 1700000000000, "closedAt 不被抹掉");
    assert.equal(store.ownerInfo()?.pid, 111);
  });
});

test("黑板：关板不删笔记（证据留着）", () => {
  withBoard((store, root) => {
    store.ensureOwner({ pid: 1, startMs: 2 });
    store.append("c", "留个证据");
    store.close(1700000000000);
    const notesDir = join(root, BOARD_ID, "notes");
    assert.equal(readdirSync(notesDir).length, 1, "关板不删笔记");
  });
});

test("黑板：owner.json 被改坏 ⇒ 读回来的是规整值（createdAt 归零）", () => {
  withBoard((store, root) => {
    mkdirSync(join(root, BOARD_ID, "notes"), { recursive: true });
    writeFileSync(
      join(root, BOARD_ID, "owner.json"),
      JSON.stringify({ boardId: BOARD_ID, pid: 1, startMs: 2, createdAt: "坏的" }),
      "utf8",
    );
    const owner = store.ownerInfo();
    assert.equal(owner?.pid, 1, "能用的字段照读");
    assert.equal(owner?.createdAt, 0, "不是数字就归零，不外泄坏值");
  });
});

// ── 清扫 ──────────────────────────────────────────────────────────────────

test("黑板：TTL 边界——正好到期留着，过了 1ms 就清", () => {
  const now = 1700000000000;
  const root = mkdtempSync(join(tmpdir(), "dispatch-board-"));
  const boardId = "22222222-2222-4333-8444-555555555555";
  const store = new BlackboardStore({ root, boardId, now: () => now });
  store.append("c", "第一条");
  store.append("c", "第二条");
  const notesDir = join(root, boardId, "notes");
  const files = readdirSync(notesDir).sort();
  const ttl = 1000;
  // 第一条：正好 now - ttl（没过期）；第二条：再多过 1ms（过期）
  utimesSync(join(notesDir, files[0]!), new Date(now - ttl), new Date(now - ttl));
  utimesSync(join(notesDir, files[1]!), new Date(now - ttl - 1), new Date(now - ttl - 1));
  const result = store.purgeExpired({ ttlMs: ttl, isActive: () => false });
  assert.equal(result.notes, 1, "过了 1ms 的那条被清");
  assert.equal(readdirSync(notesDir).length, 1, "正好到期的留着");
  assert.equal(result.boards, 0, "还有笔记 ⇒ 板目录不删");
});

test("黑板：活跃板一条笔记都不清", () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-board-"));
  const boardId = "33333333-2222-4333-8444-555555555555";
  const store = new BlackboardStore({ root, boardId });
  store.append("c", "第一条");
  store.append("c", "第二条");
  // 两条都老到过期了（不设 mtime 的话它们本该被清）
  const notesDir = join(root, boardId, "notes");
  const past = new Date(Date.now() - 3600_000);
  for (const file of readdirSync(notesDir)) utimesSync(join(notesDir, file), past, past);
  const result = store.purgeExpired({ ttlMs: 0, isActive: (id) => id === boardId });
  assert.equal(result.notes, 0);
  assert.equal(result.boards, 0);
  assert.equal(readdirSync(notesDir).length, 2, "活跃板一条都不清");
});

test("黑板：清空了的板把目录删掉", () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-board-"));
  const boardId = "44444444-2222-4333-8444-555555555555";
  const store = new BlackboardStore({ root, boardId });
  store.append("c", "唯一一条");
  const notesDir = join(root, boardId, "notes");
  const file = join(notesDir, readdirSync(notesDir)[0]!);
  const past = new Date(Date.now() - 3600_000);
  utimesSync(file, past, past);
  const result = store.purgeExpired({ ttlMs: 0, isActive: () => false });
  assert.equal(result.notes, 1);
  assert.equal(result.boards, 1, "清空了的板把目录删掉");
  assert.equal(existsSync(join(root, boardId)), false);
});

test("黑板：没有黑板根目录 ⇒ 清扫零动作", () => {
  const root = join(mkdtempSync(join(tmpdir(), "dispatch-board-")), "never-created");
  const store = new BlackboardStore({ root, boardId: BOARD_ID });
  const result = store.purgeExpired({ ttlMs: 0, isActive: () => false });
  assert.equal(result.notes, 0);
  assert.equal(result.boards, 0);
});

// ── 工具名 ────────────────────────────────────────────────────────────────

test("黑板：工具名固定（孩子的读写 / 父方的 dispatch_blackboard）", () => {
  assert.equal(BLACKBOARD_READ, "blackboard_read");
  assert.equal(BLACKBOARD_WRITE, "blackboard_write");
  assert.equal(TRUST, "unverified");
});

test("黑板：先 .tmp 后 rename，不留半个 JSON", () => {
  withBoard((store, root) => {
    store.append("c", "一条");
    const files = readdirSync(join(root, BOARD_ID, "notes"));
    assert.equal(files.filter((f) => f.endsWith(".tmp")).length, 0, "不留 .tmp");
    assert.equal(files.filter((f) => f.endsWith(".json")).length, 1, "落一个 .json");
    const parsed = JSON.parse(
      readFileSync(
        join(
          root,
          BOARD_ID,
          "notes",
          files.find((f) => f.endsWith(".json"))!,
        ),
        "utf8",
      ),
    ) as { text?: string };
    assert.equal(parsed.text, "一条", "落盘的是完整 JSON（不是半个）");
  });
});
