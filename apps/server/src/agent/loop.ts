/**
 * agent/loop：M1-6 agent 主循环（t4 §5 工具调用 + §4 治理内核 + §6 沙箱注入）。
 *
 * 一个回合 = 一次 `runTurn`，形态是经典的 ReAct 往返：
 *
 * ```
 * ensure 会话 → user 落库 → [组装 messages → 调 LLM → 有 tool_calls?
 *      → 逐个执行工具 + 落库 + 发事件 → 回到组装] → 无 tool_calls
 *      → assistant 文本落库 → 交付判定 + 审计 → 返回
 * ```
 *
 * 三条纪律（违反即打回）：
 * 1. **不伪造**：模型 provider 未配置时抛 `ToolInputError`（见 `llm.ts`），工具未注册/执行失败
 *    一律如实 `ok:false`；任何"看起来成功"的占位都必须消失（t7 §1.2 FG-03）。
 * 2. **文本不得覆盖事实**：`delivery` 只由 `decideTurnDelivery` 的事实口径产出；
 *    `matchesPlanPattern` 只额外给出 `blockedHint` 提示位（t4 §4「进度文本≠交付」）。
 * 3. **取消要真的生效**：`signal` 全程透传给模型请求与 `ToolContext.signal`
 *    ——客户端断线后不许还有模型在跑（t4 §2）。
 *
 * **M1 边界（不许伪造 tasks 写入）**：M1 没有 `tasks` 表（M2 才建，t4 §7）。因此
 * 「进度文本落 blocked」在 M1 的语义是**三件可断言的事**：`done.delivery === "claimed"`
 * + `turn.end` 审计 `status: "blocked"` + `blockedHint: true`。任务行的 `blocked` 状态要等
 * M2 的 tasks 表；前端此时按 ia §6.3 渲染「仅计划，尚未执行」标签。本文件**不写任务表**。
 *
 * **M1 流式说明**：模型调用是**非流式**的（`stream:false`），正文一次性发一个 `token` 事件。
 * 事件序因此天然合法（`start` → `token` → `done` → `[DONE]`），只是没有逐字增量；
 * 流式透传（`stream:true` + delta 解析）是后续优化，不改本文件的对外形状。
 *
 * **M1 就地确认语义（M1-9 ③，改动前先读完这一段）**：工具轮里遇到
 * `needsConfirmation` 为真的调用时，本回合**在确认处停下**：
 *
 * 1. 先照常发 `tool_call` 事件（前端据此渲染待确认卡片，ia §4.4），
 * 2. 把 `{callId, name, args}` 登记进 run 注册表的挂起集合（`sse.ts`），
 * 3. **不发 `tool_result`、不执行工具、不再发起下一次模型请求**，直接按
 *    `finishReason: "tool_calls"` 收尾（`delivery` 仍按本回合**已有**的事实判定）。
 *
 * 为什么不是"发一个 `ok:false` 的 tool_result"：`tool_result` 的语义是"这次调用有结论了"，
 * 而挂起恰恰是"没有结论"；protocol 的 `tool_result` 也没有任何字段能表达"待确认"
 * （`SseToolResultDataSchema` 是 closed 的，多塞字段即违约）。前端判定待确认卡片的依据
 * 就是**有 `tool_call` 而没有配对的 `tool_result`**。
 *
 * 后果（如实写下来）：本回合的 `done` 不带 evidence，且**没有** tool 消息落库；
 * 挂起的调用在用户显式 `POST /api/chat/confirm` 之前**永不执行**。
 * 同一批里排在挂起调用之后的调用也不会执行（M1 一次只确认一个，不猜用户意图）。
 */
import {
  MAX_TOOL_ITERATIONS,
  ToolAuthorizationError,
  ToolInputError,
  buildAuditMeta,
  decideTurnDelivery,
  matchesPlanPattern,
  maybeSuggestMemory,
  summarizeEvidence,
  type DecidedTurnDelivery,
  type ToolFailureKind,
} from "@agentplant/agent-core";
import type { StateDao } from "@agentplant/state";
import type { ToolName } from "@agentplant/protocol";
import { registerPendingCall } from "../sse.js";
import { materializeParams } from "../tools/params.js";
import type { FetchLike, ToolRegistry, ToolServices } from "../tools/index.js";
import type { ToolContext } from "../tools/types.js";
import { needsConfirmation } from "./confirmation.js";
import { chatCompletions, type LlmConfig, type LlmMessage } from "./llm.js";

