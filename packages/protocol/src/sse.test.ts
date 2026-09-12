/**
 * SSE 契约测试：8 种事件名 / discriminator 收窄 / done.delivery 三态 /
 * encodeSseEvent 线格式 / [DONE] 常量。
 *
 * 依据：t4 §2（事件名与结束帧）+ t5 §5（delivery 缺失不得渲染为成功）。
 */
import { describe, expect, it } from "vitest";
import { validate } from "./index.js";
import {
  SSE_DONE_FRAME,
  SSE_EVENT_DATA_SCHEMAS,
  SSE_EVENT_NAMES,
  SSE_HEADERS,
  SSE_FINISH_REASONS,
  TURN_DELIVERIES,
  encodeSseEvent,
  sseEvent,
  type SseEvent,
  type SseEventName,
} from "./sse.js";

describe("事件清单", () => {
  it("恰好 8 种事件名，且顺序与 t4 §2 一致", () => {
    expect(SSE_EVENT_NAMES).toEqual([
      "start",
      "token",
      "thinking",
      "tool_call",
      "tool_result",
      "usage",
      "error",
      "done",
    ]);
  });

  it("每种事件名都有一个 data schema", () => {
    for (const name of SSE_EVENT_NAMES) {
      expect(SSE_EVENT_DATA_SCHEMAS[name]).toBeDefined();
    }
  });

  it("[DONE] 常量与响应头是契约原文", () => {
    expect(SSE_DONE_FRAME).toBe("data: [DONE]");
    expect(SSE_HEADERS["Content-Type"]).toBe("text/event-stream; charset=utf-8");
    expect(SSE_HEADERS["Cache-Control"]).toBe("no-cache");
    expect(SSE_HEADERS.Connection).toBe("keep-alive");
  });
});

describe("事件 data 校验（判别的合法性）", () => {
  const samples: ReadonlyArray<readonly [SseEventName, unknown]> = [
    ["start", { runId: "r1", sessionId: "s1" }],
    ["token", { deltaText: "你" }],
    ["thinking", { deltaText: "想一下" }],
    ["tool_call", { callId: "c1", name: "read_file", args: { path: "a.txt" } }],
    ["tool_result", { callId: "c1", ok: true, summary: "读到 3 行" }],
    ["usage", { promptTokens: 12, completionTokens: 34 }],
    ["error", { code: "rate_limited", message: "稍后再试" }],
    [
      "done",
      {
        runId: "r1",
        finishReason: "stop",
        delivery: "verified",
        evidence: { toolName: "read_file", count: 1, toolCallIds: ["c1"] },
        message: "已核验",
      },
    ],
  ];

  it.each(samples)("%s 的合法样本通过，缺少判别所需字段则失败", (name, sample) => {
    expect(validate(SSE_EVENT_DATA_SCHEMAS[name] as never, sample).ok).toBe(true);
    expect(validate(SSE_EVENT_DATA_SCHEMAS[name] as never, {}).ok).toBe(false);
  });

  it("args / details 是 unknown：任意形状都合法", () => {
    expect(
      validate(SSE_EVENT_DATA_SCHEMAS.tool_call as never, {
        callId: "c1",
        name: "x",
        args: [1, "two", { three: null }],
      }).ok,
    ).toBe(true);
    expect(
      validate(SSE_EVENT_DATA_SCHEMAS.tool_result as never, {
        callId: "c1",
        ok: false,
        summary: "失败",
        details: { stack: "..." },
      }).ok,
    ).toBe(true);
  });
});

describe("done.delivery（t5 契约 d 项）", () => {
  it("三态取值集合固定为 claimed / verified / unknown", () => {
    expect(TURN_DELIVERIES).toEqual(["claimed", "verified", "unknown"]);
    expect(SSE_FINISH_REASONS).toEqual(["stop", "tool_calls", "aborted", "error"]);
  });

  it.each(TURN_DELIVERIES)("delivery=%s 通过", (delivery) => {
    expect(
      validate(SSE_EVENT_DATA_SCHEMAS.done as never, {
        runId: "r1",
        finishReason: "stop",
        delivery,
      }).ok,
    ).toBe(true);
  });

  it("delivery 是必填：缺失即校验失败（后端不许留空）", () => {
    const result = validate(SSE_EVENT_DATA_SCHEMAS.done as never, {
      runId: "r1",
      finishReason: "stop",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((issue) => issue.path.endsWith("/delivery"))).toBe(true);
    }
  });

  it("delivery 自造取值被拒", () => {
    expect(
      validate(SSE_EVENT_DATA_SCHEMAS.done as never, {
        runId: "r1",
        finishReason: "stop",
        delivery: "done",
      }).ok,
    ).toBe(false);
  });

  it("finishReason 自造取值被拒", () => {
    expect(
      validate(SSE_EVENT_DATA_SCHEMAS.done as never, {
        runId: "r1",
        finishReason: "finished",
        delivery: "unknown",
      }).ok,
    ).toBe(false);
  });

  it("evidence 字段 closed：多字段即失败", () => {
    expect(
      validate(SSE_EVENT_DATA_SCHEMAS.done as never, {
        runId: "r1",
        finishReason: "stop",
        delivery: "verified",
        evidence: { toolName: "read_file", count: 1, toolCallIds: ["c1"], extra: 1 },
      }).ok,
    ).toBe(false);
  });
});

describe("discriminated union 收窄", () => {
  it("按 event 收窄后才能取到对应 data 字段（编译期 + 运行期一致）", () => {
    const events: readonly SseEvent[] = [
      sseEvent("token", { deltaText: "hi" }),
      sseEvent("done", { runId: "r1", finishReason: "stop", delivery: "claimed" }),
    ];
    const seen: string[] = [];
    for (const item of events) {
      switch (item.event) {
        case "token":
          seen.push(item.data.deltaText);
          break;
        case "done":
          seen.push(item.data.delivery);
          break;
        default:
          seen.push("skip");
      }
    }
    expect(seen).toEqual(["hi", "claimed"]);
  });

  it("sseEvent 产出的对象与事件名配对", () => {
    const event = sseEvent("start", { runId: "r1", sessionId: "s1" });
    expect(event.event).toBe("start");
    expect(event.data).toEqual({ runId: "r1", sessionId: "s1" });
  });
});

describe("encodeSseEvent 线格式", () => {
  it("序列化为 event:/data:/空行 三段", () => {
    const frame = encodeSseEvent("token", { deltaText: "你" });
    expect(frame).toBe('event: token\ndata: {"deltaText":"你"}\n\n');
  });

  it("多行文本被 JSON 转义为单行 data（SSE 规范下合法）", () => {
    const frame = encodeSseEvent("token", { deltaText: "a\nb" });
    expect(frame.split("\n").filter((line) => line.startsWith("data:"))).toHaveLength(1);
    expect(frame).toContain("a\\nb");
  });

  it("每帧以空行结束", () => {
    for (const name of SSE_EVENT_NAMES) {
      expect(encodeSseEvent(name, {}).endsWith("\n\n")).toBe(true);
    }
  });
});
