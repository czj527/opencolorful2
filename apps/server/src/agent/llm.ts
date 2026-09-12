/**
 * agent/llm：模型 provider 客户端（OpenAI-compatible chat completions）。
 *
 * **口径由 backend-authority 定死（t15 任务书 §1），不许改**：
 * - 只走 `POST {BASE}/chat/completions`（OpenAI 兼容形），`Authorization: Bearer <KEY>`；
 * - 配置来自 env：`MODEL_API_BASE` + `MODEL_API_KEY` + `MODEL_NAME`（默认 `deepseek-chat`，
 *   **只是默认值**，代码里没有任何硬编码 key）；
 * - 缺 BASE 或 KEY → `readLlmConfig` 返回 `null`，主循环据此抛
 *   `ToolInputError("未配置模型 provider…")`，经路由转成 SSE `error` 事件 + 非流式 400/500。
 *   **绝不回放 mock 结果充数**（t7 §1.2 FG-03）：一条"看起来像回答"的假回复比明确报错危险得多。
 *
 * 本文件是 server 侧 I/O：允许 `fetch` / 时钟 / env（纯逻辑在 `agent-core`）。
 */
import { lookup } from "node:dns/promises";
import { ToolInputError } from "@agentplant/agent-core";
import { expandNumericIpv4, isPrivateAddress } from "../tools/builtin/net.js";
import type { FetchLike, ResolveHostAddresses } from "../tools/types.js";

/** 未配置模型 provider 时的固定报错文案（测试直接断言它，避免措辞漂移）。 */
export const MODEL_NOT_CONFIGURED_MESSAGE =
  "未配置模型 provider（需要 MODEL_API_BASE 与 MODEL_API_KEY 环境变量）：" +
  "M1 不会回放 mock 回复充数，请先配置 provider 再发起对话";

/** 默认模型名（用户可用 `MODEL_NAME` 覆盖；本仓不硬编码任何厂商 key）。 */
export const DEFAULT_MODEL_NAME = "deepseek-chat";

/** 单次模型请求超时（t15 任务书 §3.3：120s）。 */
export const MODEL_REQUEST_TIMEOUT_MS = 120_000;

/** 模型侧错误的两种 code（与路由的 SSE `error` / 非流式错误码同口径）。 */
export type LlmErrorCode = "model_unconfigured" | "model_request_failed";

export interface LlmConfig {
  /** 去掉末尾斜杠的 base URL（调用时拼 `/chat/completions`）。 */
  readonly base: string;
  readonly key: string;
  readonly model: string;
}

/** 带 code 的模型错误：**唯一**的错误码来源，路由不靠匹配消息文本判断（脆弱）。 */
export class LlmError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/** 判断任意错误是不是本模块产出的模型错误（路由据此映射状态码/错误码）。 */
export function isLlmError(error: unknown): error is LlmError {
  return error instanceof LlmError;
}

/**
 * 从 env 读模型配置；缺 `MODEL_API_BASE` 或 `MODEL_API_KEY` 返回 `null`（= 未配置）。
 *
 * 与 `web_search` 的 `readSearchConfig` 同一形状：**只读 env**，不读配置文件、不落盘。
 * base 末尾斜杠在这里去掉，避免调用点出现 `//chat/completions`（某些网关会 404）。
 */
export function readLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig | null {
  const base = (env.MODEL_API_BASE ?? "").trim().replace(/\/+$/, "");
  const key = (env.MODEL_API_KEY ?? "").trim();
  if (base.length === 0 || key.length === 0) {
    return null;
  }
  const model = (env.MODEL_NAME ?? "").trim();
  return { base, key, model: model.length > 0 ? model : DEFAULT_MODEL_NAME };
}

/**
 * 只允许 http/https 的 base URL（协议面）。
 *
 * 与出网工具的区别在**主机面**：那个守卫把私网一律拒掉（工具的目标是"任意网页"，
 * 私网必是 SSRF）；而 `MODEL_API_BASE` 是**用户自己指定**的自托管模型地址，
 * 本机调试天然要指向 `127.0.0.1:11434` 这类 loopback。所以：
 *
 * | 主机 | 结论 | 理由 |
 * |---|---|---|
 * | loopback（`localhost` / `127.0.0.0/8` / `::1`） | **放行** | 用户自指本机模型服务，M1 主场景 |
 * | 公网 | **放行** | 云 provider |
 * | 私网非环回（`10/8`、`192.168/16`、`172.16/12`、link-local、CGNAT、`.internal`…） | **拒绝** | 典型的"配置被污染成内网探测"，无正常用途 |
 *
 * 域名走真实 DNS（可注入），**任一**解析结果落在私网非环回即拒绝（fail-closed，
 * 与工具侧同一套多变体 DNS 口径）。**诚实标注**：解析与建连之间仍有 TOCTOU 窗口，
 * 与 t4 §6 对工具侧 SSRF 的标注同一性质。
 */
