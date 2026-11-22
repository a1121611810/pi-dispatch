import type { TaskRegistry } from "./registry.ts";
import { tallySteers, type SteerTally } from "./steer.ts";

// 通知：后台任务完成的消息按批发给父方。
// 事件源 = registry 的终态变迁。100 KB 一批切开，别刷屏。

export interface TaskNotification {
  taskId: string;
  status: string;
  at: number;
  /** 自述对不上收据（没有实测支撑） */
  deliveryUnverified?: boolean;
  /** 谎报自检（声称的命令没观测到） */
  verifyUnverified?: boolean;
  /** 工具通道报告早于最后一次转向送达（以最终正文为准） */
  reportStale?: true;
  /** 转向收据计数（只在任务真的被转向过时出现） */
  steers?: SteerTally;
}

export const NOTIFICATION_BATCH_MAX_BYTES = 100 * 1024;

/**
 * 按 JSON 字节数分批：一批的总字节不超过 maxBytes，单条超限也自成一批（不丢）。
 * 抽成纯函数是因为边界（正好等于上限、bytes 初值）只能用手工构造的条目测准。
 */
export function batchBySize<T>(items: readonly T[], maxBytes: number): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item), "utf8");
    if (current.length > 0 && bytes + size > maxBytes) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** 待投递队列。drain 取走即清。 */
export class NotificationCenter {
  readonly #pending: TaskNotification[] = [];

  /** 挂到 registry：终态变迁进待投递队列。 */
  attach(registry: TaskRegistry): void {
    registry.subscribe((next, prev) => {
      if (prev?.status === next.status) return;
      if (!isTerminalStatus(next.status)) return;
      this.#pending.push({
        taskId: next.id,
        status: next.status,
        at: next.finishedAt ?? Date.now(),
        ...(next.deliveryUnverified ? { deliveryUnverified: true } : {}),
        ...(next.verifyUnverified ? { verifyUnverified: true } : {}),
        ...(next.reportStale ? { reportStale: true as const } : {}),
        ...(next.steers && next.steers.length > 0 ? { steers: tallySteers(next.steers) } : {}),
      });
    });
  }

  pendingCount(): number {
    return this.#pending.length;
  }

  /** 取走全部待投递，按 100 KB 分批。空 = 无事发生。 */
  drain(): TaskNotification[][] {
    return batchBySize(this.#pending.splice(0), NOTIFICATION_BATCH_MAX_BYTES);
  }
}

function isTerminalStatus(status: string): boolean {
  return (
    status === "succeeded" || status === "failed" || status === "canceled" || status === "lost"
  );
}
