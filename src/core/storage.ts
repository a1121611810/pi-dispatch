import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { join } from "node:path";
import type { TaskRecord } from "./types.ts";

// 留痕：账本落在一个全局目录、按项目分桶。
//   <rootDir>/<桶>/
//     ├── records/<id>.json         ← 记录，一次任务一个文件
//     ├── records/<id>.json.tmp     ← 写入中的临时文件
//     ├── tasks/<id>/output.log     ← 子代理的完整输出
//     └── archive/<id>.json.gz + <id>.output.gz  ← 挤掉的记录搬来这里
//
// 桶名照抄 pi 的会话目录编码——自己发明编码的最大风险是跟 pi 的约定分叉。
// 编号会拼进路径——落盘前先查 / \ ..，拒绝。

/** 桶名编码：`--` + 根路径去首斜杠 + / \ : → - + `--`。 */
export function encodeBucket(projectRoot: string): string {
  return `--${projectRoot.replace(/^\//, "").replace(/[\\/:\s]+/g, "-")}--`;
}

/** 项目根：向上找 .git 或 .pi（不是裸 cwd）。 */
export function findProjectRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, ".git")) || existsSync(join(dir, ".pi"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) return start; // 到顶了都没找到 ⇒ 退回 start
    dir = parent;
  }
}

/** 编号会拼进路径——有 / \ 或 .. 就拒绝。 */
export function isSafeTaskId(taskId: string): boolean {
  return !taskId.includes("/") && !taskId.includes("\\") && !taskId.includes("..");
}

/** 项目桶下的目录布局。 */
export interface StoragePaths {
  recordsDir: string;
  tasksDir: string;
  archiveDir: string;
  /** 受管 worktree 的根目录。默认不建（隔离没开就不该有这个目录）。 */
  worktreesDir: string;
  /** 受管黑板的根目录。默认不建（黑板没开就不该有这个目录）。 */
  blackboardsDir: string;
}

export class Storage {
  readonly #bucket: string;
  #paths: StoragePaths;

  constructor(rootDir: string, projectRoot: string) {
    this.#bucket = encodeBucket(projectRoot);
    const base = join(rootDir, this.#bucket);
    this.#paths = {
      recordsDir: join(base, "records"),
      tasksDir: join(base, "tasks"),
      archiveDir: join(base, "archive"),
      worktreesDir: join(base, "worktrees"),
      blackboardsDir: join(base, "blackboards"),
    };
  }

  get bucket(): string {
    return this.#bucket;
  }

  /** 受管 worktree 的根目录。 */
  get worktreesDir(): string {
    return this.#paths.worktreesDir;
  }