/** 身份 + 工具纪律 + 中文回复（短提示，t15 任务书 §3.2）。 */
export const SYSTEM_PROMPT = [
  "你是 agentplant——一个本地优先的单人私人 AI 助理。运行在用户自己的机器上，工作区就是用户的目录。",
  "",
  "工具使用纪律：",
  "1. 需要事实、需要读文件、需要执行命令时**直接调用工具**，不要凭记忆猜测环境状态。",
  "2. 一次只做能验证的事：调用工具后依据**工具返回的真实结果**回答，不要编造结果。",
  "3. 工具失败时如实说明失败原因与影响，不要假装成功，也不要静默重试三次以上。",
  "4. 文件路径相对工作区根书写；不要试图访问工作区以外的路径（沙箱会拒绝）。",
  "5. 只有在用户明确表达「以后都这样」或跨会话仍然成立的信息时，才用 memory_write 记下来。",
  "",
  "回答用中文，简洁、直给结论；涉及文件/命令时给出具体路径与命令。",
].join("\n");

/** 历史注入条数上限（近 20 条，t15 任务书 §3.2）。 */
export const HISTORY_LIMIT = 20;

/** `tool_result` 事件里的摘要长度上限（UI 卡片 L3 只展示摘要，完整输出只在 messages 表里）。 */
export const TOOL_SUMMARY_MAX_CHARS = 400;

/** 本次回合消费的模型端口（注入以便测试指向本地回环 stub；生产 = `llm.ts` 的真实实现）。 */
export interface TurnLlmClient {
  readonly config: LlmConfig;
  complete(input: {
    readonly messages: readonly LlmMessage[];
    readonly tools: readonly {
      readonly type: "function";
      readonly function: {
        readonly name: string;
        readonly description: string;
        readonly parameters: unknown;
      };
    }[];
    readonly signal: AbortSignal;
  }): Promise<{
    readonly content: string;
    readonly toolCalls: readonly { readonly id: string; readonly name: string; readonly args: string }[];
    readonly usage?: { readonly promptTokens: number; readonly completionTokens: number };
  }>;
}

/** 事件出口：SSE 路径推送事件，非流式路径只读最终返回值（入参可省）。 */
export interface TurnEventSink {
  (event:
    | { readonly name: "start"; readonly data: { readonly runId: string; readonly sessionId: string } }
    | { readonly name: "token"; readonly data: { readonly deltaText: string } }
    | {
        readonly name: "tool_call";
        readonly data: { readonly callId: string; readonly name: string; readonly args: unknown };
      }
    | {
        readonly name: "tool_result";
        readonly data: {
          readonly callId: string;
          readonly ok: boolean;
          readonly summary: string;
          readonly details?: unknown;
        };
      }
    | {
        readonly name: "usage";
        readonly data: { readonly promptTokens: number; readonly completionTokens: number };
      }
    | { readonly name: "thinking"; readonly data: { readonly deltaText: string } }
    | { readonly name: "error"; readonly data: { readonly code: string; readonly message: string } },
  ): void;
}

export interface RunTurnOptions {
  readonly sessionId: string;
  readonly runId: string;
  readonly message: string;
  /** 取消信号：客户端断线 / `/api/chat/abort` 触发；全程透传。 */
  readonly signal: AbortSignal;
  readonly db: StateDao;
  readonly registry: ToolRegistry;
  readonly services: ToolServices;
  readonly llm: TurnLlmClient;
  readonly onEvent?: TurnEventSink;
}

