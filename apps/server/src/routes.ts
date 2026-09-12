/**
 * routes：HTTP 路由表（对齐 t4 §3 端点表 + `protocol/src/api.ts` 的 schema）。
 *
 * 纪律：
 * - **所有请求体/查询串都用 protocol 的 `validate()` 校验**，失败一律 400 + ApiError
 *   `{ code: "bad_request", message }`（不把非法结构当合法用下去）。
 * - 认证：`/api/health` 免认证，其余 `/api/*` 要 `Authorization: Bearer <token>`；
 *   未匹配的路由一律 404 ApiError（先判路由再判认证：未匹配路径不因认证与否改变结论）。
 * - `/api/chat` 走 **M1-6 主循环**（`agent/loop.ts`）：HTTP 层只负责校验 / 认证 / 事件转发 /
 *   错误映射，回合语义（工具调用、交付判定、审计）全在主循环里（t4 §2 单一职责）。
 * - **记忆 / 会话读端点接真库**（t17）：`sessions` / `messages` / `memories` 三个面全部经
 *   `@agentplant/state` 的 `StateDao` 读写（`node:sqlite`，WAL 单文件），**没有内存影子状态**。
 *   端点与 chat 主循环共用**同一个 DAO**（`resolveDao`）——同一库文件，"聊天写 → 列表查"
 *   端到端一致；路由层零 SQL（表结构/触发器/FTS 都属于 `packages/state`）。
 * - 治理内核接线（t4 §4）：`delivery` 由 `decideTurnDelivery` 判定产出（不硬编码），
 *   `turn.end` 审计**由主循环写**（它才知道工具调用事实），abort 写一条 `state.transition`
 *   审计——都只记元数据（`buildAuditMeta`），落在进程内存环形缓冲
 *   （`audit-buffer.ts`）。`GET /api/health` 是探活，**不写审计**。
 * - **模型 provider 未配置**：不得回放 mock 结果充数（t7 §1.2 FG-03），一律
 *   SSE `error`（code `model_unconfigured`）+ 非流式 400 同码。
 * - **M1-9 增补**：`GET /api/memory`（列表分页 + total）、`OPTIONS` 预检
 *   （只回显 loopback origin，`cors.ts`）、`POST /api/chat/confirm`（就地确认，
 *   判定在 `agent/confirm.ts`，挂起语义在 `agent/loop.ts` 文件头）。
 *   `/api/tasks` **不建**（M1 无 tasks 表，t4 §7）：未知路由一律 404，前端走诚实空态。
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ToolInputError,
  buildAuditMeta,
  type Tool,
} from "@agentplant/agent-core";
import {
  ChatAbortRequestSchema,
  ChatConfirmRequestSchema,
  ChatRequestSchema,
  MemoryDeleteRequestSchema,
  MemoryListQuerySchema,
  MemorySearchQuerySchema,
  MemoryWriteRequestSchema,
  MessagesQuerySchema,
  SessionCreateRequestSchema,
  validate,
  type ApiError,
  type HealthResponse,
  type MemoryItem,
  type Message,
  type SessionSummary,
  type ValidationIssue,
  type ValidationResult,
} from "@agentplant/protocol";
import type { MemoryRecord, MessageRecord, StateDao } from "@agentplant/state";
import {
  LlmError,
  MODEL_NOT_CONFIGURED_MESSAGE,
  assertAllowedModelBase,
  createLlmClient,
  readLlmConfig,
  resolveConfirmation,
  runTurn,
  type TurnEventSink,
  type TurnLlmClient,
} from "./agent/index.js";
import { openStateDatabase } from "./agent/state-db.js";
import { appendAudit } from "./audit-buffer.js";
import { checkAuth } from "./auth.js";
import { originOf, sendCorsPreflight } from "./cors.js";
import { createPathGuard } from "./policy/guard.js";
import { defaultRedactor, type Redactor } from "./policy/redactor.js";
import { createCoreRegistry, type ToolRegistry } from "./tools/index.js";
import type { ModelConfigOverride } from "./tools/types.js";
import {
  abortRun,
  endStream,
  finishRun,
  getRun,
  pushEvent,
  registerRun,
  sendSseHeaders,
  watchClientDisconnect,
} from "./sse.js";

/**
 * 沙箱模式固定值 = protocol `SANDBOX_MODES` 的 `workspace-only`（t4 §6）。
 *
 * `workspace-only` 是**约定级**约束（非安全边界）：真正的强制在工具运行时（PathGuard，
 * 见 `policy/guard.ts` 的诚实标注）；本服务不提供 OS 级沙箱。
 */
export const SCAFFOLD_SANDBOX_MODE = "workspace-only";

/** `GET /api/health` 响应体。 */
export interface ScaffoldHealthResponse {
  readonly ok: boolean;
  readonly version: string;
  readonly workspaceRoot: string;
  readonly sandboxMode: "workspace-only";
}

