/**
 * server 测试：真实 HTTP（每用例起 ephemeral 端口 + node:http 原生客户端，跑完 close）。
 *
 * 覆盖（除本文件外：`auth.test.ts` 认证分支、`sse.test.ts` 注册表语义、
 * `agent/__tests__/chat-loop.test.ts` 主循环内行为与就地确认协议）：
 * 认证 / 路由兜底 / sessions / messages / memory（含 `GET /api/memory` 列表）/
 * CORS 预检 / 断线触发 abort / **chat 在模型未配置时的诚实报错路径**（t7 §1.2 FG-03 的反面证据）/
 * **驳回项 `/api/tasks` 必须是 404**（M1 无 tasks 表，t4 §7）。
 *
 * 状态库一律指向 `os.tmpdir()`（跑完删除）：**测试绝不碰 `~/.agentplant`**，
 * 仓内也永不落 `*.sqlite`（AGENTS.md 硬约束 1）。
 *
 * 不许加测试依赖：只用 node:http + vitest。
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApiErrorSchema,
  ChatAbortResponseSchema,
  HealthResponseSchema,
  MemoryDeleteResponseSchema,
  MemoryListResponseSchema,
  MemorySearchResponseSchema,
  MemoryWriteResponseSchema,
  MessagesResponseSchema,
  SessionCreateResponseSchema,
  SessionListResponseSchema,
  SseErrorDataSchema,
  SseStartDataSchema,
  validate,
} from "@agentplant/protocol";
import type { StateDao } from "@agentplant/state";
import { auditEventCount, listAuditEvents, resetAuditForTest } from "./audit-buffer.js";
import { createServer } from "./index.js";
import { closeStateDatabasesForTest, openStateDatabase } from "./agent/index.js";
import {
  abortRun,
  endStream,
  getRun,
  pushEvent,
  registerRun,
  resetRunsForTest,
  sendSseHeaders,
  watchClientDisconnect,
} from "./sse.js";

const TOKEN = "test-token";
const TEST_VERSION = "0.0.0-test";
/** 模型相关 env：本文件全部用例都必须在"未配置"状态下跑（诚实报错路径）。 */
const MODEL_ENV_KEYS = ["MODEL_API_BASE", "MODEL_API_KEY", "MODEL_NAME", "STATE_DB_PATH"] as const;
const savedEnv = { ...process.env };

interface RawResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
  readonly json: unknown;
}

