/**
 * audit 测试：metadata-only + 超限抛错 + kind 枚举冻结。
 *
 * 断言方式刻意"读 JSON"而不是"读字符串包含"：审计的核心不变量是**结构里没有正文键**，
 * 因此先 `JSON.parse` 再断言键集合，再补一条"正文片段不出现在序列化结果里"的字符串断言
 * ——两条一起才排除"键名对但值里塞了正文"这种绕过。
 */
import { describe, expect, it } from "vitest";
import { AUDIT_KINDS, PAYLOAD_META_MAX_CHARS, buildAuditMeta } from "./index.js";

/** 会被当成"正文"的样本：任何一条出现在 payload 里都算违规。 */
const SECRET_BODY = "王五的手机号是 13800000000";

function metaOf(raw: string): Record<string, unknown> {
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("buildAuditMeta（审计只记元数据，t4 §4）", () => {
  it("payload 只有 5 个固定的元数据键，且都是键名/计数/长度/布尔", () => {
    const payload = buildAuditMeta({
      toolName: "read_file",
      argKeys: ["path", "limit"],
      resultBytes: 4096,
      truncated: true,
    });
    expect(Object.keys(metaOf(payload)).sort()).toEqual([
      "argCount",
      "argKeys",
      "resultBytes",
      "toolName",
      "truncated",
    ]);
    expect(metaOf(payload)).toEqual({
      toolName: "read_file",
      argKeys: ["path", "limit"],
      argCount: 2,
      resultBytes: 4096,
      truncated: true,
    });
  });

  it("没有任何正文键（content/text/result/preview/output/args 都不出现）", () => {
    const payload = buildAuditMeta({
      toolName: "write_file",
      argKeys: ["path", "content", "mode"],
      resultBytes: 12,
      truncated: false,
    });
    const keys = Object.keys(metaOf(payload));
    for (const forbidden of ["content", "text", "result", "preview", "output", "args", "value"]) {
      expect(keys).not.toContain(forbidden);
    }
    // `argKeys` 里出现 "content" 只代表"有个叫 content 的键"，不代表记录了它的值。
    expect(metaOf(payload).argKeys).toEqual(["path", "content", "mode"]);
  });

  it("正文片段绝不进 payload（传进去的是键名，序列化结果里找不到正文）", () => {
    const payload = buildAuditMeta({
      toolName: "memory_write",
      // 键名里只允许出现键名：调用方若把正文当键名传，长度上限会兜住（下一条用例）。
      argKeys: Object.keys({ text: SECRET_BODY }),
      resultBytes: Buffer.byteLength(SECRET_BODY, "utf8"),
      truncated: false,
    });
    expect(payload).not.toContain(SECRET_BODY);
    expect(payload).not.toContain("13800000000");
    expect(metaOf(payload).argKeys).toEqual(["text"]);
    expect(metaOf(payload).resultBytes).toBe(Buffer.byteLength(SECRET_BODY, "utf8"));
  });

  it("键顺序稳定：同一输入两次产出完全相同的字符串（可断言/可去重）", () => {
    const input = { toolName: "run_command", argKeys: ["cmd", "cwd"], resultBytes: 7, truncated: false };
    expect(buildAuditMeta(input)).toBe(buildAuditMeta(input));
    expect(Object.keys(metaOf(buildAuditMeta(input)))).toEqual([
      "toolName",
      "argKeys",
      "argCount",
      "resultBytes",
      "truncated",
    ]);
  });

  it("argKeys 原样保序、深拷贝（调用方后续改数组不影响已产出的字符串）", () => {
    const argKeys = ["b", "a"];
    const payload = buildAuditMeta({ toolName: "none", argKeys, resultBytes: 0, truncated: false });
    argKeys.push("later");
    expect(metaOf(payload).argKeys).toEqual(["b", "a"]);
    expect(metaOf(payload).argCount).toBe(2);
  });

  it("恰好 2048 字符放行，2049 字符抛错（边界，与 state DAO 同口径）", () => {
    // 固定部分的字符数（键序固定故可精确推算）：
    // `{"toolName":"read_file","argKeys":["…"],"argCount":1,"resultBytes":0,"truncated":false}`
    // = 86 + 键长。下面第一行的 toBe 断言会在形状漂移时立刻失败（防"算术悄悄过期"）。
    const FIXED_PART_LENGTH = 86;
    const filler = (length: number): string => "k".repeat(length);
    const atLimit = buildAuditMeta({
      toolName: "read_file",
      argKeys: [filler(PAYLOAD_META_MAX_CHARS - FIXED_PART_LENGTH)],
      resultBytes: 0,
      truncated: false,
    });
    expect(atLimit.length).toBe(PAYLOAD_META_MAX_CHARS);

    expect(() =>
      buildAuditMeta({
        toolName: "read_file",
        argKeys: [filler(PAYLOAD_META_MAX_CHARS - FIXED_PART_LENGTH + 1)],
        resultBytes: 0,
        truncated: false,
      }),
    ).toThrow(new RegExp(String(PAYLOAD_META_MAX_CHARS)));
  });

  it("超限是抛错而非截断：报错信息带实际长度，且返回值不存在（不会静默丢审计）", () => {
    const keys = Array.from({ length: 300 }, (_unused, index) => `key_${String(index)}`);
    let caught: unknown;
    try {
      buildAuditMeta({ toolName: "run_command", argKeys: keys, resultBytes: 0, truncated: false });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    // 报错里带真实长度：调用方能据此判断"是键太多还是单个键太长"，而不是只看到一句"超限"。
    expect((caught as Error).message).toMatch(/超过 2048 字符（\d+）/);
    expect((caught as Error).message).toContain("不截断");
  });

  it("resultBytes 只接受非负整数：脏值抛错，不静默取整", () => {
    const base = { toolName: "none", argKeys: [], truncated: false } as const;
    expect(() => buildAuditMeta({ ...base, resultBytes: -1 })).toThrow(/非负整数/);
    expect(() => buildAuditMeta({ ...base, resultBytes: 1.5 })).toThrow(/非负整数/);
    expect(() => buildAuditMeta({ ...base, resultBytes: Number.NaN })).toThrow(/非负整数/);
    // 0 是合法长度（空结果），不能被当成"缺值"。
    expect(metaOf(buildAuditMeta({ ...base, resultBytes: 0 })).resultBytes).toBe(0);
  });
});

describe("AUDIT_KINDS（t4 §4 kind 枚举冻结）", () => {
  it("恰好 7 条且无重复", () => {
    expect(AUDIT_KINDS.length).toBe(7);
    expect(new Set(AUDIT_KINDS).size).toBe(7);
  });

  it("含 t4 §4 冻结的全部取值（顺序即规范顺序）", () => {
    expect([...AUDIT_KINDS]).toEqual([
      "session.start",
      "turn.end",
      "tool.call",
      "tool.result",
      "memory.write",
      "error",
      "state.transition",
    ]);
  });
});
