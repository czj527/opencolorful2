/**
 * turn.test.ts：回合级纯函数的用例（≥6）。
 *
 * 纪律：这些用例**不碰 I/O**（无 DB、无 socket、无临时目录）——turn.ts 的纯度
 * 由 `purity.test.ts` 扫源码保证，这里再用"同样的输入必得同样的输出"验证行为面。
 *
 * 重点覆盖的**方向性**：文本提示**不得**改变交付事实（t4 §4「进度文本≠交付」）。
 */
import { describe, expect, it } from "vitest";
import { PLAN_PATTERN_HINTS, decideTurnDelivery } from "./completion.js";
import {
  MAX_TOOL_ITERATIONS,
  matchesPlanPattern,
  maybeSuggestMemory,
  summarizeEvidence,
} from "./turn.js";

describe("matchesPlanPattern", () => {
  it("命中词表里的任一项即为 true（逐项遍历，不做抽样）", () => {
    for (const hint of PLAN_PATTERN_HINTS) {
      expect(matchesPlanPattern(`好的，${hint}处理这件事`)).toBe(true);
    }
  });

  it("纯结论句不命中（不把已完成的口径误判成计划）", () => {
    expect(matchesPlanPattern("已经写入 hello.md，共 3 行。")).toBe(false);
    expect(matchesPlanPattern("")).toBe(false);
  });

  it("词表逐项命中，且大小写归一化不构成破坏（拉丁字母夹写仍命中）", () => {
    for (const hint of PLAN_PATTERN_HINTS) {
      expect(matchesPlanPattern(hint)).toBe(true);
    }
    // 大小写归一化只在拉丁字母上有意义：验证"正文大小写不影响命中"。
    expect(matchesPlanPattern("markdown 的 TODO 列表")).toBe(matchesPlanPattern("markdown 的 todo 列表"));
    // 中文词表项本身逐项命中（上面已遍历），此处再固定一条最常见的。
    expect(matchesPlanPattern("接下来我会处理")).toBe(true);
  });

  it("命中与否**不改变**交付判定（文本不得覆盖事实，t4 §4 不变量）", () => {
    const planned = "接下来我会读取文件";
    const done = "已读取文件";
    expect(matchesPlanPattern(planned)).toBe(true);
    expect(matchesPlanPattern(done)).toBe(false);
    // 关键：判定只看事实，两条文本喂同一组事实必须得到同一结论。
    const facts = { hasSuccessfulToolCall: true, evidenceCount: 1 } as const;
    expect(decideTurnDelivery(facts)).toBe("verified");
    expect(decideTurnDelivery({ hasSuccessfulToolCall: false, evidenceCount: 0 })).toBe("claimed");
  });
});

describe("summarizeEvidence", () => {
  it("多工具轮次：toolName 取首个、count 为总数、toolCallIds 原样保序", () => {
    const summary = summarizeEvidence([
      { name: "read_file", callId: "call-1" },
      { name: "write_file", callId: "call-2" },
      { name: "run_command", callId: "call-3" },
    ]);
    expect(summary.toolName).toBe("read_file");
    expect(summary.count).toBe(3);
    expect(summary.toolCallIds).toEqual(["call-1", "call-2", "call-3"]);
  });

  it("空列表 → toolName 为 none 且 count 为 0（不是漏填）", () => {
    expect(summarizeEvidence([])).toEqual({ toolName: "none", count: 0, toolCallIds: [] });
  });

  it("单条证据：toolName 即该工具，count 为 1", () => {
    const summary = summarizeEvidence([{ name: "web_search", callId: "c-9" }]);
    expect(summary).toEqual({ toolName: "web_search", count: 1, toolCallIds: ["c-9"] });
  });
});

describe("maybeSuggestMemory（记忆挂钩最小化）", () => {
  it("成功 write_file 且未调用 memory_write → 给出建议串", () => {
    const suggestion = maybeSuggestMemory({
      toolNames: ["write_file"],
      successfulToolNames: ["write_file"],
    });
    expect(suggestion.suggest).toBe(true);
    expect(suggestion.text).toContain("memory_write");
  });

  it("调用过 memory_write → 不再建议（试过的事不重复提醒）", () => {
    expect(
      maybeSuggestMemory({
        toolNames: ["write_file", "memory_write"],
        successfulToolNames: ["write_file", "memory_write"],
      }),
    ).toEqual({ suggest: false, text: "" });
  });

  it("只有只读工具 → 不建议（读文件不产生值得长期记忆的事实）", () => {
    expect(
      maybeSuggestMemory({ toolNames: ["read_file"], successfulToolNames: ["read_file"] }),
    ).toEqual({ suggest: false, text: "" });
  });

  it("write_file **失败** → 不建议（失败的操作没有可记的事实）", () => {
    expect(
      maybeSuggestMemory({ toolNames: ["write_file"], successfulToolNames: [] }),
    ).toEqual({ suggest: false, text: "" });
  });
});

describe("MAX_TOOL_ITERATIONS", () => {
  it("是 8（t4 §5 上限口径）且为正整数", () => {
    expect(MAX_TOOL_ITERATIONS).toBe(8);
    expect(Number.isInteger(MAX_TOOL_ITERATIONS)).toBe(true);
  });
});
