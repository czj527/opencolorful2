/**
 * tools/registry：工具注册表（t4 §5「Map + allow/deny」）。
 *
 * 三条语义（逐条对齐 t4 §5 与前端降级约定）：
 * 1. **未知名字 `resolve` 返回空数组、不抛错**：模型可能幻觉出一个不存在的工具名，前端要
 *    降级渲染"通用卡片"而不是把整个回合打断在注册表上。注册重复名字才是真错误（抛错）。
 * 2. **`allow` / `deny` 过滤在解析时生效**：`deny` 优先于 `allow`（拒绝是更强意图）；
 *    `allow` 为空/缺省 = 全部允许。M2 的子权限三件套（子不超父）复用这个入口。
 * 3. **`registerModule` 是 M2 插件扩展点 B**：M1 只有编译期注册，不加载外部代码（t4 §7）。
 *
 * 注册表**不自造第 8 个内置工具**（窄腰纪律，t1-P2-14）：`createCoreRegistry` 注册的
 * 名字必须恰好等于 `TOOL_NAMES`，多一个少一个都由测试守住。
 */
import { TOOL_NAMES, type ToolName } from "@agentplant/protocol";
import { ToolInputError } from "@agentplant/agent-core";
import { createBrowsePageTool } from "./builtin/browse-page.js";
import { createMemorySearchTool, createMemoryWriteTool } from "./builtin/memory.js";
import { createReadFileTool } from "./builtin/read-file.js";
import { createRunCommandTool } from "./builtin/run-command.js";
import { createWebSearchTool } from "./builtin/web-search.js";
import { createWriteFileTool } from "./builtin/write-file.js";
import { CORE_TOOL_GROUP, type RegisteredTool, type Tool, type ToolServices } from "./types.js";

/** `resolve` 的过滤器；`deny` 优先。 */
export interface ToolFilter {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
}

export interface ToolRegistry {
  register(tool: Tool<unknown, unknown>, group?: string): void;
  /** M2 扩展点 B：注册一个"模块"（一批工具 + 组名）。M1 无外部调用方。 */
  registerModule(module: {
    readonly name: string;
    readonly tools: readonly Tool<unknown, unknown>[];
  }): void;
  /** 解析出本次可用的工具（顺序 = 注册顺序，保证 prompt 前缀稳定）。 */
  resolve(filter?: ToolFilter): readonly Tool<unknown, unknown>[];
  /** 名字清单（注册顺序），测试与 `/api/health` 观测用。 */
  names(): readonly string[];
  has(name: string): boolean;
  get(name: string): Tool<unknown, unknown> | undefined;
}

export function createToolRegistry(): ToolRegistry {
  const entries = new Map<string, RegisteredTool>();

  function register(tool: Tool<unknown, unknown>, group: string, builtin: boolean): void {
    if (tool.name.trim().length === 0) {
      throw new ToolInputError("注册工具失败：工具名不能为空");
    }
    if (entries.has(tool.name)) {
      throw new ToolInputError(`注册工具失败：${tool.name} 已注册（重复注册会被静默覆盖，故拒绝）`);
    }
    entries.set(tool.name, { tool, group, builtin });
  }

  return {
    register(tool, group = CORE_TOOL_GROUP) {
      register(tool, group, true);
    },
    registerModule(module) {
      for (const tool of module.tools) {
        register(tool, module.name, false);
      }
    },
    resolve(filter = {}) {
      const allow =
        filter.allow === undefined || filter.allow.length === 0 ? undefined : new Set(filter.allow);
      const deny = new Set(filter.deny ?? []);
      const out: Tool<unknown, unknown>[] = [];
      for (const [name, entry] of entries) {
        if (deny.has(name)) {
          continue;
        }
        if (allow !== undefined && !allow.has(name)) {
          continue;
        }
        out.push(entry.tool);
      }
      return out;
    },
    names: () => [...entries.keys()],
    has: (name) => entries.has(name),
    get: (name) => entries.get(name)?.tool,
  };
}

/**
 * 组装 7 个内置工具的注册表（t5 §4.2 冻结命名）。
 *
 * 返回注册表而不是数组：调用方（t15 主循环）总要按 `allow/deny` 过滤，
 * 直接给数组会诱使调用方绕过过滤器直接用。
 */
export function createCoreRegistry(services: ToolServices): ToolRegistry {
  const registry = createToolRegistry();
  const tools: Tool<unknown, unknown>[] = [
    createReadFileTool(services),
    createWriteFileTool(services),
    createRunCommandTool(services),
    createWebSearchTool(services),
    createBrowsePageTool(services),
    createMemoryWriteTool(services),
    createMemorySearchTool(services),
  ];
  const registered = new Set(tools.map((tool) => tool.name));
  const expected = new Set<string>(TOOL_NAMES);
  const missing = [...expected].filter((name) => !registered.has(name));
  const extra = [...registered].filter((name) => !expected.has(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new ToolInputError(
      `内置工具集与 protocol 的 TOOL_NAMES 不一致：缺少 [${missing.join(", ")}]，` +
        `多出 [${extra.join(", ")}]（窄腰纪律：不允许第 8 个内置工具）`,
    );
  }
  for (const tool of tools) {
    registry.register(tool);
  }
  return registry;
}

export type { ToolName };
