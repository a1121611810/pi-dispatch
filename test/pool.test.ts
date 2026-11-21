// 阶段 3 探针：资源池。
// 关键：不 mock 掉「读机器」本身——真跑一次 vm_stat / sysctl，断言解析不崩。
// 池子算法是假绿高发区（取小、边界、0 值），每个分支都要有断言。
//
// 等价变异（探针杀不掉，且也不该杀）：
//   src/core/pool.ts 的三处 `?? 兜底` → `|| 兜底`（页大小 / MemAvailable / MemTotal）。
//   正则 `(\d+)` 的捕获组要么 undefined、要么至少一位数字的非空串 ——
//   空串（唯一会让 ?? 与 || 分歧的输入）不可达 ⇒ 三个变异在本仓可达输入上等价。
//   （连 "0" 也是非空串、真值：`"0" || 16384` 仍得 "0"，Number 后仍得 0。）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canOpenAnother,
  DEFAULT_POOL_OPTIONS,
  maxConcurrentStarts,
  normalizeCpuCount,
  parseMemAvailable,
  parseMemTotal,
  parseVmStat,
  perSeatBytes,
  poolBytes,
  seatCount,
  systemMachineReader,
  type MachineSpec,
} from "../src/core/pool.ts";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** 24 GiB / 10 核的机器规格 */
const SPEC_24G: MachineSpec = { totalBytes: 24 * GiB, cpus: 10 };

test("池子 ①：池子量 = 可用 − 预留，预留按总内存算", () => {
  // 可用 5.24 GiB，预留 = 24 GiB × 10% = 2.4 GiB ⇒ 池子量 2.84 GiB
  const pool = poolBytes(5.24 * GiB, SPEC_24G.totalBytes);
  assert.equal(pool, 5.24 * GiB - Math.floor(24 * GiB * 0.1));
  assert.ok(pool > 0);
});

test("池子 ①：预留与当前占用无关（按总量算）", () => {
  const a = poolBytes(10 * GiB, SPEC_24G.totalBytes);
  const b = poolBytes(10 * GiB, SPEC_24G.totalBytes);
  assert.equal(a, b, "同样的可用 ⇒ 同样的池子量");
  // 换一台总内存不同的机器 ⇒ 预留不同 ⇒ 池子量不同
  const other = poolBytes(10 * GiB, 8 * GiB);
  assert.notEqual(a, other, "预留按总量算 ⇒ 总内存变了池子量就变");
});

test("池子 ①：可用不足预留时池子量为负（⇒ 座位数 0）", () => {
  const pool = poolBytes(1 * GiB, SPEC_24G.totalBytes);
  assert.ok(pool < 0, "可用 1 GiB < 预留 2.4 GiB");
  assert.equal(seatCount(pool, perSeatBytes(SPEC_24G.totalBytes)), 0, "挤 ⇒ 一个都不开");
});

test("池子 ②：每座份额 = max(下限, 总内存 × 比例)", () => {
  // 24 GiB × 2% = 491.5 MiB < 下限 512 MiB ⇒ 取下限
  assert.equal(perSeatBytes(24 * GiB), 512 * MiB);
  // 128 GiB × 2% = 2.5 GiB > 下限 ⇒ 取比例
  assert.equal(perSeatBytes(128 * GiB), Math.floor(128 * GiB * 0.02));
  // 极小机器 ⇒ 仍是下限 512 MiB
  assert.equal(perSeatBytes(1 * GiB), 512 * MiB);
});

test("池子 ③：座位数 = ⌊池子量 ÷ 每座份额⌋，可为 0", () => {
  assert.equal(seatCount(2911 * MiB, 512 * MiB), 5);
  assert.equal(seatCount(0, 512 * MiB), 0);
  assert.equal(seatCount(-100, 512 * MiB), 0, "负池子量 ⇒ 0，不是负数");
  assert.equal(seatCount(1024 * MiB, 512 * MiB), 2, "整除时不多给");
  assert.equal(seatCount(1024 * MiB + 1, 512 * MiB), 2, "多 1 字节也不多给一个");
});

test("池子 ③：每座份额为 0 时座位数为 0（不除零）", () => {
  assert.equal(seatCount(1000, 0), 0);
});

test("池子：本机实算——24 GiB 机器得 5 个座位", () => {
  // 用本机实测的数：可用 5369.0 MiB，预留 2457.6 MiB ⇒ 池子量 2911.4 MiB
  const available = 5369 * MiB;
  const pool = poolBytes(available, SPEC_24G.totalBytes);
  const perSeat = perSeatBytes(SPEC_24G.totalBytes);
  assert.equal(seatCount(pool, perSeat), 5);
});

