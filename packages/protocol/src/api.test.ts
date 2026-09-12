/**
 * API 契约测试：端点表 / 请求响应形状 / 判别字段（role、kind、sandboxMode）/
 * 统一错误形 ApiError / delivery 与 SSE 同口径。
 *
 * 依据：t4 §3（端点表）、t4 §4（messages 列与 role CHECK）、t5 §4.2（delivery）。
 */
import { describe, expect, it } from "vitest";
import { validate } from "./index.js";
import {
  API_ENDPOINTS,
  API_MEMORY_KINDS,
  ApiErrorSchema,
  ChatAbortRequestSchema,
  ChatAbortResponseSchema,
  ChatConfirmRequestSchema,
  ChatConfirmResponseSchema,
  ChatRequestSchema,
  ChatResponseSchema,
  HealthResponseSchema,
  MESSAGE_ROLES,
  MemoryDeleteRequestSchema,
  MemoryDeleteResponseSchema,
  MemoryItemSchema,
  MemoryListQuerySchema,
  MemoryListResponseSchema,
  MemorySearchQuerySchema,
  MemorySearchResponseSchema,
  MemoryWriteRequestSchema,
  MemoryWriteResponseSchema,
  MessageSchema,
  MessagesQuerySchema,
  MessagesResponseSchema,
  SANDBOX_MODES,
  SessionCreateRequestSchema,
  SessionCreateResponseSchema,
  SessionListResponseSchema,
  SessionSummarySchema,
} from "./api.js";

describe("端点表", () => {
  it("覆盖 t4 §3 的 9 条路径 + 方法（M1-9 增补 list / confirm 两条）", () => {
    expect(Object.values(API_ENDPOINTS)).toEqual([
      "POST /api/chat",
      "POST /api/chat/abort",
      "POST /api/chat/confirm",
      "GET /api/sessions",
      "POST /api/sessions",
      "GET /api/sessions/:id/messages",
      "GET /api/memory",
      "POST /api/memory",
      "GET /api/memory/search",
      "DELETE /api/memory",
      "GET /api/health",
    ]);
  });
});

describe("chat", () => {
  it("请求体只要求 message（sessionId / attachments 可选）", () => {
    expect(validate(ChatRequestSchema, { message: "你好" }).ok).toBe(true);
    expect(
      validate(ChatRequestSchema, { sessionId: "s1", message: "你好", attachments: [] }).ok,
    ).toBe(true);
    expect(validate(ChatRequestSchema, { sessionId: "s1" }).ok).toBe(false);
    expect(ChatRequestSchema.required).toEqual(["message"]);
  });

  it("非流式响应带 delivery（必填）与可选 evidence", () => {
    const base = { runId: "r1", sessionId: "s1", reply: "ok", delivery: "verified" };
    expect(validate(ChatResponseSchema, base).ok).toBe(true);
    expect(
      validate(ChatResponseSchema, {
        ...base,
        evidence: { toolName: "read_file", count: 2, toolCallIds: ["c1", "c2"] },
      }).ok,
    ).toBe(true);
    expect(validate(ChatResponseSchema, { runId: "r1", sessionId: "s1", reply: "ok" }).ok).toBe(
      false,
    );
    expect(validate(ChatResponseSchema, { ...base, delivery: "ok" }).ok).toBe(false);
  });

  it("abort 请求 / 响应", () => {
    expect(validate(ChatAbortRequestSchema, { runId: "r1" }).ok).toBe(true);
    expect(validate(ChatAbortRequestSchema, {}).ok).toBe(false);
    expect(validate(ChatAbortResponseSchema, { aborted: false }).ok).toBe(true);
    expect(validate(ChatAbortResponseSchema, { aborted: "yes" }).ok).toBe(false);
  });

  it("confirm 请求：decision 只接受 allow/deny，三个字段都必填", () => {
    expect(
      validate(ChatConfirmRequestSchema, { runId: "r1", toolCallId: "c1", decision: "allow" }).ok,
    ).toBe(true);
    expect(
      validate(ChatConfirmRequestSchema, { runId: "r1", toolCallId: "c1", decision: "deny" }).ok,
    ).toBe(true);
    expect(
      validate(ChatConfirmRequestSchema, { runId: "r1", toolCallId: "c1", decision: "always" }).ok,
    ).toBe(false);
    expect(validate(ChatConfirmRequestSchema, { runId: "r1", decision: "allow" }).ok).toBe(false);
    expect(
      validate(ChatConfirmRequestSchema, {
        runId: "r1",
        toolCallId: "c1",
        decision: "allow",
        extra: 1,
      }).ok,
    ).toBe(false);
  });

  it("confirm 响应：ok/summary 只在执行时出现，但出现时必须是合法类型", () => {
    expect(validate(ChatConfirmResponseSchema, { confirmed: true, executed: false }).ok).toBe(true);
    expect(
      validate(ChatConfirmResponseSchema, {
        confirmed: true,
        executed: true,
        ok: true,
        summary: "exitCode=0",
      }).ok,
    ).toBe(true);
    expect(validate(ChatConfirmResponseSchema, { confirmed: true }).ok).toBe(false);
    expect(
      validate(ChatConfirmResponseSchema, { confirmed: true, executed: true, ok: "yes" }).ok,
    ).toBe(false);
  });
});

