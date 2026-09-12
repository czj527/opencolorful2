/**
 * closedObject 语义测试：跨进程边界的对象一律拒绝多余字段（additionalProperties: false）。
 *
 * 依据：references/openclaw 的 gateway-protocol 口径 + t4 §5（工具契约为边界）。
 */
import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { closedObject } from "./closed-object.js";
import { validate } from "./index.js";
import { ChatRequestSchema, MessageSchema } from "./api.js";
import { SseDoneDataSchema } from "./sse.js";
import {
  MemoryWriteParamsSchema,
  ReadFileParamsSchema,
  TOOL_NAMES,
  TOOL_PARAM_SCHEMAS,
} from "./tools.js";

describe("closedObject", () => {
  it("声明 additionalProperties: false", () => {
    const schema = closedObject({ a: Type.String() });
    expect(schema.additionalProperties).toBe(false);
  });

  it("接受完全匹配的对象", () => {
    expect(validate(closedObject({ a: Type.String() }), { a: "x" }).ok).toBe(true);
  });

  it("拒绝多余字段", () => {
    const result = validate(closedObject({ a: Type.String() }), { a: "x", b: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("拒绝缺失必填字段", () => {
    expect(validate(closedObject({ a: Type.String() }), {}).ok).toBe(false);
  });

  it("拒绝非对象输入", () => {
    expect(validate(closedObject({ a: Type.String() }), "nope").ok).toBe(false);
  });

  it("失败分支不返回原始 data（防「校验失败但继续用下去」）", () => {
    const result = validate(closedObject({ a: Type.String() }), { a: 1 });
    expect(result.ok).toBe(false);
    expect(Object.keys(result)).toEqual(["ok", "errors"]);
  });
});

describe("边界 schema 逐一带 closed 语义", () => {
  const cases: ReadonlyArray<
    readonly [string, { additionalProperties?: unknown }, Record<string, unknown>]
  > = [
    ["SSE done", SseDoneDataSchema, { runId: "r1", finishReason: "stop", delivery: "verified" }],
    ["API chat 请求", ChatRequestSchema, { message: "hi" }],
    [
      "API message",
      MessageSchema,
      { id: "m1", sessionId: "s1", seq: 1, role: "user", createdAt: 0 },
    ],
    ["工具 read_file", ReadFileParamsSchema, { path: "a.txt" }],
    ["工具 memory_write", MemoryWriteParamsSchema, { kind: "fact", text: "t" }],
  ];

  it.each(cases)("%s 接受合法值且拒绝多余字段", (_name, schema, base) => {
    expect(validate(schema as never, base).ok).toBe(true);
    expect(validate(schema as never, { ...base, extraField: true }).ok).toBe(false);
  });

  it("7 个工具的参数 schema 都是 closed 的", () => {
    for (const name of TOOL_NAMES) {
      expect(TOOL_PARAM_SCHEMAS[name].additionalProperties).toBe(false);
    }
  });
});