/** 路由上下文：由启动入口（`index.ts`）注入。 */
export interface RouteContext {
  readonly token: string;
  readonly version: string;
  readonly workspaceRoot: string;
  /** 状态库路径（测试注入 tmpdir；缺省读 `STATE_DB_PATH` env，否则用户主目录）。 */
  readonly stateDbPath?: string;
  /** 运行期注入面（**仅测试用**；生产全部留空，见 `RouteRuntimeOverrides`）。 */
  readonly runtime?: RouteRuntimeOverrides;
}

/**
 * 运行期注入面（**仅测试用**，生产全部留空）。
 *
 * 生产路径 = 环境变量 + 真实网络 + 用户主目录下的库：不接受来自**请求**的任何覆盖
 * （否则"模型打哪个主机"会变成远程可控，等于把 SSRF 送到了 HTTP 层）。
 */
export interface RouteRuntimeOverrides {
  /** 记忆/会话 DB 注入（测试用临时库，避免碰用户主目录）。 */
  readonly stateDb?: StateDao;
  /** 模型 provider 覆盖（`null` = 显式未配置）。 */
  readonly model?: ModelConfigOverride;
  /** 沙箱工作区根覆盖。 */
  readonly workspaceRoot?: string;
  /** 脱敏器覆盖。 */
  readonly redactor?: Redactor;
  /** 工具注入面覆盖（注册表 / 工具服务 / 额外工具）。 */
  readonly tools?: {
    readonly registry?: ToolRegistry;
    readonly services?: import("./tools/types.js").ToolServices;
    readonly extraTools?: readonly Tool<unknown, unknown>[];
  };
}

type RouteId =
  | "health"
  | "chat"
  | "chatAbort"
  | "chatConfirm"
  | "sessionList"
  | "sessionCreate"
  | "sessionDelete"
  | "sessionMessages"
  | "memoryWrite"
  | "memoryList"
  | "memorySearch"
  | "memoryDelete";

interface Route {
  readonly id: RouteId;
  readonly sessionId?: string;
}

const SESSION_PATH = /^\/api\/sessions\/([^/]+)$/;
const SESSION_MESSAGES_PATH = /^\/api\/sessions\/([^/]+)\/messages$/;
const MAX_BODY_BYTES = 1024 * 1024;

function decodeSegment(raw: string | undefined): string {
  try {
    return decodeURIComponent(raw ?? "");
  } catch {
    return raw ?? "";
  }
}

/** 路由匹配（方法 + 路径）；未匹配返回 null。 */
function matchRoute(method: string, pathname: string): Route | null {
  if (pathname === "/api/health" && method === "GET") {
    return { id: "health" };
  }
  if (pathname === "/api/chat" && method === "POST") {
    return { id: "chat" };
  }
  if (pathname === "/api/chat/abort" && method === "POST") {
    return { id: "chatAbort" };
  }
  if (pathname === "/api/chat/confirm" && method === "POST") {
    return { id: "chatConfirm" };
  }
  if (pathname === "/api/sessions" && method === "GET") {
    return { id: "sessionList" };
  }
  if (pathname === "/api/sessions" && method === "POST") {
    return { id: "sessionCreate" };
  }
  // `/api/memory/search` 必须先于 `/api/memory` 判：两者路径不同（精确比较不会互相吞），
  // 但顺序写在这里是为了让"读的两种口径"在代码里也保持这个阅读顺序（检索 → 浏览）。
  if (pathname === "/api/memory/search" && method === "GET") {
    return { id: "memorySearch" };
  }
  if (pathname === "/api/memory" && method === "GET") {
    return { id: "memoryList" };
  }
  if (pathname === "/api/memory" && method === "POST") {
    return { id: "memoryWrite" };
  }
  if (pathname === "/api/memory" && method === "DELETE") {
    return { id: "memoryDelete" };
  }
  const messages = SESSION_MESSAGES_PATH.exec(pathname);
  if (messages !== null && method === "GET") {
    return { id: "sessionMessages", sessionId: decodeSegment(messages[1]) };
  }
  const session = SESSION_PATH.exec(pathname);
  if (session !== null && method === "DELETE") {
    return { id: "sessionDelete", sessionId: decodeSegment(session[1]) };
  }
  return null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendApiError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): void {
  const body: ApiError = details === undefined ? { code, message } : { code, message, details };
  sendJson(res, status, body);
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
}

function describeIssues(errors: readonly ValidationIssue[]): string {
  return errors.map((issue) => `${issue.path} ${issue.message}`).join("; ");
}

type BodyResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string };

