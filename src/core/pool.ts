import { execFileSync } from "node:child_process";

// 资源池：座位是从机器的内存池子里切出来的份额。
//
// 池子算法（唯一口径，三步）：
//   ① 池子量 = 可用 − 预留          ← 可分配给座位池的内存量
//      预留   = 总内存 × 10%        ← 按总量算，与当前占用无关
//   ② 每座份额                        ← 每个座位分到多少
//   ③ 座位数   = ⌊ 池子量 ÷ 每座份额 ⌋
//
// 同一个公式在两个时机各算一次：
//   启动时     → 座位上限（此后不变；机器规格恒定，重读是白花时间）
//   每次派发前 → 此刻池子（内存是波动的：用户开了吃内存的东西 ⇒ 池子变小）
//
// 重算只用来「决定还能不能开新的」，绝不用来「把已经在跑的收掉」。

/** 机器规格：恒定，启动时读一次就存起来。 */
export interface MachineSpec {
  /** 总内存（字节） */
  totalBytes: number;
  /** 核数 */
  cpus: number;
}

/** 此刻的可用内存（字节）。每次派发前重读。 */
export interface MemoryReading {
  availableBytes: number;
}

/** 池子与座位的算法参数。 */
export interface PoolOptions {
  /** 预留比例（按总内存算）——规格定 10% */
  reserveRatio: number;
  /** 每座份额：下限固定值，与上限取大 */
  perSeatMinBytes: number;
  /** 每座份额：上限比例（占总内存）——防大机器无谓保守 */
  perSeatMaxRatio: number;
}

export const DEFAULT_POOL_OPTIONS: PoolOptions = {
  reserveRatio: 0.1,
  perSeatMinBytes: 512 * 1024 * 1024,
  perSeatMaxRatio: 0.02,
};

/**
 * 每座份额 = max(下限, 总内存 × 上限比例)。
 * 依据：实测一个 pi 子代理的峰值 RSS 约 148 MiB，取其数倍留余量。
 */
export function perSeatBytes(
  totalBytes: number,
  options: PoolOptions = DEFAULT_POOL_OPTIONS,
): number {
  return Math.max(options.perSeatMinBytes, Math.floor(totalBytes * options.perSeatMaxRatio));
}

/** 池子量 = 可用 − 预留。预留按总内存算，与当前占用无关。 */
export function poolBytes(
  availableBytes: number,
  totalBytes: number,
  options: PoolOptions = DEFAULT_POOL_OPTIONS,
): number {
  return availableBytes - Math.floor(totalBytes * options.reserveRatio);
}

/** 座位数 = ⌊池子量 ÷ 每座份额⌋。可以是 0——机器太挤时一个都不开是正确答案。 */
export function seatCount(pool: number, perSeat: number): number {
  // 份额小于 1 字节 ⇒ 开不出一个完整座位（除法会给出天文数字）
  if (perSeat < 1) return 0;
  return Math.max(0, Math.floor(pool / perSeat));
}

/**
 * 此刻还能不能再开一个？
 * 规格原话：此刻池子 ÷ 每座份额 ≥ 已经在跑的 + 1。
 */
export function canOpenAnother(
  availableBytes: number,
  running: number,
  spec: MachineSpec,
  options: PoolOptions = DEFAULT_POOL_OPTIONS,
): boolean {
  const pool = poolBytes(availableBytes, spec.totalBytes, options);
  const perSeat = perSeatBytes(spec.totalBytes, options);
  return seatCount(pool, perSeat) >= running + 1;
}

/** 读机器情况。分「恒定的」（启动时读一次）与「波动的」（每次派发前重读）。 */
export interface MachineReader {
  /** 总内存 + 核数——恒定，启动时读一次 */
  readSpec(): MachineSpec;
  /** 此刻可用——波动，每次派发前重读 */
  readAvailable(): number;
}

function execText(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

/**
 * 解析 vm_stat 的输出。抽成纯函数是为了能测——
 * 读机器的分支里只有「解析」这件事有逻辑，「怎么拿到文本」没有。
 */
export function parseVmStat(out: string): number {
  const pageSize = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 16384);
  const pages = (key: string): number => {
    const match = new RegExp(`${key}:\\s+(\\d+)`).exec(out);
    return match ? Number(match[1]) : 0;
  };
  const total =
    pages("Pages free") +
    pages("Pages inactive") +
    pages("Pages speculative") +
    pages("Pages purgeable");
  return total * pageSize;
}

/** 从 /proc/meminfo 取一项（字节）。键不存在时返回 0。 */
function meminfoBytes(meminfo: string, key: string): number {
  const kb = Number(new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(meminfo)?.[1] ?? 0);
  return kb * 1024;
}

/** 解析 /proc/meminfo 的可用内存（Linux）。 */
export function parseMemAvailable(meminfo: string): number {
  return meminfoBytes(meminfo, "MemAvailable");
}

/** 解析 /proc/meminfo 的总内存（Linux）。 */
export function parseMemTotal(meminfo: string): number {
  return meminfoBytes(meminfo, "MemTotal");
}

/**
 * 核数兜底：读不到或读到 0 时按 1 算。
 * 单核机器也要能一个一个起子代理（规格第 4 节下限 1）。
 */
export function normalizeCpuCount(cpus: number): number {
  return cpus || 1;
}

/**
 * macOS 读法：总内存与核数用 sysctl；「此刻可用」读 vm_stat 自己算。
 * 可用 = free + inactive + speculative + purgeable
 *   —— inactive 是文件缓存，可回收但回收有延迟，算进去偏乐观（规格已警告）。
 */
function readMacSpec(): MachineSpec {
  const totalBytes = Number(execText("sysctl", ["-n", "hw.memsize"]).trim());
  const cpus = Number(execText("sysctl", ["-n", "hw.ncpu"]).trim());
  return { totalBytes, cpus };
}

function readMacAvailable(): number {
  return parseVmStat(execText("vm_stat", []));
}

/**
 * Linux 读法：总内存与核数从 /proc；「此刻可用」取 MemAvailable。
 * 未在本机实测（本机是 macOS）—— 解析部分抽成纯函数，Linux 上可直接复用同一批探针。
 */
function readLinuxSpec(): MachineSpec {
  const meminfo = execText("cat", ["/proc/meminfo"]);
  const cpus = execText("nproc", []).trim();
  return { totalBytes: parseMemTotal(meminfo), cpus: normalizeCpuCount(Number(cpus)) };
}

function readLinuxAvailable(): number {
  return parseMemAvailable(execText("cat", ["/proc/meminfo"]));
}

/** 生产实现：按平台选读法。 */
export const systemMachineReader: MachineReader = {
  readSpec: () => (process.platform === "darwin" ? readMacSpec() : readLinuxSpec()),
  readAvailable: () => (process.platform === "darwin" ? readMacAvailable() : readLinuxAvailable()),
};

/**
 * CPU 启动节流上限：核数 ÷ 2，夹在 1 到 4。
 *   ÷ 2：留一半核给父方和系统。
 *   上限 4：启动再快也就 0.2 秒，节流到 4 个一批代价可忽略。
 *   下限 1：单核机器也要能一个一个起。
 * 不读实时 CPU 负载——读一次要起进程（几百毫秒），且负载是波动的。
 */
export function maxConcurrentStarts(cpus: number): number {
  return Math.min(4, Math.max(1, Math.floor(cpus / 2)));
}