describe("sessions / messages", () => {
  it("会话摘要形状（含 messageCount）", () => {
    const summary = { id: "s1", title: "新会话", updatedAt: 1_760_000_000, messageCount: 0 };
    expect(validate(SessionSummarySchema, summary).ok).toBe(true);
    expect(validate(SessionListResponseSchema, { sessions: [summary] }).ok).toBe(true);
    expect(validate(SessionListResponseSchema, { sessions: [{ ...summary, messageCount: -1 }] }).ok).toBe(
      false,
    );
  });

  it("新建会话：title 可选，响应带 createdAt", () => {
    expect(validate(SessionCreateRequestSchema, {}).ok).toBe(true);
    expect(validate(SessionCreateRequestSchema, { title: "t" }).ok).toBe(true);
    expect(
      validate(SessionCreateResponseSchema, { id: "s1", title: "t", createdAt: 1 }).ok,
    ).toBe(true);
  });

  it("Message 的 role 只接受 system/user/assistant/tool", () => {
    expect(MESSAGE_ROLES).toEqual(["system", "user", "assistant", "tool"]);
    for (const role of MESSAGE_ROLES) {
      expect(
        validate(MessageSchema, { id: "m", sessionId: "s", seq: 0, role, createdAt: 0 }).ok,
      ).toBe(true);
    }
    expect(
      validate(MessageSchema, { id: "m", sessionId: "s", seq: 0, role: "developer", createdAt: 0 })
        .ok,
    ).toBe(false);
  });

  it("Message 的工具字段可选（tool 角色才带）", () => {
    expect(
      validate(MessageSchema, {
        id: "m",
        sessionId: "s",
        seq: 3,
        role: "tool",
        content: "3 行",
        toolName: "read_file",
        toolCallId: "c1",
        createdAt: 0,
      }).ok,
    ).toBe(true);
    expect(
      validate(MessageSchema, {
        id: "m",
        sessionId: "s",
        seq: 3,
        role: "tool",
        toolName: "read_file",
        createdAt: 0,
      }).ok,
    ).toBe(true);
  });

  it("历史查询 since 可选且 >= 0", () => {
    const query = { since: 5 };
    expect(validate(MessagesQuerySchema, query).ok).toBe(true);
    expect(validate(MessagesQuerySchema, { since: -1 }).ok).toBe(false);
    expect(validate(MessagesResponseSchema, { messages: [] }).ok).toBe(true);
  });
});

