/**
 * state 包公开类型契约（骨架期：只有类型与常量，无实现）。
 *
 * 口径来源：`docs/decisions/t4-backend-architecture.md` §4（SQLite 状态内核 +
 * 治理内核）。本文件只冻结跨包边界；连接/pragma/迁移/DAO 由后续任务落地。
 */

/** SQLite 为唯一运行时状态存储（t2 §2-4）；DB 文件 `.sqlite` 永不进仓。 */
export const STATE_DB_FILENAME = "agentplant.sqlite";

/** 初始 schema 迁移版本；**升级需用户显式同意**（t3 §2）。 */
export const SCHEMA_VERSION = 1;

/** 会话状态（t4 §4 DDL：`sessions.status CHECK (active|archived)`）。 */
export type SessionStatus = "active" | "archived";

/**
 * 任务状态（t4 §7 M2 落 `tasks` 表；此处为跨包共享词汇，M1 不建表）。
 * 终态：`completed` / `failed` / `cancelled`。
 */
export type TaskStatus =
  | "pending"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

/** `tasks.claim_token` 三件套之一：CAS 领取的令牌（t4 §4 治理内核）。 */
export interface TaskClaim {
  readonly taskId: string;
  readonly claimToken: string;
  readonly claimedAt: number;
  readonly claimExpiresAt: number;
}

/** 状态更新判定结果：被拒绝时**保留原值、不抛错**（t4 §4）。 */
export interface StatusUpdateDecision<S extends string> {
  readonly apply: boolean;
  readonly status: S;
  readonly reason?: "terminal_immutable" | "unknown_status";
}

/** 记忆类型：MVP 只做偏好 + 事实，向量检索放二期（t2 §5-3）。 */
export type MemoryKind = "preference" | "fact";

/** 记忆作用域（t4 §4 DDL：`memories.scope CHECK (session|global)`）。 */
export type MemoryScope = "session" | "global";
