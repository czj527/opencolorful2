/**
 * migrate：schema 迁移记账 + 幂等执行（t4 §4）。
 *
 * - 账本 `schema_migrations(version, name, checksum, applied_at)`；`applied_at` 为 unix 秒。
 * - `checksum` = 迁移 SQL 的 sha256：**已记账的版本 checksum 不一致直接抛错**
 *   （说明有人改过已发布的迁移，静默继续会让两个库悄悄分叉）。
 * - 幂等：重跑不报错、不重复记账（已应用的版本进 `skipped`）。
 * - v1 = t4 §4 DDL 逐字（5 张表 + 索引 + FTS5 虚表 + 同步 triggers）。
 * - v2 = `sessions.status` 终态（`archived`）禁回退触发器（DB 层第二道防线）。
 *   **追加**而非改动 v1：已发布迁移一个字符都不能动（checksum 会拦，见 v1 测试）。
 *   schema 升版需用户显式同意（t3 §2）：本次 `SCHEMA_VERSION` 1 → 2 属**待确认**变更。
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { nowSeconds, runInTransaction } from "./db.js";
import { toMigrationRecord, type MigrationRecord } from "./rows.js";
import { SCHEMA_VERSION } from "./types.js";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export interface MigrateResult {
  /** 本次真正执行并记账的版本（升序）。 */
  readonly applied: readonly number[];
  /** 已在账本中、本次跳过的版本（升序）。 */
  readonly skipped: readonly number[];
}

const SCHEMA_MIGRATIONS_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY, name TEXT NOT NULL,
  checksum TEXT, applied_at INTEGER NOT NULL);`;

const SESSIONS_SQL = `CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, title TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','archived')),
  model TEXT, provider TEXT, cwd TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER,
  metadata TEXT);
CREATE INDEX IF NOT EXISTS idx_sessions_status_updated ON sessions(status, updated_at DESC);`;

const MESSAGES_SQL = `CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
  content TEXT, tool_name TEXT, tool_call_id TEXT,
  token_in INTEGER, token_out INTEGER, created_at INTEGER NOT NULL,
  UNIQUE (session_id, seq));
CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);`;

const MEMORIES_SQL = `CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  scope TEXT NOT NULL CHECK (scope IN ('session','global')),
  kind TEXT NOT NULL, content TEXT NOT NULL,
  source_msg_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  confidence REAL, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, expires_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_memories_scope_kind ON memories(scope, kind);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, content='memories', content_rowid='rowid', tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;`;

const AUDIT_SQL = `CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
  session_id TEXT, run_id TEXT,
  kind TEXT NOT NULL, actor TEXT, subject_id TEXT,
  status TEXT, error_code TEXT, duration_ms INTEGER,
  bytes_in INTEGER, bytes_out INTEGER, payload_meta TEXT,
  CHECK (length(COALESCE(payload_meta,'')) <= 2048));
CREATE INDEX IF NOT EXISTS idx_audit_session_ts ON audit_events(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_audit_run ON audit_events(run_id, id);`;

/** v1 迁移 SQL：t4 §4 DDL 逐字（按表切分成片段再拼，避免两处 e.g. 账本表）重复维护。 */
export const V1_SQL: string = [
  SCHEMA_MIGRATIONS_SQL,
  SESSIONS_SQL,
  MESSAGES_SQL,
  MEMORIES_SQL,
  AUDIT_SQL,
].join("\n\n");

/**
 * v2 迁移 SQL：`sessions.status` 终态（`archived`）在 **DB 层**禁回退（t4 §4「终态不可降级」）。
 *
 * 语义（三条都必须是确定的）：
 * - 原始 SQL 把 `archived` 行改回非 `archived` → **抛错**（`RAISE(ABORT)`），行保持 `archived`；
 *   选显式报错而不是 `RAISE(IGNORE)` 的静默 `changes()=0`：**有人在回退却没人知道**比报错危险。
 * - 正常归档 `active → archived`：`WHEN` 子句不成立，不受影响。
 * - 同值 `archived → archived`：`WHEN` 子句同样不成立（幂等重放不是回退）。
 *
 * 应用层门禁 `shouldApplySessionStatus` 仍是第一道防线（DAO 走它）；本触发器是第二道——
 * 绕过 DAO 直接写库的路径（脚本 / 回放 / 未来新模块）也会被拦下。
 */
export const V2_SQL: string = `CREATE TRIGGER IF NOT EXISTS sessions_no_status_regression
BEFORE UPDATE OF status ON sessions
WHEN OLD.status = 'archived' AND NEW.status != 'archived'
BEGIN
  SELECT RAISE(ABORT, 'terminal status immutable: archived cannot regress');
END;`;

/** 迁移表：只追加，已发布的条目**不得修改**（checksum 会拦）。 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "init_state_kernel", sql: V1_SQL },
  { version: 2, name: "sessions_terminal_guard", sql: V2_SQL },
];

/** 代码里声明的最新 schema 版本（必须等于最后一个迁移的版本）。 */
export const LATEST_SCHEMA_VERSION = SCHEMA_VERSION;

/** 迁移 SQL 的 sha256（十六进制）。 */
export function checksumOf(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

/** 账本是否存在（未迁移过的库没有该表；显式判而不是 try/catch 挡错）。 */
function hasLedger(db: DatabaseSync): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  return row !== undefined;
}

/** 已应用的迁移记录（升序）；从未迁移过则返回 `[]`。 */
export function getAppliedVersions(db: DatabaseSync): MigrationRecord[] {
  if (!hasLedger(db)) {
    return [];
  }
  const rows = db
    .prepare("SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version")
    .all();
  return rows.map((row) => toMigrationRecord(row));
}

/**
 * 幂等执行迁移（默认执行 `MIGRATIONS`）；每个版本一个 `BEGIN IMMEDIATE` 事务。
 *
 * @throws 已记账版本的 checksum 与当前 SQL 不一致时抛错（拒绝静默分叉）。
 */
export function migrate(
  db: DatabaseSync,
  migrations: readonly Migration[] = MIGRATIONS,
): MigrateResult {
  db.exec(SCHEMA_MIGRATIONS_SQL);
  const known = new Map<number, MigrationRecord>();
  for (const record of getAppliedVersions(db)) {
    known.set(record.version, record);
  }

  const applied: number[] = [];
  const skipped: number[] = [];
  const ordered = [...migrations].sort((left, right) => left.version - right.version);

  for (const migration of ordered) {
    const checksum = checksumOf(migration.sql);
    const record = known.get(migration.version);
    if (record !== undefined) {
      if (record.checksum !== null && record.checksum !== checksum) {
        throw new Error(
          `迁移 v${migration.version}（${migration.name}）的 checksum 与账本不一致：账本 ${record.checksum} / 当前 ${checksum}`,
        );
      }
      skipped.push(migration.version);
      continue;
    }
    runInTransaction(db, () => {
      db.exec(migration.sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
      ).run(migration.version, migration.name, checksum, nowSeconds());
    });
    applied.push(migration.version);
  }

  return { applied, skipped };
}
