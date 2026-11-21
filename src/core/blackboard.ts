import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

// 黑板：会话级的一块共享板——父方与兄弟子代理共读共写。
//   <bucket>/blackboards/<boardId>/
//     ├── owner.json                        ← 谁开的板（pid + 启动时刻）；关板时补 closedAt
//     └── notes/<createdAt13位补零>-<noteId>.json
//
// 三条硬规矩：
//   ① 板上的话**不可信**——兄弟子代理自己写的，可能是假的。读信封恒带 trust=unverified，
//      文件里自报的 trust 一律不认。
//   ② 作者服务端盖章——写工具的参数里没有作者字段，作者取自环境（任务编号），参数伪造不了。
//   ③ 板的内容永不自动进任何提示词——契约全在工具描述里，读的人才知道该多疑。

/** 孩子的读工具名。 */
export const BLACKBOARD_READ = "blackboard_read";
/** 孩子的写工具名。 */
export const BLACKBOARD_WRITE = "blackboard_write";
/** 信任档：恒为「未核实」——兄弟子代理的话只是线索，不是事实。 */
export const TRUST = "unverified" as const;
/** 单条笔记的上限（字节）。 */
export const NOTE_MAX_BYTES = 8 * 1024;
/**
 * 单次读的字节预算（正文累计）：一次读最多把这些字节装进父方上下文。
 * 写侧限 8KiB/条，但兄弟可以用 bash 直接写巨型文件绕过写侧——读侧自己再守一道。
 */
export const READ_BYTE_BUDGET = 32 * 1024;
/** 单次读的上限（条）。 */
export const READ_MAX = 100;
/** 单次读的缺省条数。 */
const READ_DEFAULT = 50;

/** 板编号会拼进路径——只认 UUID 的字符集，其余一律拒绝（防路径拼接）。 */
export function isSafeBoardId(boardId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(boardId);
}

/** 板上的一条留言。 */
export interface BlackboardNote {
  noteId: string;
  /** 作者（服务端盖章来的，参数伪造不了） */
  author: string;
  createdAt: number;
  text: string;
}

/** 读回的信封：trust 恒为常量——板上的话一律未核实。 */
export interface BlackboardRead {
  boardId: string;
  trust: typeof TRUST;
  notes: BlackboardNote[];
  /** 坏文件与 .tmp 的个数（读到了但跳过，不毒化整次读） */
  errors: number;
  /** 还有更多时的游标：拿它接着读 */
  nextAfter?: string;
}

/** 板的 owner（谁开的、还在不在）。 */
export interface BlackboardOwner {
  boardId: string;
  pid: number;
  startMs: number;
  createdAt: number;
  /** 关板时刻；没关就没有这个键 */
  closedAt?: number;
}

