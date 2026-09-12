/**
 * dao：5 张表的同步数据访问层（t4 §4）。
 *
 * 纪律：
 * - **全同步**：`node:sqlite` 是同步 API，事务回调里不允许出现 `await`（这里也不导出任何 Promise）。
 * - **时间戳一律 unix 秒**：写库用 `nowSeconds()`，读库经 `rows.ts` 原样透传。
 * - **幂等由库保证**：`messages` 靠 `UNIQUE(session_id, seq)` + `INSERT OR IGNORE`；
 *   归档靠条件 UPDATE（CAS）；删记忆靠硬删（未知 id 返回 `false`，不抛错）。
 * - **FTS5 同步走 triggers**：`memories` 的增删改由 DDL 里的触发器同步到 `memories_fts`，
 *   DAO 不手写 FTS 维护语句（两处维护必然分叉）。
 * - **审计只记元数据**：`payloadMeta` 超 2048 字符**直接抛错**，绝不截断
 *   （截断 = 静默丢审计，比报错危险得多）。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { nowSeconds } from "./db.js";
import { shouldApplySessionStatus } from "./governance.js";
import {
  int,
  toAuditEvent,
  toMemory,
  toMessage,
  toSession,
  type AuditEventRecord,
  type MemoryRecord,
  type MessageRecord,
  type SessionRecord,
} from "./rows.js";
import type { MemoryKind, MemoryScope, MessageRole, SessionStatus } from "./types.js";

/** `audit_events.payload_meta` 上限（与 DDL 的 CHECK 同值）：超限抛错，不截断。 */
export const PAYLOAD_META_MAX_CHARS = 2048;

export interface CreateSessionInput {
  readonly id?: string;
  readonly title?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly cwd?: string;
  readonly metadata?: string;
  /** 测试/回放用显式时间戳（unix 秒）；缺省取当前时间。 */
  readonly createdAt?: number;
}

export interface ArchiveResult {
  readonly archived: boolean;
  /**
   * `not_found`：库里没有这个 id；`unknown_status`：库里状态不在词表内（fail-closed）。
   *
   * 没有 `terminal_immutable`：本方法只会请求 `archived`，而 `archived → archived` 是
   * 幂等放行；"终态不可降级"的拒绝分支发生在 `shouldApplySessionStatus`（archived → active），
   * 本包**不提供** unarchive，所以这里不可能被触发。
   */
  readonly reason?: "not_found" | "unknown_status";
}

export interface AppendMessageInput {
  readonly id?: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly role: MessageRole;
  readonly content?: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly tokenIn?: number;
  readonly tokenOut?: number;
  readonly createdAt?: number;
}

export interface AppendMessageResult {
  /** `false` = 该 `(sessionId, seq)` 已存在（幂等重放，不是错误）。 */
  readonly inserted: boolean;
  readonly id: string;
}

export interface WriteMemoryInput {
  readonly id?: string;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly sessionId?: string;
  /** 缺省：有 `sessionId` → `session`，否则 `global`（t4 §4）。 */
  readonly scope?: MemoryScope;
  readonly sourceMsgId?: string;
  readonly confidence?: number;
  readonly expiresAt?: number;
}

export interface SearchMemoriesOptions {
  readonly scope?: MemoryScope;
  readonly kind?: MemoryKind;
  readonly limit?: number;
}

/**
 * `listMemories` 的入参（M1-9 ①）。
 *
 * `scope`/`kind` 是等值过滤；`limit`/`offset` 是分页窗口。与 `searchMemories` 的差别是
 * **没有关键词**：这是"浏览器"口径（`created_at` 倒序），不是检索口径（FTS 相关性）。
 */
export interface ListMemoriesOptions {
  readonly scope?: MemoryScope;
  readonly kind?: MemoryKind;
  readonly limit?: number;
  readonly offset?: number;
}

/** `listMemories` 的默认条数（不传 limit 时）。 */
export const DEFAULT_MEMORY_LIST_LIMIT = 50;
/** `listMemories` 的条数硬上限：调用方给多大都按此截断（防止一次拉全库进内存）。 */
export const MAX_MEMORY_LIST_LIMIT = 200;

export interface AppendAuditInput {
  readonly sessionId?: string;
  readonly runId?: string;
  readonly kind: string;
  readonly actor?: string;
  readonly subjectId?: string;
  readonly status?: string;
  readonly errorCode?: string;
  readonly durationMs?: number;
  readonly bytesIn?: number;
  readonly bytesOut?: number;
  readonly payloadMeta?: string;
  /** 测试/回放用显式时间戳（unix 秒）；缺省取当前时间。 */
  readonly ts?: number;
}