/** 读请求体并按 JSON 解析；空体按 `{}` 处理（字段全可选的请求体因此合法）。 */
async function readJsonBody(req: IncomingMessage): Promise<BodyResult> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf: Buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer);
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      return { ok: false, message: `请求体超过 ${MAX_BODY_BYTES} 字节上限` };
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) {
    return { ok: true, value: {} };
  }
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, message: "请求体不是合法 JSON" };
  }
}

/**
 * 校验请求体；失败时已写好 400 响应并返回 undefined。
 *
 * 传的是校验闭包而非 schema 本身：类型由 `validate(schema, …)` 就地推导（`ValidationResult<T>`），
 * 本包因此不需要直接依赖 `@sinclair/typebox` 的类型。
 */
async function readValidatedBody<T>(
  req: IncomingMessage,
  res: ServerResponse,
  label: string,
  check: (value: unknown) => ValidationResult<T>,
): Promise<T | undefined> {
  const body = await readJsonBody(req);
  if (!body.ok) {
    sendApiError(res, 400, "bad_request", body.message);
    return undefined;
  }
  const parsed = check(body.value);
  if (!parsed.ok) {
    sendApiError(res, 400, "bad_request", `${label} 校验失败：${describeIssues(parsed.errors)}`, {
      issues: parsed.errors,
    });
    return undefined;
  }
  return parsed.value;
}

function wantsEventStream(req: IncomingMessage): boolean {
  const accept = req.headers.accept;
  return typeof accept === "string" && accept.toLowerCase().includes("text/event-stream");
}

/**
 * 本回合的 `toolName` 占位：**本回合零工具调用**时账本里写它。
 *
 * 用 `"none"` 而不是空串：空串在账本里会被误读成"漏填"，`none` 是"确切地没有工具"。
 * 它同时与 `decideTurnDelivery` 的 `hasSuccessfulToolCall: false` 相互印证。
 * （有工具调用的回合由主循环写 `turn.end`，`toolName` 取首个工具名——见 `agent/loop.ts`。）
 */
const NO_TOOL_SUBJECT = "none";

/**
 * abort 本次 run 并留痕（`state.transition`）。
 *
 * 与 `/api/chat/abort`、客户端断线两条路径**共用**：单一标记入口 + 单一审计入口，
 * 避免两条路径语义漂移（t4 §2）。只有**真的发生了状态迁移**才写审计——未知 runId /
 * 已终态返回 `false`（幂等重放不是一次状态迁移，写进去反而会让账本说谎）。
 */
function abortRunWithAudit(runId: string): boolean {
  const sessionId = getRun(runId)?.sessionId;
  const aborted = abortRun(runId);
  if (aborted) {
    appendAudit({
      kind: "state.transition",
      runId,
      sessionId,
      status: "aborted",
      payloadMeta: buildAuditMeta({
        toolName: NO_TOOL_SUBJECT,
        argKeys: [],
        resultBytes: 0,
        truncated: false,
      }),
    });
  }
  return aborted;
}

/** 错误 → SSE `error` / 非流式错误响应（**唯一**映射点，避免两条路径各写一套码）。 */
interface MappedError {
  readonly code: string;
  readonly message: string;
  readonly httpStatus: number;
}

export function mapChatError(error: unknown, redactor: Redactor = defaultRedactor): MappedError {
  const raw = error instanceof Error ? error.message : String(error);
  const message = redactor.redact(raw);
  if (error instanceof LlmError) {
    return {
      code: error.code,
      message,
      // 模型 provider 未配置 = 调用方要先配置（400）；其余模型侧错误按 502 语义给 500 口径。
      httpStatus: error.code === "model_unconfigured" ? 400 : 500,
    };
  }
  if (error instanceof ToolInputError) {
    // 未配置 provider 的文案由 `agent/llm.ts` 的常量定义（含"未配置模型 provider"）。
    if (raw.includes("未配置模型 provider")) {
      return { code: "model_unconfigured", message, httpStatus: 400 };
    }
    return { code: "bad_request", message, httpStatus: 400 };
  }
  return { code: "internal_error", message, httpStatus: 500 };
}

/**
 * 解析本路由要用的 DAO（`sessions` / `messages` / `memories` 的唯一入口）。
 *
 * 生产：SQLite 单例（`~/.agentplant/agentplant.sqlite`，可被 `STATE_DB_PATH` 覆盖）；
 * 测试：`context.runtime.stateDb` 注入的临时库（**绝不在测试里碰用户主目录**）。
 *
 * 与 chat 主循环**同一出口**（`resolveRuntime` 也走这里）是硬要求：端点和主循环必须落在
 * 同一个库文件上，否则"聊天写、列表查"各写各的（t17 端到端一致性）。
 */
function resolveDao(context: RouteContext): StateDao {
  return context.runtime?.stateDb ?? openStateDatabase(context.stateDbPath).dao;
}

