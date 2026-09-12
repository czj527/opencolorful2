/**
 * @agentplant/agent-core —— 公开 barrel。
 *
 * 骨架期导出：类型契约（`types.ts`）+ 治理内核的纯判定层
 * （`completion.ts` 完成判定 / `audit.ts` 审计元数据 / `turn.ts` 回合级纯函数）。
 * 主循环、工具实现、提示词组装由 t15 等后续任务落地，在此追加导出。
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

export {
  DECIDED_TURN_DELIVERIES,
  NON_TERMINAL_TASK_STATUSES,
  NON_TERMINAL_TOOL_STATUSES,
  PLAN_PATTERN_HINTS,
  TERMINAL_TASK_STATUSES,
  TERMINAL_TOOL_STATUSES,
  decideTurnDelivery,
  isTerminalStatus,
} from "./completion.js";
export type { DecidedTurnDelivery, TurnDeliveryFacts } from "./completion.js";

export { AUDIT_KINDS, PAYLOAD_META_MAX_CHARS, buildAuditMeta } from "./audit.js";
export type { AuditKind, AuditMetaInput } from "./audit.js";

export {
  MAX_TOOL_ITERATIONS,
  MEMORY_SUGGEST_TRIGGER_TOOLS,
  matchesPlanPattern,
  maybeSuggestMemory,
  summarizeEvidence,
} from "./turn.js";
export type { MemorySuggestion, MemorySuggestionFacts } from "./turn.js";
