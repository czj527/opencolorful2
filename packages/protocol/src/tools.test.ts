/**
 * 工具契约测试：7 个工具的命名与参数边界 / 默认值语义 / 状态字面量取值集合。
 *
 * 依据：t5 §4.2（工具命名）、t4 §5（参数形状）、t4 §6（命令默认超时与截断）、
 *      t5 §4.3（tool 6 态）、t5 §6.2（task 7 态）。
 */
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { validate } from "./index.js";
import {
  BROWSE_PAGE_DEFAULT_MAX_BYTES,
  MEMORY_SEARCH_DEFAULT_LIMIT,
  RUN_COMMAND_DEFAULT_MAX_OUTPUT_BYTES,
  RUN_COMMAND_DEFAULT_TIMEOUT_MS,
  TASK_STATUSES,
  TOOL_NAMES,
  TOOL_PARAM_SCHEMAS,
  TOOL_STATUSES,
  WEB_SEARCH_DEFAULT_COUNT,
  type ToolName,
} from "./tools.js";
import { TURN_DELIVERIES } from "./sse.js";

/** 取某工具参数 schema 的字段注解（用于断言 default 与形状）。 */
function fieldSchema(name: ToolName, field: string): Record<string, unknown> | undefined {
  const properties = TOOL_PARAM_SCHEMAS[name].properties as Record<string, object>;
  return properties[field] as Record<string, unknown> | undefined;
}