/**
 * 解析本回合的运行期面（DB / 注册表 / 工具服务 / 模型客户端）。
 *
 * 生产：SQLite 单例（`~/.agentplant/agentplant.sqlite`，可被 `STATE_DB_PATH` 覆盖）+
 * 真实工作区守卫 + `globalThis.fetch`。测试：全部经 `context.runtime` 注入。
 */
function resolveRuntime(context: RouteContext): {
  readonly dao: StateDao;
  readonly services: import("./tools/types.js").ToolServices;
  readonly registry: ToolRegistry;
  readonly redactor: Redactor;
} {
  // DB：测试注入的 DAO 优先（**绝不在测试里碰用户主目录**：跑一次测试就在家目录留库是 bug）。
  const dao: StateDao = resolveDao(context);
  const redactor = context.runtime?.redactor ?? defaultRedactor;
  const workspaceRoot = context.runtime?.workspaceRoot ?? context.workspaceRoot;
  const injected = context.runtime?.tools;
  if (injected?.services !== undefined) {
    return {
      dao,
      services: injected.services,
      registry: injected.registry ?? createCoreRegistry(injected.services),
      redactor,
    };
  }
  if (injected?.registry !== undefined) {
    return {
      dao,
      // 只给了注册表（测试用具）时服务面仍然要有真实守卫/脱敏器，避免半截注入。
      services: {
        workspaceRoot,
        guard: createPathGuard(workspaceRoot),
        redactor,
        memoryDb: dao,
      },
      registry: injected.registry,
      redactor,
    };
  }
  const services: import("./tools/types.js").ToolServices = {
    workspaceRoot,
    guard: createPathGuard(workspaceRoot),
    redactor,
    // 记忆工具真正接线（t15 的核心接线动作之一）：不注入时 memory_* 会诚实报错。
    memoryDb: dao,
  };
  const registry = createCoreRegistry(services);
  for (const tool of injected?.extraTools ?? []) {
    registry.registerModule({ name: "test-extra", tools: [tool] });
  }
  return { dao, services, registry, redactor };
}

/**
 * 解析本回合的模型客户端。
 *
 * 两条"未配置"路径都要走到诚实报错：① env 缺 BASE/KEY（`readLlmConfig` 返回 null）；
 * ② base 被配成私网非环回（SSRF 口径，见 `agent/llm.ts`）。**绝不**回放 mock 回复充数。
 */
async function resolveLlmClient(context: RouteContext): Promise<TurnLlmClient> {
  const override = context.runtime?.model;
  if (override?.llm === null) {
    throw new ToolInputError(MODEL_NOT_CONFIGURED_MESSAGE);
  }
  const fromEnv = override?.llm ?? readLlmConfig();
  if (fromEnv === null) {
    throw new ToolInputError(MODEL_NOT_CONFIGURED_MESSAGE);
  }
  await assertAllowedModelBase(fromEnv.base);
  return createLlmClient(fromEnv, override?.fetchImpl);
}

/** SSE 分支：事件原样转发（主循环给什么发什么，路由不重排、不合并，ia §3）。 */
function sseSink(res: ServerResponse): TurnEventSink {
  return (event) => {
    pushEvent(res, event.name, event.data);
  };
}

async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  context: RouteContext,
): Promise<void> {
  const chat = await readValidatedBody(req, res, "ChatRequest", (value) =>
    validate(ChatRequestSchema, value),
  );
  if (chat === undefined) {
    // 校验失败（400）没有登记 run，也就不产生回合：不写 turn.end（写了等于给不存在的回合记账）。
    return;
  }
  const runId = randomUUID();
  const sessionId = chat.sessionId ?? randomUUID();
  const record = registerRun(runId, sessionId);
  const stream = wantsEventStream(req);

  if (stream) {
    sendSseHeaders(res);
  }
  const detach = stream
    ? watchClientDisconnect(req, res, () => {
        abortRunWithAudit(runId);
      })
    : (): void => undefined;

  try {
    // `start` 是**流的第一帧**（t4 §2 事件序），在任何可能失败的准备之前发出：
    // 否则"模型未配置"这类前置失败会让流以 `error` 开头，前端拿到一个没有 runId 的错误。
    if (stream) {
      pushEvent(res, "start", { runId, sessionId });
    }
    const runtime = resolveRuntime(context);
    const llm = await resolveLlmClient(context);
    const result = await runTurn({
      runId,
      sessionId,
      message: chat.message,
      // 断线 → `abortRun` → 同一个 signal 传给模型请求与工具（全程透传，t4 §2）。
      signal: record.controller.signal,
      db: runtime.dao,
      registry: runtime.registry,
      services: runtime.services,
      llm,
      ...(stream ? { onEvent: sseSink(res) } : {}),
    });
    if (stream) {
      pushEvent(res, "done", {
        runId,
        finishReason: result.finishReason,
        delivery: result.delivery,
        ...(result.evidence.count > 0 ? { evidence: result.evidence } : {}),
      });
    } else {
      sendJson(res, 200, {
        runId,
        sessionId,
        reply: result.reply,
        delivery: result.delivery,
        ...(result.evidence.count > 0 ? { evidence: result.evidence } : {}),
      });
    }
    finishRun(runId);
  } catch (error) {
    handleChatFailure(res, runId, error, stream);
  } finally {
    detach();
    if (stream) {
      // `endStream` 幂等性由 `res.end` 保证（已 end 的响应再 end 不会抛）。
      endStream(res);
    } else if (!res.headersSent) {
      // 兜底：上面的 catch 已应答一切错误；走到这里说明分支漏了，明确报错比挂住连接诚实。
      sendApiError(res, 500, "internal_error", "chat 未产生响应（分支遗漏）");
    }
  }
}

