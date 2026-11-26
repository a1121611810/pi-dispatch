// 会话审计的公开面。判定层是纯函数；归一化与 CLI 各自在自己的文件里。
export { audit, claimHit, collectReceipts, verdictOf } from "./verdict.ts";
export { extractClaims, normalizePath } from "./claims.ts";
export { normalizeCodex, unwrapShell } from "./normalize-codex.ts";
export { normalizeClaude } from "./normalize-claude.ts";
export type {
  AuditOptions,
  AuditResult,
  ClaimSet,
  CommandClaim,
  CommandReceipt,
  ExtractedClaims,
  Receipts,
  SessionEvent,
} from "./types.ts";
