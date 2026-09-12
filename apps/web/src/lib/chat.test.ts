/**
 * 回合聚合测试（IA §3.2 块序列 / §4.3 工具卡状态 / §3.4 中断语义）。
 *
 * 断言四件事：
 *   ① 块顺序 = 事件顺序（token 与 tool_call 交错时不得合并）；
 *   ② 工具卡状态**只由 tool_result 推进**（没收到结果前是 running，收不到就显式失败）；
 *   ③ `done` 的 delivery/evidence 原样落进回合，不被前端改写；
 *   ④ 未知 callId 的结果、非法 JSON 载荷都变成**可见的错误块**，不静默丢弃。
 */
import { describe, expect, it } from "vitest";

import { applySseEvent, evidenceText, hasPendingConfirm, hasRunningTool, newAssistantTurn, sealTurn, turnText } from "./chat.js";
import type { SseEvent } from "./protocol.js";

function event<Name extends SseEvent["event"]>(name: Name, data: unknown): SseEvent {
  return { event: name, data } as SseEvent;
}

describe("回合聚合（applySseEvent）", () => {
  it("start→token→tool_call→tool_result→token→done：块顺序等于事件顺序", () => {
    const turn = newAssistantTurn();
    expect(applySseEvent(turn, event("start", { runId: "r1", sessionId: "s1" }))).toBe("structure");
    expect(applySseEvent(turn, event("token", { deltaText: "我先看一下" }))).toBe("text");
    expect(applySseEvent(turn, event("tool_call", { callId: "c1", name: "read_file", args: { path: "a.md" } }))).toBe(
      "structure",
    );
    expect(
      applySseEvent(turn, event("tool_result", { callId: "c1", ok: true, summary: "读取 3 行" })),
    ).toBe("structure");
    expect(applySseEvent(turn, event("token", { deltaText: "，内容如下。" }))).toBe("text");
    applySseEvent(turn, event("done", { runId: "r1", finishReason: "stop", delivery: "claimed" }));

    expect(turn.blocks.map((block) => block.kind)).toEqual(["text", "tool_call", "text"]);
    expect(turnText(turn)).toBe("我先看一下\n[工具 read_file · success] 读取 3 行\n，内容如下。");
  });

  it("token 增量追加到同一文本块；tool_call 会「封口」当前块", () => {
    const turn = newAssistantTurn();
    applySseEvent(turn, event("token", { deltaText: "a" }));
    applySseEvent(turn, event("token", { deltaText: "b" }));
    expect(turn.blocks).toHaveLength(1);
    applySseEvent(turn, event("tool_call", { callId: "c1", name: "run_command", args: {} }));
    applySseEvent(turn, event("token", { deltaText: "c" }));
    expect(turn.blocks).toHaveLength(3);
    expect(turn.blocks[0]).toMatchObject({ kind: "text", text: "ab", streaming: false });
  });

  it("工具卡状态只由 tool_result 推进：未收到结果前是 running", () => {
    const turn = newAssistantTurn();
    applySseEvent(turn, event("tool_call", { callId: "c1", name: "run_command", args: {} }));
    expect(hasRunningTool(turn)).toBe(true);
    applySseEvent(turn, event("tool_result", { callId: "c1", ok: false, summary: "沙箱拦截：路径越界" }));
    expect(hasRunningTool(turn)).toBe(false);
    expect(turn.blocks[0]).toMatchObject({ kind: "tool_call", status: "error", summary: "沙箱拦截：路径越界" });
  });

  it("未知 callId 的 tool_result 变成可见错误块（不静默丢弃）", () => {
    const turn = newAssistantTurn();
    applySseEvent(turn, event("tool_result", { callId: "ghost", ok: true, summary: "?" }));
    expect(turn.blocks[0]).toMatchObject({ kind: "error", code: "tool_result_unknown_call" });
  });

  it("done 的 delivery/evidence 原样落进回合；前端不改写", () => {
    const turn = newAssistantTurn();
    applySseEvent(
      turn,
      event("done", {
        runId: "r1",
        finishReason: "tool_calls",
        delivery: "verified",
        evidence: { toolName: "write_file", count: 1, toolCallIds: ["c9"] },
      }),
    );
    expect(turn.delivery).toBe("verified");
    expect(evidenceText(turn)).toBe("write_file ×1");
  });

  it("流结束仍未收到结果的工具卡被显式标成失败（禁止猜测成功）", () => {
    const turn = newAssistantTurn();
    applySseEvent(turn, event("tool_call", { callId: "c1", name: "run_command", args: {} }));
    sealTurn(turn);
    expect(turn.blocks[0]).toMatchObject({ kind: "tool_call", status: "error" });
    expect((turn.blocks[0] as { summary: string | null }).summary).toContain("未收到");
  });

  it("待确认卡片会影响 presence（hasPendingConfirm）", () => {
    const turn = newAssistantTurn();
    applySseEvent(turn, event("tool_call", { callId: "c1", name: "run_command", args: {} }));
    expect(hasPendingConfirm(turn)).toBe(false);
    const block = turn.blocks[0];
    if (block?.kind === "tool_call") {
      block.confirm = { kind: "pending" };
    }
    expect(hasPendingConfirm(turn)).toBe(true);
  });

  it("error 事件变成错误块（不吞）", () => {
    const turn = newAssistantTurn();
    applySseEvent(turn, event("error", { code: "model_unconfigured", message: "未配置模型" }));
    expect(turn.blocks[0]).toMatchObject({ kind: "error", code: "model_unconfigured", message: "未配置模型" });
  });

  it("usage 累加（prompt/completion）", () => {
    const turn = newAssistantTurn();
    applySseEvent(turn, event("usage", { promptTokens: 10, completionTokens: 2.5 }));
    applySseEvent(turn, event("usage", { promptTokens: 5, completionTokens: 1 }));
    expect(turn.promptTokens).toBe(15);
    expect(turn.completionTokens).toBe(3.5);
  });
});
