/**
 * audit-buffer 测试：环形缓冲的 cap 语义 + 元数据上限兜底 + 只读副本。
 *
 * 这些用例直接测模块（不走 HTTP）：缓冲是"接 state 之前的过渡实现"，
 * 它的行为必须与落库实现同口径（超限抛错、丢最旧、时间戳 unix 秒），
 * 否则换实现时会静默改变审计语义。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { PAYLOAD_META_MAX_CHARS, buildAuditMeta } from "@agentplant/agent-core";
import {
  AUDIT_BUFFER_CAP,
  appendAudit,
  auditEventCount,
  listAuditEvents,
  resetAuditForTest,
} from "./audit-buffer.js";

beforeEach(() => {
  resetAuditForTest();
});

describe("appendAudit / 环形 cap", () => {
  it("cap = 200：写 201 条只剩 200 条，且丢的是最旧那条（FIFO）", () => {
    expect(AUDIT_BUFFER_CAP).toBe(200);
    for (let index = 0; index <= AUDIT_BUFFER_CAP; index += 1) {
      appendAudit({ kind: "turn.end", runId: `run-${String(index)}` });
    }
    const events = listAuditEvents();
    expect(events.length).toBe(AUDIT_BUFFER_CAP);
    expect(events[0]?.runId).toBe("run-1");
    expect(events.at(-1)?.runId).toBe(`run-${String(AUDIT_BUFFER_CAP)}`);
  });

  it("没写满时不丢任何一条，且保持写入顺序", () => {
    appendAudit({ kind: "session.start", runId: "a" });
    appendAudit({ kind: "turn.end", runId: "b" });
    appendAudit({ kind: "state.transition", runId: "c" });
    expect(listAuditEvents().map((event) => event.runId)).toEqual(["a", "b", "c"]);
    expect(auditEventCount()).toBe(3);
  });

  it("time 口径 = unix 秒（可显式注入）", () => {
    appendAudit({ kind: "turn.end", runId: "run-now" });
    appendAudit({ kind: "turn.end", runId: "run-fixed", ts: 1_700_000_000 });
    const [auto, fixed] = listAuditEvents();
    expect(fixed?.ts).toBe(1_700_000_000);
    const now = Math.floor(Date.now() / 1000);
    expect(Math.abs((auto?.ts ?? 0) - now)).toBeLessThanOrEqual(60);
    expect(Number.isInteger(auto?.ts)).toBe(true);
  });

  it("payloadMeta 超限抛错（与 state DAO / DDL CHECK 同口径，不截断）", () => {
    const tooLong = "x".repeat(PAYLOAD_META_MAX_CHARS + 1);
    expect(() => appendAudit({ kind: "turn.end", payloadMeta: tooLong })).toThrow(/2048/);
    // 拒写之后缓冲没有被污染（抛错发生在入队之前）。
    expect(auditEventCount()).toBe(0);

    // 自校准到"恰好等于上限"：先用空键探一次长度，避免在测试里硬编码形状常量。
    const probe = buildAuditMeta({ toolName: "none", argKeys: [""], resultBytes: 0, truncated: false });
    const atLimit = buildAuditMeta({
      toolName: "none",
      argKeys: ["k".repeat(PAYLOAD_META_MAX_CHARS - probe.length)],
      resultBytes: 0,
      truncated: false,
    });
    expect(atLimit.length).toBe(PAYLOAD_META_MAX_CHARS);
    appendAudit({ kind: "turn.end", payloadMeta: atLimit });
    expect(auditEventCount()).toBe(1);
  });

  it("listAuditEvents 每次返回新的副本（不是内部数组的引用）", () => {
    appendAudit({ kind: "turn.end", runId: "run-1" });
    const first = listAuditEvents();
    const second = listAuditEvents();
    expect(first).not.toBe(second); // 副本语义：外部拿到的是快照
    expect(first).toEqual(second);
    // 类型层也是只读的（`readonly BufferedAuditEvent[]`）：外部改不动靠类型约束 + 快照双保险。
    expect(first[0]?.runId).toBe("run-1");
    expect(auditEventCount()).toBe(1);
  });
});
