/**
 * rows：库行（snake_case）→ TS 记录（camelCase）映射。
 *
 * 所有时间戳都是 `INTEGER` unix epoch **seconds**（t4 §4）；`*_at`/`ts` → `*At`/`ts` 数值直传，
 * 不要在这里做毫秒换算（口径一旦在这里分叉，全仓就再也对不上）。
 *
 * 映射用运行时守卫（`typeof` 判定）而不是 `as`：库里的 NULL 与 JS `undefined` 不同，
 * 让"缺列/类型不符"当场抛错，好过把 `undefined` 混进上层判断。
 */
import type { MemoryKind, MemoryScope, MessageRole, SessionStatus } from "./types.js";

export interface SessionRecord {
  readonly id: string;
  readonly title: string | null;
  readonly status: SessionStatus;
  readonly model: string | null;
  readonly provider: string | null;
  readonly cwd: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archivedAt: number | null;
  readonly metadata: string | null;
}

export interface MessageRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly role: MessageRole;
  readonly content: string | null;
  readonly toolName: string | null;
  readonly toolCallId: string | null;
  readonly tokenIn: number | null;
  readonly tokenOut: number | null;
  readonly createdAt: number;
}

export interface MemoryRecord {
  readonly id: string;
  readonly sessionId: string | null;
  readonly scope: MemoryScope;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly sourceMsgId: string | null;
  readonly confidence: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number | null;
}

export interface AuditEventRecord {
  readonly id: number;
  readonly ts: number;
  readonly sessionId: string | null;
  readonly runId: string | null;
  readonly kind: string;
  readonly actor: string | null;
  readonly subjectId: string | null;
  readonly status: string | null;
  readonly errorCode: string | null;
  readonly durationMs: number | null;
  readonly bytesIn: number | null;
  readonly bytesOut: number | null;
  readonly payloadMeta: string | null;
}

export interface MigrationRecord {
  readonly version: number;
  readonly name: string;
  readonly checksum: string | null;
  readonly appliedAt: number;
}

function rec(row: unknown): Record<string, unknown> {
  return (row as Record<string, unknown> | undefined) ?? {};
}

function asText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asInt(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/** 必填 TEXT：不符即抛（库结构或写入路径出问题时不静默降级）。 */
export function text(value: unknown, field: string): string {
  const parsed = asText(value);
  if (parsed === null) {
    throw new Error(`state 行字段 ${field} 期望 TEXT，实际 ${typeof value}`);
  }
  return parsed;
}

/** 必填 INTEGER：不符即抛。 */
export function int(value: unknown, field: string): number {
  const parsed = asInt(value);
  if (parsed === null) {
    throw new Error(`state 行字段 ${field} 期望 INTEGER，实际 ${typeof value}`);
  }
  return parsed;
}

export { asInt, asText };

export function toSession(row: unknown): SessionRecord {
  const r = rec(row);
  return {
    id: text(r.id, "sessions.id"),
    title: asText(r.title),
    status: text(r.status, "sessions.status") as SessionStatus,
    model: asText(r.model),
    provider: asText(r.provider),
    cwd: asText(r.cwd),
    createdAt: int(r.created_at, "sessions.created_at"),
    updatedAt: int(r.updated_at, "sessions.updated_at"),
    archivedAt: asInt(r.archived_at),
    metadata: asText(r.metadata),
  };
}

export function toMessage(row: unknown): MessageRecord {
  const r = rec(row);
  return {
    id: text(r.id, "messages.id"),
    sessionId: text(r.session_id, "messages.session_id"),
    seq: int(r.seq, "messages.seq"),
    role: text(r.role, "messages.role") as MessageRole,
    content: asText(r.content),
    toolName: asText(r.tool_name),
    toolCallId: asText(r.tool_call_id),
    tokenIn: asInt(r.token_in),
    tokenOut: asInt(r.token_out),
    createdAt: int(r.created_at, "messages.created_at"),
  };
}

export function toMemory(row: unknown): MemoryRecord {
  const r = rec(row);
  return {
    id: text(r.id, "memories.id"),
    sessionId: asText(r.session_id),
    scope: text(r.scope, "memories.scope") as MemoryScope,
    kind: text(r.kind, "memories.kind") as MemoryKind,
    content: text(r.content, "memories.content"),
    sourceMsgId: asText(r.source_msg_id),
    confidence: asInt(r.confidence),
    createdAt: int(r.created_at, "memories.created_at"),
    updatedAt: int(r.updated_at, "memories.updated_at"),
    expiresAt: asInt(r.expires_at),
  };
}

export function toAuditEvent(row: unknown): AuditEventRecord {
  const r = rec(row);
  return {
    id: int(r.id, "audit_events.id"),
    ts: int(r.ts, "audit_events.ts"),
    sessionId: asText(r.session_id),
    runId: asText(r.run_id),
    kind: text(r.kind, "audit_events.kind"),
    actor: asText(r.actor),
    subjectId: asText(r.subject_id),
    status: asText(r.status),
    errorCode: asText(r.error_code),
    durationMs: asInt(r.duration_ms),
    bytesIn: asInt(r.bytes_in),
    bytesOut: asInt(r.bytes_out),
    payloadMeta: asText(r.payload_meta),
  };
}

export function toMigrationRecord(row: unknown): MigrationRecord {
  const r = rec(row);
  return {
    version: int(r.version, "schema_migrations.version"),
    name: text(r.name, "schema_migrations.name"),
    checksum: asText(r.checksum),
    appliedAt: int(r.applied_at, "schema_migrations.applied_at"),
  };
}
