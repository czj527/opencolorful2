/**
 * @agentplant/state —— 公开 barrel。
 *
 * 分层：`types.ts`（跨包类型契约，名称冻结）→ `db.ts`（连接/pragma/时间口径）→
 * `migrate.ts`（DDL 迁移记账）→ `rows.ts`（行映射）→ `dao.ts`（同步 DAO）→
 * `governance.ts`（终态门禁 + CAS）。本文件只做再导出，不含逻辑。
 */
export type {
  MemoryKind,
  MemoryScope,
  MessageRole,
  SessionStatus,
  StatusUpdateDecision,
  TaskClaim,
  TaskStatus,
} from "./types.js";
export { SCHEMA_VERSION, SESSION_STATUSES, STATE_DB_FILENAME } from "./types.js";

export {
  BUSY_TIMEOUT_MS,
  JOURNAL_SIZE_LIMIT_BYTES,
  PRAGMA_SEQUENCE,
  SQLITE_MIN_VERSION,
  WAL_AUTOCHECKPOINT_PAGES,
  applyPragmas,
  closeDatabase,
  compareVersions,
  isSqliteVersionSupported,
  journalModeOf,
  nowSeconds,
  openDatabase,
  readSqliteVersion,
  runInTransaction,
} from "./db.js";

export {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  V1_SQL,
  V2_SQL,
  checksumOf,
  getAppliedVersions,
  migrate,
} from "./migrate.js";
export type { Migration, MigrateResult } from "./migrate.js";

export {
  DEFAULT_AUDIT_LIMIT,
  DEFAULT_MEMORY_LIMIT,
  DEFAULT_MEMORY_LIST_LIMIT,
  MAX_MEMORY_LIST_LIMIT,
  PAYLOAD_META_MAX_CHARS,
  createStateDao,
} from "./dao.js";
export type {
  AppendAuditInput,
  AppendMessageInput,
  AppendMessageResult,
  ArchiveResult,
  CreateSessionInput,
  ListMemoriesOptions,
  SearchMemoriesOptions,
  StateDao,
  TailAuditOptions,
  WriteMemoryInput,
} from "./dao.js";

export { releaseClaim, shouldApplySessionStatus, tryClaim } from "./governance.js";

export { toAuditEvent, toMemory, toMessage, toMigrationRecord, toSession } from "./rows.js";
export type {
  AuditEventRecord,
  MemoryRecord,
  MessageRecord,
  MigrationRecord,
  SessionRecord,
} from "./rows.js";