function listen(server: Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo | null;
      if (address === null) {
        reject(new Error("server 未返回地址"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

interface SendOptions {
  readonly method: string;
  readonly path: string;
  readonly token?: string;
  readonly accept?: string;
  readonly body?: unknown;
  /** `Origin` 头（CORS 预检用例；其余用例不传 = 非浏览器客户端）。 */
  readonly origin?: string;
}

function send(port: number, options: SendOptions): Promise<RawResponse> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers: Record<string, string> = {};
  if (options.token !== undefined) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  if (options.accept !== undefined) {
    headers.Accept = options.accept;
  }
  if (options.origin !== undefined) {
    headers.Origin = options.origin;
  }
  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(Buffer.byteLength(payload));
  }
  return new Promise<RawResponse>((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, method: options.method, path: options.path, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          let json: unknown;
          try {
            json = body.length === 0 ? undefined : (JSON.parse(body) as unknown);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("等待条件超时");
}

let server: Server;
let port: number;
let tempDir: string;

beforeEach(async () => {
  resetRunsForTest();
  resetAuditForTest();
  closeStateDatabasesForTest();
  for (const key of MODEL_ENV_KEYS) {
    delete process.env[key];
  }
  tempDir = join(tmpdir(), `agentplant-server-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  server = createServer({
    token: TOKEN,
    version: TEST_VERSION,
    workspaceRoot: tempDir,
    stateDbPath: join(tempDir, "agentplant.sqlite"),
  });
  port = await listen(server);
});

afterEach(async () => {
  resetRunsForTest();
  resetAuditForTest();
  closeStateDatabasesForTest();
  await close(server);
  rmSync(tempDir, { recursive: true, force: true });
  for (const key of MODEL_ENV_KEYS) {
    const previous = savedEnv[key];
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
});

describe("GET /api/health", () => {
  it("免认证即可 200，字段为当前口径（workspaceRoot = 注入的工作区）", async () => {
    const res = await send(port, { method: "GET", path: "/api/health" });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      ok: true,
      version: TEST_VERSION,
      workspaceRoot: tempDir,
      sandboxMode: "workspace-only",
    });
  });

  it("health 响应满足 protocol 的 HealthResponseSchema（用 validate() 真校验）", async () => {
    const res = await send(port, { method: "GET", path: "/api/health" });
    expect(validate(HealthResponseSchema, res.json).ok).toBe(true);
    // 反向对照：确认 validate 不是恒真，否则上面那条 ok 不构成证据。
    expect(
      validate(HealthResponseSchema, {
        ok: true,
        version: "x",
        workspaceRoot: "/w",
        sandboxMode: "scaffold",
      }).ok,
    ).toBe(false);
  });
});

describe("认证", () => {
  it("无 token 调 /api/chat → 401 unauthorized", async () => {
    const res = await send(port, {
      method: "POST",
      path: "/api/chat",
      body: { message: "你好" },
    });
    expect(res.status).toBe(401);
    expect(validate(ApiErrorSchema, res.json).ok).toBe(true);
    expect((res.json as { code: string }).code).toBe("unauthorized");
  });

  it("token 错误 → 401；无 token 的 /api/sessions 同样 401", async () => {
    expect(
      (await send(port, { method: "POST", path: "/api/chat", token: "wrong", body: { message: "x" } }))
        .status,
    ).toBe(401);
    expect((await send(port, { method: "GET", path: "/api/sessions" })).status).toBe(401);
  });
});

describe("POST /api/chat：模型未配置 → 诚实报错（禁 mock 回放，t7 §1.2 FG-03）", () => {
  it("非流式 → 400 + code=model_unconfigured，且响应体满足 ApiErrorSchema", async () => {
    const res = await send(port, {
      method: "POST",
      path: "/api/chat",
      token: TOKEN,
      body: { message: "你好" },
    });
    expect(res.status).toBe(400);
    expect(validate(ApiErrorSchema, res.json).ok).toBe(true);
    const body = res.json as { code: string; message: string };
    expect(body.code).toBe("model_unconfigured");
    expect(body.message).toContain("未配置模型 provider");
    // 未配置 = 没有回合发生：不许写 turn.end（写了等于给不存在的回合记账）。
    expect(auditEventCount()).toBe(0);
  });

  it("SSE → done 之前收到 error（code=model_unconfigured），且**没有**伪造 token/done-stop", async () => {
    const res = await send(port, {
      method: "POST",
      path: "/api/chat",
      token: TOKEN,
      accept: "text/event-stream",
      body: { message: "你好" },
    });
    expect(res.status).toBe(200);
    expect(String(res.headers["content-type"])).toContain("text/event-stream");

    const events = [...res.body.matchAll(/^event: (\w+)$/gm)].map((match) => match[1]);
    expect(events[0]).toBe("start");
    expect(events).toContain("error");
    // 诚实路径的直接证据：没有 token（没有正文）、没有 done-stop（没假装成功）。
    expect(events).not.toContain("token");
    expect(events).not.toContain("done");
    expect(events.at(-1)).toBe("error");

    const dataLines = [...res.body.matchAll(/^data: (.+)$/gm)].map((match) => match[1] ?? "");
    expect(dataLines.at(-1)).toBe("[DONE]");
    expect(res.body.endsWith("data: [DONE]\n")).toBe(true);

    const startData = JSON.parse(dataLines[0] ?? "{}") as unknown;
    expect(validate(SseStartDataSchema, startData).ok).toBe(true);
    const errorData = JSON.parse(dataLines[1] ?? "{}") as unknown;
    expect(validate(SseErrorDataSchema, errorData).ok).toBe(true);
    expect((errorData as { code: string }).code).toBe("model_unconfigured");
    // 失败也是终态：注册表里不许留"看起来还在跑"的 run。
    expect(getRun((startData as { runId: string }).runId)?.finished).toBe(true);
  });

  it("校验失败（缺 message / message 非字符串）→ 400 bad_request", async () => {
    const missing = await send(port, { method: "POST", path: "/api/chat", token: TOKEN, body: {} });
    expect(missing.status).toBe(400);
    expect((missing.json as { code: string }).code).toBe("bad_request");

    const wrongType = await send(port, {
      method: "POST",
      path: "/api/chat",
      token: TOKEN,
      body: { message: 42 },
    });
    expect(wrongType.status).toBe(400);
    expect(validate(ApiErrorSchema, wrongType.json).ok).toBe(true);
  });

  it("请求体不是合法 JSON → 400", async () => {
    const res = await new Promise<RawResponse>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/api/chat",
          agent: false,
          headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        },
        (raw) => {
          const chunks: Buffer[] = [];
          raw.on("data", (chunk: Buffer) => chunks.push(chunk));
          raw.on("end", () =>
            resolve({
              status: raw.statusCode ?? 0,
              headers: raw.headers,
              body: Buffer.concat(chunks).toString("utf8"),
              json: undefined,
            }),
          );
        },
      );
      req.on("error", reject);
      req.end("{not json");
    });
    expect(res.status).toBe(400);
    expect(res.body).toContain("bad_request");
  });
});

describe("POST /api/chat（SSE：未配置路径下事件序依然合法）", () => {
  it("start → error → [DONE]，start.sessionId 与请求一致", async () => {
    const res = await send(port, {
      method: "POST",
      path: "/api/chat",
      token: TOKEN,
      accept: "text/event-stream",
      body: { message: "你好", sessionId: "sse-session" },
    });
    const dataLines = [...res.body.matchAll(/^data: (.+)$/gm)].map((match) => match[1] ?? "");
    const startData = JSON.parse(dataLines[0] ?? "{}") as { runId: string; sessionId: string };
    expect(startData.sessionId).toBe("sse-session");
    expect(startData.runId).toMatch(/^[0-9a-f-]{36}$/);
    // error 事件的 code 与响应体同口径；[DONE] 收流。
    // data 行含结束帧：解析前先滤掉（[DONE] 不是 JSON）；按字段找，不靠下标。
    const errorData = dataLines
      .filter((line) => line !== "[DONE]")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((parsed) => typeof parsed.code === "string");
    expect(errorData?.code).toBe("model_unconfigured");
    expect(dataLines.at(-1)).toBe("[DONE]");
  });
});

describe("POST /api/chat/abort", () => {
  it("未知 runId → { aborted: false }（幂等，不 404）", async () => {
    const res = await send(port, {
      method: "POST",
      path: "/api/chat/abort",
      token: TOKEN,
      body: { runId: "no-such-run" },
    });
    expect(res.status).toBe(200);
    expect(validate(ChatAbortResponseSchema, res.json).ok).toBe(true);
    expect(res.json).toEqual({ aborted: false });
  });

  it("已知在跑 runId → { aborted: true }，且与断线复用同一条标记路径", async () => {
    const record = registerRun("run-live", "session-live");
    const res = await send(port, {
      method: "POST",
      path: "/api/chat/abort",
      token: TOKEN,
      body: { runId: "run-live" },
    });
    expect(res.json).toEqual({ aborted: true });
    expect(record.aborted).toBe(true);
    expect(record.controller.signal.aborted).toBe(true);
  });

  it("缺 runId → 400 bad_request", async () => {
    const res = await send(port, {
      method: "POST",
      path: "/api/chat/abort",
      token: TOKEN,
      body: {},
    });
    expect(res.status).toBe(400);
  });
});

describe("路由兜底", () => {
  it("未知路由 → 404 not_found（带 token）", async () => {
    const res = await send(port, { method: "GET", path: "/api/nope", token: TOKEN });
    expect(res.status).toBe(404);
    expect((res.json as { code: string }).code).toBe("not_found");
    expect(validate(ApiErrorSchema, res.json).ok).toBe(true);
  });

  it("未匹配方法（GET /api/chat）→ 404", async () => {
    expect((await send(port, { method: "GET", path: "/api/chat", token: TOKEN })).status).toBe(404);
  });

  it("非 /api 路径 → 404", async () => {
    expect((await send(port, { method: "GET", path: "/", token: TOKEN })).status).toBe(404);
  });
});

describe("sessions / messages", () => {
  it("GET /api/sessions 空库 → { sessions: [] }（真表查询；建会话后即列出，见「state 落地」）", async () => {
    const res = await send(port, { method: "GET", path: "/api/sessions", token: TOKEN });
    expect(res.status).toBe(200);
    expect(validate(SessionListResponseSchema, res.json).ok).toBe(true);
    expect(res.json).toEqual({ sessions: [] });
  });

  it("POST /api/sessions → 新 id + createdAt（unix 秒），形状满足 SessionCreateResponseSchema", async () => {
    const res = await send(port, {
      method: "POST",
      path: "/api/sessions",
      token: TOKEN,
      body: { title: "  测试会话  " },
    });
    expect(res.status).toBe(200);
    expect(validate(SessionCreateResponseSchema, res.json).ok).toBe(true);
    const body = res.json as { id: string; title: string; createdAt: number };
    expect(body.title).toBe("测试会话");
    // 秒级口径（t4 §4）：与毫秒误差 1000 倍，容差取 60s 足以区分两种口径。
    expect(Math.abs(body.createdAt - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(60);
  });

  it("POST /api/sessions 缺 title → 用默认标题；title 类型非法 → 400", async () => {
    const noTitle = await send(port, { method: "POST", path: "/api/sessions", token: TOKEN, body: {} });
    expect((noTitle.json as { title: string }).title).toBe("新会话");
    const bad = await send(port, {
      method: "POST",
      path: "/api/sessions",
      token: TOKEN,
      body: { title: 7 },
    });
    expect(bad.status).toBe(400);
  });

  it("DELETE /api/sessions/:id 未知 id 也 204（幂等），且无响应体", async () => {
    const res = await send(port, { method: "DELETE", path: "/api/sessions/unknown-id", token: TOKEN });
    expect(res.status).toBe(204);
    expect(res.body).toBe("");
  });

  it("GET /api/sessions/:id/messages 未知 session → { messages: [] }；since 非整数 → 400", async () => {
    const ok = await send(port, {
      method: "GET",
      path: "/api/sessions/s1/messages?since=3",
      token: TOKEN,
    });
    expect(ok.status).toBe(200);
    expect(validate(MessagesResponseSchema, ok.json).ok).toBe(true);

    const bad = await send(port, {
      method: "GET",
      path: "/api/sessions/s1/messages?since=abc",
      token: TOKEN,
    });
    expect(bad.status).toBe(400);
  });
});

describe("memory", () => {
  it("GET /api/memory/search 空库 → { items: [] }；缺 q → 400", async () => {
    const ok = await send(port, {
      method: "GET",
      path: `/api/memory/search?q=${encodeURIComponent("咖啡")}`,
      token: TOKEN,
    });
    expect(ok.status).toBe(200);
    expect(validate(MemorySearchResponseSchema, ok.json).ok).toBe(true);
    expect(ok.json).toEqual({ items: [] });

    expect((await send(port, { method: "GET", path: "/api/memory/search", token: TOKEN })).status).toBe(400);
  });

  it("POST /api/memory 校验 kind/text（kind 非法 → 400；落库与真实 id 见「state 落地」）", async () => {
    const ok = await send(port, {
      method: "POST",
      path: "/api/memory",
      token: TOKEN,
      body: { kind: "preference", text: "喜欢深烘" },
    });
    expect(ok.status).toBe(200);
    expect(validate(MemoryWriteResponseSchema, ok.json).ok).toBe(true);
    expect((ok.json as { id: string }).id).toMatch(/^[0-9a-f-]{36}$/);

    const badKind = await send(port, {
      method: "POST",
      path: "/api/memory",
      token: TOKEN,
      body: { kind: "other", text: "x" },
    });
    expect(badKind.status).toBe(400);
  });

  it("DELETE /api/memory 未知 id / 无命中 query → { deleted: [] }；两者皆无 → 400", async () => {
    const byQuery = await send(port, {
      method: "DELETE",
      path: "/api/memory",
      token: TOKEN,
      body: { query: "咖啡" },
    });
    expect(byQuery.status).toBe(200);
    expect(validate(MemoryDeleteResponseSchema, byQuery.json).ok).toBe(true);
    expect(byQuery.json).toEqual({ deleted: [] });

    const byId = await send(port, {
      method: "DELETE",
      path: "/api/memory",
      token: TOKEN,
      body: { id: "m-1" },
    });
    expect(byId.status).toBe(200);
    expect(byId.json).toEqual({ deleted: [] });

    // id/query 至少其一：都不给等于"删库"，路由必须拒（protocol 注释点明的运行期约束）。
    const neither = await send(port, { method: "DELETE", path: "/api/memory", token: TOKEN, body: {} });
    expect(neither.status).toBe(400);
    expect((neither.json as { code: string }).code).toBe("bad_request");
  });
});

describe("GET /api/memory 列表（M1-9 ①）", () => {
  /** 写一条记忆并返回真实 id（复用端点，保证与"列表查"同库同路径）。 */
  async function writeMemory(kind: "preference" | "fact", text: string): Promise<string> {
    const res = await send(port, {
      method: "POST",
      path: "/api/memory",
      token: TOKEN,
      body: { kind, text },
    });
    expect(res.status).toBe(200);
    return (res.json as { id: string }).id;
  }

  async function list(query: string): Promise<{
    status: number;
    json: unknown;
    headers: Record<string, string | string[] | undefined>;
  }> {
    return send(port, { method: "GET", path: `/api/memory${query}`, token: TOKEN });
  }

  it("空库 → { items: [], total: 0 }，且满足 MemoryListResponseSchema", async () => {
    const res = await list("");
    expect(res.status).toBe(200);
    expect(validate(MemoryListResponseSchema, res.json).ok).toBe(true);
    expect(res.json).toEqual({ items: [], total: 0 });
  });

  it("写入后按 created_at 倒序列出，条目形状与 search 同源（validate 真校验）", async () => {
    const first = await writeMemory("preference", "用户喜欢深烘咖啡");
    const second = await writeMemory("fact", "用户在杭州");
    const res = await list("");
    expect(res.status).toBe(200);
    expect(validate(MemoryListResponseSchema, res.json).ok).toBe(true);
    const body = res.json as { items: { id: string; text: string }[]; total: number };
    expect(body.total).toBe(2);
    expect(body.items.map((item) => item.id).sort()).toEqual([first, second].sort());
    expect(body.items.map((item) => item.text)).toContain("用户在杭州");
  });

  it("total 是**过滤后的全量**：limit 只截 items，不动 total（分页不许用 items.length 冒充）", async () => {
    await writeMemory("fact", "记忆一");
    await writeMemory("fact", "记忆二");
    await writeMemory("preference", "记忆三");

    const limited = await list("?limit=1");
    const firstPage = limited.json as { items: { id: string }[]; total: number };
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.total).toBe(3);

    const second = await list("?limit=1&offset=1");
    const secondPage = second.json as { items: { id: string }[]; total: number };
    expect(secondPage.total).toBe(3);
    // 第二页是另一条（offset 真生效），但 total 不变。
    expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id);

    const onlyPreferences = await list("?kind=preference");
    expect((onlyPreferences.json as { total: number }).total).toBe(1);
    const onlyGlobals = await list("?scope=session");
    // 未带 sessionId 的写入是 global 作用域 → session 过滤下为 0（口径由 DAO 定）。
    expect((onlyGlobals.json as { total: number }).total).toBe(0);
  });

  it("limit/offset/scope/kind 非法 → 400（limit > 200 由 schema 拒；缺认证 → 401）", async () => {
    expect((await list("?limit=201")).status).toBe(400);
    expect((await list("?limit=0")).status).toBe(400);
    expect((await list("?offset=-1")).status).toBe(400);
    expect((await list("?scope=everywhere")).status).toBe(400);
    expect((await list("?kind=other")).status).toBe(400);
    const unauth = await send(port, { method: "GET", path: "/api/memory" });
    expect(unauth.status).toBe(401);
  });

  it("路由未被 search 吞掉：两个端点各回各自形状（list 有 total，search 只有 items）", async () => {
    await writeMemory("fact", "用户在上海");
    const searched = await send(port, {
      method: "GET",
      path: `/api/memory/search?q=${encodeURIComponent("用户在上海")}`,
      token: TOKEN,
    });
    expect(searched.status).toBe(200);
    expect(validate(MemorySearchResponseSchema, searched.json).ok).toBe(true);
    expect(Object.keys(searched.json as object)).toEqual(["items"]);
    const listed = await list("");
    expect(Object.keys(listed.json as object).sort()).toEqual(["items", "total"]);
  });
});

describe("CORS 预检（M1-9 ②：OPTIONS 在路由与认证之前收场）", () => {
  it("loopback origin → 204 + 回显 ACAO + 方法/头/缓存头", async () => {
    const res = await send(port, {
      method: "OPTIONS",
      path: "/api/chat",
      origin: "http://127.0.0.1:43120",
    });
    expect(res.status).toBe(204);
    expect(res.body).toBe("");
    expect(res.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:43120");
    expect(res.headers["access-control-allow-methods"]).toBe("GET, POST, DELETE, OPTIONS");
    expect(res.headers["access-control-allow-headers"]).toBe("Content-Type, Authorization, Accept");
    expect(res.headers["access-control-max-age"]).toBe("600");
    expect(res.headers.vary).toBe("Origin");
  });

  it("localhost / [::1] 同样回显（loopback 的三种写法）", async () => {
    for (const origin of ["http://localhost:5173", "http://[::1]:43120"]) {
      const res = await send(port, { method: "OPTIONS", path: "/api/chat", origin });
      expect(res.status).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe(origin);
    }
  });

  it("非 loopback origin → 204 但**没有** ACAO 头（不放行跨站）", async () => {
    const res = await send(port, {
      method: "OPTIONS",
      path: "/api/chat",
      origin: "http://evil.example.com",
    });
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    // 其余预检头照发：没有 ACAO 的预检在浏览器侧就是不通过（前端自拦）。
    expect(res.headers["access-control-allow-methods"]).toBe("GET, POST, DELETE, OPTIONS");
  });

  it("无 Origin / 非法 Origin / 其它协议 → 204 且不回 ACAO；预检不需要认证", async () => {
    const noOrigin = await send(port, { method: "OPTIONS", path: "/api/chat" });
    expect(noOrigin.status).toBe(204);
    expect(noOrigin.headers["access-control-allow-origin"]).toBeUndefined();

    const weird = await send(port, {
      method: "OPTIONS",
      path: "/api/chat",
      origin: "file:///tmp/x.html",
    });
    expect(weird.status).toBe(204);
    expect(weird.headers["access-control-allow-origin"]).toBeUndefined();

    // 未匹配路径的预检同样 204（预检先于路由判定）——这正是"预检不能走认证/路由"的证据。
    const unknownPath = await send(port, {
      method: "OPTIONS",
      path: "/api/does-not-exist",
      origin: "http://localhost:43120",
    });
    expect(unknownPath.status).toBe(204);
    expect(unknownPath.headers["access-control-allow-origin"]).toBe("http://localhost:43120");
  });

  it("带 Origin 的普通请求照常走业务（预检改动没有影响 GET /api/health）", async () => {
    const res = await send(port, {
      method: "GET",
      path: "/api/health",
      origin: "http://localhost:43120",
    });
    expect(res.status).toBe(200);
    expect(validate(HealthResponseSchema, res.json).ok).toBe(true);
    // 简单请求不写 CORS 头：本服务只放行预检，不做"任意 origin 读响应"的许诺。
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("驳回项：/api/tasks 不建（M1 无 tasks 表，t4 §7）", () => {
  it("GET /api/tasks → 404 not_found（前端走诚实空态，后端不伪造空列表）", async () => {
    const res = await send(port, { method: "GET", path: "/api/tasks", token: TOKEN });
    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ code: "not_found" });
    // 其它方法同样是未知路由（没有"半条"端点）。
    const post = await send(port, { method: "POST", path: "/api/tasks", token: TOKEN, body: {} });
    expect(post.status).toBe(404);
  });
});

describe("断线监听（t4 §2：断线后不许让模型继续跑）", () => {
  /** 起一个"永远不结束"的 SSE handler：模拟模型仍在生成。 */
  async function startHangingSseServer(runId: string): Promise<Server> {
    registerRun(runId, "session-hang");
    const hanging = createHttpServer((req, res) => {
      sendSseHeaders(res);
      pushEvent(res, "start", { runId, sessionId: "session-hang" });
      watchClientDisconnect(req, res, () => {
        abortRun(runId);
      });
    });
    await listen(hanging);
    return hanging;
  }

  it("客户端中途断线 → 该 run 被标记 aborted（AbortController 触发）", async () => {
    const runId = "run-hang";
    const hanging = await startHangingSseServer(runId);
    const hangingPort = (hanging.address() as AddressInfo).port;
    try {
      await new Promise<void>((resolve) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: hangingPort, method: "POST", path: "/api/chat", agent: false },
          (res) => {
            res.once("data", () => {
              req.destroy();
              res.destroy();
              resolve();
            });
          },
        );
        req.on("error", () => {
          /* 主动断线导致的 ECONNRESET 属预期 */
        });
        req.end();
      });
      await waitFor(() => getRun(runId)?.aborted === true);
      const record = getRun(runId);
      expect(record?.aborted).toBe(true);
      expect(record?.controller.signal.aborted).toBe(true);
    } finally {
      await close(hanging);
    }
  });

  it("正常收流的 SSE 不会被误判为断线", async () => {
    const runId = "run-normal";
    registerRun(runId, "session-ok");
    const normal = createHttpServer((req, res) => {
      sendSseHeaders(res);
      const detach = watchClientDisconnect(req, res, () => {
        abortRun(runId);
      });
      pushEvent(res, "start", { runId, sessionId: "session-ok" });
      pushEvent(res, "done", { runId, finishReason: "stop", delivery: "claimed" });
      detach();
      endStream(res);
    });
    const normalPort = await listen(normal);
    try {
      const res = await send(normalPort, { method: "POST", path: "/api/chat" });
      expect(res.body).toContain("data: [DONE]");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(getRun(runId)?.aborted).toBe(false);
    } finally {
      await close(normal);
    }
  });
});

describe("治理内核接线（t4 §4：审计只记元数据）", () => {
  it("模型未配置的 chat **不写** turn.end（没有回合就没有账）", async () => {
    const res = await send(port, {
      method: "POST",
      path: "/api/chat",
      token: TOKEN,
      body: { message: "任意正文" },
    });
    expect(res.status).toBe(400);
    expect(auditEventCount()).toBe(0);
  });

  it("400 校验失败的 chat 不写 turn.end", async () => {
    const res = await send(port, { method: "POST", path: "/api/chat", token: TOKEN, body: {} });
    expect(res.status).toBe(400);
    expect(auditEventCount()).toBe(0);
  });

  it("GET /api/health 不写审计（探活噪声不进账本）", async () => {
    await send(port, { method: "GET", path: "/api/health" });
    await send(port, { method: "GET", path: "/api/health" });
    expect(auditEventCount()).toBe(0);
  });

  it("abort 写一条 state.transition；已终态/未知 runId 不再写（幂等重放不是状态迁移）", async () => {
    registerRun("run-audit", "session-audit");
    const first = await send(port, {
      method: "POST",
      path: "/api/chat/abort",
      token: TOKEN,
      body: { runId: "run-audit" },
    });
    expect(first.json).toEqual({ aborted: true });
    const events = listAuditEvents();
    expect(events.length).toBe(1);
    expect(events[0]?.kind).toBe("state.transition");
    expect(events[0]?.status).toBe("aborted");
    expect(events[0]?.runId).toBe("run-audit");
    expect(events[0]?.sessionId).toBe("session-audit");
    // 审计条目里除了 run/session 标识与状态，没有别的东西（abort 不带任何正文）。
    expect(Object.keys(events[0] ?? {}).sort()).toEqual([
      "kind",
      "payloadMeta",
      "runId",
      "sessionId",
      "status",
      "ts",
    ]);

    const again = await send(port, {
      method: "POST",
      path: "/api/chat/abort",
      token: TOKEN,
      body: { runId: "run-audit" },
    });
    expect(again.json).toEqual({ aborted: false });
    const unknown = await send(port, {
      method: "POST",
      path: "/api/chat/abort",
      token: TOKEN,
      body: { runId: "no-such-run" },
    });
    expect(unknown.json).toEqual({ aborted: false });
    expect(auditEventCount()).toBe(1);
  });
});

/**
 * 记忆 / 会话读端点接真库（t17）。
 *
 * 每个用例的库都是**真 tmpdir 文件**（`beforeEach` 的 `stateDbPath`），没有 mock、没有内存
 * 替身：断言里的"第二条读路径"是 `openStateDatabase(同一路径)` 直取 DAO（单例复用同一连接），
 * 证明端点读写的**就是 `packages/state` 落在盘上的那些行**。
 *
 * FTS 断言的口径：`memories_fts` 用 `unicode61` 分词 + 短语前缀查询，故
 * 「token 前缀命中、纯子串不命中」——后一条正是"走的 FTS 而不是 `LIKE '%…%'`"的判别证据。
 */
describe("state 落地（真库真盘：写 → 查 → 删）", () => {
  /** 同库第二读路径：单例按路径复用连接，所以这里读到的就是端点写下的行。 */
  function daoOf(): StateDao {
    return openStateDatabase(join(tempDir, "agentplant.sqlite")).dao;
  }

  /** 同库原始连接（验收用：绕过 DAO 的 SQL 注入会走这条路，例如终态回退）。 */
  function dbOf(): DatabaseSync {
    return openStateDatabase(join(tempDir, "agentplant.sqlite")).db;
  }

  interface CreatedSession {
    readonly id: string;
    readonly title: string;
    readonly createdAt: number;
  }

  async function postSession(title?: string): Promise<CreatedSession> {
    const res = await send(port, {
      method: "POST",
      path: "/api/sessions",
      token: TOKEN,
      body: title === undefined ? {} : { title },
    });
    expect(res.status).toBe(200);
    return res.json as CreatedSession;
  }

  async function postMemory(body: unknown): Promise<string> {
    const res = await send(port, { method: "POST", path: "/api/memory", token: TOKEN, body });
    expect(res.status).toBe(200);
    return (res.json as { id: string }).id;
  }

  async function searchMemory(
    q: string,
    limit?: number,
  ): Promise<{ status: number; json: unknown }> {
    const params = new URLSearchParams({ q });
    if (limit !== undefined) {
      params.set("limit", String(limit));
    }
    const res = await send(port, {
      method: "GET",
      path: `/api/memory/search?${params.toString()}`,
      token: TOKEN,
    });
    return { status: res.status, json: res.json };
  }

  function itemsOf(json: unknown): { id: string; kind: string; text: string; createdAt: number }[] {
    return (json as { items: { id: string; kind: string; text: string; createdAt: number }[] })
      .items;
  }

  /** 记忆条目的正文关键字：CJK 词之间留空格，第一段即 FTS 可命中的 token。 */
  const MEMORY_TEXT = "深烘 咖啡豆 爱好者";

  it("POST /api/sessions 真落盘：id 出现在 GET /api/sessions，且同库行可直查", async () => {
    const created = await postSession("第一会话");
    const list = await send(port, { method: "GET", path: "/api/sessions", token: TOKEN });
    expect(list.status).toBe(200);
    expect(validate(SessionListResponseSchema, list.json).ok).toBe(true);
    const sessions = (
      list.json as { sessions: { id: string; title: string; updatedAt: number; messageCount: number }[] }
    ).sessions;
    expect(sessions.map((session) => session.id)).toEqual([created.id]);
    expect(sessions[0]?.title).toBe("第一会话");
    expect(sessions[0]?.messageCount).toBe(0);
    expect(sessions[0]?.updatedAt).toBe(created.createdAt);
    expect(daoOf().getSession(created.id)?.title).toBe("第一会话");
  });

  it("createdAt 取库行 created_at（unix 秒）；空白标题回落默认值并落库", async () => {
    const created = await postSession("   ");
    expect(created.title).toBe("新会话");
    const row = daoOf().getSession(created.id);
    expect(row?.createdAt).toBe(created.createdAt);
    expect(row?.title).toBe("新会话");
    expect(row?.status).toBe("active");
    // 秒级口径（t4 §4）：毫秒会大 1000 倍，60s 容差足以区分两种口径。
    expect(Math.abs(created.createdAt - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(60);
  });

  it("跨面一致：同库写入主循环风格的消息后，sessions 的 messageCount 与 messages 列表对齐", async () => {
    const session = await postSession("一致性");
    const dao = daoOf();
    // 与 chat 主循环同一条写路径（`agent/loop.ts` 就是 appendMessage）+ 同一个库文件。
    dao.appendMessage({ sessionId: session.id, seq: 1, role: "user", content: "晚点提醒我" });
    dao.appendMessage({ sessionId: session.id, seq: 2, role: "assistant", content: "好" });

    const list = await send(port, { method: "GET", path: "/api/sessions", token: TOKEN });
    const sessions = (list.json as { sessions: { id: string; messageCount: number }[] }).sessions;
    expect(sessions[0]?.messageCount).toBe(2);

    const messages = await send(port, {
      method: "GET",
      path: `/api/sessions/${session.id}/messages`,
      token: TOKEN,
    });
    expect(validate(MessagesResponseSchema, messages.json).ok).toBe(true);
    expect((messages.json as { messages: { seq: number }[] }).messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(dao.listMessages(session.id)).toHaveLength(2);
  });

  it("未知 session 的消息查询 → 200 { messages: [] }（空态，不 404）", async () => {
    const res = await send(port, {
      method: "GET",
      path: "/api/sessions/no-such-session/messages",
      token: TOKEN,
    });
    expect(res.status).toBe(200);
    expect(validate(MessagesResponseSchema, res.json).ok).toBe(true);
    expect(res.json).toEqual({ messages: [] });
  });

  it("?since= 是 seq 水位（只回 seq > since）", async () => {
    const session = await postSession("水位");
    const dao = daoOf();
    for (const seq of [1, 2, 3]) {
      dao.appendMessage({ sessionId: session.id, seq, role: "user", content: `第 ${seq} 条` });
    }
    const res = await send(port, {
      method: "GET",
      path: `/api/sessions/${session.id}/messages?since=2`,
      token: TOKEN,
    });
    expect((res.json as { messages: { seq: number }[] }).messages.map((m) => m.seq)).toEqual([3]);
  });

  it("消息形状：tool 消息带 toolName/toolCallId，content 为 NULL 时**不带** content 键", async () => {
    const session = await postSession("形状");
    daoOf().appendMessage({
      sessionId: session.id,
      seq: 1,
      role: "tool",
      toolName: "read_file",
      toolCallId: "call-1",
    });
    const res = await send(port, {
      method: "GET",
      path: `/api/sessions/${session.id}/messages`,
      token: TOKEN,
    });
    const message = (res.json as { messages: Record<string, unknown>[] }).messages[0] ?? {};
    expect(Object.keys(message).sort()).toEqual([
      "createdAt",
      "id",
      "role",
      "seq",
      "sessionId",
      "toolCallId",
      "toolName",
    ]);
    expect(message.role).toBe("tool");
    expect(message.toolName).toBe("read_file");
  });

  it("POST /api/memory 落盘真实 id：库里同一行可直查，FTS 立刻命中", async () => {
    const id = await postMemory({ kind: "preference", text: MEMORY_TEXT });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(daoOf().searchMemories("深烘").map((row) => row.id)).toEqual([id]);

    const res = await searchMemory("深烘");
    expect(res.status).toBe(200);
    expect(validate(MemorySearchResponseSchema, res.json).ok).toBe(true);
    const items = itemsOf(res.json);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      id,
      kind: "preference",
      text: MEMORY_TEXT,
      createdAt: expect.any(Number),
    });
    // 不带 sessionId 写入 = 全局作用域：条目不带来源字段（closed 对象，键都不出现）。
    expect(Object.keys(items[0] ?? {}).sort()).toEqual(["createdAt", "id", "kind", "text"]);
  });

  it("检索真走 FTS5：token 前缀命中，正文里的纯子串不命中（LIKE '%…%' 会命中）", async () => {
    const id = await postMemory({ kind: "fact", text: MEMORY_TEXT });
    // 前缀命中（`咖啡` 是 token `咖啡豆` 的前缀）。
    expect(itemsOf((await searchMemory("咖啡")).json).map((item) => item.id)).toEqual([id]);
    // 子串不命中（正文含「啡豆」但没有以它开头的 token）→ FTS 分词/前缀语义的直接证据。
    expect(itemsOf((await searchMemory("啡豆")).json)).toEqual([]);
    // 无匹配 → 空数组（不是报错）。
    const unrelated = await searchMemory("完全无关");
    expect(unrelated.status).toBe(200);
    expect(itemsOf(unrelated.json)).toEqual([]);
  });

  it("检索 limit 生效（上限截断在 DAO 的 SQL 里）", async () => {
    for (const suffix of ["甲", "乙", "丙"]) {
      await postMemory({ kind: "fact", text: `重复词 条目 ${suffix}` });
    }
    const limited = await searchMemory("重复词", 2);
    expect(itemsOf(limited.json)).toHaveLength(2);
    const all = await searchMemory("重复词");
    expect(itemsOf(all.json)).toHaveLength(3);
  });

  it("带 sessionId 的记忆 → 条目带 sourceSessionId，且库里 session_id 列同值（会话作用域）", async () => {
    const session = await postSession("记忆归属");
    const id = await postMemory({ kind: "fact", text: "会话内 偏好 记录", sessionId: session.id });
    const rows = daoOf().searchMemories("会话内");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionId).toBe(session.id);
    expect(rows[0]?.scope).toBe("session");
    const items = itemsOf((await searchMemory("会话内")).json);
    expect(items[0]).toMatchObject({ id, sourceSessionId: session.id });
  });

  it("POST /api/memory 带未知 sessionId → 400 bad_request（调用方错误不报 500），且不落库", async () => {
    const bad = await send(port, {
      method: "POST",
      path: "/api/memory",
      token: TOKEN,
      body: { kind: "fact", text: "会话内 幽灵 记忆", sessionId: "no-such-session" },
    });
    expect(bad.status).toBe(400);
    expect(validate(ApiErrorSchema, bad.json).ok).toBe(true);
    expect((bad.json as { code: string }).code).toBe("bad_request");
    // 400 = 拒绝前先判存在性：没有留下半条（FK 兜底路径根本不进入）。
    expect(daoOf().searchMemories("幽灵")).toEqual([]);

    // 存在但**已归档**的会话：库行还在（FK 成立），照常可写（会话作用域记忆）。
    const session = await postSession("记忆目标");
    await send(port, { method: "DELETE", path: `/api/sessions/${session.id}`, token: TOKEN });
    const ok = await send(port, {
      method: "POST",
      path: "/api/memory",
      token: TOKEN,
      body: { kind: "fact", text: "会话内 记录 乙", sessionId: session.id },
    });
    expect(ok.status).toBe(200);
    expect(validate(MemoryWriteResponseSchema, ok.json).ok).toBe(true);
    expect(daoOf().searchMemories("记录").map((row) => row.sessionId)).toEqual([session.id]);

    // 空 / 纯空白 sessionId 视同未给（全局作用域，不做存在性检查）。
    const global = await send(port, {
      method: "POST",
      path: "/api/memory",
      token: TOKEN,
      body: { kind: "preference", text: "全局 偏好 丙", sessionId: "   " },
    });
    expect(global.status).toBe(200);
  });

  it("DELETE /api/memory by id：回真实 id，删后 FTS 查不到、库行也没了；重复删 → deleted: []", async () => {
    const id = await postMemory({ kind: "preference", text: MEMORY_TEXT });
    const first = await send(port, {
      method: "DELETE",
      path: "/api/memory",
      token: TOKEN,
      body: { id },
    });
    expect(first.status).toBe(200);
    expect(validate(MemoryDeleteResponseSchema, first.json).ok).toBe(true);
    expect(first.json).toEqual({ deleted: [id] });
    expect(itemsOf((await searchMemory("深烘")).json)).toEqual([]);
    expect(daoOf().searchMemories("深烘")).toEqual([]);

    const again = await send(port, {
      method: "DELETE",
      path: "/api/memory",
      token: TOKEN,
      body: { id },
    });
    expect(again.json).toEqual({ deleted: [] });
  });

  it("DELETE /api/memory by query：先 FTS 取 id 再逐个真删；未知 id → deleted: []；空体 → 400", async () => {
    const first = await postMemory({ kind: "fact", text: "临时 记忆 甲" });
    const second = await postMemory({ kind: "fact", text: "临时 记忆 乙" });
    const res = await send(port, {
      method: "DELETE",
      path: "/api/memory",
      token: TOKEN,
      body: { query: "临时" },
    });
    expect(res.status).toBe(200);
    expect(new Set((res.json as { deleted: string[] }).deleted)).toEqual(new Set([first, second]));
    expect(itemsOf((await searchMemory("临时")).json)).toEqual([]);
    expect(daoOf().searchMemories("临时")).toEqual([]);

    const unknown = await send(port, {
      method: "DELETE",
      path: "/api/memory",
      token: TOKEN,
      body: { id: "no-such-memory" },
    });
    expect(unknown.status).toBe(200);
    expect(unknown.json).toEqual({ deleted: [] });

    const empty = await send(port, { method: "DELETE", path: "/api/memory", token: TOKEN, body: {} });
    expect(empty.status).toBe(400);
    expect((empty.json as { code: string }).code).toBe("bad_request");
  });

  it("DELETE /api/sessions/:id → 204 且库行转 archived（归档终态、消息不级联删）；未知 id 仍 204", async () => {
    const session = await postSession("待归档");
    daoOf().appendMessage({ sessionId: session.id, seq: 1, role: "user", content: "归档前的话" });

    const res = await send(port, {
      method: "DELETE",
      path: `/api/sessions/${session.id}`,
      token: TOKEN,
    });
    expect(res.status).toBe(204);
    expect(res.body).toBe("");
    const row = daoOf().getSession(session.id);
    expect(row?.status).toBe("archived");
    expect(row?.archivedAt).not.toBeNull();
    // 归档不是物理删：消息仍在表里，只读端点照常返回。
    const messages = await send(port, {
      method: "GET",
      path: `/api/sessions/${session.id}/messages`,
      token: TOKEN,
    });
    expect((messages.json as { messages: unknown[] }).messages).toHaveLength(1);

    // 幂等：重复归档 / 未知 id 都 204，不 404。
    for (const path of [`/api/sessions/${session.id}`, "/api/sessions/unknown-id"]) {
      const again = await send(port, { method: "DELETE", path, token: TOKEN });
      expect(again.status).toBe(204);
    }
  });

  it("归档即从列表消失（GET /api/sessions 只列 active）：库行仍 archived、消息仍可查", async () => {
    const kept = await postSession("留下的");
    const archived = await postSession("归档的");
    daoOf().appendMessage({ sessionId: archived.id, seq: 1, role: "user", content: "归档前的话" });

    const before = await send(port, { method: "GET", path: "/api/sessions", token: TOKEN });
    expect(
      (before.json as { sessions: { id: string }[] }).sessions.map((row) => row.id).sort(),
    ).toEqual([archived.id, kept.id].sort());

    const del = await send(port, {
      method: "DELETE",
      path: `/api/sessions/${archived.id}`,
      token: TOKEN,
    });
    expect(del.status).toBe(204);

    const after = await send(port, { method: "GET", path: "/api/sessions", token: TOKEN });
    expect(validate(SessionListResponseSchema, after.json).ok).toBe(true);
    expect((after.json as { sessions: { id: string }[] }).sessions.map((row) => row.id)).toEqual([
      kept.id,
    ]);

    // 归档不是物理删：库行仍是 archived（终态），第二读路径直查得到；消息端点不受列表过滤影响。
    expect(daoOf().getSession(archived.id)?.status).toBe("archived");
    expect(daoOf().listSessions("archived").map((row) => row.id)).toEqual([archived.id]);
    const messages = await send(port, {
      method: "GET",
      path: `/api/sessions/${archived.id}/messages`,
      token: TOKEN,
    });
    expect((messages.json as { messages: unknown[] }).messages).toHaveLength(1);

    // 终态不可降级：归档后原始 SQL 回退被库层拦下（列表口径的前提不会被"偷偷复活"破坏）。
    expect(() =>
      dbOf().prepare("UPDATE sessions SET status = 'active' WHERE id = ?").run(archived.id),
    ).toThrow(/terminal status immutable/);
    expect(daoOf().getSession(archived.id)?.status).toBe("archived");
  });

  it("STATE_DB_PATH 注入：不传 stateDbPath 时读写落在 env 指定的库文件（真盘存在）", async () => {
    const envDir = join(tempDir, "env-db");
    mkdirSync(envDir, { recursive: true });
    const envPath = join(envDir, "agentplant.sqlite");
    // 放下当前句柄，逼服务按 env 重新开库（否则会复用上一个库的单例）。
    closeStateDatabasesForTest();
    process.env.STATE_DB_PATH = envPath;
    const envServer = createServer({ token: TOKEN, version: TEST_VERSION, workspaceRoot: tempDir });
    const envPort = await listen(envServer);
    try {
      const created = await send(envPort, {
        method: "POST",
        path: "/api/sessions",
        token: TOKEN,
        body: { title: "env 会话" },
      });
      expect(created.status).toBe(200);
      const id = (created.json as { id: string }).id;
      expect(existsSync(envPath)).toBe(true);
      const list = await send(envPort, { method: "GET", path: "/api/sessions", token: TOKEN });
      expect((list.json as { sessions: { id: string }[] }).sessions.map((s) => s.id)).toEqual([id]);
      expect(openStateDatabase(envPath).dao.getSession(id)?.title).toBe("env 会话");
    } finally {
      delete process.env.STATE_DB_PATH;
      await close(envServer);
    }
  });
});
