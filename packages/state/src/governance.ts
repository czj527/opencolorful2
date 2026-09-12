/**
 * governance：治理内核（t4 §4）——终态不可降级门禁 + CAS 领取原语。
 *
 * 两个不变量（AGENTS.md 硬约束 7）：
 * - **终态不可降级**：门禁返回 `{apply:false}` 并保留原值，**不抛错、不改写**。
 * - **CAS 领取**：条件 UPDATE 即 CAS（无 SELECT-then-UPDATE），`changes != 1` 即抢输。
 *
 * 覆盖面（本次 M1-3）：`sessions.status` 只有 `active|archived`（`archived` 为终态）；
 * CAS 原语是**表无关**的（`table`/`idColumn`/`lock` 由调用方给），M2 `tasks` 表直接复用
 * ——因此本次**不往 MVP 表上加 claim 列**，独立测试表验证语义。
 */
import type { DatabaseSync } from "node:sqlite";
import { nowSeconds, runInTransaction } from "./db.js";
import { SESSION_STATUSES, type StatusUpdateDecision } from "./types.js";

const KNOWN_STATUSES: readonly string[] = SESSION_STATUSES;

/**
 * 会话状态迁移门禁（t4 §4）。
 *
 * 判定表：
 * | current | next | 结果 |
 * |---|---|---|
 * | 任意已知 | 相同值 | `apply:true`（幂等重放） |
 * | `active` | `archived` | `apply:true` |
 * | `archived` | `active` | `apply:false, reason:"terminal_immutable"`（保留原值） |
 * | 任一未知 | 任意 | `apply:false, reason:"unknown_status"`（fail-closed） |
 *
 * 形参刻意取 `string`（而非 `SessionStatus`）：未知值必须能被**归类**而不是变成类型错误，
 * 否则"非法状态悄悄写库"会绕过门禁。
 */
export function shouldApplySessionStatus(
  current: string,
  next: string,
): StatusUpdateDecision<string> {
  if (!KNOWN_STATUSES.includes(current) || !KNOWN_STATUSES.includes(next)) {
    return { apply: false, status: current, reason: "unknown_status" };
  }
  if (current === next) {
    return { apply: true, status: next };
  }
  if (current === "archived") {
    return { apply: false, status: current, reason: "terminal_immutable" };
  }
  return { apply: true, status: next };
}

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 表名/列名要拼进 SQL，只能是标识符（防注入；不是可选项）。 */
function assertIdentifier(name: string, what: string): void {
  if (!IDENTIFIER_PATTERN.test(name)) {
    throw new Error(`${what} 不是合法 SQL 标识符：${JSON.stringify(name)}`);
  }
}

/**
 * CAS 领取（抄 hermes 语义）：抢到返回 `true`，被别人抢/不存在返回 `false`。
 *
 * 目标表需要的列（M2 `tasks` 表同形状）：`<idColumn>`、`claim_lock TEXT`、
 * `claim_expires_at INTEGER`、`claimed_at INTEGER`。
 *
 * 条件 UPDATE 的三条放行路径：从未领取、claim 已释放、**claim 过期**（reclaim）。
 * 整个过程在一个 `BEGIN IMMEDIATE` 事务里，`changes == 1` 才叫抢到。
 *
 * 第 7 个形参 `now` 是可注入时钟（可选，默认当前 unix 秒）：过期/reclaim 分支因此能
 * 被确定性测试覆盖，不必去改库里的时间戳伪造"时间流逝"。
 */
export function tryClaim(
  db: DatabaseSync,
  table: string,
  idColumn: string,
  id: string,
  lock: string,
  ttlSeconds: number,
  now: number = nowSeconds(),
): boolean {
  assertIdentifier(table, "table");
  assertIdentifier(idColumn, "idColumn");
  const expiresAt = now + ttlSeconds;
  return runInTransaction(db, () => {
    const result = db
      .prepare(
        `UPDATE ${table} SET claim_lock = ?, claim_expires_at = ?, claimed_at = ?
         WHERE ${idColumn} = ?
           AND (claim_lock IS NULL OR claim_expires_at IS NULL OR claim_expires_at < ?)`,
      )
      .run(lock, expiresAt, now, id, now);
    return Number(result.changes) === 1;
  });
}

/** CAS 释放：只有持有同一 `lock` 才放得掉（`changes == 1` 才算释放成功）。 */
export function releaseClaim(
  db: DatabaseSync,
  table: string,
  idColumn: string,
  id: string,
  lock: string,
): boolean {
  assertIdentifier(table, "table");
  assertIdentifier(idColumn, "idColumn");
  return runInTransaction(db, () => {
    const result = db
      .prepare(
        `UPDATE ${table} SET claim_lock = NULL, claim_expires_at = NULL, claimed_at = NULL
         WHERE ${idColumn} = ? AND claim_lock = ?`,
      )
      .run(id, lock);
    return Number(result.changes) === 1;
  });
}
