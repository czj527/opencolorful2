/**
 * 后端 HTTP 客户端（唯一出口）。
 *
 * 契约：`packages/protocol/src/api.ts`（端点表 + 统一错误形 `ApiError`）。
 * 认证：`Authorization: Bearer <token>`（apps/server README「认证语义」）；
 *   `GET /api/health` 免认证；401 必须给**明确提示**，不许静默失败（P5）。
 *
 * 错误处理采用"返回值而非异常"：每个请求返回 `Ok | Fail`，
 * 调用方必须显式处理失败分支，避免 catch 吞掉错误后渲染成空态（这会伪装成"你没有数据"）。
 */
import type {
  ApiError,
  ChatRequest,
  HealthResponse,
  MemoryDeleteResponse,
  MemorySearchResponse,
  MessagesResponse,
  SessionCreateResponse,
  SessionListResponse,
} from "./protocol.js";

/** 默认本地 server 地址（apps/server 默认 `PORT=43121`，与 DSH 的 43120 错开一位）。 */
export const DEFAULT_BASE_URL = "http://127.0.0.1:43121";

/** 失败分支：`status` 为 null 表示请求根本没到服务端（网络层）。 */
export interface RequestFailure {
  readonly status: number | null;
  readonly code: string;
  readonly message: string;
  /** 后端 `ApiError.details` 的原文（沙箱拦截/限额拒绝等场景必须能显示原文）。 */
  readonly details: unknown;
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: RequestFailure };

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** 401 的固定用户文案（IA §3.8-E2 口径）。 */
export const UNAUTHORIZED_HINT = "未授权：请在「设置」中填写访问令牌（Bearer token）后重试。";

export interface ClientOptions {
  readonly baseUrl?: string;
  readonly token?: () => string | null;
  readonly fetchImpl?: Fetcher;
}

export class Client {
  readonly baseUrl: string;
  private readonly token: () => string | null;
  private readonly fetcher: Fetcher;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.token = options.token ?? (() => null);
    this.fetcher = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    const token = this.token();
    if (token !== null && token !== "") {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  /** 把非 2xx 响应体解析成 `RequestFailure`（解析不出来就退回 HTTP 状态码文案）。 */
  private async failureOf(response: Response): Promise<RequestFailure> {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const apiError = body as Partial<ApiError> | null;
    if (apiError !== null && typeof apiError.code === "string") {
      return {
        status: response.status,
        code: apiError.code,
        message: typeof apiError.message === "string" && apiError.message !== "" ? apiError.message : response.statusText,
        details: apiError.details ?? null,
      };
    }
    return {
      status: response.status,
      code: `http_${response.status}`,
      message: response.statusText === "" ? `HTTP ${response.status}` : response.statusText,
      details: body,
    };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<Result<T>> {
    let response: Response;
    try {
      response = await this.fetcher(this.url(path), init);
    } catch (error) {
      return {
        ok: false,
        error: {
          status: null,
          code: "network_error",
          message: `本地服务不可达（${this.baseUrl}）：${error instanceof Error ? error.message : String(error)}`,
          details: null,
        },
      };
    }
    if (!response.ok) {
      return { ok: false, error: await this.failureOf(response) };
    }
    try {
      return { ok: true, value: (await response.json()) as T };
    } catch (error) {
      return {
        ok: false,
        error: {
          status: response.status,
          code: "invalid_json",
          message: `响应不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
          details: null,
        },
      };
    }
  }

  /** 探活（免认证）。 */
  health(): Promise<Result<HealthResponse>> {
    return this.request<HealthResponse>("/api/health", { headers: this.headers() });
  }

  listSessions(): Promise<Result<SessionListResponse>> {
    return this.request<SessionListResponse>("/api/sessions", { headers: this.headers() });
  }

  createSession(title?: string): Promise<Result<SessionCreateResponse>> {
    return this.request<SessionCreateResponse>("/api/sessions", {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(title === undefined ? {} : { title }),
    });
  }

  listMessages(sessionId: string, since?: number): Promise<Result<MessagesResponse>> {
    const query = since === undefined ? "" : `?since=${String(since)}`;
    return this.request<MessagesResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages${query}`,
      { headers: this.headers() },
    );
  }

  /**
   * 记忆检索。`q` 是 `minLength: 1` 的必填查询词（协议层口径）——
   * **没有"列出全部"的读端点**，故本方法不提供空查询语义（调用方见 memory.ts 的 planSearch）。
   */
  searchMemories(query: string): Promise<Result<MemorySearchResponse>> {
    const params = new URLSearchParams({ q: query });
    return this.request<MemorySearchResponse>(`/api/memory/search?${params.toString()}`, {
      headers: this.headers(),
    });
  }

  /** 删除一条记忆（按 id；`deleted: []` = 没命中，不是错误）。 */
  deleteMemory(id: string): Promise<Result<MemoryDeleteResponse>> {
    return this.request<MemoryDeleteResponse>("/api/memory", {
      method: "DELETE",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ id }),
    });
  }

  abortRun(runId: string): Promise<Result<{ aborted: boolean }>> {
    return this.request<{ aborted: boolean }>("/api/chat/abort", {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ runId }),
    });
  }

  /**
   * 发起流式对话：**返回原始 Response 而不是解析结果**，
   * 让 sse.ts 的解析器与 chat 视图负责事件顺序与渲染（职责不混）。
   *
   * 失败时返回 `RequestFailure`（含 401 的明确文案）。
   */
  async chatStream(body: ChatRequest): Promise<Result<Response>> {
    let response: Response;
    try {
      response = await this.fetcher(this.url("/api/chat"), {
        method: "POST",
        headers: this.headers({
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        }),
        body: JSON.stringify(body),
      });
    } catch (error) {
      return {
        ok: false,
        error: {
          status: null,
          code: "network_error",
          message: `本地服务不可达（${this.baseUrl}）：${error instanceof Error ? error.message : String(error)}`,
          details: null,
        },
      };
    }
    if (!response.ok) {
      return { ok: false, error: await this.failureOf(response) };
    }
    return { ok: true, value: response };
  }
}

/** 把失败分支渲染成一句给人看的话（401 走固定提示，其余带原文）。 */
export function failureMessage(failure: RequestFailure): string {
  if (failure.status === 401) {
    return UNAUTHORIZED_HINT;
  }
  const detail = failure.details === null ? "" : ` · ${JSON.stringify(failure.details)}`;
  return `${failure.message}（${failure.code}）${detail}`;
}

/**
 * 把 `ReadableStream<Uint8Array>` 解成文本块异步迭代器（SSE 的增量输入）。
 * 拆成独立函数是为了让单测能直接喂"任意分块的字节序列"，不必真的有网络。
 */
export async function* streamChunks(
  stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8");
  if (Symbol.asyncIterator in stream) {
    for await (const chunk of stream as AsyncIterable<Uint8Array>) {
      yield decoder.decode(chunk, { stream: true });
    }
  } else {
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value !== undefined) {
          yield decoder.decode(value, { stream: true });
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
  const tail = decoder.decode();
  if (tail !== "") {
    yield tail;
  }
}