export interface TurnResult {
  readonly runId: string;
  readonly sessionId: string;
  readonly reply: string;
  readonly delivery: DecidedTurnDelivery;
  readonly evidence: {
    readonly toolName: string;
    readonly count: number;
    readonly toolCallIds: readonly string[];
  };
  /** `true`：正文命中计划词且本回合**没有**成功工具调用 → 前端按 ia §6.3 渲染「仅计划」。 */
  readonly blockedHint: boolean;
  /** `tool_calls` = 用满 `MAX_TOOL_ITERATIONS` 仍在调工具（如实标注，不静默截断）。 */
  readonly finishReason: "stop" | "tool_calls";
  readonly toolCalls: readonly { readonly name: string; readonly callId: string; readonly ok: boolean }[];
  /**
   * 本回合**挂起等确认**的调用（非空 = 主循环在确认处停下了）。
   *
   * 它们既不算成功也不算失败（没执行），因此**不在** `toolCalls` / `evidence` 里出现；
   * 这里是给调用方（路由转 `done`、测试断言）看的显式清单，事实源仍是 run 注册表。
   */
  readonly pendingConfirmations: readonly {
    readonly callId: string;
    readonly name: string;
  }[];
  /** 记忆建议（`maybeSuggestMemory` 的产出；仅提示，不自动写库）。 */
  readonly memorySuggestion: string | undefined;
}

/** 组装系统提示：基础纪律 + 本回合真实可用的工具名（不给不存在的工具，避免幻觉调用）。 */
export function buildSystemPrompt(toolNames: readonly string[]): string {
  return `${SYSTEM_PROMPT}\n\n本轮可用工具：${toolNames.join("、")}。`;
}

