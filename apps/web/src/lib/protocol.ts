/**
 * apps/web 的**协议类型入口**：一切后端面类型只从 `@agentplant/protocol` 取，本文件不重定义形状。
 *
 * 硬纪律：渲染层产物必须能被浏览器/Electron 直接 `<script type="module">` 加载，
 * 而裸包名说明符在没有打包器的前提下无法解析。因此本文件**只出现 `import type`**
 * （编译期被完全擦除，`verbatimModuleSyntax: true` 保证不做值改写）：
 *   - 类型检查期：类型来自 `packages/protocol/dist`（故 apps/web 的 build 必须排在 protocol 之后）；
 *   - 运行期：零 workspace 依赖，产物是纯相对导入的 ESM（由 scripts/build.mjs 守卫①强制）。
 *
 * 运行期校验（把服务端来的未知 JSON 收窄成协议类型）**只允许活在测试里**：
 * 需要真校验时由 `src/lib/*.test.ts` 直接 import 协议层的 `validate()`（测试文件不进 dist，
 * 也不会让产物出现裸包名）。生产模块的契约守卫由 `scripts/build.mjs` 的守卫①强制。
 */
import type {
  ValidationIssue,
  SseEvent,
  SseEventName,
  SseStartData,
  SseTokenData,
  SseThinkingData,
  SseToolCallData,
  SseToolResultData,
  SseUsageData,
  SseErrorData,
  SseDoneData,
  SseFinishReason,
  TurnDelivery,
  DeliveryEvidence,
  ApiError,
  ChatRequest,
  ChatResponse,
  SessionSummary,
  SessionListResponse,
  SessionCreateResponse,
  Message,
  MessageRole,
  MessagesResponse,
  MemoryItem,
  MemoryKind,
  MemorySearchResponse,
  MemoryDeleteResponse,
  HealthResponse,
  ToolName,
  ToolStatus,
  TaskStatus,
} from "@agentplant/protocol";

export type {
  ValidationIssue,
  SseEvent,
  SseEventName,
  SseStartData,
  SseTokenData,
  SseThinkingData,
  SseToolCallData,
  SseToolResultData,
  SseUsageData,
  SseErrorData,
  SseDoneData,
  SseFinishReason,
  TurnDelivery,
  DeliveryEvidence,
  ApiError,
  ChatRequest,
  ChatResponse,
  SessionSummary,
  SessionListResponse,
  SessionCreateResponse,
  Message,
  MessageRole,
  MessagesResponse,
  MemoryItem,
  MemoryKind,
  MemorySearchResponse,
  MemoryDeleteResponse,
  HealthResponse,
  ToolName,
  ToolStatus,
  TaskStatus,
};

/**
 * 8 种 SSE 事件名（顺序与协议层一致；用作解析器白名单与事件联合的判别键）。
 *
 * 为什么在前端"再写一遍"这 8 个字符串：生产代码不许 import protocol 的**值**（产物必须能被
 * 浏览器直载，裸包名解析不了）。这里用 `satisfies readonly SseEventName[]` 把"与协议同名同序"
 * 变成**编译期约束**（写错一个名字立刻类型报错），并在 `contract.test.ts` 里用协议层的
 * `SSE_EVENT_NAMES` 做运行期逐项比对（漂移必红）。类型仍然从协议单一来源取（`import type`）。
 */
export const SSE_EVENT_NAMES = [
  "start",
  "token",
  "thinking",
  "tool_call",
  "tool_result",
  "usage",
  "error",
  "done",
] as const satisfies readonly SseEventName[];

/** 结束帧原文（`data: [DONE]`）。 */
export const SSE_DONE_FRAME = "data: [DONE]";

/** 事件名 → data 的类型（按事件名从协议的事件联合里取，不手写字段）。 */
export type SseEventDataOf<Name extends SseEventName> =
  SseEvent extends { event: Name; data: infer Data } ? Data : never;

/** 把 `ValidationIssue[]` 压成一行错误摘要（行内错误条的"原始错误摘要"用它）。 */
export function describeIssues(issues: readonly ValidationIssue[]): string {
  return issues.map((issue) => `${issue.path} ${issue.message}`).join("; ");
}
