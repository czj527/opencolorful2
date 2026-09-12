/**
 * db 测试：连接内核（真实文件库 + 纯函数分支）。
 *
 * 覆盖：journal_mode 实为 wal、单文件落盘、pragma 取值、`:memory:` 例外、
 * 版本安全线纯函数（mock 版本号分支）、非法版本号 fail-closed。
 */
import type { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BUSY_TIMEOUT_MS,
  JOURNAL_SIZE_LIMIT_BYTES,
  SQLITE_MIN_VERSION,
  WAL_AUTOCHECKPOINT_PAGES,
  closeDatabase,
  compareVersions,
  isSqliteVersionSupported,
  journalModeOf,
  openDatabase,
  readSqliteVersion,
} from "./index.js";
import { createTempStateDb } from "./test-support.js";

/** 取 `PRAGMA <name>` 的第一列值（不硬编码各 pragma 的列名）。 */
function pragmaValue(db: DatabaseSync, name: string): unknown {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  return row === undefined ? undefined : Object.values(row)[0];
}

describe("openDatabase（真实文件库）", () => {
  it("journal_mode 实为 wal，且 sqlite_version() 不低于安全线", () => {
    const temp = createTempStateDb();
    try {
      expect(journalModeOf(temp.db)).toBe("wal");
      const version = readSqliteVersion(temp.db);
      expect(version).toMatch(/^\d+\.\d+/);
      expect(isSqliteVersionSupported(version)).toBe(true);
      expect(compareVersions(version, SQLITE_MIN_VERSION)).toBeGreaterThanOrEqual(0);
    } finally {
      temp.cleanup();
    }
  });

  it("单文件：目录内只有一个 *.sqlite（-wal/-shm 只是伴随文件，不是第二个库）", () => {
    const temp = createTempStateDb();
    try {
      const files = temp.files();
      const sqliteFiles = files.filter((name) => name.endsWith(".sqlite"));
      expect(sqliteFiles).toEqual(["agentplant.sqlite"]);
      expect(files.filter((name) => name.endsWith(".db"))).toEqual([]);
      // 伴随文件必须是同一个库的（WAL 的 -wal/-shm），不是别的库。
      for (const name of files) {
        expect(name === "agentplant.sqlite" || name.startsWith("agentplant.sqlite-")).toBe(true);
      }
    } finally {
      const dir = temp.dir;
      temp.cleanup();
      expect(existsSync(dir)).toBe(false);
    }
  });

  it("pragma 落定且为 t4 §4 的顺序取值", () => {
    const temp = createTempStateDb();
    try {
      expect(pragmaValue(temp.db, "busy_timeout")).toBe(BUSY_TIMEOUT_MS);
      expect(pragmaValue(temp.db, "synchronous")).toBe(1); // NORMAL
      expect(pragmaValue(temp.db, "foreign_keys")).toBe(1);
      expect(pragmaValue(temp.db, "wal_autocheckpoint")).toBe(WAL_AUTOCHECKPOINT_PAGES);
      expect(pragmaValue(temp.db, "journal_size_limit")).toBe(JOURNAL_SIZE_LIMIT_BYTES);
    } finally {
      temp.cleanup();
    }
  });

  it("`:memory:` 允许打开，但 journal_mode 是 memory（无 WAL 概念，不误判为失败）", () => {
    const db = openDatabase(":memory:");
    try {
      expect(journalModeOf(db)).toBe("memory");
    } finally {
      closeDatabase(db);
    }
  });
});

describe("版本安全线（纯函数，mock 版本号分支）", () => {
  it("低于三档最低值 3.44.6 → 拒绝", () => {
    expect(isSqliteVersionSupported("3.44.5")).toBe(false);
    expect(isSqliteVersionSupported("3.44")).toBe(false);
    expect(isSqliteVersionSupported("3.4.99")).toBe(false);
  });

  it("等于或高于安全线 → 放行（含三档安全线本身）", () => {
    expect(isSqliteVersionSupported("3.44.6")).toBe(true);
    expect(isSqliteVersionSupported("3.45.0")).toBe(true);
    expect(isSqliteVersionSupported("3.50.7")).toBe(true);
    expect(isSqliteVersionSupported("3.51.3")).toBe(true);
    expect(isSqliteVersionSupported("4.0")).toBe(true);
  });

  it("读不懂的版本号 fail-closed（NaN → 拒绝，并恒不等于 0）", () => {
    expect(compareVersions("3.44.6-beta", "3.44.6")).toBeNaN();
    expect(compareVersions("", "3.44.6")).toBeNaN();
    expect(compareVersions("abc", "3.44.6")).toBeNaN();
    expect(isSqliteVersionSupported("3.44.6-beta")).toBe(false);
    expect(isSqliteVersionSupported("")).toBe(false);
  });

  it("段数不等时按缺位补 0 比较", () => {
    expect(compareVersions("3.44.6", "3.44")).toBe(1);
    expect(compareVersions("3.44.6", "3.44.6.0")).toBe(0);
  });
});