export interface TailAuditOptions {
  readonly afterId?: number;
  readonly sessionId?: string;
  readonly limit?: number;
}

/** 默认检索条数上限（防止把整库记忆拉进一次上下文）。 */
export const DEFAULT_MEMORY_LIMIT = 20;
/** 默认审计 tail 条数上限。 */
export const DEFAULT_AUDIT_LIMIT = 50;

export interface StateDao {
  createSession(input?: CreateSessionInput): SessionRecord;
  getSession(id: string): SessionRecord | null;
  listSessions(status?: SessionStatus): SessionRecord[];
  /** 归档 = 终态迁移；已 `archived` 再归档是**幂等成功**；本包不提供 unarchive（没有就是语义）。 */
  archiveSession(id: string): ArchiveResult;

  /** 追加消息；`(sessionId, seq)` 唯一，重放返回 `{inserted:false}`。 */
  appendMessage(input: AppendMessageInput): AppendMessageResult;
  /** 按 `seq` 升序；`since` 是水位（返回 `seq > since` 的消息）。 */
  listMessages(sessionId: string, since?: number): MessageRecord[];

  writeMemory(input: WriteMemoryInput): MemoryRecord;
  /** FTS5 `MATCH` 检索；空/纯空白 query 返回 `[]`（不抛错）。 */
  searchMemories(query: string, options?: SearchMemoriesOptions): MemoryRecord[];
  /**
   * `created_at` 倒序浏览（M1-9 ①）；`limit` 缺省 50、上限 200，`offset` 负数按 0 处理。
   * 与 `searchMemories` 同一张表，只是没有 FTS 命中条件。
   */
  listMemories(options?: ListMemoriesOptions): MemoryRecord[];
  /**
   * 过滤条件下的**全量**条数（忽略 `limit`/`offset`）：分页响应里的 `total` 由它给出，
   * 不许用 `items.length` 冒充（那在第二页起就会撒谎）。
   */
  countMemories(options?: Omit<ListMemoriesOptions, "limit" | "offset">): number;
  /** 硬删 + FTS 同步（触发器）；未知 id 返回 `false`，不抛错。 */
  forgetMemory(id: string): boolean;

  appendAudit(input: AppendAuditInput): AuditEventRecord;
  /** 按 `id` 升序的游标 tail（`afterId` 不含本身）。 */
  tailAudit(options?: TailAuditOptions): AuditEventRecord[];
}

/** FTS5 查询串：整体加引号做短语查询（用户输入里的 `"`/`*` 因此不可能变成语法错误）。 */
function toFtsPhrase(query: string): string {
  return `"${query.replace(/"/g, '""')}"*`;
}

function clampLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return fallback;
  }
  return Math.floor(limit);
}

/** 列表条数：缺省 50，向上不超过硬上限 200（`limit` 是"最多给多少"，不是"必须给多少"）。 */
function clampListLimit(limit: number | undefined): number {
  return Math.min(clampLimit(limit, DEFAULT_MEMORY_LIST_LIMIT), MAX_MEMORY_LIST_LIMIT);
}

/** 分页偏移：缺省/负数/非有限值一律归 0（OFFSET 负数在 SQLite 里是**未定义行为**，不能透传）。 */
function clampOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset) || offset <= 0) {
    return 0;
  }
  return Math.floor(offset);
}

/**
 * 记忆过滤条件 → `WHERE` 片段 + 绑定参数（`listMemories` 与 `countMemories` **共用**）。
 *
 * 两处各写一遍条件，就等于给"分页总数和分页条目对不上"留了一条路（条件漂移时
 * `total` 会说谎，而 UI 只会显示一个看起来正常的数字）。
 */
function memoryFilter(options: { scope?: MemoryScope; kind?: MemoryKind }): {
  where: string;
  params: (string | number)[];
} {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (options.scope !== undefined) {
    conditions.push("scope = ?");
    params.push(options.scope);
  }
  if (options.kind !== undefined) {
    conditions.push("kind = ?");
    params.push(options.kind);
  }
  return { where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "", params };
}

/** `memories` 的列清单（与 `getMemory` 一字不差；两处漂移会让 `listMemories` 少列）。 */
const MEMORY_COLUMNS =
  "id, session_id, scope, kind, content, source_msg_id, confidence, created_at, updated_at, expires_at";