/** 失败收尾：SSE 发 `error` 事件（+ 取消时补 `done.finishReason=aborted`），非流式发 ApiError。 */
function handleChatFailure(
  res: ServerResponse,
  runId: string,
  error: unknown,
  stream: boolean,
): void {
  // 取消（客户端断线 / 显式 abort）不是"错误"：语义是本次运行被主动终止。
  const aborted =
    (error instanceof Error && error.name === "AbortError") ||
    getRun(runId)?.aborted === true;
  if (aborted) {
    if (stream) {
      pushEvent(res, "done", { runId, finishReason: "aborted", delivery: "unknown" });
    } else {
      sendApiError(res, 499, "aborted", "本次运行已被取消");
    }
  } else {
    const mapped = mapChatError(error);
    if (stream) {
      // 只发 protocol `SseErrorDataSchema` 声明的字段（该 schema 是 closed 的）：
      // 多塞一个字段就违约。会话定位信息已经在 `start` 事件里给过。
      pushEvent(res, "error", { code: mapped.code, message: mapped.message });
    } else {
      sendApiError(res, mapped.httpStatus, mapped.code, mapped.message);
    }
  }
  // 失败/取消同样是**终态**：标记收尾，避免注册表里留下"看起来还在跑"的 run
  // （否则 `/api/chat/abort` 会对一个早已结束的 run 返回 aborted:true，等于账本说谎）。
  finishRun(runId);
}


async function handleChatAbort(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readValidatedBody(req, res, "ChatAbortRequest", (value) =>
    validate(ChatAbortRequestSchema, value),
  );
  if (body === undefined) {
    return;
  }
  sendJson(res, 200, { aborted: abortRunWithAudit(body.runId) });
}

/**
 * `POST /api/chat/confirm` —— 就地确认（M1-9 ③）。
 *
 * 路由层只做三件事：校验请求体 → 解析本次运行面（**与 chat 同一出口** `resolveRuntime`：
 * 同一份 DB / 注册表 / 沙箱守卫，确认执行的工具与主循环里的完全同源）→ 把服务层的
 * `ConfirmOutcome` 翻成 200 / ApiError。判定逻辑全在 `agent/confirm.ts`。
 *
 * 与 chat 的接口差异（M1 口径）：这里**不写 `turn.end` 审计**——确认不是一个回合，
 * 它只有两条 `tool.call` / `tool.result` 审计（由服务层写）。
 */
async function handleChatConfirm(
  req: IncomingMessage,
  res: ServerResponse,
  context: RouteContext,
): Promise<void> {
  const body = await readValidatedBody(req, res, "ChatConfirmRequest", (value) =>
    validate(ChatConfirmRequestSchema, value),
  );
  if (body === undefined) {
    return;
  }
  const runtime = resolveRuntime(context);
  const outcome = await resolveConfirmation({
    runId: body.runId,
    toolCallId: body.toolCallId,
    decision: body.decision,
    dao: runtime.dao,
    registry: runtime.registry,
    services: runtime.services,
  });
  if (outcome.ok) {
    sendJson(res, 200, outcome.body);
    return;
  }
  sendApiError(res, outcome.status, outcome.code, outcome.message);
}

/** `POST /api/sessions` 缺省标题（`title` 省略或纯空白时用）。 */
const DEFAULT_SESSION_TITLE = "新会话";

/** `messages` 行 → protocol `Message`；`null` 列**不带键**（closed 对象多一个键即违约）。 */
function toApiMessage(row: MessageRecord): Message {
  return {
    id: row.id,
    sessionId: row.sessionId,
    seq: row.seq,
    role: row.role,
    createdAt: row.createdAt,
    ...(row.content === null ? {} : { content: row.content }),
    ...(row.toolName === null ? {} : { toolName: row.toolName }),
    ...(row.toolCallId === null ? {} : { toolCallId: row.toolCallId }),
  };
}

