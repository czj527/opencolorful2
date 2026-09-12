/**
 * db：SQLite 连接内核（t4 §4）——`node:sqlite` 内置驱动，零第三方依赖。
 *
 * 三条纪律（违反即打回）：
 * 1. **版本安全线**：先在同一 SQLite 库上查 `sqlite_version()`，低于 3.44.6 拒绝打开
 *    （t4 §4：上游 WAL-reset 损坏 bug；安全线三档 3.51.3+ / 3.50.7+ / 3.44.6+ 取最低值简化）。
 *    检查在**建库之前**做：不让有 bug 的 SQLite 创建出新的库文件。
 * 2. **pragma 顺序即契约**（`PRAGMA_SEQUENCE`）：busy_timeout → journal_mode=WAL →
 *    wal_autocheckpoint → journal_size_limit → synchronous=NORMAL → foreign_keys=ON。
 * 3. **拒绝非 WAL 落盘**：设置后回读 `journal_mode`，不是 `wal` 直接抛错
 *    （NFS/SMB/FUSE 上 WAL 不可靠，t4 §4）。
 */
import { DatabaseSync } from "node:sqlite";

/** WAL 安全线（t4 §4 三档最低值）。 */
export const SQLITE_MIN_VERSION = "3.44.6";
export const BUSY_TIMEOUT_MS = 5_000;
export const WAL_AUTOCHECKPOINT_PAGES = 1_000;
export const JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

/** pragma 顺序（t4 §4）：改序要先改决策文档，否则这里就是错的口径。 */
export const PRAGMA_SEQUENCE: readonly string[] = [
  `PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`,
  "PRAGMA journal_mode = WAL",
  `PRAGMA wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES}`,
  `PRAGMA journal_size_limit = ${JOURNAL_SIZE_LIMIT_BYTES}`,
  "PRAGMA synchronous = NORMAL",
  "PRAGMA foreign_keys = ON",
];

const VERSION_PATTERN = /^\d+(\.\d+)*$/;

/**
 * 比较两段点分版本号：左小返回负数、相等 0、左大正数；**非法版本号返回 `NaN`**。
 *
 * 返回 `NaN` 是刻意的：调用方（`isSqliteVersionSupported`）对 `NaN` 判否 → 校验失败即拒绝运行
 * （fail-closed，不把读不懂的版本当合格）。
 */
export function compareVersions(left: string, right: string): number {
  if (!VERSION_PATTERN.test(left) || !VERSION_PATTERN.test(right)) {
    return Number.NaN;
  }
  const a = left.split(".").map((part) => Number.parseInt(part, 10));
  const b = right.split(".").map((part) => Number.parseInt(part, 10));
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** 纯函数版本门禁：`version >= SQLITE_MIN_VERSION` 才算合格（纯函数，便于 mock 版本号测分支）。 */
export function isSqliteVersionSupported(version: string): boolean {
  return compareVersions(version, SQLITE_MIN_VERSION) >= 0;
}

/** 读当前 SQLite 库版本（`sqlite_version()`）。 */
export function readSqliteVersion(db: DatabaseSync): string {
  const row = db.prepare("SELECT sqlite_version() AS version").get() as
    | { version?: unknown }
    | undefined;
  return typeof row?.version === "string" ? row.version : "";
}

/** 读当前连接的 `journal_mode`（小写；`:memory:` 恒 `memory`）。 */
export function journalModeOf(db: DatabaseSync): string {
  const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: unknown } | undefined;
  return typeof row?.journal_mode === "string" ? row.journal_mode : "";
}

/** 统一时间戳口径：`INTEGER` unix epoch **seconds**（t4 §4）。 */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** 按 `PRAGMA_SEQUENCE` 顺序应用 pragma（开库、以及测试显式复用）。 */
export function applyPragmas(db: DatabaseSync): void {
  for (const pragma of PRAGMA_SEQUENCE) {
    db.exec(pragma);
  }
}

/**
 * 打开库：版本门禁 → 建连接 → pragma → 回读 journal_mode。
 *
 * `":memory:"` 允许（无 WAL 概念，回读为 `memory`，跳过 WAL 断言）；文件库必须是 `wal`。
 */
export function openDatabase(path: string): DatabaseSync {
  const probe = new DatabaseSync(":memory:");
  let version = "";
  try {
    version = readSqliteVersion(probe);
  } finally {
    probe.close();
  }
  if (!isSqliteVersionSupported(version)) {
    throw new Error(
      `SQLite 版本 ${version.length > 0 ? version : "未知"} 低于安全线 ${SQLITE_MIN_VERSION}，拒绝运行（t4 §4 WAL-reset 损坏 bug）`,
    );
  }

  const db = new DatabaseSync(path);
  applyPragmas(db);
  const mode = journalModeOf(db);
  if (mode !== "wal" && mode !== "memory") {
    db.close();
    throw new Error(`journal_mode=${mode}（期望 wal）：${path} 可能位于 NFS/SMB/FUSE，拒绝运行（t4 §4）`);
  }
  return db;
}

/** 关闭连接（`node:sqlite` 语义：对已关闭的连接再 close 会抛错，调用方保证一次）。 */
export function closeDatabase(db: DatabaseSync): void {
  db.close();
}

/**
 * 事务纪律（t4 §4）：规划完再 `BEGIN IMMEDIATE`，回调内**禁 `await`**（同步 API 天然契合）。
 *
 * 用 IMMEDIATE 而非 DEFERRED：领取/归档这类 CAS 必须在事务开始时就拿到写锁，
 * 避免"读后才升级锁"造成的 SQLITE_BUSY 窗口。
 */
export function runInTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 回滚失败（例如连接已坏）时不掩盖原始错误：抛原始异常即可。
    }
    throw error;
  }
}