/** 原子写：先写 .tmp 再 rename——崩了最多留一个没用的 .tmp，不会留半个 JSON。 */
function writeJsonAtomic(final: string, value: unknown): void {
  const tmp = `${final}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmp, final);
}

/**
 * 读一个笔记文件；坏文件（含形状不对、正文超 8KiB）返回 undefined——计入 errors 跳过。
 * 先 stat：大到怎么也不止 8KiB 正文的（手写巨型文件）连读都不读。
 * 阈值按 JSON 转义的最坏情况留量（控制字符转义成 \uXXXX = 6 字节）：写侧收下的 8KiB 正文
 * 落盘可能近 48KiB——拿 32KiB 读预算当阈值，会把写侧合法写入的笔记误判成坏文件。
 * 大小只挡「装不进任何一次读」的；单条上限按解析出的正文再判。
 */
function readNoteFile(path: string): BlackboardNote | undefined {
  try {
    if (statSync(path).size > NOTE_MAX_BYTES * 6 + 1024) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BlackboardNote>;
    if (typeof parsed.noteId !== "string" || typeof parsed.author !== "string") return undefined;
    if (typeof parsed.createdAt !== "number" || typeof parsed.text !== "string") return undefined;
    // 写侧拒超 8KiB；读侧也拒——手写/旁路写进来的巨型 note 不进父方上下文
    if (Buffer.byteLength(parsed.text, "utf8") > NOTE_MAX_BYTES) return undefined;
    // 多余的键（自报的 trust 之类）一律不认——只取这四个字段
    return {
      noteId: parsed.noteId,
      author: parsed.author,
      createdAt: parsed.createdAt,
      text: parsed.text,
    };
  } catch {
    return undefined;
  }
}

/** 读 owner.json；没有或坏了就 undefined（判不了活就当没这个板）。 */
function readOwnerFile(path: string): BlackboardOwner | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BlackboardOwner>;
    if (typeof parsed.pid !== "number" || typeof parsed.startMs !== "number") return undefined;
    return {
      boardId: typeof parsed.boardId === "string" ? parsed.boardId : "",
      pid: parsed.pid,
      startMs: parsed.startMs,
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
      ...(typeof parsed.closedAt === "number" ? { closedAt: parsed.closedAt } : {}),
    };
  } catch {
    return undefined;
  }
}

/** limit：缺省 50、>100 夹到 100、0/负数/非整数拒（坏值不悄悄变小）。 */
function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return READ_DEFAULT;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
    throw new Error(`limit 非法：${String(limit)}（要正整数，≤${READ_MAX}）`);
  }
  return Math.min(limit, READ_MAX);
}

/** 游标之后的第一条（严格之后）。游标不在了（被清掉）⇒ 从头给。 */
function indexAfter(notes: BlackboardNote[], after: string): number {
  const at = notes.findIndex((note) => note.noteId === after);
  if (at < 0) return 0;
  return at + 1;
}

/**
 * 一块板。
 * root 是**板们**的根目录（<桶>/blackboards），boardId 是这一块板的编号——
 * 所以同一个 store 也能清扫 root 底下所有板（purgeExpired）。
 */
export class BlackboardStore {
  readonly #root: string;
  readonly #boardId: string;
  readonly #now: () => number;
  readonly #newId: () => string;

  constructor(o: { root: string; boardId: string; now?: () => number; newId?: () => string }) {
    this.#root = o.root;
    this.#boardId = o.boardId;
    this.#now = o.now ?? Date.now;
    this.#newId = o.newId ?? randomUUID;
  }

  /** 这块板的目录：<root>/<boardId>。板编号是路径的一段，这里一处守全。 */
  boardDir(): string {
    const boardId = this.#boardId;
    if (!isSafeBoardId(boardId)) throw new Error(`invalid board id: ${boardId}`);
    return join(this.#root, boardId);
  }

  #notesDir(): string {
    return join(this.boardDir(), "notes");
  }

  #ownerPath(): string {
    return join(this.boardDir(), "owner.json");
  }

  /**
   * 建板的 owner.json（原子写）。已存在就不覆盖——owner 是这块板的第一任主人，
   * 换会话接管靠记录里的引用判活，不靠改这个文件。
   */
  ensureOwner(owner: { pid: number; startMs: number }): void {
    const boardId = this.#boardId;
    const path = this.#ownerPath();
    mkdirSync(this.boardDir(), { recursive: true });
    mkdirSync(this.#notesDir(), { recursive: true });
    if (existsSync(path)) return;
    writeJsonAtomic(path, {
      boardId,
      pid: owner.pid,
      startMs: owner.startMs,
      createdAt: this.#now(),
    } satisfies BlackboardOwner);
  }

  /** 关板：原子补 closedAt。不删任何笔记——证据留着。 */
  close(now: number): void {
    const path = this.#ownerPath();
    if (!existsSync(path)) return; // 没板 ⇒ 没得关
    const owner = readOwnerFile(path);
    if (!owner) return;
    writeJsonAtomic(path, { ...owner, closedAt: now });
  }

  /** 指定那块板的 owner 信息；没有或坏了就 undefined。 */
  ownerInfo(boardId: string): BlackboardOwner | undefined {
    if (!isSafeBoardId(boardId)) return undefined;
    return readOwnerFile(join(this.#root, boardId, "owner.json"));
  }

  /**
   * 写一条留言。空白或超 8KiB 就抛——让调用方把话还回去，别静默吞掉。
   * 文件名是 `<createdAt13位补零>-<noteId>.json`：文件名序 = 时间序。
   */
  append(author: string, text: string): BlackboardNote {
    if (typeof text !== "string" || text.trim() === "") throw new Error("黑板笔记不能是空白");
    if (Buffer.byteLength(text, "utf8") > NOTE_MAX_BYTES) {
      throw new Error(`黑板笔记超上限（${NOTE_MAX_BYTES} 字节）`);
    }
    const notesDir = this.#notesDir();
    mkdirSync(notesDir, { recursive: true });
    const noteId = this.#newId();
    const createdAt = this.#now();
    const note: BlackboardNote = { noteId, author, createdAt, text };
    const name = `${String(createdAt).padStart(13, "0")}-${noteId}.json`;
    writeJsonAtomic(join(notesDir, name), note);
    return note;
  }

  /**
   * 读板。文件名序（=时间序）；坏文件与 .tmp 计入 errors 跳过——不毒化整次读。
   * after 是 noteId 游标（严格之后）；limit 缺省 50、>100 夹到 100、0/负数/非整数拒。
   * 正文按文件名序累计，超 READ_BYTE_BUDGET 就截断：已读部分照给，nextAfter 接着读。
   * trust 恒为常量——文件自报的 trust 不作数。
   */
  read(o: { after?: string; limit?: number } = {}): BlackboardRead {
    const limit = normalizeLimit(o.limit);
    const notesDir = this.#notesDir();
    if (!existsSync(notesDir))
      return { boardId: this.#boardId, trust: TRUST, notes: [], errors: 0 };
    const files = readdirSync(notesDir).sort();
    const notes: BlackboardNote[] = [];
    let errors = 0;
    for (const file of files) {
      // 只认 .json：.tmp（写一半的）与别的都不算笔记，但记一笔错
      const note = file.endsWith(".json") ? readNoteFile(join(notesDir, file)) : undefined;
      if (!note) {
        errors += 1;
        continue;
      }
      notes.push(note);
    }
    const start = o.after === undefined ? 0 : indexAfter(notes, o.after);
    // 条数上限与字节预算两道闸：先到哪道就在哪道截断，nextAfter 续读
    const window: BlackboardNote[] = [];
    let bytes = 0;
    for (let i = start; i < notes.length && window.length < limit; i++) {
      const note = notes[i]!;
      const cost = Buffer.byteLength(note.text, "utf8");
      if (bytes + cost > READ_BYTE_BUDGET) break;
      bytes += cost;
      window.push(note);
    }
    const hasMore = notes.length > start + window.length;
    return {
      boardId: this.#boardId,
      trust: TRUST,
      notes: window,
      errors,
      ...(hasMore ? { nextAfter: window[window.length - 1]!.noteId } : {}),
    };
  }

  /**
   * 清扫：活跃板整板跳过（有人在用）；owner 读不到/坏的板也跳过（判不了活 ⇒ 可能活着，
   * 计入 skippedUnknown）；只有 owner 可读且被证死（closedAt，或 pid 双条件判死）才动。
   * 死板按笔记 mtime 清过期；空板（无笔记残留）才删目录。
   * stat 失败的笔记算「没清」（left 加一笔）——全失败时目录绝不因为计数归零被删。
   */
  purgeExpired(o: {
    ttlMs: number;
    isActive: (boardId: string) => boolean;
    isOwnerDead: (owner: BlackboardOwner) => boolean;
  }): {
    notes: number;
    boards: number;
    skippedUnknown: number;
  } {
    const { ttlMs, isActive, isOwnerDead } = o;
    const now = this.#now();
    let notes = 0;
    let boards = 0;
    let skippedUnknown = 0;
    if (!existsSync(this.#root)) return { notes, boards, skippedUnknown };
    for (const entry of readdirSync(this.#root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const boardId = entry.name;
      if (isActive(boardId)) continue;
      // 判活 fail-safe：owner 读不到/坏 ⇒ 视为「可能活跃」，整板跳过（只记一笔待查）
      const owner = readOwnerFile(join(this.#root, boardId, "owner.json"));
      if (!owner) {
        skippedUnknown += 1;
        continue;
      }
      // 活着但证不死（pid 活、启动时刻读不到）⇒ 也不动
      if (!isOwnerDead(owner)) continue;
      const notesDir = join(this.#root, boardId, "notes");
      let left = 0;
      if (existsSync(notesDir)) {
        for (const file of readdirSync(notesDir)) {
          const path = join(notesDir, file);
          try {
            const mtimeMs = statSync(path).mtimeMs;
            if (now - mtimeMs > ttlMs) {
              rmSync(path);
              notes += 1;
              continue;
            }
          } catch {
            // 单条失败跳过，下轮再收；但算「没清」——不许因此把目录删掉
            left += 1;
            continue;
          }
          left += 1;
        }
      }
      // 空板删目录的前提：owner 可读 && 判死 && 无笔记残留（left 计数把 stat 失败也算未清）
      if (left === 0) {
        try {
          rmSync(join(this.#root, boardId), { recursive: true, force: true });
          boards += 1;
        } catch {
          // 删不掉就留着——下轮再收
        }
      }
    }
    return { notes, boards, skippedUnknown };
  }
}
