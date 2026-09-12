/**
 * protocol/closed-object：TypeBox `closedObject` 语义（additionalProperties: false）。
 *
 * 抄 `references/openclaw/packages/gateway-protocol/src/schema/closed-object.ts`：
 * 所有跨进程边界（SSE / HTTP API / 工具参数）的对象一律 closed —— 多传字段即校验失败，
 * 避免"前端塞了个后端不认识的值、后端静默忽略"这类静默漂移。
 *
 * 依据：docs/decisions/t4-backend-architecture.md §5（工具契约）
 *      + design.md §2.2（前后端只走这一套面）。
 */
import { Type, type TProperties } from "@sinclair/typebox";

/** 构造 `additionalProperties: false` 的 object schema。 */
export function closedObject<Properties extends TProperties>(properties: Properties) {
  return Type.Object(properties, { additionalProperties: false });
}
