/**
 * agent-core 公开类型契约（骨架期：只有类型，无实现）。
 *
 * 形状对齐 `docs/decisions/t4-backend-architecture.md` §5；
 * 具体工具实现与主循环由后续任务落地，本文件只冻结跨包边界。
 */

/** 工具执行失败分类：运行时据此映射 HTTP/SSE 错误（t4 §5）。 */
export type ToolFailureKind =
  | "input" // 参数不合法 → 400
  | "authorization" // 越权/沙箱拒绝 → 403
  | "runtime"; // 执行期错误 → 500/error 事件

/** 工具失败一律 throw，由运行时统一转 tool_result error（t4 §5）。 */
export class ToolInputError extends Error {
  readonly kind: ToolFailureKind = "input";
  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ToolInputError";
  }
}

export class ToolAuthorizationError extends Error {
  readonly kind: ToolFailureKind = "authorization";
  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ToolAuthorizationError";
  }
}

/** 沙箱判定结果（t4 §6：workspace-only 是**约定级**约束，非安全边界）。 */
export type GuardDecision = "allow" | "blocked" | "readonly";

/** 命令风险分类：只做审批提示，**不当拦截**（t4 §6 诚实标注）。 */
export type CommandRisk = "safe" | "probe" | "mutation" | "dangerous" | "unknown";

/**
 * 工具执行上下文：由调用方（apps/*）注入，core 内不构造。
 *
 * `permissionMode` 为 M2 预留位（子权限不超父，MVP 单 Agent 不实现，见 t4 §6）。
 */
export interface ToolContext {
  /** 沙箱工作区根；PathGuard 以内 rw、以外 blocked/ro。 */
  readonly workspaceRoot: string;
  /** 本次 run 的标识，用于审计与取消传播。 */
  readonly runId: string;
  /** 会话标识（记忆归属）。 */
  readonly sessionId: string;
  /** 取消信号：客户端断线须 abort 本次 run（t4 §2）。 */
  readonly signal: AbortSignal;
  /** 是否发出进度事件；进度永不进模型上下文。 */
  readonly onProgress?: (text: string) => void;
  /** M2 预留：父权限不得被放大。 */
  readonly permissionMode?: "default" | "readonly" | "unrestricted";
}

/** 工具输出：`content` 给模型，`details` 给日志/UI（t4 §5）。 */
export interface ToolResult<D = unknown> {
  readonly content: string;
  readonly details?: D;
}

/**
 * 工具契约。`parameters` 的 schema 类型（TypeBox `TSchema`）由 t4 分派任务引入，
 * 骨架期以 `unknown` 占位，避免提前引入运行时依赖。
 *
 * 形状已冻结在 `packages/protocol`（t3 §8 落定：protocol = 前后端共享 schema）：
 * 7 个内置工具的参数 schema 与状态字面量见 `@agentplant/protocol` 的
 * `TOOL_PARAM_SCHEMAS` / `ToolParams` / `ToolStatus`；本接口的 `P` 即由调用方
 * 用 `Static<typeof TOOL_PARAM_SCHEMAS["read_file"]>` 之类实例化。
 */
export interface Tool<P = unknown, D = unknown> {
  readonly name: string;
  readonly label: string;
  /** 写清"何时用/何时不用"。 */
  readonly description: string;
  readonly parameters: P;
  readonly outputSchema?: unknown;
  readonly sideEffect?: {
    readonly kind: "fs_write" | "fs_delete" | "command" | "network";
    readonly capability: string;
  };
  readonly risk: "safe" | "review";
  execute(ctx: ToolContext, params: P): Promise<ToolResult<D>>;
}