/** `memories` 行 → protocol `MemoryItem`（来源溯源：会话/消息 id 有则带、无则省键）。 */
function toApiMemoryItem(row: MemoryRecord): MemoryItem {
  return {
    id: row.id,
    kind: row.kind,
    text: row.content,
    createdAt: row.createdAt,
    ...(row.sessionId === null ? {} : { sourceSessionId: row.sessionId }),
    ...(row.sourceMsgId === null ? {} : { sourceMessageId: row.sourceMsgId }),
  };
}

async function handleSessionCreate(
  req: IncomingMessage,
  res: ServerResponse,
  dao: StateDao,
): Promise<void> {
  const body = await readValidatedBody(req, res, "SessionCreateRequest", (value) =>
    validate(SessionCreateRequestSchema, value),
  );
  if (body === undefined) {
    return;
  }
  const trimmed = body.title?.trim() ?? "";
  // 落盘（真表）：返回的 `createdAt` 取**库行**的 `created_at`（unix 秒），不是"我以为写进去的
  // 时间"——写后读回，库里是什么就报什么；`id` 也来自库行（缺省由 DAO 生成 uuid）。
  const session = dao.createSession({
    title: trimmed.length > 0 ? trimmed : DEFAULT_SESSION_TITLE,
  });
  sendJson(res, 200, {
    id: session.id,
    title: session.title ?? DEFAULT_SESSION_TITLE,
    createdAt: session.createdAt,
  });
}

/**
 * `GET /api/sessions` —— 真表列表（`updated_at` 倒序，排序由 DAO 的 SQL 负责）。
 *
 * `messageCount` 逐会话调 `listMessages(id).length`：M1 单机库量与消息量都小，一次列表
 * 至多几十次带索引的查询，可接受；**后续优化为一条 `COUNT(*) … GROUP BY session_id`**，
 * 量级上来后这里会是 N+1（改 DAO，不在路由层手写聚合 SQL）。
 *
 * 口径：**只列 `active`**（`dao.listSessions("active")`）。`DELETE /api/sessions/:id` 是
 * **归档**（终态、不物理删行），归档即"从产品视图消失"——归档行仍在表里、消息照常可查
 * （`GET /api/sessions/:id/messages` 不受影响），但不再出现在本列表；与"终态不可降级"
 * 同一口径：归档是一次单向的产品级移除，不是可逆的软标记。
 *
 * `title` 为 `NULL` 的行（chat 主循环 ensure 出的会话不带标题）如实报空串，不编造标题。
 */
function handleSessionList(res: ServerResponse, dao: StateDao): void {
  const sessions: SessionSummary[] = dao.listSessions("active").map((session) => ({
    id: session.id,
    title: session.title ?? "",
    updatedAt: session.updatedAt,
    messageCount: dao.listMessages(session.id).length,
  }));
  sendJson(res, 200, { sessions });
}

/**
 * `DELETE /api/sessions/:id` —— **归档**（`archiveSession`，终态不可回退；不物理删行、
 * 不级联删消息）。
 *
 * 未知 id 仍回 204：DELETE 幂等，重复删 / 删不存在的 id 都不是错误，故 `not_found` 被有意
 * 忽略（不上报、不 404）。已归档再归档同样是幂等成功（DAO 的 CAS 语义）。
 */
function handleSessionDelete(res: ServerResponse, dao: StateDao, sessionId: string): void {
  dao.archiveSession(sessionId);
  sendNoContent(res);
}

/**
 * `GET /api/sessions/:id/messages` —— 真表查询（`?since=` 是 seq 水位，返回 `seq > since`）。
 *
 * 未知 session 回 `{ messages: [] }` **200**（不是 404）：空会话与不存在的会话在前端是同一个
 * 空态，拆成两种响应只会多一条前端分支；`listMessages` 对未知 session 天然回空数组。
 */
function handleSessionMessages(
  url: URL,
  res: ServerResponse,
  dao: StateDao,
  sessionId: string,
): void {
  const query: Record<string, unknown> = {};
  const since = url.searchParams.get("since");
  if (since !== null) {
    query.since = Number(since);
  }
  const parsed = validate(MessagesQuerySchema, query);
  if (!parsed.ok) {
    sendApiError(res, 400, "bad_request", `MessagesQuery 校验失败：${describeIssues(parsed.errors)}`);
    return;
  }
  sendJson(res, 200, {
    messages: dao.listMessages(sessionId, parsed.value.since).map(toApiMessage),
  });
}

/**
 * `GET /api/memory` —— **列表浏览**（M1-9 ①；`created_at` 倒序 + `total`）。
 *
 * 与 `GET /api/memory/search` 的区别是口径而非形状：search 有 `q`、走 FTS5 命中排序；
 * 本端点没有关键词，只有 `scope`/`kind` 等值过滤 + `limit`/`offset` 分页，排序由 DAO
 * 的 SQL 负责（`created_at DESC, id ASC`，与 search 的次序口径一致）。
 *
 * `total` 是**过滤条件下的全量条数**（`countMemories`，忽略 limit/offset）：分页 UI 需要它
 * 才知道"还有多少没加载"；用 `items.length` 冒充会在第二页起就说谎。
 * `limit` 超过 200 由 DAO 的 `clampListLimit` 截断（schema 也拦了一层，两道都在）。
 */
