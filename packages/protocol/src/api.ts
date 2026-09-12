/**
 * protocol/api：HTTP 端点请求/响应契约（前缀 `/api`）。
 *
 * 形状对齐 `docs/decisions/t4-backend-architecture.md` §3 端点表；
 * `delivery`/`evidence` 沿用 t5 §4.2/§5 的交付判定三态（前端 DeliveryBadge 消费）。
 *
 * 端点在实现期从 t4 §3 的 /api/memory 单端点细化为 memory / memory/search / memory(list)
 * 四个形状，但字段口径不变（kind/text/sessionId、id 删除、检索条目带来源溯源）；
 * M1-9 再补上 `chat/confirm`（就地确认）与 `GET /api/memory` 列表分页。
 * 时间戳一律 `INTEGER` unix epoch seconds（t4 §4），故用 `Type.Integer`。
 * 所有对象 closed（见 closed-object.ts）。
 */
import { Type, type Static } from "@sinclair/typebox";
import { closedObject } from "./closed-object.js";

/** 交付判定三态（与 sse.ts 的 TURN_DELIVERIES 同口径，t5 §4.2）。 */
export const API_TURN_DELIVERIES = ["claimed", "verified", "unknown"] as const;

/** 会话消息角色（与 t4 §4 `messages.role` CHECK 约束一致）。 */
export const MESSAGE_ROLES = ["system", "user", "assistant", "tool"] as const;

/** 记忆种类（用户拍板：偏好 + 事实）。 */
export const API_MEMORY_KINDS = ["preference", "fact"] as const;

/** 记忆作用域（与 t4 §4 的 `memories.scope CHECK (session|global)` 一致）。 */
export const API_MEMORY_SCOPES = ["session", "global"] as const;

/** 沙箱模式（t4 §6：workspace-only 是**约定级**约束，非安全边界）。 */
export const SANDBOX_MODES = ["workspace-only", "unrestricted"] as const;

/** 统一错误形：所有非 2xx 响应体都是它，`details` 由各路由自定。 */
export const ApiErrorSchema = closedObject({
  code: Type.String({ minLength: 1 }),
  message: Type.String(),
  details: Type.Optional(Type.Unknown()),
});

/** `POST /api/chat` 请求体（无 `Accept: text/event-stream` 时走非流式响应）。 */
export const ChatRequestSchema = closedObject({
  sessionId: Type.Optional(Type.String({ minLength: 1 })),
  message: Type.String(),
  attachments: Type.Optional(Type.Array(Type.Unknown())),
});

/** `POST /api/chat` 非流式响应体。 */
export const ChatResponseSchema = closedObject({
  runId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  reply: Type.String(),
  delivery: Type.Union(API_TURN_DELIVERIES.map((delivery) => Type.Literal(delivery))),
  evidence: Type.Optional(
    closedObject({
      toolName: Type.String({ minLength: 1 }),
      count: Type.Integer({ minimum: 0 }),
      toolCallIds: Type.Array(Type.String({ minLength: 1 })),
    }),
  ),
});

/** `POST /api/chat/abort` 请求体。 */
export const ChatAbortRequestSchema = closedObject({
  runId: Type.String({ minLength: 1 }),
});

/** `POST /api/chat/abort` 响应体；`aborted=false` 表示该 run 已终态（不是错误）。 */
export const ChatAbortResponseSchema = closedObject({
  aborted: Type.Boolean(),
});

/**
 * `POST /api/chat/confirm` 请求体（M1-9 就地确认协议）。
 *
 * `toolCallId` 来自本回合的 `tool_call` 事件（挂起时**没有**配对的 `tool_result`，
 * 这就是前端判定"待确认卡片"的依据，ia §4.4）。
 */
export const ChatConfirmRequestSchema = closedObject({
  runId: Type.String({ minLength: 1 }),
  toolCallId: Type.String({ minLength: 1 }),
  decision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
});

/**
 * `POST /api/chat/confirm` 响应体。
 *
 * `confirmed` = 决策已生效（落在审计与消息表上）；`executed` = 工具是否真的跑了
 * （`deny` 恒为 `false`）。`ok`/`summary` 只在 `executed=true` 时出现，语义与
 * `tool_result` 事件的同名字段一致（同一个执行出口）。
 */
