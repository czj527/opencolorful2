/**
 * registry.test.ts：注册表语义（t4 §5 Map + allow/deny）+ 参数物化（默认值/闭包校验）。
 *
 * 关键断言：**注册表恰好等于 protocol 的 `TOOL_NAMES`**（7 个）——窄腰纪律的机器守卫，
 * 想加第 8 个内置工具就必须先改冻结的协议常量（`protocol/src/tools.ts` 文件头已点名）。
 */
import { TOOL_NAMES } from "@agentplant/protocol";
import { ToolInputError } from "@agentplant/agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { READ_FILE_DEFAULT_LIMIT, materializeParams } from "../params.js";
import { createCoreRegistry, createToolRegistry } from "../registry.js";
import { createServices, createTestWorkspace, type TestWorkspace } from "./harness.js";

let workspace: TestWorkspace;

beforeEach(() => {
  workspace = createTestWorkspace();
});

afterEach(() => {
  workspace.cleanup();
});

describe("注册表：内置工具集", () => {
  it("恰好注册协议冻结的 7 个工具（名字与顺序）", () => {
    const registry = createCoreRegistry(createServices(workspace));
    expect(registry.names()).toEqual([...TOOL_NAMES]);
    expect(registry.names()).toHaveLength(7);
  });

  it("旧命名（fs_read/shell_exec/web_fetch/memory）一律不存在", () => {
    const registry = createCoreRegistry(createServices(workspace));
    for (const legacy of ["fs_read", "fs_write", "shell_exec", "web_fetch", "memory"]) {
      expect(registry.has(legacy), legacy).toBe(false);
      expect(registry.get(legacy), legacy).toBeUndefined();
    }
  });

  it("每个工具都带 label/description/parameters 与合法性 risk", () => {
    const registry = createCoreRegistry(createServices(workspace));
    for (const tool of registry.resolve()) {
      expect(tool.label.length, tool.name).toBeGreaterThan(0);
      expect(tool.description.length, tool.name).toBeGreaterThan(0);
      expect(tool.parameters, tool.name).toBeDefined();
      expect(["safe", "review"], tool.name).toContain(tool.risk);
    }
  });

  it("重复注册被拒绝（静默覆盖会让 allow/deny 与 prompt 说不一致）", () => {
    const registry = createToolRegistry();
    const core = createCoreRegistry(createServices(workspace));
    const readFile = core.get("read_file");
    expect(readFile).toBeDefined();
    registry.register(readFile as never);
    expect(() => registry.register(readFile as never)).toThrow(ToolInputError);
  });

  it("空名字注册被拒绝", () => {
    const registry = createToolRegistry();
    expect(() =>
      registry.register({ name: "  ", label: "x", description: "x", parameters: {}, risk: "safe", execute: async () => ({ content: "" }) }),
    ).toThrow(ToolInputError);
  });
});

describe("注册表：resolve 过滤", () => {
  it("未知名字返回空数组而不抛错（前端降级通用卡片）", () => {
    const registry = createCoreRegistry(createServices(workspace));
    expect(registry.resolve({ allow: ["no_such_tool"] })).toEqual([]);
    expect(registry.resolve({ allow: ["fs_read"] })).toEqual([]);
  });

  it("allow 命中时只返回被允许的工具", () => {
    const registry = createCoreRegistry(createServices(workspace));
    const tools = registry.resolve({ allow: ["read_file", "write_file"] });
    expect(tools.map((tool) => tool.name)).toEqual(["read_file", "write_file"]);
  });

  it("deny 生效", () => {
    const registry = createCoreRegistry(createServices(workspace));
    const names = registry.resolve({ deny: ["run_command"] }).map((tool) => tool.name);
    expect(names).not.toContain("run_command");
    expect(names).toHaveLength(6);
  });

  it("deny 优先于 allow（拒绝是更强意图）", () => {
    const registry = createCoreRegistry(createServices(workspace));
    expect(registry.resolve({ allow: ["read_file"], deny: ["read_file"] })).toEqual([]);
  });

  it("空 allow 数组 = 不过滤（不是'谁都不给'）", () => {
    const registry = createCoreRegistry(createServices(workspace));
    expect(registry.resolve({ allow: [] })).toHaveLength(7);
  });

  it("registerModule 注册一批工具（M2 扩展点 B，M1 无外部调用方）", () => {
    const registry = createToolRegistry();
    registry.registerModule({
      name: "demo-plugin",
      tools: [
        {
          name: "demo_tool",
          label: "演示",
          description: "演示工具",
          parameters: {},
          risk: "safe",
          execute: async () => ({ content: "ok" }),
        },
      ],
    });
    expect(registry.names()).toEqual(["demo_tool"]);
    expect(registry.resolve({ deny: ["demo_tool"] })).toEqual([]);
  });
});

describe("参数物化：默认值与校验", () => {
  it("省略的可选字段用 protocol 常量物化", () => {
    const read = materializeParams("read_file", { path: "a.txt" });
    expect(read.offset).toBe(0);
    expect(read.limit).toBe(READ_FILE_DEFAULT_LIMIT);

    const command = materializeParams("run_command", { cmd: "node -v" });
    expect(command.timeoutMs).toBe(10_000);
    expect(command.maxOutputBytes).toBe(51_200);

    const search = materializeParams("web_search", { query: "x" });
    expect(search.count).toBe(5);

    const browse = materializeParams("browse_page", { url: "https://example.com" });
    expect(browse.maxBytes).toBe(51_200);

    const memorySearch = materializeParams("memory_search", { query: "x" });
    expect(memorySearch.limit).toBe(10);
  });

  it("显式给值时不覆盖", () => {
    const read = materializeParams("read_file", { path: "a.txt", offset: 5, limit: 3 });
    expect(read.offset).toBe(5);
    expect(read.limit).toBe(3);
  });

  it("缺必填字段 → ToolInputError（400 口径）", () => {
    expect(() => materializeParams("read_file", {})).toThrow(ToolInputError);
    expect(() => materializeParams("write_file", { path: "a.txt" })).toThrow(ToolInputError);
    expect(() => materializeParams("run_command", {})).toThrow(ToolInputError);
  });

  it("类型不对 → ToolInputError", () => {
    expect(() => materializeParams("read_file", { path: 42 })).toThrow(ToolInputError);
    expect(() => materializeParams("run_command", { cmd: "x", timeoutMs: "10s" })).toThrow(
      ToolInputError,
    );
  });

  it("超出枚举 → ToolInputError（write mode / memory kind）", () => {
    expect(() => materializeParams("write_file", { path: "a", content: "b", mode: "replace" })).toThrow(
      ToolInputError,
    );
    expect(() => materializeParams("memory_write", { kind: "note", text: "x" })).toThrow(
      ToolInputError,
    );
  });

  it("多余字段 → ToolInputError（closed object：静默忽略会造成漂移）", () => {
    expect(() => materializeParams("read_file", { path: "a", extra: 1 })).toThrow(ToolInputError);
  });

  it("非对象参数 → ToolInputError", () => {
    expect(() => materializeParams("read_file", "a.txt")).toThrow(ToolInputError);
    expect(() => materializeParams("read_file", null)).toThrow(ToolInputError);
    expect(() => materializeParams("read_file", ["a"])).toThrow(ToolInputError);
  });
});
