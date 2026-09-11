/**
 * @agentplant/agent-core —— 公开 barrel（骨架期只导出类型与常量）。
 *
 * 主循环、工具实现、记忆读写、提示词组装由后续任务落地；在此追加导出。
 */
export { AGENT_CORE_VERSION } from "./version.js";
export type {
  CommandRisk,
  GuardDecision,
  Tool,
  ToolContext,
  ToolFailureKind,
  ToolResult,
} from "./types.js";
export { ToolAuthorizationError, ToolInputError } from "./types.js";