test("判「还能不能再开一个」：此刻池子量 ÷ 每座份额 ≥ 已在跑的 + 1", () => {
  const available = 5369 * MiB;
  const perSeat = perSeatBytes(SPEC_24G.totalBytes);
  const pool = poolBytes(available, SPEC_24G.totalBytes);
  const capacity = seatCount(pool, perSeat);
  // 5 个座：跑 4 个还能再开 1 个，跑 5 个不能
  assert.equal(canOpenAnother(available, 0, SPEC_24G), true);
  assert.equal(canOpenAnother(available, 4, SPEC_24G), true);
  assert.equal(canOpenAnother(available, 5, SPEC_24G), false);
  assert.equal(capacity, 5);
});

test("判「还能不能再开一个」：机器挤了就不开", () => {
  // 可用只 1 GiB ⇒ 池子量为负 ⇒ 一个都开不了
  const tight = 1 * GiB;
  assert.equal(canOpenAnother(tight, 0, SPEC_24G), false);
});

test("CPU 启动节流：核数 ÷ 2，夹在 1 到 4", () => {
  assert.equal(maxConcurrentStarts(10), 4, "10 核 ⇒ 5 被上限夹到 4");
  assert.equal(maxConcurrentStarts(8), 4, "8 核 ⇒ 4");
  assert.equal(maxConcurrentStarts(4), 2);
  assert.equal(maxConcurrentStarts(2), 1);
  assert.equal(maxConcurrentStarts(1), 1, "单核也要能起");
  assert.equal(maxConcurrentStarts(0), 1, "核数读不到时兜底 1");
});

test("默认参数符合规格：预留 10%，每座下限 512 MiB、上限 2%", () => {
  assert.equal(DEFAULT_POOL_OPTIONS.reserveRatio, 0.1);
  assert.equal(DEFAULT_POOL_OPTIONS.perSeatMinBytes, 512 * MiB);
  assert.equal(DEFAULT_POOL_OPTIONS.perSeatMaxRatio, 0.02);
});

test("真机：读一次机器规格，断言解析不崩且数值合理", () => {
  const spec = systemMachineReader.readSpec();
  assert.ok(spec.totalBytes > 0, `总内存读到了：${spec.totalBytes}`);
  assert.ok(spec.cpus > 0, `核数读到了：${spec.cpus}`);
  assert.ok(spec.totalBytes >= 256 * MiB, "总内存不该小于 256 MiB");
});

test("真机：读一次此刻可用，断言解析不崩且落在总内存范围内", () => {
  const spec = systemMachineReader.readSpec();
  const available = systemMachineReader.readAvailable();
  assert.ok(available > 0, `可用内存读到了：${available}`);
  assert.ok(available <= spec.totalBytes, "可用不该超过总内存");
});

test("真机：读一次此刻可用，耗时在可接受范围（规格说约 3 毫秒）", () => {
  const started = Date.now();
  systemMachineReader.readAvailable();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 200, `读一次用了 ${elapsed}ms，不该慢到影响派发`);
});

test("真机：本机算出来的座位数与规格演算一致", () => {
  const spec = systemMachineReader.readSpec();
  const available = systemMachineReader.readAvailable();
  const pool = poolBytes(available, spec.totalBytes);
  const perSeat = perSeatBytes(spec.totalBytes);
  const seats = seatCount(pool, perSeat);
  // 座位数不能是负数，也不能超过「池子量 ÷ 每座份额」的物理上限
  assert.ok(seats >= 0);
  assert.ok(seats * perSeat <= pool, "开的座位不能超过池子量");
});

// ── 解析函数（从「读机器」里抽出来的纯逻辑，可喂假数据测） ──────────────────