/** 注册表 → OpenAI tools 形（`parameters` 用 protocol 的 JSON Schema 原形，不做二次包装）。 */
export function toLlmTools(
  registry: ToolRegistry,
): { type: "function"; function: { name: string; description: string; parameters: unknown } }[] {
  return registry.resolve().map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/**
 * 历史消息 → OpenAI messages。
 *
 * `tool` 消息在 OpenAI 形里必须紧跟带 `tool_calls` 的 assistant 消息，而本仓的
 * `messages` 表把 assistant 文本与工具调用分两行存（`role/tool_name/tool_call_id`）。
 * 因此重建时把 `tool` 行配一个**合成的** assistant `tool_calls` 行：
 * 不这么做，严格实现（含部分自托管网关）会因"tool 消息没有对应的调用"直接 400。
 */
export function buildLlmMessages(history: readonly HistoryRow[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (const row of history) {
    if (row.role === "system") {
      continue; // 系统提示由本文件统一组装（历史里同角色会重复压上下文）
    }
    if (row.role === "tool") {
      const callId = row.toolCallId ?? `call-missing-${out.length}`;
      const name = row.toolName ?? "unknown";
      out.push({
        role: "assistant",
        content: null,
        tool_calls: [
          { id: callId, type: "function", function: { name, arguments: "{}" } },
        ],
      });
      out.push({ role: "tool", content: row.content, tool_call_id: callId });
      continue;
    }
    out.push({ role: row.role, content: row.content });
  }
  return out;
}

/** 历史行（`StateDao.listMessages` 的子集，便于纯函数式组装与单测）。 */
export interface HistoryRow {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
}

/** 中文安全截断（码元层面截断会把代理对切成孤字，因此按码点数组切）。 */
function truncateSummary(text: string, max: number): string {
  const points = [...text];
  if (points.length <= max) {
    return text;
  }
  return `${points.slice(0, max).join("")}…（共 ${points.length} 字符）`;
}

/** 工具失败分类（t4 §5）：409/403 口径来自错误类自带 `kind`，未知错误归 `runtime`。 */
function failureKindOf(error: unknown): ToolFailureKind {
  if (error instanceof ToolAuthorizationError) {
    return "authorization";
  }
  if (error instanceof ToolInputError) {
    return "input";
  }
  return "runtime";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asToolError(error: unknown, toolName: string): Error {
  return error instanceof Error ? error : new ToolInputError(`${toolName} 执行失败：${String(error)}`);
}

/**
 * 跑一个回合。
 *
 * @throws ToolInputError 会话已归档（不允许在归档会话里追加回合）
 * @throws ToolInputError 模型 provider 未配置（调用方映射成 SSE `error` + 400 口径）
 * @throws Error 模型 5xx / 网络错（调用方映射成 `error` 事件 + 500 口径）
 * @throws AbortError 本回合被取消（调用方映射成 `done.finishReason: "aborted"`）
 */
export async function runTurn(options: RunTurnOptions): Promise<TurnResult> {
  const { runId, sessionId, db, registry, services, llm, signal } = options;
  const emit: TurnEventSink = options.onEvent ?? (() => undefined);

  // 1) 会话 ensure（无则建；归档 → 拒绝，终态不可降级：归档会话不能再被写入新回合）。
  const existing = db.getSession(sessionId);
  if (existing === null) {
    db.createSession({ id: sessionId });
  } else if (existing.status === "archived") {
    throw new ToolInputError(`会话已归档（${sessionId}）：归档是终态，不能再发起新回合`, {
      sessionId,
    });
  }

  const startedAt = Date.now();
  const history = db.listMessages(sessionId);
  const nextSeq = history.reduce((max, row) => (row.seq > max ? row.seq : max), 0) + 1;
  db.appendMessage({ sessionId, seq: nextSeq, role: "user", content: options.message });

  // 注意：`start` 事件**不在这里发**。它是"一次 run 开始"的传输层事件，由调用方（`routes.ts`）
  // 在**任何可能失败的准备之前**发出——这样"模型未配置""会话已归档"这类更早的失败也不会
  // 让流以 `error` 开头（前端需要一个带 runId 的首帧，t4 §2）。主循环只发回合内事件。

  const tail: HistoryRow[] = history.slice(-HISTORY_LIMIT).map((row) => ({
    role: row.role,
    content: row.content ?? "",
    ...(row.toolName === null ? {} : { toolName: row.toolName }),
    ...(row.toolCallId === null ? {} : { toolCallId: row.toolCallId }),
  }));
  const llmMessages: LlmMessage[] = buildLlmMessages(tail);
  llmMessages.push({ role: "user", content: options.message });

  const llmTools = toLlmTools(registry);
  const toolNames = registry.names();
  const rawCalls: { name: string; callId: string; ok: boolean }[] = [];
  const pendingCalls: { callId: string; name: string }[] = [];
  const evidenceCalls: { name: string; callId: string }[] = [];
  const successfulNames: string[] = [];
  const allNames: string[] = [];
  const transcript: LlmMessage[] = [];
  let reply = "";
  let finishReason: "stop" | "tool_calls" = "stop";
  let seq = nextSeq + 1;
  let memorySuggestion: string | undefined;
  let iterations = 0;
  let paused = false;

  // 2) ReAct 往返：最多 MAX_TOOL_ITERATIONS 轮模型调用。
  for (;;) {
    if (iterations >= MAX_TOOL_ITERATIONS) {
      finishReason = "tool_calls";
      break;
    }
    iterations += 1;
    const systemPrompt = buildSystemPrompt(toolNames);
    const suggestion =
      memorySuggestion === undefined ? "" : `\n\n【上一轮系统提示】${memorySuggestion}`;
    const completion = await llm.complete({
      messages: [
        { role: "system", content: `${systemPrompt}${suggestion}` },
        ...llmMessages,
        ...transcript,
      ],
      tools: llmTools,
      signal,
    });
    if (completion.usage !== undefined) {
      emit({ name: "usage", data: completion.usage });
    }

    if (completion.toolCalls.length === 0) {
      reply = completion.content;
      db.appendMessage({ sessionId, seq, role: "assistant", content: reply });
      seq += 1;
      emit({ name: "token", data: { deltaText: reply } });
      break;
    }

    // 3) 工具轮：逐个调用 → 发事件 → 落库。
    transcript.push({
      role: "assistant",
      content: completion.content.length === 0 ? null : completion.content,
      tool_calls: completion.toolCalls.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: { name: call.name, arguments: call.args },
      })),
    });
    if (completion.content.length > 0) {
      db.appendMessage({ sessionId, seq, role: "assistant", content: completion.content });
      seq += 1;
    }
    // assistant 行里没有 tool_calls 列：把本轮的调用 id 记录在紧随其后的 tool 行上
    // （`messages` 表有 `tool_call_id` 列），历史重建时据此拼回合法形状。

    for (const call of completion.toolCalls) {
      allNames.push(call.name);
      const args = safeParseArgs(call.args);
      emit({
        name: "tool_call",
        data: { callId: call.id, name: call.name, args },
      });
      // 确认只在"本进程真的注册了这个工具"时才有意义：模型幻觉出的名字不该弹确认卡片
      // （它连执行都到不了，执行出口会如实报"未知工具"）。
      const registered = registry.get(call.name) !== undefined;
      if (registered && needsConfirmation(call.name, args, services.guard)) {
        // M1 挂起：登记 → 停在本轮 → 由 for(;;) 外层收尾（见文件头「M1 就地确认语义」）。
        registerPendingCall(runId, sessionId, {
          callId: call.id,
          name: call.name,
          args,
          rawArgs: call.args,
        });
        pendingCalls.push({ callId: call.id, name: call.name });
        paused = true;
        break;
      }

      const result = await executeToolCall({
        registry,
        call,
        runId,
        sessionId,
        signal,
        services,
        redact: (text) => services.redactor.redact(text),
      });
      rawCalls.push({ name: call.name, callId: call.id, ok: result.ok });
      if (result.ok) {
        successfulNames.push(call.name);
        evidenceCalls.push({ name: call.name, callId: call.id });
      }
      emit({
        name: "tool_result",
        data: {
          callId: call.id,
          ok: result.ok,
          summary: result.summary,
          ...(result.details === undefined ? {} : { details: result.details }),
        },
      });
      // 落库的是**完整**结果（模型需要原文），SSE 里的 summary 才是给 UI 的摘要。
      db.appendMessage({
        sessionId,
        seq,
        role: "tool",
        content: result.fullContent,
        toolName: call.name,
        toolCallId: call.id,
      });
      seq += 1;
      transcript.push({ role: "tool", content: result.fullContent, tool_call_id: call.id });
    }

    if (paused) {
      // 确认处停下 = 本轮没有可继续的事实：不组装下一轮请求（也就不再花一次模型调用）。
      finishReason = "tool_calls";
      break;
    }

    // 每轮结束调一次记忆建议（纯函数；命中只作为**下一轮**的系统提示，不自动写库）。
    const suggestionResult = maybeSuggestMemory({
      toolNames: allNames,
      successfulToolNames: successfulNames,
    });
    memorySuggestion = suggestionResult.suggest ? suggestionResult.text : undefined;
  }

  // 4) 收尾：交付判定走事实口径，文本只给提示位（t4 §4 不变量）。
  const evidence = summarizeEvidence(evidenceCalls);
  const delivery = decideTurnDelivery({
    hasSuccessfulToolCall: evidenceCalls.length > 0,
    evidenceCount: evidenceCalls.length,
  });
  const blockedHint = delivery === "claimed" && matchesPlanPattern(reply);

  // 5) turn.end 审计：metadata-only（正文/参数值永不进账本，t4 §4）。
  db.appendAudit({
    kind: "turn.end",
    sessionId,
    runId,
    // M1 无语义上的任务表：blocked 由"仅计划（claimed）+ 命中计划词"三件事共同表达（见文件头）。
    status: blockedHint ? "blocked" : delivery,
    durationMs: Date.now() - startedAt,
    bytesIn: Buffer.byteLength(options.message, "utf8"),
    bytesOut: Buffer.byteLength(reply, "utf8"),
    payloadMeta: buildAuditMeta({
      toolName: evidence.toolName,
      // `argKeys` 是**参数键名**清单（`buildAuditMeta` 的口径，t4 §4）。本层拿不到逐次调用的
      // 物化参数键名（参数在工具内部才物化），因此如实留空——**不拿工具名冒充参数键名**：
      // 账本里的键名对不上，比空数组危险得多（读账的人会以为"这次调用只有这些键"）。
      argKeys: [],
      resultBytes: Buffer.byteLength(reply, "utf8"),
      truncated: false,
    }),
  });

  return {
    runId,
    sessionId,
    reply,
    delivery,
    evidence,
    blockedHint,
    finishReason,
    toolCalls: rawCalls,
    pendingConfirmations: pendingCalls,
    memorySuggestion,
  };
}

