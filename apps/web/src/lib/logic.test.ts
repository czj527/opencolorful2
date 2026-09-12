/**
 * 交付标签 / presence 状态机 / 确认动线 / 记忆过滤 / 工具卡分级的纯逻辑测试。
 *
 * 覆盖三条"执行层不得翻案"的治理编码（t5 §5、IA §6.3）：
 *   ① delivery 缺失不得渲染成成功；
 *   ② presence 五态优先级与"awaiting/idle 必须静止"；
 *   ③ denied/沙箱拦截必须显式（状态色 + 原因原文语义）。
 */
import { describe, expect, it } from "vitest";

import { deliveryShortLabel, deliveryView } from "./delivery.js";
import { PRESENCE_SPECS, mustBeStatic, presenceAnimationClass, presenceOf } from "./presence.js";
import {
  confirmTransition,
  dangerBadge,
  dangerLevelOf,
  needsConfirmation,
  shouldAutoExpand,
  statusLabel,
  statusTone,
} from "./danger.js";
import { kindGlyph, kindLabel, matchesSubstring, sortByCreatedAtDesc, visibleMemories } from "./memory.js";
import { THINKING_TIMELINE, formatBytes, formatDuration, sessionGroupOf, thinkingStage, thinkingText } from "./timeline.js";
import type { MemoryItem } from "./protocol.js";

describe("delivery 标签映射（t5 §5：前端不做时态推断）", () => {
  it("claimed → warning「仅计划，尚未执行」", () => {
    const view = deliveryView("claimed");
    expect(view.tone).toBe("warning");
    expect(view.label).toBe("◷ 仅计划，尚未执行");
    expect(view.missingOrUnknown).toBe(false);
  });

  it("verified → success + 依据（工具名 ×N）", () => {
    const view = deliveryView("verified", { toolName: "write_file", count: 2, toolCallIds: ["c1", "c2"] });
    expect(view.tone).toBe("success");
    expect(view.label).toBe("✓ 已核验交付");
    expect(view.evidenceLabel).toBe("依据：write_file ×2");
    expect(view.evidenceClickable).toBe(true);
  });

  it("verified 但无 evidence：仍标已核验，但不编造依据", () => {
    const view = deliveryView("verified", undefined);
    expect(view.tone).toBe("success");
    expect(view.evidenceLabel).toBeNull();
  });

  it("unknown → 未提供交付状态（既不是成功也不是失败）", () => {
    const view = deliveryView("unknown");
    expect(view.label).toBe("未提供交付状态");
    expect(view.missingOrUnknown).toBe(true);
    expect(view.tone).not.toBe("success");
  });

  it("**字段缺失** → 与 unknown 同一条诚实分支，绝不渲染成成功", () => {
    for (const missing of [null, undefined]) {
      const view = deliveryView(missing);
      expect(view.label).toBe("未提供交付状态");
      expect(view.tone).not.toBe("success");
    }
    expect(deliveryShortLabel(null)).toBe("未提供交付状态");
  });
});

describe("presence 五态（tokens.md §3.1/§6.3 + IA §3.6）", () => {
  it("优先级 awaiting > acting > streaming > thinking > idle", () => {
    expect(presenceOf({ awaiting: true, acting: true, streaming: true, thinking: true })).toBe("awaiting");
    expect(presenceOf({ awaiting: false, acting: true, streaming: true, thinking: true })).toBe("acting");
    expect(presenceOf({ awaiting: false, acting: false, streaming: true, thinking: true })).toBe("streaming");
    expect(presenceOf({ awaiting: false, acting: false, streaming: false, thinking: true })).toBe("thinking");
    expect(presenceOf({ awaiting: false, acting: false, streaming: false, thinking: false })).toBe("idle");
  });

  it("idle 必须静止；awaiting 只允许「入场一次」，禁止任何持续动效", () => {
    expect(mustBeStatic("idle")).toBe(true);
    expect(mustBeStatic("awaiting")).toBe(true);
    expect(presenceAnimationClass("idle")).toBeNull();
    // awaiting 的入场 settle 是一次性的（tokens.md §6.3「入场后完全静止」），
    // 不是持续动画类（breathe/pulse 才是持续类）。
    expect(PRESENCE_SPECS.awaiting.animation).toBe("settle");
    expect(presenceAnimationClass("awaiting")).not.toContain("breathe");
    expect(presenceAnimationClass("awaiting")).not.toContain("pulse");
  });

  it("streaming 无脉冲（文本 + 光标已足够可见，避免双重动效）", () => {
    expect(presenceAnimationClass("streaming")).toBeNull();
    expect(PRESENCE_SPECS.streaming.animated).toBe(false);
  });

  it("每个状态都有文字标签（色不是唯一信息载体）", () => {
    for (const spec of Object.values(PRESENCE_SPECS)) {
      expect(spec.label.length).toBeGreaterThan(0);
    }
    expect(PRESENCE_SPECS.awaiting.label).toBe("待你确认");
  });
});