export const ChatConfirmResponseSchema = closedObject({
  confirmed: Type.Boolean(),
  executed: Type.Boolean(),
  ok: Type.Optional(Type.Boolean()),
  summary: Type.Optional(Type.String()),
});

/** 会话摘要（`GET /api/sessions` 列表项）。 */
export const SessionSummarySchema = closedObject({
  id: Type.String({ minLength: 1 }),
  title: Type.String(),
  updatedAt: Type.Integer({ minimum: 0 }),
  messageCount: Type.Integer({ minimum: 0 }),
});

/** `GET /api/sessions` 响应体。 */
export const SessionListResponseSchema = closedObject({
  sessions: Type.Array(SessionSummarySchema),
});

/** `POST /api/sessions` 请求体；title 省略时由后端取首条消息截断生成。 */
export const SessionCreateRequestSchema = closedObject({
  title: Type.Optional(Type.String()),
});

/** `POST /api/sessions` 响应体。 */
export const SessionCreateResponseSchema = closedObject({
  id: Type.String({ minLength: 1 }),
  title: Type.String(),
  createdAt: Type.Integer({ minimum: 0 }),
});

/** 历史消息（与 t4 §4 `messages` 表列对应；工具消息带 toolName/toolCallId）。 */
export const MessageSchema = closedObject({
  id: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  seq: Type.Integer({ minimum: 0 }),
  role: Type.Union(MESSAGE_ROLES.map((role) => Type.Literal(role))),
  content: Type.Optional(Type.String()),
  toolName: Type.Optional(Type.String()),
  toolCallId: Type.Optional(Type.String()),
  createdAt: Type.Integer({ minimum: 0 }),
});

/** `GET /api/sessions/:id/messages` query（`since` = 增量拉取的 seq 水位）。 */
export const MessagesQuerySchema = closedObject({
  since: Type.Optional(Type.Integer({ minimum: 0 })),
});

/** `GET /api/sessions/:id/messages` 响应体。 */
export const MessagesResponseSchema = closedObject({
  messages: Type.Array(MessageSchema),
});

/** `POST /api/memory` 请求体（写记忆；`sessionId` 缺省 = 全局作用域）。 */
export const MemoryWriteRequestSchema = closedObject({
  kind: Type.Union(API_MEMORY_KINDS.map((kind) => Type.Literal(kind))),
  text: Type.String({ minLength: 1 }),
  sessionId: Type.Optional(Type.String({ minLength: 1 })),
});

/** `POST /api/memory` 响应体。 */
export const MemoryWriteResponseSchema = closedObject({
  id: Type.String({ minLength: 1 }),
});

/** `GET /api/memory/search` query（FTS5 检索）。 */
export const MemorySearchQuerySchema = closedObject({
  q: Type.String({ minLength: 1 }),
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
});

/** 检索条目：带来源溯源，供 UI 回答"你从哪知道的"（t5 §4.2）。 */
export const MemoryItemSchema = closedObject({
  id: Type.String({ minLength: 1 }),
  kind: Type.Union(API_MEMORY_KINDS.map((kind) => Type.Literal(kind))),
  text: Type.String(),
  createdAt: Type.Integer({ minimum: 0 }),
  sourceSessionId: Type.Optional(Type.String()),
  sourceMessageId: Type.Optional(Type.String()),
});

/** `GET /api/memory/search` 响应体。 */
export const MemorySearchResponseSchema = closedObject({
  items: Type.Array(MemoryItemSchema),
});

/**
 * `GET /api/memory` query（列表分页；`limit` 上限 200 由 state 层的 clamp 兜底）。
 *
 * 与 `GET /api/memory/search` 的区别是**口径**而非形状：search 走 FTS5 命中排序，
 * list 是 `created_at` 倒序的全量浏览（无关键词）。
 */
export const MemoryListQuerySchema = closedObject({
  scope: Type.Optional(Type.Union(API_MEMORY_SCOPES.map((scope) => Type.Literal(scope)))),
  kind: Type.Optional(Type.Union(API_MEMORY_KINDS.map((kind) => Type.Literal(kind)))),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
});

/**
 * `GET /api/memory` 响应体。
 *
 * `total` 是**过滤条件下的全量条数**（不受 `limit`/`offset` 影响）：前端据它渲染
 * "共 N 条 / 还有多少没加载"，用 `items.length` 冒充 total 会在分页时撒谎。
 */