/** 解析模型给的参数 JSON：解析失败保留原文（`materializeParams` 会给出准确的参数错误）。 */
function safeParseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { __raw: raw };
  }
}

interface ExecuteCallInput {
  readonly registry: ToolRegistry;
  readonly call: { readonly id: string; readonly name: string; readonly args: string };
  readonly runId: string;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly services: ToolServices;
  readonly redact: (text: string) => string;
}

/** 工具执行的出口形状（给 SSE 的摘要 + 落库的完整内容 + 可选 details）。 */
export interface ExecuteCallOutput {
  readonly ok: boolean;
  /** 给 SSE 的摘要（UI 卡片 L3）。 */
  readonly summary: string;
  /** 落库 / 给模型的完整内容。 */
  readonly fullContent: string;
  readonly details?: unknown;
}

/** 模型 provider 未配置时的构造结果（调用方据此走"诚实报错"分支，见 `llm.ts`）。 */
export type LlmClientResult =
  | { readonly ok: true; readonly client: TurnLlmClient }
  | { readonly ok: false; readonly reason: string };

/**
 * 构造生产用 LLM 客户端（薄包装 `llm.ts` 的 `chatCompletions`）。
 *
 * `fetchImpl` **仅测试注入**（本地回环 stub 服务器）；生产传 `undefined` → 用 `globalThis.fetch`，
 * 与工具侧 `resolveFetch` 同一口径（AGENTS.md 禁 mock 回放：测试必须打真 socket）。
 */
