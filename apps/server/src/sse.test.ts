/**
 * sse 测试：run 注册表语义（abort 幂等 / 终态不可降级）+ SSE 线格式。
 *
 * 依据：t4 §2（SSE 头、结束帧、断线 abort）+ protocol 的 `SSE_HEADERS` / `SSE_DONE_FRAME`。
 * 真实 socket 上的断线行为在 `server.test.ts` 用真 HTTP 覆盖。
 */
import type { ServerResponse } from "node:http";
import { beforeEach, describe, expect, it } from "vitest";
import { SSE_DONE_FRAME, SSE_HEADERS, encodeSseEvent } from "@agentplant/protocol";
import {
  abortRun,
  activeRunCount,
  endStream,
  finishRun,
  getRun,
  pushEvent,
  registerRun,
  resetRunsForTest,
  sendSseHeaders,
} from "./sse.js";

interface RecordedResponse {
  status?: number;
  headers?: Record<string, string>;
  flushed: boolean;
  chunks: string[];
}

/** 极简 ServerResponse 替身：只记录被调用的写操作（不涉及 socket）。 */
function fakeResponse(sink: RecordedResponse): ServerResponse {
  return {
    writeHead(status: number, headers: Record<string, string>) {
      sink.status = status;
      sink.headers = headers;
      return this;
    },
    flushHeaders() {
      sink.flushed = true;
    },
    write(chunk: string) {
      sink.chunks.push(chunk);
      return true;
    },
    end(chunk?: string) {
      if (chunk !== undefined) {
        sink.chunks.push(chunk);
      }
      return this;
    },
  } as unknown as ServerResponse;
}

beforeEach(() => {
  resetRunsForTest();
});

describe("run 注册表", () => {
  it("registerRun 登记后可按 runId 取回，且 controller 未 aborted", () => {
    const record = registerRun("run-1", "session-1");
    expect(getRun("run-1")).toBe(record);
    expect(record.sessionId).toBe("session-1");
    expect(record.controller.signal.aborted).toBe(false);
    expect(activeRunCount()).toBe(1);
  });

  it("abortRun 未知 runId → false（幂等，不抛错）", () => {
    expect(abortRun("nope")).toBe(false);
  });

  it("abortRun 已登记 run → true，并真的触发 AbortController", () => {
    const record = registerRun("run-2", "session-2");
    expect(abortRun("run-2")).toBe(true);
    expect(record.aborted).toBe(true);
    expect(record.controller.signal.aborted).toBe(true);
    expect(activeRunCount()).toBe(0);
  });

  it("abortRun 重复调用 → 第二次 false（同一路径复用，无重复副作用）", () => {
    registerRun("run-3", "session-3");
    expect(abortRun("run-3")).toBe(true);
    expect(abortRun("run-3")).toBe(false);
  });

  it("finishRun 后的 run 再 abort → false（已终态，与 ChatAbortResponseSchema 注释一致）", () => {
    registerRun("run-4", "session-4");
    finishRun("run-4");
    expect(abortRun("run-4")).toBe(false);
    expect(activeRunCount()).toBe(0);
  });

  it("终态不可降级：先 abort 再 finish，仍保持 aborted", () => {
    const record = registerRun("run-5", "session-5");
    abortRun("run-5");
    finishRun("run-5");
    expect(record.aborted).toBe(true);
    expect(record.finished).toBe(false);
  });
});

describe("SSE 线格式（常量一律取自 protocol）", () => {
  it("sendSseHeaders 写 SSE_HEADERS 并 flushHeaders", () => {
    const sink: RecordedResponse = { flushed: false, chunks: [] };
    sendSseHeaders(fakeResponse(sink));
    expect(sink.status).toBe(200);
    expect(sink.headers).toEqual({ ...SSE_HEADERS });
    expect(sink.flushed).toBe(true);
  });

  it("pushEvent 产出 encodeSseEvent 的原文，endStream 以 [DONE] 帧收尾", () => {
    const sink: RecordedResponse = { flushed: false, chunks: [] };
    const res = fakeResponse(sink);
    pushEvent(res, "start", { runId: "r1", sessionId: "s1" });
    pushEvent(res, "token", { deltaText: "骨架" });
    endStream(res);

    const text = sink.chunks.join("");
    expect(text.startsWith(encodeSseEvent("start", { runId: "r1", sessionId: "s1" }))).toBe(true);
    expect(text).toContain('event: token\ndata: {"deltaText":"骨架"}\n\n');
    expect(text.endsWith(`${SSE_DONE_FRAME}\n`)).toBe(true);
    expect(text.match(/^event: /gm)).toHaveLength(2);
  });
});
