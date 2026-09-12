/**
 * protocol/sse：SSE 事件契约（8 种事件名 + 结束帧）。
 *
 * 形状对齐 `docs/decisions/t4-backend-architecture.md` §2：
 * 事件名 `start / token / thinking / tool_call / tool_result / usage / error / done`，
 * 结束帧 `data: [DONE]`，响应头固定 text/event-stream + no-cache + keep-alive。
 *
 * `done.delivery` + `done.evidence` 是 t5 §5/§4.2 的契约（「进度文本 ≠ 交付」）：
 * 前端只消费后端**显式给出**的 delivery，缺失时渲染「未提供交付状态」，
 * 因此本 schema 把 `delivery` 定为 **required**——后端不许留空（t4 §4 不变量四）。
 */
import { Type, type Static } from "@sinclair/typebox";
import { closedObject } from "./closed-object.js";

/** SSE 结束帧原文（前端据此收流；EventSource 不会收到它，由 fetch 流解析器识别）。 */
export const SSE_DONE_FRAME = "data: [DONE]";

/** SSE 响应头（t4 §2：no-cache + keep-alive，且调用方需 flushHeaders）。 */
export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

/** 本次 run 的结束原因（t4 §2 + t5 §5：error/aborted 都不得渲染成成功）。 */
export const SSE_FINISH_REASONS = ["stop", "tool_calls", "aborted", "error"] as const;

/** 交付判定三态（t5 §4.2；`unknown` 是显式取值，不是"缺失"）。 */
export const TURN_DELIVERIES = ["claimed", "verified", "unknown"] as const;

/** 交付证据：核验型交付必须给出可复核的工具调用凭据（t5 §5「依据 <工具>×N」）。 */
export const DeliveryEvidenceSchema = closedObject({
  toolName: Type.String({ minLength: 1 }),
  count: Type.Integer({ minimum: 0 }),
  toolCallIds: Type.Array(Type.String({ minLength: 1 })),
});

/** `event: start` —— 一次 run 开始。 */
export const SseStartDataSchema = closedObject({
  runId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
});

/** `event: token` —— 正文增量。 */
export const SseTokenDataSchema = closedObject({
  deltaText: Type.String(),
});

/** `event: thinking` —— 思考增量（UI 折叠展示，不进模型上下文）。 */
export const SseThinkingDataSchema = closedObject({
  deltaText: Type.String(),
});

/** `event: tool_call` —— 工具调用发起；`args` 由各工具参数 schema 各自校验。 */
export const SseToolCallDataSchema = closedObject({
  callId: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  args: Type.Unknown(),
});

/** `event: tool_result` —— 工具调用结束；`ok=false` 时 summary 为人话失败原因。 */
export const SseToolResultDataSchema = closedObject({
  callId: Type.String({ minLength: 1 }),
  ok: Type.Boolean(),
  summary: Type.String(),
  details: Type.Optional(Type.Unknown()),
});

/** `event: usage` —— token 计费增量（provider 常给小数，故用 Number 而非 Integer）。 */
export const SseUsageDataSchema = closedObject({
  promptTokens: Type.Number({ minimum: 0 }),
  completionTokens: Type.Number({ minimum: 0 }),
});

/** `event: error` —— 终止性错误；`code` 与 HTTP 错误形（ApiError.code）同口径。 */
export const SseErrorDataSchema = closedObject({
  code: Type.String({ minLength: 1 }),
  message: Type.String(),
});

/** `event: done` —— 终态；delivery/evidence 供前端 DeliveryBadge 消费（t5 §5）。 */
export const SseDoneDataSchema = closedObject({
  runId: Type.String({ minLength: 1 }),
  finishReason: Type.Union(SSE_FINISH_REASONS.map((reason) => Type.Literal(reason))),
  delivery: Type.Union(TURN_DELIVERIES.map((delivery) => Type.Literal(delivery))),
  evidence: Type.Optional(DeliveryEvidenceSchema),
  message: Type.Optional(Type.String()),
});

export type SseStartData = Static<typeof SseStartDataSchema>;
export type SseTokenData = Static<typeof SseTokenDataSchema>;
export type SseThinkingData = Static<typeof SseThinkingDataSchema>;
export type SseToolCallData = Static<typeof SseToolCallDataSchema>;
export type SseToolResultData = Static<typeof SseToolResultDataSchema>;
export type SseUsageData = Static<typeof SseUsageDataSchema>;
export type SseErrorData = Static<typeof SseErrorDataSchema>;
export type SseDoneData = Static<typeof SseDoneDataSchema>;
export type DeliveryEvidence = Static<typeof DeliveryEvidenceSchema>;

export type SseFinishReason = (typeof SSE_FINISH_REASONS)[number];
export type TurnDelivery = (typeof TURN_DELIVERIES)[number];

/**
 * 事件名 → data schema 的对照表。
 *
 * 结构上必须是「按 event 区分的 discriminated union」：每条分支带 `event` literal，
 * 消费方先按 `event` 收窄再解析 `data`。此处用映射表固化配对关系，
 * 避免 8 个 schema 与 8 个事件名各写一遍而漂移。
 */
export const SSE_EVENT_DATA_SCHEMAS = {
  start: SseStartDataSchema,
  token: SseTokenDataSchema,
  thinking: SseThinkingDataSchema,
  tool_call: SseToolCallDataSchema,
  tool_result: SseToolResultDataSchema,
  usage: SseUsageDataSchema,
  error: SseErrorDataSchema,
  done: SseDoneDataSchema,
} as const;

/** SSE 事件名（8 种，顺序与 t4 §2 一致）。 */
export const SSE_EVENT_NAMES = [
  "start",
  "token",
  "thinking",
  "tool_call",
  "tool_result",
  "usage",
  "error",
  "done",
] as const;

export type SseEventName = (typeof SSE_EVENT_NAMES)[number];

/** 单条 SSE 事件：`event` 为判别键，`data` 与事件名一一对应。 */
export type SseEvent = {
  [Name in SseEventName]: {
    readonly event: Name;
    readonly data: Static<(typeof SSE_EVENT_DATA_SCHEMAS)[Name]>;
  };
}[SseEventName];

/** 把事件名 + data 组装成完整事件（供后端统一构造、前端测试造样本）。 */
export function sseEvent<Name extends SseEventName>(
  event: Name,
  data: Static<(typeof SSE_EVENT_DATA_SCHEMAS)[Name]>,
): SseEvent {
  return { event, data } as SseEvent;
}

/**
 * 序列化为 wire 格式：`event: <name>\ndata: <json>\n\n`。
 *
 * JSON 内的换行由 JSON.stringify 转义，故单行 `data:` 合法（SSE 规范：多行 data
 * 需多行 `data:` 前缀；这里不产生多行，也就不需要）。
 */
export function encodeSseEvent(event: SseEventName, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