export function createLlmClient(
  config: LlmConfig,
  fetchImpl?: FetchLike,
): TurnLlmClient {
  const doFetch: FetchLike =
    fetchImpl ??
    ((globalThis.fetch as unknown as FetchLike | undefined) ??
      (() => {
        throw new ToolInputError("本运行时没有 globalThis.fetch（需要 Node ≥18）");
      }));
  return {
    config,
    complete: (input) =>
      chatCompletions(
        doFetch,
        config,
        { messages: input.messages, tools: input.tools },
        input.signal,
      ),
  };
}

/**
 * 执行一个工具调用（**唯一**执行出口：主循环与 `POST /api/chat/confirm` 共用）。
 *
 * 沙箱与策略**不在本函数里**：`ctx` 只带 `workspaceRoot`，越权判定由各工具内的
 * `assertAllowed`（`PathGuard`）做（t4 §6）。本函数只负责：取工具 → 物化参数 → 执行 →
 * 把 throw 翻成 `ok:false`（失败分类，t4 §5）。
 *
 * 未知工具名也走这里（如实回 `ok:false`），因此"模型幻觉出的工具名"与"确认后按名执行"
 * 两条路径的措辞天然一致，不会各写一套。
 */
export async function executeToolCall(input: ExecuteCallInput): Promise<ExecuteCallOutput> {
  const tool = input.registry.get(input.call.name);
  if (tool === undefined) {
    const summary = `未知工具：${input.call.name}（不在本进程注册的 7 个内置工具内）`;
    return { ok: false, summary, fullContent: summary };
  }
  const params = safeParseArgs(input.call.args);
  const context: ToolContext = {
    workspaceRoot: input.services.workspaceRoot,
    runId: input.runId,
    sessionId: input.sessionId,
    // signal 原样透传：断线后工具内部的长任务（命令/抓取）一并被取消。
    signal: input.signal,
    onProgress: () => undefined,
  };
  try {
    const result = await tool.execute(
      context,
      // 工具名来自注册表解析（必然是 7 个冻结名之一），schema 由 `materializeParams` 取。
      materializeParams(tool.name as ToolName, params),
    );
    return {
      ok: true,
      summary: truncateSummary(result.content, TOOL_SUMMARY_MAX_CHARS),
      fullContent: result.content,
      ...(result.details === undefined ? {} : { details: result.details }),
    };
  } catch (error) {
    const kind = failureKindOf(error);
    // 失败消息过脱敏器再出网：错误文本可能内嵌 URL/命令原文（t4 §6）。
    const summary = input.redact(`[${kind}] ${errorText(asToolError(error, tool.name))}`);
    return { ok: false, summary, fullContent: summary };
  }
}