describe("工具命名（t5 §4.2 为准，t4 旧名作废）", () => {
  it("恰好 7 个工具，顺序固定", () => {
    expect(TOOL_NAMES).toEqual([
      "read_file",
      "write_file",
      "run_command",
      "web_search",
      "browse_page",
      "memory_write",
      "memory_search",
    ]);
  });

  it("注册表键集合与 TOOL_NAMES 完全一致", () => {
    expect(Object.keys(TOOL_PARAM_SCHEMAS).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("旧名（fs_read/fs_write/shell_exec/web_fetch/memory）不存在", () => {
    const legacy = ["fs_read", "fs_write", "shell_exec", "web_fetch", "memory"];
    for (const name of legacy) {
      expect(TOOL_NAMES as readonly string[]).not.toContain(name);
      expect(Object.keys(TOOL_PARAM_SCHEMAS)).not.toContain(name);
    }
  });
});

describe("状态字面量取值集合", () => {
  it("ToolStatus 6 态", () => {
    expect(TOOL_STATUSES).toEqual([
      "pending",
      "running",
      "success",
      "error",
      "denied",
      "cancelled",
    ]);
  });

  it("TaskStatus 7 态（needs_input 与 blocked 并列，不是失败）", () => {
    expect(TASK_STATUSES).toEqual([
      "pending",
      "running",
      "blocked",
      "needs_input",
      "completed",
      "failed",
      "cancelled",
    ]);
  });

  it("TurnDelivery 三态", () => {
    expect(TURN_DELIVERIES).toEqual(["claimed", "verified", "unknown"]);
  });
});

describe("必需 / 可选边界", () => {
  /** [工具名, 只给必填字段的合法参数, 其中一个必填字段名] */
  const cases: ReadonlyArray<readonly [ToolName, Record<string, unknown>, string]> = [
    ["read_file", { path: "a.txt" }, "path"],
    ["write_file", { path: "a.txt", content: "", mode: "create" }, "content"],
    ["run_command", { cmd: "echo hi" }, "cmd"],
    ["web_search", { query: "ts" }, "query"],
    ["browse_page", { url: "https://example.com" }, "url"],
    ["memory_write", { kind: "preference", text: "喜欢深色" }, "kind"],
    ["memory_search", { query: "深色" }, "query"],
  ];

  it.each(cases)("%s 只给必填字段即可通过（可选字段不是必需）", (name, params) => {
    expect(validate(TOOL_PARAM_SCHEMAS[name], params).ok).toBe(true);
  });

  it.each(cases)("%s 缺少必填字段即失败", (name, params, dropped) => {
    const withoutField = { ...params };
    delete withoutField[dropped];
    expect(validate(TOOL_PARAM_SCHEMAS[name], withoutField).ok).toBe(false);
  });

  it.each(cases)("%s 的 required 集合恰为必填字段（可选字段不在其中）", (name, params, dropped) => {
    const required = [...(TOOL_PARAM_SCHEMAS[name].required ?? [])].sort();
    // write_file 有三个必填字段，其它工具各一个；断言口径统一为"必填 ⊆ 样例给的键"。
    expect(required).toContain(dropped);
    expect(required.length).toBeGreaterThan(0);
    expect(required.length).toBeLessThanOrEqual(Object.keys(params).length);
  });

  it("write_file 的 mode 只接受 create/overwrite/append", () => {
    for (const mode of ["create", "overwrite", "append"]) {
      expect(validate(TOOL_PARAM_SCHEMAS.write_file, { path: "a", content: "", mode }).ok).toBe(
        true,
      );
    }
    expect(
      validate(TOOL_PARAM_SCHEMAS.write_file, { path: "a", content: "", mode: "truncate" }).ok,
    ).toBe(false);
  });

  it("memory_write 的 kind 只接受 preference/fact", () => {
    expect(validate(TOOL_PARAM_SCHEMAS.memory_write, { kind: "note", text: "t" }).ok).toBe(false);
  });

  it("read_file 的 offset 允许 0，limit 必须 >= 1", () => {
    expect(validate(TOOL_PARAM_SCHEMAS.read_file, { path: "a", offset: 0 }).ok).toBe(true);
    expect(validate(TOOL_PARAM_SCHEMAS.read_file, { path: "a", offset: -1 }).ok).toBe(false);
    expect(validate(TOOL_PARAM_SCHEMAS.read_file, { path: "a", limit: 0 }).ok).toBe(false);
  });

  it("run_command 的 cwd 是可选非空字符串", () => {
    expect(validate(TOOL_PARAM_SCHEMAS.run_command, { cmd: "pwd", cwd: "sub" }).ok).toBe(true);
    expect(validate(TOOL_PARAM_SCHEMAS.run_command, { cmd: "pwd", cwd: "" }).ok).toBe(false);
  });

  it("可选字段一律是 Type.Optional（多字段必填会被这里挡住）", () => {
    expect(TOOL_PARAM_SCHEMAS.run_command.required).toEqual(["cmd"]);
    expect(TOOL_PARAM_SCHEMAS.web_search.required).toEqual(["query"]);
    expect(TOOL_PARAM_SCHEMAS.browse_page.required).toEqual(["url"]);
    expect(TOOL_PARAM_SCHEMAS.memory_search.required).toEqual(["query"]);
    expect(TOOL_PARAM_SCHEMAS.memory_write.required).toEqual(["kind", "text"]);
    expect(TOOL_PARAM_SCHEMAS.read_file.required).toEqual(["path"]);
    expect(TOOL_PARAM_SCHEMAS.write_file.required).toEqual(["path", "content", "mode"]);
  });
});

describe("默认值语义", () => {
  it("默认值常量与 schema 注解一致", () => {
    expect(fieldSchema("run_command", "timeoutMs")?.default).toBe(RUN_COMMAND_DEFAULT_TIMEOUT_MS);
    expect(fieldSchema("run_command", "maxOutputBytes")?.default).toBe(
      RUN_COMMAND_DEFAULT_MAX_OUTPUT_BYTES,
    );
    expect(fieldSchema("web_search", "count")?.default).toBe(WEB_SEARCH_DEFAULT_COUNT);
    expect(fieldSchema("browse_page", "maxBytes")?.default).toBe(BROWSE_PAGE_DEFAULT_MAX_BYTES);
    expect(fieldSchema("memory_search", "limit")?.default).toBe(MEMORY_SEARCH_DEFAULT_LIMIT);
  });

  it("默认值符合 t4 §6：命令 10s 超时 / 50KiB 截断", () => {
    expect(RUN_COMMAND_DEFAULT_TIMEOUT_MS).toBe(10_000);
    expect(RUN_COMMAND_DEFAULT_MAX_OUTPUT_BYTES).toBe(51_200);
    expect(BROWSE_PAGE_DEFAULT_MAX_BYTES).toBe(51_200);
    expect(WEB_SEARCH_DEFAULT_COUNT).toBe(5);
    expect(MEMORY_SEARCH_DEFAULT_LIMIT).toBe(10);
  });

  it("Value.Check 不改写数据：缺省字段保持缺省（默认值由运行时用常量物化）", () => {
    const params = { cmd: "echo hi" };
    expect(validate(TOOL_PARAM_SCHEMAS.run_command, params).ok).toBe(true);
    expect(params).toEqual({ cmd: "echo hi" });
    expect("timeoutMs" in params).toBe(false);
  });

  it("Value.Default 可按 schema 注解物化默认值（运行时统一补默认的依据）", () => {
    const filled = Value.Default(TOOL_PARAM_SCHEMAS.run_command, { cmd: "echo hi" }) as Record<
      string,
      unknown
    >;
    expect(filled.timeoutMs).toBe(RUN_COMMAND_DEFAULT_TIMEOUT_MS);
    expect(filled.maxOutputBytes).toBe(RUN_COMMAND_DEFAULT_MAX_OUTPUT_BYTES);
  });
});
