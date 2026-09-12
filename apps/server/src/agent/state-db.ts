/**
 * agent/state-db：SQLite 状态库的进程级单例（t4 §4）。
 *
 * 三条纪律：
 * 1. **默认落在用户主目录**（`~/.agentplant/agentplant.sqlite`），**不在仓内**：
 *    `*.sqlite` 永不进仓（AGENTS.md 硬约束 1）。父目录自动 `mkdir -p`。
 * 2. **测试注入**：`STATE_DB_PATH` 指向 tmpdir 时按该路径开库；测试进程里不开默认库
 *    （否则跑一次测试就在用户主目录留一个真实库）。
 * 3. **单例复用**：同一路径只开一次连接（`node:sqlite` 是同步 API，多连接写同一 WAL 文件
 *    只会自己跟自己抢锁）。测试用 `closeStateDatabasesForTest()` 清干净。
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { closeDatabase, createStateDao, migrate, openDatabase, type StateDao } from "@agentplant/state";

/** 覆盖 DB 路径的 env 名（未设置时用 `defaultStateDbPath()`）。 */
export const STATE_DB_PATH_ENV = "STATE_DB_PATH";

export interface StateDbHandle {
  readonly path: string;
  readonly db: DatabaseSync;
  readonly dao: StateDao;
}

const handles = new Map<string, StateDbHandle>();

/** 默认库路径：`~/.agentplant/agentplant.sqlite`（**不进仓**；单机默认位置）。 */
export function defaultStateDbPath(): string {
  return join(homedir(), ".agentplant", "agentplant.sqlite");
}

/** 本进程是否有显式的 DB 路径覆盖（测试据此判断"不许碰默认库"）。 */
export function hasStateDbOverride(env: NodeJS.ProcessEnv = process.env): boolean {
  const override = (env[STATE_DB_PATH_ENV] ?? "").trim();
  return override.length > 0;
}

/**
 * 解析本次要用的库路径：`STATE_DB_PATH` 优先，否则默认路径；相对路径按 cwd 解析。
 *
 * `injectPath` 供测试/调用方直接传路径（优先级最高），避免为测试去改进程 env。
 */
export function resolveStateDbPath(
  injectPath?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = injectPath?.trim() ?? "";
  if (explicit.length > 0) {
    return resolve(explicit);
  }
  const fromEnv = (env[STATE_DB_PATH_ENV] ?? "").trim();
  if (fromEnv.length > 0) {
    return resolve(fromEnv);
  }
  return defaultStateDbPath();
}

/**
 * 打开（或复用）状态库并跑迁移。
 *
 * 已开过的路径直接返回同一个 handle；新路径则 `mkdir -p` 父目录 → `openDatabase`
 * （SQLite 版本门禁 + WAL 断言）→ `migrate`（幂等）。
 */
export function openStateDatabase(injectPath?: string, env: NodeJS.ProcessEnv = process.env): StateDbHandle {
  const path = resolveStateDbPath(injectPath, env);
  const cached = handles.get(path);
  if (cached !== undefined) {
    return cached;
  }
  mkdirSync(dirname(path), { recursive: true });
  const db = openDatabase(path);
  migrate(db);
  const handle: StateDbHandle = { path, db, dao: createStateDao(db) };
  handles.set(path, handle);
  return handle;
}

/** 仅测试用：关闭并清空所有已打开的状态库（避免用例之间串味、避免残留句柄）。 */
export function closeStateDatabasesForTest(): void {
  for (const handle of handles.values()) {
    try {
      closeDatabase(handle.db);
    } catch {
      // 已关闭的连接再 close 会抛错；测试清理不该因此判负（真实错误在业务路径上已暴露）。
    }
  }
  handles.clear();
}
