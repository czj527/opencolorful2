/**
 * agent barrel：M1-6 主循环的公开面。
 *
 * 调用方（`routes.ts` / 测试 / 桌面壳）只需要从这里拿：主循环入口、LLM 客户端与配置读取、
 * 状态库单例。**内部件**（`SYSTEM_PROMPT` 之外的事件形状、摘要长度等）按需导出，
 * 但不经第二次转发，避免 barrel 变成"什么都往外漏"的通道。
 */
export {
  HISTORY_LIMIT,
  SYSTEM_PROMPT,
  TOOL_SUMMARY_MAX_CHARS,
  buildLlmMessages,
  buildSystemPrompt,
  createLlmClient,
  executeToolCall,
  runTurn,
  toLlmTools,
} from "./loop.js";
export type {
  ExecuteCallOutput,
  HistoryRow,
  LlmClientResult,
  RunTurnOptions,
  TurnEventSink,
  TurnLlmClient,
  TurnResult,
} from "./loop.js";

export { ALWAYS_CONFIRM_TOOLS, CONFIRM_DECISIONS, NEVER_CONFIRM_TOOLS, needsConfirmation } from "./confirmation.js";
export type { ConfirmDecision } from "./confirmation.js";

export { DENIED_MESSAGE, resolveConfirmation } from "./confirm.js";
export type { ConfirmInput, ConfirmOutcome } from "./confirm.js";

export {
  DEFAULT_MODEL_NAME,
  LlmError,
  MODEL_NOT_CONFIGURED_MESSAGE,
  MODEL_REQUEST_TIMEOUT_MS,
  assertAllowedModelBase,
  chatCompletions,
  isLlmError,
  isLoopbackHost,
  parseChatCompletion,
  readLlmConfig,
} from "./llm.js";
export type { ChatCompletionRequest, ChatCompletionResult, LlmConfig, LlmErrorCode, LlmMessage } from "./llm.js";

export {
  STATE_DB_PATH_ENV,
  closeStateDatabasesForTest,
  defaultStateDbPath,
  hasStateDbOverride,
  openStateDatabase,
} from "./state-db.js";
export type { StateDbHandle } from "./state-db.js";
