// 会话审计的中间模型与结果形状。
// 判词枚举直接复用 core 的那一份——五档只许有一个定义处。
import type { Deliverable } from "../core/types.ts";

/** 一条命令自述。`wantOk` = 这句话声称的是「跑通了」还是只声称「跑过」。 */
export interface CommandClaim {
  command: string;
  wantOk: boolean;
}

/** 从散文里抽出来的自述。 */
export interface ExtractedClaims {
  paths: string[];
  commands: CommandClaim[];
  /**
   * 每个「完成词」绑到哪条命令（`commands` 的下标）。
   * `null` = 本句与上一句都没有前置命令，绑不到。
   */
  vagueBindings: Array<number | null>;
}

/** 一条带退出码的命令收据。没有退出码的收据 `trusted: false`，永远不能证明「跑通」。 */
export interface CommandReceipt {
  command: string;
  exitCode?: number;
  trusted: boolean;
}

export interface Receipts {
  paths: string[];
  commands: CommandReceipt[];
}

/** 输出契约里的 claims / mismatch：只放可核对的字面量。 */
export interface ClaimSet {
  paths: string[];
  commands: string[];
}

export interface AuditResult {
  deliverable: Deliverable;
  claims: ClaimSet;
  receipts: Receipts;
  mismatch: ClaimSet;
  truncated: boolean;
  notes: string[];
}

/**
 * 归一化事件。三家日志在这里汇成一个形状；判定层不认识来源。
 * 工具名只保留三种：`write`（带 path）/ `bash`（带 command）/ `read`（只用于区分「读过」）。
 */
export type SessionEvent =
  | {
      kind: "tool";
      name: "write" | "bash" | "read";
      input: { path?: string; command?: string };
      exitCode?: number;
      cwd?: string;
    }
  | { kind: "tool_result"; output: string; isError?: boolean; callId?: string }
  | {
      kind: "message";
      role: "assistant" | "user";
      text: string;
      /** 运行中插进来的用户话（转向） */
      steer?: true;
      /** 子代理侧链，不算主链 */
      sidechain?: boolean;
    }
  | { kind: "meta"; cwd?: string };

export interface AuditOptions {
  /** 解析相对路径的基准；必须绝对，否则当 `/`。 */
  cwd?: string;
  /** 每一维各留多少条（默认 20）。 */
  maxReceipts?: number;
  /** 结构化自述：给了就不跑散文抽取。 */
  claims?: ExtractedClaims;
}
