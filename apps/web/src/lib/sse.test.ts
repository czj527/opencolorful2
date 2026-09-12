/**
 * SSE 解析器测试（IA §3.4 / t7 AT-201）。
 *
 * 断言的是四件**契约级**行为：
 *   ① 块顺序 = 后端事件顺序（不重排、不合并）；
 *   ② `data: [DONE]` 是唯一收流信号，且跨 chunk 分片也要能识别；
 *   ③ 未知事件名不静默丢弃（记入 `unknownEvents`）；
 *   ④ 错误帧（`event: error`）照原样产出，不被吞掉。
 */
import { describe, expect, it } from "vitest";

import { DONE_FRAME, isDoneFrame, parseSseChunk } from "./sse.js";
import type { SseEventName } from "./protocol.js";
import { SSE_EVENT_NAMES } from "./protocol.js";

const EVENTS: readonly SseEventName[] = SSE_EVENT_NAMES;

/** 按协议线格式（packages/protocol 的 encodeSseEvent）拼一帧。 */
function frame(event: SseEventName, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** 拼一个**事件名不在白名单内**的帧（用于"未知事件"分支）。 */
function rawFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe("parseSseChunk（SSE 帧解析）", () => {
  it("按事件顺序产出帧，绝不重排或合并", () => {
    const wire =
      frame("start", { runId: "r1", sessionId: "s1" }) +
      frame("token", { deltaText: "你" }) +
      frame("tool_call", { callId: "c1", name: "run_command", args: { command: "dir" } }) +
      frame("tool_result", { callId: "c1", ok: true, summary: "exit 0" }) +
      frame("token", { deltaText: "好" }) +
      frame("done", { runId: "r1", finishReason: "stop", delivery: "verified" }) +
      `${DONE_FRAME}\n\n`;

    const parsed = parseSseChunk("", wire, EVENTS);
    expect(parsed.frames.map((f) => f.event)).toEqual([
      "start",
      "token",
      "tool_call",
      "tool_result",
      "token",
      "done",
    ]);
    expect(parsed.done).toBe(true);
    expect(parsed.unknownEvents).toEqual([]);
    expect(JSON.parse(parsed.frames[1]?.data ?? "{}")).toEqual({ deltaText: "你" });
  });

  it("[DONE] 被分片切开时（chunk 边界落在其中）仍能识别，且不产出半帧", () => {
    const wire = frame("token", { deltaText: "abc" }) + "data: [DO";
    const first = parseSseChunk("", wire, EVENTS);
    expect(first.done).toBe(false);
    expect(first.frames).toHaveLength(1);
    expect(first.rest).toBe("data: [DO");

    const second = parseSseChunk(first.rest, "NE]\n\n", EVENTS);
    expect(second.done).toBe(true);
    expect(second.frames).toHaveLength(0);
  });

  it("data 载荷被分片切开时不产生半个 JSON 帧", () => {
    const first = parseSseChunk("", 'event: token\ndata: {"deltaText":"你', EVENTS);
    expect(first.frames).toHaveLength(0);
    const second = parseSseChunk(first.rest, '好"}\n\n', EVENTS);
    expect(second.frames).toHaveLength(1);
    expect(JSON.parse(second.frames[0]?.data ?? "{}")).toEqual({ deltaText: "你好" });
  });

  it("未知事件名记入 unknownEvents，不猜形状也不丢弃计数", () => {
    const parsed = parseSseChunk("", rawFrame("future_event", { x: 1 }), EVENTS);
    expect(parsed.frames).toHaveLength(0);
    expect(parsed.unknownEvents).toEqual(["future_event"]);
  });

  it("error 帧原样产出（不许被解析器吞掉）", () => {
    const parsed = parseSseChunk("", frame("error", { code: "model_unconfigured", message: "未配置模型" }), EVENTS);
    expect(parsed.frames[0]?.event).toBe("error");
    expect(JSON.parse(parsed.frames[0]?.data ?? "{}")).toEqual({
      code: "model_unconfigured",
      message: "未配置模型",
    });
  });

  it("CRLF 与注释行（keep-alive）不影响解析", () => {
    const wire = `: keep-alive\r\n\r\nevent: token\r\ndata: {"deltaText":"x"}\r\n\r\n`;
    const parsed = parseSseChunk("", wire, EVENTS);
    expect(parsed.frames).toHaveLength(1);
    expect(parsed.frames[0]?.event).toBe("token");
  });

  it("DONE_FRAME 常量与协议层同值（字面量守卫）", () => {
    expect(DONE_FRAME).toBe("data: [DONE]");
    expect(isDoneFrame("data: [DONE]")).toBe(true);
    expect(isDoneFrame('data: {"a":1}')).toBe(false);
  });
});