  /** 受管 worktree 的落点：<桶>/worktrees/<taskId>。目录默认不建（用时由 git 建）。 */
  worktreePath(taskId: string): string {
    if (!isSafeTaskId(taskId)) throw new Error(`invalid task id: ${taskId}`);
    return join(this.#paths.worktreesDir, taskId);
  }

  /** 受管黑板的根目录（板们都在这儿底下）。默认不建。 */
  get blackboardsDir(): string {
    return this.#paths.blackboardsDir;
  }

  /** 受管黑板的落点：<桶>/blackboards/<boardId>。目录默认不建（用时由黑板自己建）。 */
  blackboardDir(boardId: string): string {
    return join(this.#paths.blackboardsDir, boardId);
  }

  #ensureDirs(): void {
    mkdirSync(this.#paths.recordsDir, { recursive: true });
    mkdirSync(this.#paths.tasksDir, { recursive: true });
  }

  recordPath(id: string): string {
    if (!isSafeTaskId(id)) throw new Error(`invalid task id: ${id}`);
    return join(this.#paths.recordsDir, `${id}.json`);
  }

  /**
   * 记录变了 → 原子写。
   * 先写 .tmp 再 rename——写到一半崩了，磁盘上最多留一个没用的 .tmp，不会留半个 .json。
   * 写盘失败不阻塞任务流——记录还在内存，磁盘这轮缺了下轮补。
   */
  persistRecord(record: TaskRecord): void {
    if (!isSafeTaskId(record.id)) throw new Error(`invalid task id: ${record.id}`);
    try {
      this.#ensureDirs();
      const path = this.recordPath(record.id);
      writeFileSync(`${path}.tmp`, JSON.stringify(record, null, 2), "utf8");
      renameSync(`${path}.tmp`, path);
    } catch {
      // 落盘失败不阻塞任务流——记进日志即可，别 throw
    }
  }

  /** 子代理的产出。写一次整份。 */
  persistOutput(taskId: string, text: string): string {
    if (!isSafeTaskId(taskId)) throw new Error(`invalid task id: ${taskId}`);
    this.#ensureDirs();
    const dir = join(this.#paths.tasksDir, taskId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "output.log");
    writeFileSync(path, text, "utf8");
    return path;
  }

  readOutput(taskId: string): string | undefined {
    if (!isSafeTaskId(taskId)) return undefined;
    const path = join(this.#paths.tasksDir, taskId, "output.log");
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  }

  /** 读 records/*.json 装回内存。一个坏文件不许拖垮启动——跳过它继续。 */
  restoreRecords(): TaskRecord[] {
    if (!existsSync(this.#paths.recordsDir)) return [];
    const records: TaskRecord[] = [];
    for (const file of readdirSync(this.#paths.recordsDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const record = JSON.parse(
          readFileSync(join(this.#paths.recordsDir, file), "utf8"),
        ) as TaskRecord;
        if (record && typeof record.id === "string") records.push(record);
      } catch {
        // 单条坏记录不拖垮启动
      }
    }
    return records;
  }

  /** 删除一个任务的留痕（挤掉时）。 */
  removeTrace(taskId: string): void {
    try {
      rmSync(this.recordPath(taskId));
      rmSync(join(this.#paths.tasksDir, taskId), { recursive: true, force: true });
    } catch {
      // 单条删失败不拖垮整批；残留文件下轮 restore 同机制收
    }
  }

  /**
   * 异步归档：gzip 后落位（.gz.tmp → rename），再删热文件。
   * 中途死掉最多留双份，restore 时容忍重复。
   * 归档失败 → 热文件留着不动（只允许「多留一份」，不允许「没归档就删了」）。
   */
  archiveOne(record: TaskRecord): void {
    if (!isSafeTaskId(record.id)) return;
    const id = record.id;
    try {
      mkdirSync(this.#paths.archiveDir, { recursive: true });
      const recordGz = gzipSync(Buffer.from(JSON.stringify({ ...record, archivedAt: Date.now() })));
      const recordGzTmp = join(this.#paths.archiveDir, `${id}.json.gz.tmp`);
      writeFileSync(recordGzTmp, recordGz);
      renameSync(recordGzTmp, join(this.#paths.archiveDir, `${id}.json.gz`));
      const outputPath = join(this.#paths.tasksDir, id, "output.log");
      if (existsSync(outputPath)) {
        const outputGz = gzipSync(readFileSync(outputPath));
        const outputGzTmp = join(this.#paths.archiveDir, `${id}.output.gz.tmp`);
        writeFileSync(outputGzTmp, outputGz);
        renameSync(outputGzTmp, join(this.#paths.archiveDir, `${id}.output.gz`));
      }
      this.removeTrace(id);
    } catch {
      // 归档失败：热文件留着，下轮 boot 直删路径收尸
    }
  }

  /** 从压缩归档拉回一条记录（决策 29 的冷存读者）；miss = undefined。 */
  readArchivedRecord(taskId: string): (TaskRecord & { archived: true }) | undefined {
    const file = join(this.#paths.archiveDir, `${taskId}.json.gz`);
    if (!existsSync(file)) return undefined;
    try {
      const parsed = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8")) as TaskRecord;
      return { ...parsed, archived: true };
    } catch {
      return undefined;
    }
  }

  readArchivedOutput(taskId: string): string | undefined {
    const file = join(this.#paths.archiveDir, `${taskId}.output.gz`);
    if (!existsSync(file)) return undefined;
    try {
      return gunzipSync(readFileSync(file)).toString("utf8");
    } catch {
      return undefined;
    }
  }

  /** 归档里有这个编号吗（清扫时当「有账本」——归档也是账）。 */
  hasArchivedRecord(taskId: string): boolean {
    if (!isSafeTaskId(taskId)) return false;
    return existsSync(join(this.#paths.archiveDir, `${taskId}.json.gz`));
  }

  /** 归档 TTL 清理：归档文件写成就不改写，mtime 即归档时刻。
   * 过期在启动时清，单批上限 500——别拖住启动。
   */
  purgeExpiredArchive(ttlDays: number, maxPerBatch = 500): number {
    if (!existsSync(this.#paths.archiveDir)) return 0;
    const ttlMs = ttlDays * 86_400_000;
    const now = Date.now();
    let purged = 0;
    for (const file of readdirSync(this.#paths.archiveDir)) {
      if (purged >= maxPerBatch) break;
      if (!file.endsWith(".gz")) continue;
      try {
        if (now - statSync(join(this.#paths.archiveDir, file)).mtimeMs > ttlMs) {
          rmSync(join(this.#paths.archiveDir, file));
          purged++;
        }
      } catch {
        // 单条失败跳过，下轮再收
      }
    }
    return purged;
  }
}

/**
 * 主方存活判定：进程号 + 启动时刻，两个都对才算活着。
 * 光看进程号会认错人——进程号会被系统重复使用。
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 解析 `/proc/<pid>/stat` 的 starttime（第 22 字段，自系统启动的时钟嘀嗒数）。
 * 不能按空格切：第 2 字段是 `(comm)`，进程名可以含空格。从最后一个 `)` 之后切。
 */
export function parseProcStatStarttime(stat: string): number | undefined {
  const close = stat.lastIndexOf(")");
  if (close < 0) return undefined;
  // `)` 之后还有 20 个字段，starttime 是第 20 个（整体第 22）
  const ticks = Number(
    stat
      .slice(close + 1)
      .trim()
      .split(/\s+/)[19],
  );
  return Number.isFinite(ticks) ? ticks : undefined;
}

/** 主方进程的启动时刻（毫秒）。macOS 用 ps -o lstart；Linux 用 /proc/<pid>/stat。 */
export function processStartMs(pid: number): number | undefined {
  try {
    if (process.platform === "darwin") {
      const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        // 输出跟 locale 走：中文环境会是「三 11月/18 …」，Date.parse 得 NaN
        env: { ...process.env, LC_ALL: "C" },
      }).trim();
      const t = Date.parse(out);
      return Number.isNaN(t) ? undefined : t;
    }
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const startTicks = parseProcStatStarttime(stat);
    if (startTicks === undefined) return undefined;
    const ticksPerSec = 100;
    const btime = Number(/btime\s+(\d+)/.exec(readFileSync("/proc/stat", "utf8"))?.[1]);
    return btime * 1000 + (startTicks / ticksPerSec) * 1000;
  } catch {
    return undefined;
  }
}