describe("危险分级与确认动线（IA §4.4，裁决 A7/A8/A9）", () => {
  it("读类/记忆类 safe、域内写 caution、命令与越界写 danger", () => {
    expect(dangerLevelOf("read_file")).toBe("safe");
    expect(dangerLevelOf("memory_write")).toBe("safe");
    expect(dangerLevelOf("write_file")).toBe("caution");
    expect(dangerLevelOf("write_file", true)).toBe("danger");
    expect(dangerLevelOf("run_command")).toBe("danger");
  });

  it("未登记工具保守降级为 caution（不假装它安全）", () => {
    expect(dangerLevelOf("some_future_tool")).toBe("caution");
  });

  it("只有 danger 走就地确认；徽标文案与级别对应", () => {
    expect(needsConfirmation("safe")).toBe(false);
    expect(needsConfirmation("caution")).toBe(false);
    expect(needsConfirmation("danger")).toBe(true);
    expect(dangerBadge("safe")).toBe("");
    expect(dangerBadge("caution")).toBe("会写入磁盘");
    expect(dangerBadge("danger")).toBe("会执行命令");
    expect(dangerBadge("danger", true)).toBe("会写入工作目录外");
  });

  it("确认状态机：一次性授权 + 非法迁移不改状态（终态不降级）", () => {
    let state = confirmTransition({ kind: "idle" }, "request");
    expect(state.kind).toBe("pending");
    // 重复请求不重置
    expect(confirmTransition(state, "request").kind).toBe("pending");
    state = confirmTransition(state, "allow", { at: "10:16:20" });
    expect(state.kind).toBe("allowed");
    // 已允许后再 deny 无效（一次性语义不可逆）
    expect(confirmTransition(state, "deny").kind).toBe("allowed");
  });

  it("拒绝必须带原因原文（返回给 Agent，不得静默）", () => {
    const pending = confirmTransition({ kind: "idle" }, "request");
    const denied = confirmTransition(pending, "deny", { reason: "用户拒绝了本次执行" });
    expect(denied).toEqual({ kind: "denied", reason: "用户拒绝了本次执行" });
  });

  it("失败 / 被拒自动展开；用户手动收起后不再自动展开", () => {
    expect(shouldAutoExpand("error", false)).toBe(true);
    expect(shouldAutoExpand("denied", false)).toBe(true);
    expect(shouldAutoExpand("error", true)).toBe(false);
    expect(shouldAutoExpand("running", false)).toBe(false);
    expect(shouldAutoExpand("success", false)).toBe(false);
  });

  it("状态色与文案：denied/error 走 danger，且必须有文字", () => {
    expect(statusTone("denied")).toBe("danger");
    expect(statusTone("error")).toBe("danger");
    expect(statusTone("running")).toBe("acting");
    expect(statusTone("success")).toBe("success");
    expect(statusLabel("denied")).toBe("已拒绝");
    expect(statusLabel("success", 1200)).toBe("成功 · 1.2s");
  });
});

describe("记忆视图纯逻辑（IA §5）", () => {
  const items: MemoryItem[] = [
    { id: "b", kind: "fact", text: "常用目录是 D:/work", createdAt: 200 },
    { id: "a", kind: "preference", text: "咖啡不加糖", createdAt: 100 },
    { id: "c", kind: "preference", text: "偏好简短回答", createdAt: 300 },
  ];

  it("按 created_at 倒序（最新在上），同秒按 id 稳定排序", () => {
    expect(sortByCreatedAtDesc(items).map((item) => item.id)).toEqual(["c", "b", "a"]);
    const tied: MemoryItem[] = [
      { id: "z", kind: "fact", text: "z", createdAt: 5 },
      { id: "y", kind: "fact", text: "y", createdAt: 5 },
    ];
    expect(sortByCreatedAtDesc(tied).map((item) => item.id)).toEqual(["y", "z"]);
  });

  it("子串匹配（大小写不敏感，空查询匹配一切）", () => {
    expect(matchesSubstring(items[1] as MemoryItem, "不加糖")).toBe(true);
    expect(matchesSubstring(items[1] as MemoryItem, "咖啡")).toBe(true);
    expect(matchesSubstring(items[1] as MemoryItem, "茶")).toBe(false);
    expect(matchesSubstring(items[1] as MemoryItem, "  ")).toBe(true);
  });

  it("过滤 + 排序：先按 kind/子串筛，再按时间倒序", () => {
    expect(visibleMemories(items, "preference", "").map((item) => item.id)).toEqual(["c", "a"]);
    expect(visibleMemories(items, "all", "目录").map((item) => item.id)).toEqual(["b"]);
    expect(visibleMemories(items, "fact", "咖啡")).toEqual([]);
  });

  it("类型标签与图形标记（色不是唯一编码）", () => {
    expect(kindLabel("preference")).toBe("偏好");
    expect(kindLabel("fact")).toBe("事实");
    expect(kindGlyph("preference")).not.toBe(kindGlyph("fact"));
  });
});

describe("交互时间轴（IA §3.6 P-B：250ms / 2.5s / 8s / 30s）", () => {
  it("分级推进与超时", () => {
    expect(thinkingStage(0)).toBe("none");
    expect(thinkingStage(THINKING_TIMELINE.indicatorAfterMs)).toBe("dots");
    expect(thinkingStage(THINKING_TIMELINE.textAfterMs)).toBe("dots-text");
    expect(thinkingStage(THINKING_TIMELINE.stopHintAfterMs)).toBe("dots-text-stophint");
    expect(thinkingStage(THINKING_TIMELINE.timeoutAfterMs)).toBe("timeout");
    expect(thinkingText("dots")).toBeNull();
    expect(thinkingText("dots-text")).toBe("正在思考…");
    expect(thinkingText("timeout")).toContain("30 秒");
  });

  it("格式化：时长 / 体积 / 会话分组", () => {
    expect(formatDuration(800)).toBe("0.8s");
    expect(formatDuration(-5)).toBe("0.0s");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    const now = new Date("2026-09-11T12:00:00").getTime();
    expect(sessionGroupOf(Math.floor(now / 1000) - 60, now)).toBe("今天");
    expect(sessionGroupOf(Math.floor(now / 1000) - 3 * 86_400, now)).toBe("近 7 天");
    expect(sessionGroupOf(Math.floor(now / 1000) - 30 * 86_400, now)).toBe("更早");
  });
});