export async function assertAllowedModelBase(
  base: string,
  options: { readonly resolveHost?: ResolveHostAddresses } = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new ToolInputError(`MODEL_API_BASE 不是合法 URL：${base}`, { base });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ToolInputError(`MODEL_API_BASE 只允许 http/https，收到 ${url.protocol}`, { base });
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname.length === 0) {
    throw new ToolInputError("MODEL_API_BASE 缺少主机名", { base });
  }
  if (isLoopbackHost(hostname)) {
    return url;
  }
  if (isIpLiteral(hostname)) {
    // 字面量地址且不是环回：私网段一律拒绝（无需 DNS）。
    if (isPrivateAddress(hostname)) {
      throw new ToolInputError(
        `MODEL_API_BASE 指向私网非环回地址，拒绝（${hostname}）：` +
          "自托管模型请用 loopback（127.0.0.1 / ::1 / localhost），公网 provider 请用域名",
        { base, blockedReason: "private-address" },
      );
    }
    return url;
  }
  const resolver = options.resolveHost ?? defaultResolveHost;
  let addresses: readonly string[];
  try {
    addresses = await resolver(hostname);
  } catch (error) {
    throw new ToolInputError(
      `MODEL_API_BASE 主机名无法解析（${hostname}：${
        error instanceof Error ? error.message : String(error)
      }）`,
      { base },
    );
  }
  if (addresses.length === 0) {
    throw new ToolInputError(`MODEL_API_BASE 主机名解析无结果（${hostname}）`, { base });
  }
  for (const address of addresses) {
    if (isPrivateAddress(address) && !isLoopbackHost(address)) {
      throw new ToolInputError(`MODEL_API_BASE 解析到私网非环回地址，拒绝（${hostname}）`, {
        base,
        blockedReason: "private-resolved",
        hostname,
      });
    }
  }
  return url;
}

function isIpLiteral(hostname: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":");
}

/**
 * 是否环回。
 *
 * `127.1` / `2130706433` / `0x7f.1` 这类**数字变体**必须一并识别：`isPrivateAddress`
 * 会把它们展开成 `127.0.0.1` 判为私网，若这里只看标准四段写法，同一台机器就会
 * 时而放行（`127.0.0.1`）时而拒绝（`127.1`）——口径漂移本身就是 bug。
 */
export function isLoopbackHost(hostname: string): boolean {
  const value = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (value === "localhost" || value.endsWith(".localhost")) {
    return true;
  }
  if (value.includes(":")) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
    if (mapped !== null && mapped[1] !== undefined) {
      return isLoopbackHost(mapped[1]);
    }
    return value === "::1";
  }
  const expanded = expandNumericIpv4(value) ?? value;
  return expanded === "127.0.0.1" || /^127\./.test(expanded);
}

const defaultResolveHost: ResolveHostAddresses = async (hostname) => {
  const results = await lookup(hostname, { all: true });
  return results.map((entry) => entry.address);
};

/** OpenAI 兼容的消息形状（本仓只需这几种字段）。 */
export interface LlmMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly tool_calls?: readonly {
    readonly id: string;
    readonly type: "function";
    readonly function: { readonly name: string; readonly arguments: string };
  }[];
  readonly tool_call_id?: string;
}

/** OpenAI 工具形；`parameters` 直接取 protocol `TOOL_PARAM_SCHEMAS` 的 JSON Schema 原形。 */
export interface LlmToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: unknown;
  };
}

export interface ChatCompletionRequest {
  readonly messages: readonly LlmMessage[];
  readonly tools: readonly LlmToolDefinition[];
  /** M1 用**非流式**（`stream:false`）：流式透传是后续优化（见主循环 JSDoc）。 */
  readonly timeoutMs?: number;
}

/** 归一化后的模型回复（只保留主循环真正消费的字段）。 */
export interface ChatCompletionResult {
  readonly content: string;
  readonly toolCalls: readonly {
    readonly id: string;
    readonly name: string;
    readonly args: string;
  }[];
  readonly usage?: { readonly promptTokens: number; readonly completionTokens: number };
}

/**
 * 调一次 chat completions（**非流式**）。
 *
 * 错误口径（任务书 §3.3）：
 * - 4xx → `LlmError("model_request_failed")`（**调用错误**：key/base/model 不对，
 *   应当由用户纠正配置，不是服务器故障）；
 * - 5xx / 网络错 → 普通 `Error`（**服务故障**，路由按 500 口径处理）；
 * - abort（客户端断线/显式取消）→ **原样抛出** `AbortError`：上层据此区分"取消"与"失败"，
 *   绝不把取消渲染成错误结果（t4 §2）。
 */