/** 真机抓的 vm_stat 样本（2026-11-18）——逐项核对过。 */
const VM_STAT_SAMPLE = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    36390.
Pages active:                                 306130.
Pages inactive:                               308326.
Pages speculative:                             1585.
Pages throttled:                                  0.
Pages wired down:                             213051.
Pages purgeable:                               7886.
`;

test("解析：vm_stat 的可用 = free + inactive + speculative + purgeable", () => {
  const bytes = parseVmStat(VM_STAT_SAMPLE);
  const expectedPages = 36390 + 308326 + 1585 + 7886;
  assert.equal(bytes, expectedPages * 16384);
});

test("解析：vm_stat 里的 active / wired 不计入可用", () => {
  // active 与 wired 都被排除——加了它们可用会虚高
  const bytes = parseVmStat(VM_STAT_SAMPLE);
  const withoutActive = bytes;
  assert.ok(withoutActive > 0);
  // 若错误地加上 active（306130 页 = 4.9 GiB），可用会远超总内存的一半
  assert.ok(withoutActive < 10 * GiB, "可用不该包含 active/wired");
});

test("解析：vm_stat 缺页大小时用 16384 兜底", () => {
  const noSize = VM_STAT_SAMPLE.replace("(page size of 16384 bytes)", "(unknown)");
  const expectedPages = 36390 + 308326 + 1585 + 7886;
  assert.equal(parseVmStat(noSize), expectedPages * 16384);
});

test("解析：vm_stat 用别的页大小时按实际值算", () => {
  const with8k = VM_STAT_SAMPLE.replace("16384", "8192");
  const expectedPages = 36390 + 308326 + 1585 + 7886;
  assert.equal(parseVmStat(with8k), expectedPages * 8192, "页大小要跟着变");
});

test("解析：vm_stat 里缺某个键时按 0 算（不崩）", () => {
  const noFree = VM_STAT_SAMPLE.replace(/Pages free:.*\n/, "");
  const expectedPages = 308326 + 1585 + 7886;
  assert.equal(parseVmStat(noFree), expectedPages * 16384);
});

test("解析：vm_stat 空输入返回 0", () => {
  assert.equal(parseVmStat(""), 0);
});

test("解析：meminfo 的 MemAvailable（Linux）", () => {
  const meminfo = `MemTotal:       25769803776 kB
MemFree:         1234567890 kB
MemAvailable:    1234567890 kB
Buffers:          123456 kB
`;
  assert.equal(parseMemAvailable(meminfo), 1234567890 * 1024);
});

test("解析：meminfo 缺 MemAvailable 时返回 0", () => {
  assert.equal(parseMemAvailable("MemTotal: 100 kB\n"), 0);
  assert.equal(parseMemAvailable(""), 0);
});

test("解析：meminfo 不会被别的键误匹配（MemAvailable 不能被 MemTotal 带偏）", () => {
  const meminfo = "MemTotal:       100 kB\nMemFree: 50 kB\n";
  assert.equal(parseMemAvailable(meminfo), 0, "MemFree 不能被当成 MemAvailable");
});

test("解析：meminfo 的 MemTotal", () => {
  const meminfo = `MemTotal:       25769803776 kB
MemFree:         1234567890 kB
MemAvailable:    1234567890 kB
`;
  assert.equal(parseMemTotal(meminfo), 25769803776 * 1024);
});

test("解析：meminfo 缺 MemTotal 时返回 0", () => {
  assert.equal(parseMemTotal("MemFree: 50 kB\n"), 0);
  assert.equal(parseMemTotal(""), 0);
});

test("解析：meminfo 的 MemTotal 不会被 MemTotalized 之类的键带偏", () => {
  const meminfo = "MemTotalized:   999 kB\n";
  assert.equal(parseMemTotal(meminfo), 0, "MemTotalized 不是 MemTotal");
});

test("解析：vm_stat 的页大小写错时用兜底值 16384", () => {
  const badSize = VM_STAT_SAMPLE.replace("page size of 16384 bytes", "page size of ??? bytes");
  const expectedPages = 36390 + 308326 + 1585 + 7886;
  assert.equal(parseVmStat(badSize), expectedPages * 16384, "读不出页大小就用默认");
});

test("座位数：每座份额为负时返回 0（不返回负座位）", () => {
  assert.equal(seatCount(1000, -1), 0);
  assert.equal(seatCount(1000, 0), 0);
});

test("座位数：每座份额小于 1 字节时返回 0（不能开出半个座位）", () => {
  assert.equal(seatCount(1000, 0.5), 0, "0.5 字节的份额开不出一个完整座位");
  assert.equal(seatCount(1000, 0.999), 0);
  assert.equal(seatCount(1000, 1), 1000, "1 字节的份额刚好能开");
});

test("核数兜底：读到 0 或读不到时按 1 算（单核也要能起）", () => {
  assert.equal(normalizeCpuCount(0), 1);
  assert.equal(normalizeCpuCount(10), 10, "正常核数不动");
  assert.equal(normalizeCpuCount(Number.NaN), 1, "NaN 也按 1 算");
});