/** 绑定 `createStateDao(db)` 后使用；DAO 不持有连接生命周期的所有权（谁开谁关）。 */
export function createStateDao(db: DatabaseSync): StateDao {
  function getSession(id: string): SessionRecord | null {
    const row = db
      .prepare(
        `SELECT id, title, status, model, provider, cwd, created_at, updated_at, archived_at, metadata
         FROM sessions WHERE id = ?`,
      )
      .get(id);
    return row === undefined ? null : toSession(row);
  }

  function requireSession(id: string): SessionRecord {
    const session = getSession(id);
    if (session === null) {
      throw new Error(`会话不存在：${id}`);
    }
    return session;
  }

  function getMemory(id: string): MemoryRecord {
    const row = db
      .prepare(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE id = ?`)
      .get(id);
    return toMemory(row);
  }

  return {
    createSession(input = {}) {
      const id = input.id ?? randomUUID();
      const now = input.createdAt ?? nowSeconds();
      db.prepare(
        `INSERT INTO sessions (id, title, status, model, provider, cwd, created_at, updated_at, archived_at, metadata)
         VALUES (?, ?, 'active', ?, ?, ?, ?, ?, NULL, ?)`,
      ).run(
        id,
        input.title ?? null,
        input.model ?? null,
        input.provider ?? null,
        input.cwd ?? null,
        now,
        now,
        input.metadata ?? null,
      );
      return requireSession(id);
    },

    getSession,

    listSessions(status) {
      const rows =
        status === undefined
          ? db
              .prepare(
                `SELECT id, title, status, model, provider, cwd, created_at, updated_at, archived_at, metadata
                 FROM sessions ORDER BY updated_at DESC, id ASC`,
              )
              .all()
          : db
              .prepare(
                `SELECT id, title, status, model, provider, cwd, created_at, updated_at, archived_at, metadata
                 FROM sessions WHERE status = ? ORDER BY updated_at DESC, id ASC`,
              )
              .all(status);
      return rows.map((row) => toSession(row));
    },

    archiveSession(id) {
      const current = getSession(id);
      if (current === null) {
        return { archived: false, reason: "not_found" };
      }
      const decision = shouldApplySessionStatus(current.status, "archived");
      if (!decision.apply) {
        // next 恒为 archived，故此处只可能是 unknown_status（库状态不在词表内 → fail-closed）。
        return { archived: false, reason: "unknown_status" };
      }
      const now = nowSeconds();
      // CAS：只有 'active' 才迁移；并发下别人先归档则 changes=0 → 幂等成功（终态不可回退）。
      // 第二道防线在**库层**：v2 迁移的 `sessions_no_status_regression` 触发器会让任何
      // `archived → 非 archived` 的写入抛错（本语句只写 'archived'，故永不触发）。
      // 刻意**不** catch 触发器错误：真被拦下说明有人在回退终态，必须显式失败（静默吞掉=假绿）。
      db.prepare(
        `UPDATE sessions SET status = 'archived', archived_at = ?, updated_at = ?
         WHERE id = ? AND status = 'active'`,
      ).run(now, now, id);
      return { archived: true };
    },

    appendMessage(input) {
      const id = input.id ?? randomUUID();
      const result = db
        .prepare(
          `INSERT OR IGNORE INTO messages
             (id, session_id, seq, role, content, tool_name, tool_call_id, token_in, token_out, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.sessionId,
          input.seq,
          input.role,
          input.content ?? null,
          input.toolName ?? null,
          input.toolCallId ?? null,
          input.tokenIn ?? null,
          input.tokenOut ?? null,
          input.createdAt ?? nowSeconds(),
        );
      return { inserted: Number(result.changes) === 1, id };
    },

    listMessages(sessionId, since) {
      const rows =
        since === undefined
          ? db
              .prepare(
                `SELECT id, session_id, seq, role, content, tool_name, tool_call_id, token_in, token_out, created_at
                 FROM messages WHERE session_id = ? ORDER BY seq ASC`,
              )
              .all(sessionId)
          : db
              .prepare(
                `SELECT id, session_id, seq, role, content, tool_name, tool_call_id, token_in, token_out, created_at
                 FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq ASC`,
              )
              .all(sessionId, since);
      return rows.map((row) => toMessage(row));
    },

    writeMemory(input) {
      const id = input.id ?? randomUUID();
      const now = nowSeconds();
      const scope: MemoryScope = input.scope ?? (input.sessionId === undefined ? "global" : "session");
      db.prepare(
        `INSERT INTO memories
           (id, session_id, scope, kind, content, source_msg_id, confidence, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.sessionId ?? null,
        scope,
        input.kind,
        input.content,
        input.sourceMsgId ?? null,
        input.confidence ?? null,
        now,
        now,
        input.expiresAt ?? null,
      );
      // 写回读：返回库里真实落定的行（含触发器/FTS 之后的最终值），不返回"我以为写进去的值"。
      return getMemory(id);
    },
    searchMemories(query, options = {}) {
      if (query.trim().length === 0) {
        return [];
      }
      const conditions: string[] = ["memories_fts MATCH ?"];
      const params: (string | number)[] = [toFtsPhrase(query)];
      if (options.scope !== undefined) {
        conditions.push("m.scope = ?");
        params.push(options.scope);
      }
      if (options.kind !== undefined) {
        conditions.push("m.kind = ?");
        params.push(options.kind);
      }
      params.push(clampLimit(options.limit, DEFAULT_MEMORY_LIMIT));
      const rows = db
        .prepare(
          `SELECT m.id, m.session_id, m.scope, m.kind, m.content, m.source_msg_id,
                  m.confidence, m.created_at, m.updated_at, m.expires_at
           FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
           WHERE ${conditions.join(" AND ")}
           ORDER BY m.created_at DESC, m.id ASC
           LIMIT ?`,
        )
        .all(...params);
      return rows.map((row) => toMemory(row));
    },

    listMemories(options = {}) {
      const { where, params } = memoryFilter(options);
      const rows = db
        .prepare(
          `SELECT ${MEMORY_COLUMNS} FROM memories ${where}
           ORDER BY created_at DESC, id ASC
           LIMIT ? OFFSET ?`,
        )
        .all(...params, clampListLimit(options.limit), clampOffset(options.offset));
      return rows.map((row) => toMemory(row));
    },

    countMemories(options = {}) {
      const { where, params } = memoryFilter(options);
      const row = db.prepare(`SELECT COUNT(*) AS total FROM memories ${where}`).get(...params);
      // 计数读不回来就是库出了问题：`int()` 直接抛错，不把 0 当成"没有记忆"报出去。
      return int((row as Record<string, unknown> | undefined)?.total, "COUNT(*)");
    },

    forgetMemory(id) {
      const result = db.prepare("DELETE FROM memories WHERE id = ?").run(id);
      return Number(result.changes) === 1;
    },

    appendAudit(input) {
      const payloadMeta = input.payloadMeta ?? null;
      if (payloadMeta !== null && payloadMeta.length > PAYLOAD_META_MAX_CHARS) {
        throw new Error(
          `payloadMeta 超过 ${PAYLOAD_META_MAX_CHARS} 字符（${payloadMeta.length}）：审计正文不截断，请只传元数据（t4 §4）`,
        );
      }
      const result = db
        .prepare(
          `INSERT INTO audit_events
             (ts, session_id, run_id, kind, actor, subject_id, status, error_code,
              duration_ms, bytes_in, bytes_out, payload_meta)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.ts ?? nowSeconds(),
          input.sessionId ?? null,
          input.runId ?? null,
          input.kind,
          input.actor ?? null,
          input.subjectId ?? null,
          input.status ?? null,
          input.errorCode ?? null,
          input.durationMs ?? null,
          input.bytesIn ?? null,
          input.bytesOut ?? null,
          payloadMeta,
        );
      const row = db
        .prepare(
          `SELECT id, ts, session_id, run_id, kind, actor, subject_id, status, error_code,
                  duration_ms, bytes_in, bytes_out, payload_meta
           FROM audit_events WHERE id = ?`,
        )
        .get(Number(result.lastInsertRowid));
      return toAuditEvent(row);
    },

    tailAudit(options = {}) {
      const conditions: string[] = [];
      const params: (string | number)[] = [];
      if (options.afterId !== undefined) {
        conditions.push("id > ?");
        params.push(options.afterId);
      }
      if (options.sessionId !== undefined) {
        conditions.push("session_id = ?");
        params.push(options.sessionId);
      }
      params.push(clampLimit(options.limit, DEFAULT_AUDIT_LIMIT));
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const rows = db
        .prepare(
          `SELECT id, ts, session_id, run_id, kind, actor, subject_id, status, error_code,
                  duration_ms, bytes_in, bytes_out, payload_meta
           FROM audit_events ${where} ORDER BY id ASC LIMIT ?`,
        )
        .all(...params);
      return rows.map((row) => toAuditEvent(row));
    },
  };
}