function handleMemoryList(url: URL, res: ServerResponse, dao: StateDao): void {
  const query: Record<string, unknown> = {};
  for (const key of ["scope", "kind"] as const) {
    const value = url.searchParams.get(key);
    if (value !== null) {
      query[key] = value;
    }
  }
  for (const key of ["limit", "offset"] as const) {
    const value = url.searchParams.get(key);
    if (value !== null) {
      query[key] = Number(value);
    }
  }
  const parsed = validate(MemoryListQuerySchema, query);
  if (!parsed.ok) {
    sendApiError(
      res,
      400,
      "bad_request",
      `MemoryListQuery 校验失败：${describeIssues(parsed.errors)}`,
    );
    return;
  }
  const { scope, kind, limit, offset } = parsed.value;
  const filter = {
    ...(scope === undefined ? {} : { scope }),
    ...(kind === undefined ? {} : { kind }),
  };
  sendJson(res, 200, {
    items: dao
      .listMemories({
        ...filter,
        ...(limit === undefined ? {} : { limit }),
        ...(offset === undefined ? {} : { offset }),
      })
      .map(toApiMemoryItem),
    total: dao.countMemories(filter),
  });
}

/**
 * `GET /api/memory/search` —— **FTS5 检索**（`searchMemories` 走 `memories_fts MATCH`，
 * 由 DDL 触发器与 `memories` 同步；路由层不碰 FTS）。
 *
 * 空 / 纯空白 `q` 由 DAO 回 `[]`（不抛错）；`limit` 缺省用 DAO 的默认上限。
 */
function handleMemorySearch(url: URL, res: ServerResponse, dao: StateDao): void {
  const query: Record<string, unknown> = {};
  const q = url.searchParams.get("q");
  if (q !== null) {
    query.q = q;
  }
  const limit = url.searchParams.get("limit");
  if (limit !== null) {
    query.limit = Number(limit);
  }
  const parsed = validate(MemorySearchQuerySchema, query);
  if (!parsed.ok) {
    sendApiError(
      res,
      400,
      "bad_request",
      `MemorySearchQuery 校验失败：${describeIssues(parsed.errors)}`,
    );
    return;
  }
  const { q: text, limit: max } = parsed.value;
  const items = dao.searchMemories(text, max === undefined ? {} : { limit: max }).map(
    toApiMemoryItem,
  );
  sendJson(res, 200, { items });
}

/**
 * `POST /api/memory` —— 写入 `memories` 真表。
 *
 * `text` → 列 `content`；`sessionId` 有则透传（作用域由 DAO 定：有会话 = `session`，
 * 无 = `global`）。返回**库行的真实 id**（写后读回，不是本地拼的 uuid）——这是 AT-401 的
 * 唯一交付凭据。
 *
 * `sessionId` 是**调用方给的引用**，故先查存在性：不存在的会话 → **400 bad_request**
 * （不是 500）。`memories.session_id` 有 FK，直接写会撞 `FOREIGN KEY` 抛错并被兜底映射成
 * `internal_error` ——但那是**调用方的错**，报 500 等于让前端去猜"服务器挂了"。
 * 空 / 纯空白 `sessionId` 视同未给（全局作用域，不做存在性检查）。
 */
async function handleMemoryWrite(
  req: IncomingMessage,
  res: ServerResponse,
  dao: StateDao,
): Promise<void> {
  const body = await readValidatedBody(req, res, "MemoryWriteRequest", (value) =>
    validate(MemoryWriteRequestSchema, value),
  );
  if (body === undefined) {
    return;
  }
  const sessionId = body.sessionId?.trim() ?? "";
  if (sessionId.length > 0 && dao.getSession(sessionId) === null) {
    sendApiError(res, 400, "bad_request", `sessionId 指向的会话不存在：${sessionId}`);
    return;
  }
  const record = dao.writeMemory({
    kind: body.kind,
    content: body.text,
    ...(sessionId.length === 0 ? {} : { sessionId }),
  });
  sendJson(res, 200, { id: record.id });
}

/**
 * `DELETE /api/memory` —— 硬删真表（FTS 由触发器同步，删完立即查不到）。
 *
 * `id` 分支：`forgetMemory(id)` 命中才回该 id；未知 id → `{deleted: []}`（**不是错误**）。
 * `query` 分支：先 `searchMemories` 取 id 再逐个 `forgetMemory`（M1 量小；单次删除上限即
 * 检索默认上限 `DEFAULT_MEMORY_LIMIT`）。后续可收敛为一条 `DELETE … WHERE id IN (…)`。
 * `id` 与 `query` 同时给时以 `id` 为准（精确删除优先）。
 */
