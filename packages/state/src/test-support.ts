/**
 * test-support：真实 SQLite 文件的测试脚手架（**测试专用，不进产品路径**）。
 *
 * 纪律（AGENTS.md 硬约束 1）：
 * - 测试库一律建在 `os.tmpdir()` 的临时目录里，`cleanup()` 删目录 → 仓内永不留 `*.sqlite`。
 * - 用**真实文件**（不是 `:memory:`）：WAL / 单文件 / 迁移落盘这些验收点只有在真有文件时才算数。
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { closeDatabase, openDatabase } from "./db.js";
import { migrate } from "./migrate.js";

export interface TempStateDb {
  readonly dir: string;
  readonly path: string;
  readonly db: DatabaseSync;
  /** 目录内文件清单（升序），用于"单文件"断言。 */
  files(): string[];
  cleanup(): void;
}

/** 建一个临时目录 + 真实库文件；默认已跑完迁移（`migrate:false` 可跳过）。 */
export function createTempStateDb(options: { migrate?: boolean } = {}): TempStateDb {
  const dir = mkdtempSync(join(tmpdir(), "agentplant-state-test-"));
  const path = join(dir, "agentplant.sqlite");
  const db = openDatabase(path);
  if (options.migrate !== false) {
    migrate(db);
  }
  return {
    dir,
    path,
    db,
    files: () => readdirSync(dir).sort(),
    cleanup: () => {
      closeDatabase(db);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
