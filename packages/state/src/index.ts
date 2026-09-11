/**
 * @agentplant/state —— 公开 barrel（骨架期只导出类型与常量）。
 *
 * 连接/pragma/版本校验/迁移/DAO/FTS5 与治理内核由后续任务落地；在此追加导出。
 */
export type {
  MemoryKind,
  MemoryScope,
  SessionStatus,
  StatusUpdateDecision,
  TaskClaim,
  TaskStatus,
} from "./types.js";
export { SCHEMA_VERSION, STATE_DB_FILENAME } from "./types.js";