async function handleMemoryDelete(
  req: IncomingMessage,
  res: ServerResponse,
  dao: StateDao,
): Promise<void> {
  const body = await readValidatedBody(req, res, "MemoryDeleteRequest", (value) =>
    validate(MemoryDeleteRequestSchema, value),
  );
  if (body === undefined) {
    return;
  }
  // protocol 注释（`MemoryDeleteRequestSchema`）点明该约束由路由运行时校验：
  // `id`/`query` 都不给等于"删库"，必须由调用方明示意图 → 400。
  if (body.id === undefined && body.query === undefined) {
    sendApiError(res, 400, "bad_request", "MemoryDeleteRequest 校验失败：id 与 query 至少给一个");
    return;
  }
  const deleted: string[] = [];
  if (body.id !== undefined) {
    if (dao.forgetMemory(body.id)) {
      deleted.push(body.id);
    }
  } else if (body.query !== undefined) {
    for (const record of dao.searchMemories(body.query)) {
      if (dao.forgetMemory(record.id)) {
        deleted.push(record.id);
      }
    }
  }
  sendJson(res, 200, { deleted });
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  route: Route,
  context: RouteContext,
): Promise<void> {
  switch (route.id) {
    case "health": {
      // 交叉标注 = 编译期护栏：health 形状必须同时满足本包口径与 protocol 的
      // `HealthResponse`（运行期由 server.test.ts 的 `validate()` 真校验兜底）。
      const health: ScaffoldHealthResponse & HealthResponse = {
        ok: true,
        version: context.version,
        workspaceRoot: context.workspaceRoot,
        sandboxMode: SCAFFOLD_SANDBOX_MODE,
      };
      sendJson(res, 200, health);
      return;
    }
    case "chat":
      await handleChat(req, res, context);
      return;
    case "chatAbort":
      await handleChatAbort(req, res);
      return;
    case "chatConfirm":
      await handleChatConfirm(req, res, context);
      return;
    case "sessionList":
      handleSessionList(res, resolveDao(context));
      return;
    case "sessionCreate":
      await handleSessionCreate(req, res, resolveDao(context));
      return;
    case "sessionDelete":
      handleSessionDelete(res, resolveDao(context), route.sessionId ?? "");
      return;
    case "sessionMessages":
      handleSessionMessages(url, res, resolveDao(context), route.sessionId ?? "");
      return;
    case "memoryWrite":
      await handleMemoryWrite(req, res, resolveDao(context));
      return;
    case "memorySearch":
      handleMemorySearch(url, res, resolveDao(context));
      return;
    case "memoryList":
      handleMemoryList(url, res, resolveDao(context));
      return;
    case "memoryDelete":
      await handleMemoryDelete(req, res, resolveDao(context));
      return;
  }
}

/** 单次请求处理（导出便于测试直调；生产路径由 `createRequestHandler` 包一层兜底）。 */
export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  context: RouteContext,
): Promise<void> {
  // base 只用于解析 pathname/searchParams（本服务不产出绝对 URL），故与 Host 头无关。
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const method = req.method ?? "GET";
  // 预检在**路由匹配与认证之前**收场（M1-9 ②）：预检请求按浏览器规范不带 Authorization，
  // 让它走认证只会得到 401，前端看到的是"CORS 失败"这种查不出原因的错。
  // 只回显 loopback origin，其余一律不带 ACAO 头（`cors.ts` 有完整理由）。
  if (method === "OPTIONS") {
    sendCorsPreflight(res, originOf(req.headers));
    return;
  }
  const route = matchRoute(method, url.pathname);
  if (route === null) {
    sendApiError(res, 404, "not_found", `未知路由：${method} ${url.pathname}`);
    return;
  }
  if (route.id !== "health") {
    const auth = checkAuth(req, context.token);
    if (auth !== "ok") {
      sendApiError(
        res,
        401,
        "unauthorized",
        auth === "missing"
          ? "缺少 Authorization: Bearer <token> 请求头"
          : "Authorization token 无效",
      );
      return;
    }
  }
  await dispatch(req, res, url, route, context);
}

/** 组装 node:http 的 handler（异常兜底成 500 ApiError）。 */
export function createRequestHandler(
  context: RouteContext,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    handleRequest(req, res, context).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // 密钥永不落日志：错误消息可能内嵌 URL/命令原文，先过 redactor 再出网（t4 §6）。
      const safeMessage = defaultRedactor.redact(message);
      process.stderr.write(`[server] 未处理异常：${safeMessage}\n`);
      if (res.headersSent) {
        res.end();
        return;
      }
      sendApiError(res, 500, "internal_error", `服务器内部错误：${safeMessage}`);
    });
  };
}
