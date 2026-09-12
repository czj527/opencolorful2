/**
 * @agentplant/protocol —— 前后端共享契约的唯一来源。
 *
 * 职责：TypeBox schema（SSE 事件 / HTTP API / 工具参数）+ 由 schema 推导的 TS 类型
 * + 运行期校验辅助。运行期依赖只有 `@sinclair/typebox`，不含任何状态（t3 §1 / t4 §1）。
 *
 * 依据：design.md §2.2（HTTP+SSE 唯一接口面）、t4 §2/§3/§5/§6、t5 §4.2/§4.3/§5/§6.2。
 */
import { type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export * from "./closed-object.js";
export * from "./sse.js";
export * from "./api.js";
export * from "./tools.js";

/** 单条校验失败（`path` 是 JSON Pointer，按 `.` 连接的数组下标也是合法读法）。 */
export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

/** `validate` 的返回值：成功带收窄后的值，失败带可枚举的错误列表。 */
export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly ValidationIssue[] };

/**
 * 运行期校验：`Value.Check` 为真才把 `data` 当作 `T` 收窄返回。
 *
 * 关键点：**失败分支不返回 data**。调用方只能拿到 errors，
 * 避免"校验失败但还是把原始对象当成合法结构用下去"这类假绿。
 */
export function validate<T extends TSchema>(
  schema: T,
  data: unknown,
): ValidationResult<Static<T>> {
  if (Value.Check(schema, data)) {
    return { ok: true, value: data as Static<T> };
  }
  const errors: ValidationIssue[] = [];
  for (const error of Value.Errors(schema, data)) {
    errors.push({ path: error.path === "" ? "/" : error.path, message: error.message });
  }
  return { ok: false, errors };
}