export const MemoryListResponseSchema = closedObject({
  items: Type.Array(MemoryItemSchema),
  total: Type.Integer({ minimum: 0 }),
});

/**
 * `DELETE /api/memory` 请求体。
 *
 * `id` 与 `query` 至少给一个（都不给等于"删库"，必须由调用方明示意图）；
 * 该约束由路由在运行时校验——JSON Schema 的 anyOf 会让 provider 侧工具 schema
 * 兼容性变差，故不写进 schema，而在 handler 里显式判。
 */
export const MemoryDeleteRequestSchema = closedObject({
  id: Type.Optional(Type.String({ minLength: 1 })),
  query: Type.Optional(Type.String({ minLength: 1 })),
});

/** `DELETE /api/memory` 响应体：返回被删 id（空数组 = 没命中，不是错误）。 */
export const MemoryDeleteResponseSchema = closedObject({
  deleted: Type.Array(Type.String({ minLength: 1 })),
});

/** `GET /api/health` 响应体（t4 §3）。 */
export const HealthResponseSchema = closedObject({
  ok: Type.Boolean(),
  version: Type.String({ minLength: 1 }),
  workspaceRoot: Type.String({ minLength: 1 }),
  sandboxMode: Type.Union(SANDBOX_MODES.map((mode) => Type.Literal(mode))),
});

export type ApiError = Static<typeof ApiErrorSchema>;
export type ChatRequest = Static<typeof ChatRequestSchema>;
export type ChatResponse = Static<typeof ChatResponseSchema>;
export type ChatAbortRequest = Static<typeof ChatAbortRequestSchema>;
export type ChatAbortResponse = Static<typeof ChatAbortResponseSchema>;
export type ChatConfirmRequest = Static<typeof ChatConfirmRequestSchema>;
export type ChatConfirmResponse = Static<typeof ChatConfirmResponseSchema>;
export type SessionSummary = Static<typeof SessionSummarySchema>;
export type SessionListResponse = Static<typeof SessionListResponseSchema>;
export type SessionCreateRequest = Static<typeof SessionCreateRequestSchema>;
export type SessionCreateResponse = Static<typeof SessionCreateResponseSchema>;
export type Message = Static<typeof MessageSchema>;
export type MessagesQuery = Static<typeof MessagesQuerySchema>;
export type MessagesResponse = Static<typeof MessagesResponseSchema>;
export type MemoryWriteRequest = Static<typeof MemoryWriteRequestSchema>;
export type MemoryWriteResponse = Static<typeof MemoryWriteResponseSchema>;
export type MemorySearchQuery = Static<typeof MemorySearchQuerySchema>;
export type MemoryItem = Static<typeof MemoryItemSchema>;
export type MemorySearchResponse = Static<typeof MemorySearchResponseSchema>;
export type MemoryListQuery = Static<typeof MemoryListQuerySchema>;
export type MemoryListResponse = Static<typeof MemoryListResponseSchema>;
export type MemoryDeleteRequest = Static<typeof MemoryDeleteRequestSchema>;
export type MemoryDeleteResponse = Static<typeof MemoryDeleteResponseSchema>;
export type HealthResponse = Static<typeof HealthResponseSchema>;

export type MessageRole = (typeof MESSAGE_ROLES)[number];
export type ApiMemoryKind = (typeof API_MEMORY_KINDS)[number];
export type ApiMemoryScope = (typeof API_MEMORY_SCOPES)[number];
export type SandboxMode = (typeof SANDBOX_MODES)[number];

/** 端点契约表：路由注册与前端 client 共用一份（路径键便于双端对照）。 */
export const API_ENDPOINTS = {
  chat: "POST /api/chat",
  chatAbort: "POST /api/chat/abort",
  chatConfirm: "POST /api/chat/confirm",
  sessionList: "GET /api/sessions",
  sessionCreate: "POST /api/sessions",
  sessionMessages: "GET /api/sessions/:id/messages",
  memoryList: "GET /api/memory",
  memoryWrite: "POST /api/memory",
  memorySearch: "GET /api/memory/search",
  memoryDelete: "DELETE /api/memory",
  health: "GET /api/health",
} as const;