describe("memory", () => {
  it("写入：kind 二选一，text 必填，sessionId 可选", () => {
    expect(API_MEMORY_KINDS).toEqual(["preference", "fact"]);
    expect(validate(MemoryWriteRequestSchema, { kind: "preference", text: "爱喝美式" }).ok).toBe(
      true,
    );
    expect(
      validate(MemoryWriteRequestSchema, { kind: "fact", text: "在杭州", sessionId: "s1" }).ok,
    ).toBe(true);
    expect(validate(MemoryWriteRequestSchema, { kind: "other", text: "x" }).ok).toBe(false);
    expect(validate(MemoryWriteResponseSchema, { id: "mem1" }).ok).toBe(true);
  });

  it("检索：q 必填、limit 可选；条目带来源溯源", () => {
    expect(validate(MemorySearchQuerySchema, { q: "咖啡" }).ok).toBe(true);
    expect(validate(MemorySearchQuerySchema, { q: "咖啡", limit: 3 }).ok).toBe(true);
    expect(validate(MemorySearchQuerySchema, { limit: 3 }).ok).toBe(false);
    const item = {
      id: "mem1",
      kind: "fact",
      text: "在杭州",
      createdAt: 1,
      sourceSessionId: "s1",
      sourceMessageId: "m1",
    };
    expect(validate(MemoryItemSchema, item).ok).toBe(true);
    expect(validate(MemorySearchResponseSchema, { items: [item] }).ok).toBe(true);
    expect(validate(MemoryItemSchema, { ...item, sourceSessionId: 1 }).ok).toBe(false);
  });

  it("列表：scope/kind/limit/offset 全可选，limit 有 1..200 硬边界", () => {
    expect(validate(MemoryListQuerySchema, {}).ok).toBe(true);
    expect(validate(MemoryListQuerySchema, { scope: "global", kind: "fact" }).ok).toBe(true);
    expect(validate(MemoryListQuerySchema, { scope: "everywhere" }).ok).toBe(false);
    expect(validate(MemoryListQuerySchema, { limit: 200, offset: 0 }).ok).toBe(true);
    expect(validate(MemoryListQuerySchema, { limit: 201 }).ok).toBe(false);
    expect(validate(MemoryListQuerySchema, { limit: 0 }).ok).toBe(false);
    expect(validate(MemoryListQuerySchema, { offset: -1 }).ok).toBe(false);
  });

  it("列表响应：total 必填（与 items 长度解耦，分页不许用 items.length 冒充）", () => {
    const item = { id: "mem1", kind: "fact", text: "在杭州", createdAt: 1 };
    expect(validate(MemoryListResponseSchema, { items: [item], total: 7 }).ok).toBe(true);
    expect(validate(MemoryListResponseSchema, { items: [], total: 0 }).ok).toBe(true);
    expect(validate(MemoryListResponseSchema, { items: [item] }).ok).toBe(false);
    expect(validate(MemoryListResponseSchema, { items: [], total: -1 }).ok).toBe(false);
  });

  it("删除：id / query 均可选（至少其一的约束由路由显式判，不在 schema 里）", () => {
    expect(validate(MemoryDeleteRequestSchema, {}).ok).toBe(true);
    expect(validate(MemoryDeleteRequestSchema, { id: "mem1" }).ok).toBe(true);
    expect(validate(MemoryDeleteRequestSchema, { query: "咖啡" }).ok).toBe(true);
    expect(validate(MemoryDeleteRequestSchema, { id: 1 }).ok).toBe(false);
    expect(validate(MemoryDeleteResponseSchema, { deleted: [] }).ok).toBe(true);
    expect(validate(MemoryDeleteResponseSchema, { deleted: ["mem1"] }).ok).toBe(true);
  });
});

describe("health 与统一错误形", () => {
  it("health 四字段 + sandboxMode 取值集合", () => {
    expect(SANDBOX_MODES).toEqual(["workspace-only", "unrestricted"]);
    expect(
      validate(HealthResponseSchema, {
        ok: true,
        version: "2026.9.1",
        workspaceRoot: "D:\\ws",
        sandboxMode: "workspace-only",
      }).ok,
    ).toBe(true);
    expect(
      validate(HealthResponseSchema, {
        ok: true,
        version: "v",
        workspaceRoot: "/ws",
        sandboxMode: "none",
      }).ok,
    ).toBe(false);
  });

  it("ApiError：code/message 必填、details 可选、closed", () => {
    expect(validate(ApiErrorSchema, { code: "not_found", message: "会话不存在" }).ok).toBe(true);
    expect(
      validate(ApiErrorSchema, { code: "bad_request", message: "参数错", details: { field: "q" } })
        .ok,
    ).toBe(true);
    expect(validate(ApiErrorSchema, { message: "缺 code" }).ok).toBe(false);
    expect(
      validate(ApiErrorSchema, { code: "x", message: "y", extra: true }).ok,
    ).toBe(false);
  });
});
