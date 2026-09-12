/**
 * completion 测试：回合交付判定 + 终态词表 + 提醒清单。
 *
 * 纪律：这里断言的是**判定表**（t5 §6.3）与**词表一致性**（protocol 是唯一真相源），
 * 不测任何文本匹配——本包不做文本匹配（见 `completion.ts` 的 JSDoc）。
 */
import { describe, expect, it } from "vitest";
import { TASK_STATUSES, TOOL_STATUSES, TURN_DELIVERIES } from "@agentplant/protocol";
import {
  DECIDED_TURN_DELIVERIES,
  NON_TERMINAL_TASK_STATUSES,
  NON_TERMINAL_TOOL_STATUSES,
  PLAN_PATTERN_HINTS,
  TERMINAL_TASK_STATUSES,
  TERMINAL_TOOL_STATUSES,
  decideTurnDelivery,
  isTerminalStatus,
} from "./index.js";

describe("decideTurnDelivery（进度文本≠交付，t5 §6.3 判定表）", () => {
  it("无成功工具调用 + 无证据 → claimed（纯文本计划就是 claimed）", () => {
    expect(decideTurnDelivery({ hasSuccessfulToolCall: false, evidenceCount: 0 })).toBe("claimed");
  });

  it("无工具调用但 evidenceCount>0 → 仍 claimed（计数不能顶替工具调用事实）", () => {
    expect(decideTurnDelivery({ hasSuccessfulToolCall: false, evidenceCount: 3 })).toBe("claimed");
  });

  it("有成功工具调用 + 有证据 → verified", () => {
    expect(decideTurnDelivery({ hasSuccessfulToolCall: true, evidenceCount: 1 })).toBe("verified");
    expect(decideTurnDelivery({ hasSuccessfulToolCall: true, evidenceCount: 9 })).toBe("verified");
  });

  it("有成功工具调用但证据为 0 → claimed（拿不出凭据就不叫已核验）", () => {
    expect(decideTurnDelivery({ hasSuccessfulToolCall: true, evidenceCount: 0 })).toBe("claimed");
  });

  it("脏 evidenceCount（负数 / NaN / Infinity / 小数）一律按无证据处理，不抛错", () => {
    expect(decideTurnDelivery({ hasSuccessfulToolCall: true, evidenceCount: -1 })).toBe("claimed");
    expect(decideTurnDelivery({ hasSuccessfulToolCall: true, evidenceCount: Number.NaN })).toBe(
      "claimed",
    );
    expect(
      decideTurnDelivery({ hasSuccessfulToolCall: true, evidenceCount: Number.POSITIVE_INFINITY }),
    ).toBe("claimed");
    // 判定只做 `> 0` 比较、不做取整：0.5 条证据不可能出现（计数是整数），但既然 > 0 就按"有证据"。
    expect(decideTurnDelivery({ hasSuccessfulToolCall: true, evidenceCount: 0.5 })).toBe("verified");
  });

  it("本函数不产出 unknown（unknown 是调用方显式取值）", () => {
    const seen = new Set<string>();
    for (const hasSuccessfulToolCall of [true, false]) {
      for (const evidenceCount of [0, 1, 5]) {
        seen.add(decideTurnDelivery({ hasSuccessfulToolCall, evidenceCount }));
      }
    }
    expect([...seen].sort()).toEqual(["claimed", "verified"]);
    expect(seen.has("unknown")).toBe(false);
  });

  it("判定取值范围 = protocol 的 TURN_DELIVERIES 去掉 unknown（词表不许漂移）", () => {
    expect([...DECIDED_TURN_DELIVERIES]).toEqual(
      TURN_DELIVERIES.filter((delivery) => delivery !== "unknown"),
    );
  });
});

describe("isTerminalStatus（终态词表；task ∪ tool）", () => {
  it.each(TERMINAL_TASK_STATUSES)("任务终态 %s → true", (status) => {
    expect(isTerminalStatus(status)).toBe(true);
  });

  it.each(TERMINAL_TOOL_STATUSES)("工具终态 %s → true", (status) => {
    expect(isTerminalStatus(status)).toBe(true);
  });

  it.each(NON_TERMINAL_TASK_STATUSES)("任务非终态 %s → false", (status) => {
    expect(isTerminalStatus(status)).toBe(false);
  });

  it.each(NON_TERMINAL_TOOL_STATUSES)("工具非终态 %s → false", (status) => {
    expect(isTerminalStatus(status)).toBe(false);
  });

  it("未知取值一律 false（fail-closed 拦截在 state 门禁，不在这里当终态）", () => {
    for (const status of ["", "done", "sleeping", "COMPLETED", "success "]) {
      expect(isTerminalStatus(status)).toBe(false);
    }
  });

  it("终态 + 非终态 = protocol 全枚举，且两边不重叠（无缺口、无漏项）", () => {
    expect([...TERMINAL_TASK_STATUSES, ...NON_TERMINAL_TASK_STATUSES].sort()).toEqual(
      [...TASK_STATUSES].sort(),
    );
    expect([...TERMINAL_TOOL_STATUSES, ...NON_TERMINAL_TOOL_STATUSES].sort()).toEqual(
      [...TOOL_STATUSES].sort(),
    );
    const overlap = TERMINAL_TASK_STATUSES.filter((status) =>
      (NON_TERMINAL_TASK_STATUSES as readonly string[]).includes(status),
    );
    expect(overlap).toEqual([]);
    const toolOverlap = TERMINAL_TOOL_STATUSES.filter((status) =>
      (NON_TERMINAL_TOOL_STATUSES as readonly string[]).includes(status),
    );
    expect(toolOverlap).toEqual([]);
  });

  it("cancelled 在 task 与 tool 两份终态里都成立（同一语义，不因词表而异）", () => {
    expect(TERMINAL_TASK_STATUSES).toContain("cancelled");
    expect(TERMINAL_TOOL_STATUSES).toContain("cancelled");
    expect(isTerminalStatus("cancelled")).toBe(true);
  });
});

describe("PLAN_PATTERN_HINTS（未来时表述清单，供 t15 主循环/前端引用）", () => {
  it("至少 8 条、无重复、无非空串，且含 t5 §6.3 点名的三条", () => {
    expect(PLAN_PATTERN_HINTS.length).toBeGreaterThanOrEqual(8);
    expect(PLAN_PATTERN_HINTS.every((hint) => hint.trim().length > 0)).toBe(true);
    expect(new Set(PLAN_PATTERN_HINTS).size).toBe(PLAN_PATTERN_HINTS.length);
    for (const required of ["接下来", "将要", "正在准备"]) {
      expect(PLAN_PATTERN_HINTS).toContain(required);
    }
  });

  it("清单与判定解耦：文本是否命中都不改变判定结果（判定只看事实）", () => {
    const planned = PLAN_PATTERN_HINTS[0] ?? "";
    expect(planned.length).toBeGreaterThan(0);
    expect(decideTurnDelivery({ hasSuccessfulToolCall: false, evidenceCount: 0 })).toBe("claimed");
    expect(decideTurnDelivery({ hasSuccessfulToolCall: true, evidenceCount: 1 })).toBe("verified");
  });
});