export async function chatCompletions(
  fetchImpl: FetchLike,
  config: LlmConfig,
  request: ChatCompletionRequest,
  signal: AbortSignal,
): Promise<ChatCompletionResult> {
  const timeoutMs = request.timeoutMs ?? MODEL_REQUEST_TIMEOUT_MS;
  // 先判"已经取消"：否则一个已 abort 的 signal 在部分实现下会静默成功发起请求。
  if (signal.aborted) {
    throw abortError();
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = AbortSignal.any([signal, timeout]);
  let response;
  try {
    response = await fetchImpl(`${config.base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.key}`,
      },
      // signal 从**同一处**透传：客户端断线 → 请求立即中断（openclaw 教训，t4 §2）。
      signal: combined,
      body: JSON.stringify({
        model: config.model,
        messages: request.messages,
        tools: request.tools,
        tool_choice: "auto",
        stream: false,
      }),
    });
  } catch (error) {
    if (signal.aborted) {
      throw abortError();
    }
    if (timeout.aborted) {
      throw new LlmError("model_request_failed", `模型请求超时（${timeoutMs}ms）`, {
        base: config.base,
        model: config.model,
      });
    }
    // 网络错（DNS/TLS/连接被拒）是**服务故障**，不是调用错误。
    throw new Error(
      `模型请求失败（网络）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (response.status < 200 || response.status >= 300) {
    const detail = await safeText(response);
    const message = `模型 provider 返回 HTTP ${response.status}${
      detail.length === 0 ? "" : `：${truncate(detail, 300)}`
    }`;
    if (response.status >= 400 && response.status < 500) {
      throw new LlmError("model_request_failed", message, {
        status: response.status,
        base: config.base,
        model: config.model,
      });
    }
    throw new Error(message);
  }
  const text = await safeText(response);
  return parseChatCompletion(text);
}

/** 解析 provider 响应；形状不认识就**报错**（不降级成空回复——空回复会被读成"模型没话说"）。 */
export function parseChatCompletion(text: string): ChatCompletionResult {
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    throw new Error("模型 provider 返回的不是合法 JSON");
  }
  if (typeof body !== "object" || body === null) {
    throw new Error("模型 provider 响应不是对象");
  }
  const record = body as Record<string, unknown>;
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error("模型 provider 响应缺少 choices 数组");
  }
  const first = choices[0];
  if (typeof first !== "object" || first === null) {
    throw new Error("模型 provider 响应的 choices[0] 不是对象");
  }
  const message = (first as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) {
    throw new Error("模型 provider 响应的 choices[0].message 不是对象");
  }
  const messageRecord = message as Record<string, unknown>;
  const content = typeof messageRecord.content === "string" ? messageRecord.content : "";
  const rawCalls = messageRecord.tool_calls;
  const toolCalls: { id: string; name: string; args: string }[] = [];
  if (Array.isArray(rawCalls)) {
    for (const [index, entry] of rawCalls.entries()) {
      if (typeof entry !== "object" || entry === null) {
        throw new Error(`模型返回的 tool_calls[${index}] 不是对象`);
      }
      const call = entry as Record<string, unknown>;
      const fn = call.function;
      if (typeof fn !== "object" || fn === null) {
        throw new Error(`模型返回的 tool_calls[${index}].function 不是对象`);
      }
      const fnRecord = fn as Record<string, unknown>;
      const name = typeof fnRecord.name === "string" ? fnRecord.name : "";
      if (name.length === 0) {
        throw new Error(`模型返回的 tool_calls[${index}] 缺少函数名`);
      }
      toolCalls.push({
        id: typeof call.id === "string" && call.id.length > 0 ? call.id : `call-${index}`,
        name,
        args: typeof fnRecord.arguments === "string" ? fnRecord.arguments : "{}",
      });
    }
  }
  const usageRecord = record.usage;
  const usage =
    typeof usageRecord === "object" && usageRecord !== null
      ? {
          promptTokens: numberOr((usageRecord as Record<string, unknown>).prompt_tokens, 0),
          completionTokens: numberOr((usageRecord as Record<string, unknown>).completion_tokens, 0),
        }
      : undefined;
  return { content, toolCalls, ...(usage === undefined ? {} : { usage }) };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 读响应正文；读失败（连接被中断等）不掩盖主错误，返回空串。 */
async function safeText(response: { text(): Promise<string> }): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** 造一个标准 `AbortError`（`DOMException` 在 Node ≥18 恒可用）。 */
function abortError(): Error {
  return new DOMException("本次运行已被取消", "AbortError");
}
