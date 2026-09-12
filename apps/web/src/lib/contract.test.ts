/**
 * 协议一致性测试（**前端对线上形状的理解 == 协议层 schema**）。
 *
 * 这是本包唯一 import `@agentplant/protocol` **值**的地方（见 lib/protocol.ts 头注：
 * 生产模块只用 `import type`，产物才可能是纯相对导入的 ESM）。因此本文件也是被
 * `scripts/build.mjs` 守卫①"产物不得出现裸包名"约束的边界——**运行期校验只允许活在测试里**。
 *
 * 用协议层的真 `validate()` 断言：
 *   - 前端 `SSE_EVENT_NAMES` 与协议层逐项同序；
 *   - 前端 `SSE_DONE_FRAME` 与协议层同值；
 *   - 前端消费的 done / error / tool_result / HTTP 响应样本都能过协议 schema（字段名没抄错）；
 *   - "缺失 delivery"的诚实分支**不可能**由协议层产出（协议把 delivery 定为必填）。
 */
import { describe, expect, it } from "vitest";
import {
  validate,
  ApiErrorSchema,
  ChatResponseSchema,
  HealthResponseSchema,
  MemoryDeleteResponseSchema,
  MemoryItemSchema,
  MemorySearchResponseSchema,
  MessageSchema,
  MessagesResponseSchema,
  SSE_DONE_FRAME,
  SSE_EVENT_NAMES,
  SessionListResponseSchema,
  SessionSummarySchema,
  SseDoneDataSchema,
  SseErrorDataSchema,
  SseStartDataSchema,
  SseThinkingDataSchema,
  SseTokenDataSchema,
  SseToolCallDataSchema,
  SseToolResultDataSchema,
  SseUsageDataSchema,
  TASK_STATUSES,
  TOOL_STATUSES,
  TURN_DELIVERIES,
} from "@agentplant/protocol";

import { SSE_DONE_FRAME as WEB_DONE_FRAME, SSE_EVENT_NAMES as WEB_EVENT_NAMES } from "./protocol.js";

/** 用协议 schema 校验样本；失败时把 issues 交回，便于断言失败信息可读。 */
function protocolCheck(schema: Parameters<typeof validate>[0], sample: unknown): string {
  const result = validate(schema, sample);
  return result.ok ? "ok" : result.errors.map((error) => `${error.path} ${error.message}`).join("; ");
}

describe("协议对齐（@agentplant/protocol 实值校验）", () => {
  it("8 个事件名与协议层同值同序", () => {
    expect([...WEB_EVENT_NAMES]).toEqual([...SSE_EVENT_NAMES]);
  });

  it("结束帧原文与协议层同值", () => {
    expect(WEB_DONE_FRAME).toBe(SSE_DONE_FRAME);
  });

  it("done 样本（三态 delivery + evidence）过协议 schema", () => {
    for (const delivery of TURN_DELIVERIES) {
      const detail = protocolCheck(SseDoneDataSchema, {
        runId: "r1",
        finishReason: "stop",
        delivery,
        evidence: { toolName: "run_command", count: 1, toolCallIds: ["c1"] },
      });
      expect(detail).toBe("ok");
    }
  });

  it("done 缺少 delivery 时**协议层直接拒绝**（前端因此永远收不到「无 delivery」的 done）", () => {
    expect(protocolCheck(SseDoneDataSchema, { runId: "r1", finishReason: "stop" })).not.toBe("ok");
  });

  it("start/token/thinking/tool_call/tool_result/usage/error 样本逐条过 schema", () => {
    const samples: readonly [Parameters<typeof validate>[0], unknown, string][] = [
      [SseStartDataSchema, { runId: "r1", sessionId: "s1" }, "start"],
      [SseTokenDataSchema, { deltaText: "hi" }, "token"],
      [SseThinkingDataSchema, { deltaText: "hmm" }, "thinking"],
      [SseToolCallDataSchema, { callId: "c1", name: "read_file", args: { path: "a.md" } }, "tool_call"],
      [SseToolResultDataSchema, { callId: "c1", ok: false, summary: "sandbox blocked" }, "tool_result"],
      [SseUsageDataSchema, { promptTokens: 12.5, completionTokens: 3 }, "usage"],
      [SseErrorDataSchema, { code: "model_unconfigured", message: "未配置模型" }, "error"],
    ];
    for (const [schema, sample, name] of samples) {
      expect(protocolCheck(schema, sample), name).toBe("ok");
    }
  });

  it("闭对象：多带一个字段即违约（前端不得自造字段）", () => {
    expect(protocolCheck(SseTokenDataSchema, { deltaText: "hi", extra: 1 })).not.toBe("ok");
  });

  it("HTTP 响应形状：会话 / 消息 / 记忆 / 删除 / chat / health / ApiError", () => {
    expect(
      protocolCheck(SessionListResponseSchema, {
        sessions: [{ id: "s1", title: "新对话", updatedAt: 1, messageCount: 2 }],
      }),
    ).toBe("ok");
    expect(protocolCheck(SessionSummarySchema, { id: "s1", title: "t", updatedAt: 1, messageCount: 0 })).toBe("ok");
    expect(
      protocolCheck(MessageSchema, { id: "m1", sessionId: "s1", seq: 0, role: "user", content: "hi", createdAt: 1 }),
    ).toBe("ok");
    expect(protocolCheck(MessagesResponseSchema, { messages: [] })).toBe("ok");
    expect(protocolCheck(MemoryItemSchema, { id: "k7p2q9", kind: "preference", text: "咖啡不加糖", createdAt: 1 })).toBe(
      "ok",
    );
    expect(protocolCheck(MemorySearchResponseSchema, { items: [] })).toBe("ok");
    expect(protocolCheck(MemoryDeleteResponseSchema, { deleted: ["k7p2q9"] })).toBe("ok");
    expect(
      protocolCheck(ChatResponseSchema, {
        runId: "r1",
        sessionId: "s1",
        reply: "好的",
        delivery: "claimed",
      }),
    ).toBe("ok");
    expect(
      protocolCheck(HealthResponseSchema, {
        ok: true,
        version: "0.0.0-scaffold",
        workspaceRoot: "D:/agentplant",
        sandboxMode: "workspace-only",
      }),
    ).toBe("ok");
    expect(protocolCheck(ApiErrorSchema, { code: "unauthorized", message: "无合法 token" })).toBe("ok");
  });

  it("工具/任务状态取值集合是 UI 分档的依据（6 态工具 / 7 态任务）", () => {
    expect([...TOOL_STATUSES]).toEqual(["pending", "running", "success", "error", "denied", "cancelled"]);
    expect([...TASK_STATUSES]).toEqual([
      "pending",
      "running",
      "blocked",
      "needs_input",
      "completed",
      "failed",
      "cancelled",
    ]);
  });
});
