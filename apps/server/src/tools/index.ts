/**
 * tools barrel：工具运行时的公开面（t4 §5）。
 *
 * 只导出**调用方真正会用**的东西：注册表工厂 + 注入面 + 参数物化 + 各工具的独立工厂
 * （测试与 t15 主循环按需单独构造一个工具时用）。内置工具的**内部**（截断实现、SSRF 细节）
 * 从各自文件导入，不经 barrel 扩散。
 */
export type {
  CoreToolName,
  FetchInitLike,
  FetchLike,
  FetchResponseLike,
  ModelConfigOverride,
  RegisteredTool,
  ResolveHostAddresses,
  Tool,
  ToolContext,
  ToolResult,
  ToolServices,
} from "./types.js";
export { CORE_TOOL_GROUP, ToolAuthorizationError, ToolInputError } from "./types.js";

export type { ToolFilter, ToolRegistry } from "./registry.js";
export { createCoreRegistry, createToolRegistry } from "./registry.js";

export type { MaterializedParams } from "./params.js";
export {
  BROWSE_PAGE_DEFAULT_TIMEOUT_MS,
  READ_FILE_DEFAULT_LIMIT,
  WEB_SEARCH_DEFAULT_TIMEOUT_MS,
  materializeParams,
  paramKeys,
} from "./params.js";

export { createBrowsePageTool } from "./builtin/browse-page.js";
export type { BrowsePageDetails } from "./builtin/browse-page.js";
export { createMemorySearchTool, createMemoryWriteTool } from "./builtin/memory.js";
export type { MemorySearchDetails, MemoryWriteDetails } from "./builtin/memory.js";
export { createReadFileTool } from "./builtin/read-file.js";
export { createRunCommandTool, classifyCommand, killProcessTree } from "./builtin/run-command.js";
export type { RunCommandDetails } from "./builtin/run-command.js";
export { createWebSearchTool, readSearchConfig } from "./builtin/web-search.js";
export type { SearchConfig, SearchItem, WebSearchDetails } from "./builtin/web-search.js";
export { createWriteFileTool } from "./builtin/write-file.js";
export type { WriteFileDetails } from "./builtin/write-file.js";
export { RollingBuffer, readLineWindow, truncateTail, truncateToBytes } from "./builtin/text.js";
export type { LineWindow, TailResult } from "./builtin/text.js";
export { MAX_REDIRECTS, guardOutboundUrl, htmlToText, isPrivateAddress } from "./builtin/net.js";
