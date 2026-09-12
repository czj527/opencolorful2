/**
 * chat-loop.test.ts：**主循环端到端**（t15 验收 3）。
 *
 * 「真实优先」的口径（AGENTS.md 硬约束 6 / FG-03）：
 * - LLM = `node:http` 起的**本地回环真 socket stub**，脚本化返回 OpenAI 格式响应；
 * - 工作区 = `os.tmpdir()` 下的真目录（真写文件）；
 * - 状态库 = 真 SQLite 临时文件（真迁移、真 WAL）；
 * - HTTP 面 = 真 `createServer(...).listen(0)` + 真客户端。
 * 全程**零 mock 框架 API**（`grep vi.mock/jest.mock` 在任何用例里都不出现），
 * 注入点只有"打哪个主机"（`fetchImpl`），这是接口注入而不是行为替换。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ChatConfirmResponseSchema,
  SseDoneDataSchema,
  SseErrorDataSchema,
  SseToolCallDataSchema,
  SseToolResultDataSchema,
  validate,
} from "@agentplant/protocol";
import type { StateDao } from "@agentplant/state";
import { closeDatabase, createStateDao, migrate, openDatabase } from "@agentplant/state";
import { createCoreRegistry, createToolRegistry } from "../../tools/registry.js";
import { removeTempDirRetrying } from "../../tools/__tests__/harness.js";
import { createPathGuard } from "../../policy/guard.js";
import { createRedactor } from "../../policy/redactor.js";
import type { FetchLike, Tool, ToolServices } from "../../tools/types.js";
import { createServer } from "../../index.js";
import {
  abortRun,
  getPendingCall,
  registerPendingCall,
  registerRun,
  resetRunsForTest,
} from "../../sse.js";
import { closeStateDatabasesForTest, openStateDatabase } from "../state-db.js";
import { createLlmClient, runTurn, type TurnEventSink, type TurnResult } from "../loop.js";
import { resolveConfirmation } from "../confirm.js";
import { MODEL_NOT_CONFIGURED_MESSAGE, readLlmConfig } from "../llm.js";

const MODEL_ENV_KEYS = ["MODEL_API_BASE", "MODEL_API_KEY", "MODEL_NAME", "STATE_DB_PATH"] as const;
const savedEnv = { ...process.env };

interface StubRequest {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown>;
  readonly messageRoles: readonly string[];
  readonly tools: readonly string[];
  readonly toolChoice: unknown;
  readonly model: unknown;
  readonly stream: unknown;
}

type StubReply = (request: StubRequest, index: number) => { readonly body: unknown } | { readonly raw: string } | { readonly status: number; readonly body: unknown };

interface StubServer {
  readonly port: number;
  readonly base: string;
  readonly requests: StubRequest[];
  close(): Promise<void>;
}

/** 起真 socket stub：脚本化响应 + 记录每次请求（含 Authorization，用于断言密钥确实发了）。 */
async function startLlmStub(replies: readonly StubReply[]): Promise<StubServer> {
  const requests: StubRequest[] = [];
  const server: Server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const parsed = safeJson(raw) as Record<string, unknown>;
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
      const request: StubRequest = {
        url: req.url ?? "",
        authorization: req.headers.authorization,
        body: parsed,
        messageRoles: messages.map((entry) =>
          typeof entry === "object" && entry !== null
            ? String((entry as { role?: unknown }).role ?? "")
            : "",
        ),
        tools: tools.map((entry) =>
          typeof entry === "object" && entry !== null
            ? String((entry as { function?: { name?: unknown } }).function?.name ?? "")
            : "",
        ),
        toolChoice: parsed.tool_choice,
        model: parsed.model,
        stream: parsed.stream,
      };
      const index = requests.length;
      requests.push(request);
      const reply = replies[Math.min(index, replies.length - 1)];
      if (reply === undefined) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "stub 没有配置这一轮的响应" }));
        return;
      }
      const produced = reply(request, index);
      if ("raw" in produced) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(produced.raw);
        return;
      }
      const status = "status" in produced ? produced.status : 200;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(produced.body));
    });
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo | null;
      if (address === null) {
        reject(new Error("stub server 未返回地址"));
        return;
      }
      resolve(address.port);
    });
  });
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

/** OpenAI 格式：纯文本回复。 */
function textReply(content: string, usage?: { prompt: number; completion: number }) {
  return {
    body: {
      id: "chatcmpl-stub",
      object: "chat.completion",
      model: "stub-model",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      ...(usage === undefined
        ? {}
        : { usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion } }),
    },
  } satisfies { body: unknown };
}

/** OpenAI 格式：工具调用回复。 */
function toolCallReply(calls: readonly { id: string; name: string; args: unknown }[]) {
  return {
    body: {
      id: "chatcmpl-stub",
      object: "chat.completion",
      model: "stub-model",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: calls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            })),
          },
          finish_reason: "tool_calls",
        },
      ],
    },
  } satisfies { body: unknown };
}

/** 生产 fetch 语义的本地实现：真 socket、真头、真 body；`signal` 真生效（abort → reject）。 */
function realFetch(): FetchLike {
  return (input: string | URL, init?: Parameters<FetchLike>[1]) =>
    new Promise((resolve, reject) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      const req = httpRequest(
        {
          host: url.hostname,
          port: url.port === "" ? 80 : Number(url.port),
          method: init?.method ?? "GET",
          path: `${url.pathname}${url.search}`,
          headers: { ...(init?.headers ?? {}) },
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({
              status: res.statusCode ?? 0,
              url: url.toString(),
              headers: { get: (name: string) => res.headers[name.toLowerCase()]?.toString() ?? null },
              text: async () => text,
            });
          });
        },
      );
      const signal = init?.signal;
      if (signal !== undefined) {
        const onAbort = (): void => {
          req.destroy(new Error("aborted"));
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }
      req.on("error", reject);
      if (init?.body !== undefined) {
        req.write(init.body);
      }
      req.end();
    });
}

interface TestContext {
  readonly dir: string;
  readonly workspaceRoot: string;
  readonly db: StateDao;
  readonly registry: ReturnType<typeof createToolRegistry>;
  readonly services: ToolServices;
  readonly events: { name: string; data: unknown }[];
  readonly sink: TurnEventSink;
  cleanup(): void;
}

let contexts: TestContext[] = [];
let stubs: StubServer[] = [];

function makeContext(options: { readonly extraTools?: readonly Tool<unknown, unknown>[] } = {}): TestContext {
  const dir = join(
    tmpdir(),
    `agentplant-loop-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const workspaceRoot = join(dir, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  const sqlite = openDatabase(join(dir, "agentplant.sqlite"));
  migrate(sqlite);
  const db = createStateDao(sqlite);
  const guard = createPathGuard(workspaceRoot);
  const redactor = createRedactor();
  const services: ToolServices = { workspaceRoot: guard.workspaceRoot, guard, redactor, memoryDb: db };
  const registry = createToolRegistry();
  for (const tool of options.extraTools ?? []) {
    registry.register(tool);
  }
  const core = createCoreRegistry(services);
  for (const name of core.names()) {
    const tool = core.get(name);
    if (tool !== undefined) {
      registry.register(tool);
    }
  }
  const events: { name: string; data: unknown }[] = [];
  const sink: TurnEventSink = (event: Parameters<TurnEventSink>[0]) => {
    events.push({ name: event.name, data: event.data });
  };
  const context: TestContext = {
    dir,
    workspaceRoot,
    db,
    registry,
    services,
    events,
    sink,
    cleanup: () => {
      try {
        closeDatabase(sqlite);
      } catch {
        /* 已关闭 */
      }
      // HTTP 面用例经 `openStateDatabase` 另开了库（句柄在那边的单例表里）：
      // Windows 上未关闭的 SQLite 句柄会让临时目录 `rmSync` 报 EPERM。
      closeStateDatabasesForTest();
      removeTempDirRetrying(dir);
    },
  };
  contexts.push(context);
  return context;
}

function configuredEnv(stub: StubServer): void {
  process.env.MODEL_API_BASE = stub.base;
  process.env.MODEL_API_KEY = "test-model-key-0123456789";
  delete process.env.MODEL_NAME;
}

beforeEach(() => {
  contexts = [];
  stubs = [];
  for (const key of MODEL_ENV_KEYS) {
    delete process.env[key];
  }
  closeStateDatabasesForTest();
  // run 注册表（挂起确认挂在这里）是进程级单例：不重置会让上一条用例的挂起串到这条。
  resetRunsForTest();
});

afterEach(async () => {
  for (const context of contexts) {
    context.cleanup();
  }
  for (const stub of stubs) {
    await stub.close();
  }
  closeStateDatabasesForTest();
  for (const key of MODEL_ENV_KEYS) {
    const previous = savedEnv[key];
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
});

/** 建 stub 并登记进清理表。 */
async function stub(replies: readonly StubReply[]): Promise<StubServer> {
  const server = await startLlmStub(replies);
  stubs.push(server);
  return server;
}

/** 跑一个回合（用生产 LLM 客户端，只是 base 指向回环 stub）。 */
async function turn(
  context: TestContext,
  options: {
    readonly message?: string;
    readonly sessionId?: string;
    readonly signal?: AbortSignal;
  } = {},
): Promise<TurnResult> {
  const config = readLlmConfig();
  if (config === null) {
    throw new Error("测试未配置 MODEL_API_BASE/MODEL_API_KEY");
  }
  return runTurn({
    runId: "run-loop-test",
    sessionId: options.sessionId ?? "session-loop-test",
    message: options.message ?? "你好",
    signal: options.signal ?? new AbortController().signal,
    db: context.db,
    registry: context.registry,
    services: context.services,
    llm: createLlmClient(config, realFetch()),
    onEvent: context.sink,
  });
}

describe("runTurn：纯文本回合", () => {
  it("回复落库（seq 连续）、发 token 单事件、delivery=claimed、写 turn.end 审计", async () => {
    const context = makeContext();
    const server = await stub([() => textReply("你好，我是 agentplant。")]);
    configuredEnv(server);

    const result = await turn(context, { message: "你好" });

    expect(result.reply).toBe("你好，我是 agentplant。");
    expect(result.delivery).toBe("claimed");
    expect(result.blockedHint).toBe(false);
    expect(result.finishReason).toBe("stop");
    expect(result.evidence).toEqual({ toolName: "none", count: 0, toolCallIds: [] });

    // 消息落库：seq 连续 1(user)/2(assistant)，正文原样。
    const messages = context.db.listMessages("session-loop-test");
    expect(messages.map((row) => [row.seq, row.role, row.content])).toEqual([
      [1, "user", "你好"],
      [2, "assistant", "你好，我是 agentplant。"],
    ]);

    // 事件：token → done（顺序即契约，ia §3 禁止重排）。
    // 主循环只发**回合内**事件：纯文本回合 = 一个 token（正文一次性发）。
    // `start` / `done` 是传输层事件，由 routes 发（见 loop.ts 注释）——HTTP 面用例覆盖它们。
    expect(context.events.map((entry) => entry.name)).toEqual(["token"]);
    expect(context.events[0]?.data).toMatchObject({ deltaText: "你好，我是 agentplant。" });
    expect(context.events.some((entry) => entry.name === "start")).toBe(false);
    expect(context.events.some((entry) => entry.name === "done")).toBe(false);

    // 请求面：真发了 key、tools 是 7 个内置工具、tool_choice=auto、model 落默认值、stream=false。
    const request = server.requests[0];
    expect(server.requests).toHaveLength(1);
    expect(request?.url).toBe("/chat/completions");
    expect(request?.authorization).toBe("Bearer test-model-key-0123456789");
    expect(request?.toolChoice).toBe("auto");
    expect(request?.model).toBe("deepseek-chat");
    expect(request?.stream).toBe(false);
    expect(request?.tools).toHaveLength(7);
    expect(request?.messageRoles).toEqual(["system", "user"]);

    // 审计：turn.end，status=claimed（事实口径），payload 只有元数据。
    const audit = context.db.tailAudit({ sessionId: "session-loop-test" });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.kind).toBe("turn.end");
    expect(audit[0]?.status).toBe("claimed");
    expect(audit[0]?.runId).toBe("run-loop-test");
    const meta = JSON.parse(audit[0]?.payloadMeta ?? "{}") as Record<string, unknown>;
    expect(meta.toolName).toBe("none");
    expect(meta.resultBytes).toBe(Buffer.byteLength("你好，我是 agentplant。", "utf8"));
  });

  it("正文命中计划词 → blockedHint=true 且审计 status=blocked（M1 无 tasks 表的口径）", async () => {
    const context = makeContext();
    const server = await stub([() => textReply("接下来我会读取配置文件，然后给你结论。")]);
    configuredEnv(server);

    const result = await turn(context, { message: "帮我查一下配置" });

    expect(result.delivery).toBe("claimed");
    expect(result.blockedHint).toBe(true);
    const audit = context.db.tailAudit({ sessionId: "session-loop-test" });
    expect(audit[0]?.status).toBe("blocked");
  });
});

describe("runTurn：工具调用回合", () => {
  it("tool_call → 真执行 write_file → tool_result ok → 第二轮收尾：verified + evidence 对应", async () => {
    const context = makeContext();
    const server = await stub([
      () =>
        toolCallReply([
          { id: "call-w1", name: "write_file", args: { path: "hello.md", content: "你好\n世界\n", mode: "create" } },
        ]),
      () => textReply("已写入 hello.md，共 2 行。"),
    ]);
    configuredEnv(server);

    const result = await turn(context, { message: "把 hello.md 写出来" });

    // 真写盘（不是 mock 成功）。
    const written = readFileSync(join(context.workspaceRoot, "hello.md"), "utf8");
    expect(written).toBe("你好\n世界\n");

    expect(result.delivery).toBe("verified");
    expect(result.blockedHint).toBe(false);
    expect(result.evidence.toolName).toBe("write_file");
    expect(result.evidence.count).toBe(1);
    expect(result.evidence.toolCallIds).toEqual(["call-w1"]);
    expect(result.toolCalls).toEqual([{ name: "write_file", callId: "call-w1", ok: true }]);

    // 事件序：tool_call → tool_result → token（块顺序 = 后端事件顺序；start/done 由 routes 发）。
    expect(context.events.map((entry) => entry.name)).toEqual(["tool_call", "tool_result", "token"]);
    const callData = context.events[0]?.data;
    expect(validate(SseToolCallDataSchema, callData).ok).toBe(true);
    expect(callData).toMatchObject({ callId: "call-w1", name: "write_file" });
    const resultData = context.events[1]?.data;
    expect(validate(SseToolResultDataSchema, resultData).ok).toBe(true);
    expect(resultData).toMatchObject({ callId: "call-w1", ok: true });

    // 落库：user / tool / assistant 三条，tool 行带 toolName + toolCallId。
    const messages = context.db.listMessages("session-loop-test");
    expect(messages.map((row) => [row.seq, row.role])).toEqual([
      [1, "user"],
      [2, "tool"],
      [3, "assistant"],
    ]);
    expect(messages[1]?.toolName).toBe("write_file");
    expect(messages[1]?.toolCallId).toBe("call-w1");
    expect(messages[1]?.content).toContain("hello.md");

    // 第二轮请求：带上 tool 消息 + tool_call_id（OpenAI 形合法）。
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]?.messageRoles).toEqual(["system", "user", "assistant", "tool"]);
    const secondMessages = server.requests[1]?.body.messages as { tool_call_id?: string }[];
    expect(secondMessages.at(-1)?.tool_call_id).toBe("call-w1");

    // 审计写的是 verified；payload 的 toolName 是首个工具名，argKeys 如实为空
    // （主循环拿不到逐次物化的参数键名，**不拿工具名冒充参数键名**）。
    const audit = context.db.tailAudit({ sessionId: "session-loop-test" });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.status).toBe("verified");
    const meta = JSON.parse(audit[0]?.payloadMeta ?? "{}") as Record<string, unknown>;
    expect(meta.toolName).toBe("write_file");
    expect(meta.argKeys).toEqual([]);
    expect(meta.argCount).toBe(0);
    // 正文（文件内容）永不进账本。
    expect(JSON.stringify(audit)).not.toContain("世界");
  });

  it("工具执行失败（越权路径）→ ok:false + 分类前缀，回合仍收尾且不产生证据", async () => {
    const context = makeContext();
    const server = await stub([
      () => toolCallReply([{ id: "call-bad", name: "read_file", args: { path: "../outside.txt" } }]),
      () => textReply("读取失败：越出工作区。"),
    ]);
    configuredEnv(server);

    const result = await turn(context, { message: "读工作区外的文件" });

    const resultData = context.events[1]?.data as { ok: boolean; summary: string };
    expect(resultData.ok).toBe(false);
    expect(resultData.summary).toMatch(/^\[(input|authorization|runtime)\]/);
    expect(result.delivery).toBe("claimed");
    expect(result.evidence.count).toBe(0);
    expect(result.toolCalls).toEqual([{ name: "read_file", callId: "call-bad", ok: false }]);
    // 失败的工具消息也落库（下次请求要看到"为什么失败"）。
    expect(context.db.listMessages("session-loop-test")[1]?.toolName).toBe("read_file");
  });

  it("未知工具名（模型幻觉）→ ok:false 明确报错，不编造结果", async () => {
    const context = makeContext();
    const server = await stub([
      () => toolCallReply([{ id: "call-x", name: "teleport", args: { to: "月球" } }]),
      () => textReply("没有这个工具。"),
    ]);
    configuredEnv(server);

    const result = await turn(context, { message: "瞬移到月球" });

    const resultData = context.events[1]?.data as { ok: boolean; summary: string };
    expect(resultData.ok).toBe(false);
    expect(resultData.summary).toContain("未知工具");
    expect(result.delivery).toBe("claimed");
    expect(result.evidence.count).toBe(0);
  });

  it("run_command → **挂起等确认**：只发 tool_call、无 tool 行、finishReason=tool_calls", async () => {
    const context = makeContext();
    const server = await stub([
      () => toolCallReply([{ id: "call-pending", name: "run_command", args: { cmd: "echo hi" } }]),
      () => textReply("如果这条被用到，说明挂起后还在继续跑模型。"),
    ]);
    configuredEnv(server);

    const result = await turn(context, { message: "跑个命令" });

    // 事件序：**只有** tool_call —— 前端据此渲染待确认卡片（有 call 无 result）。
    expect(context.events.map((entry) => entry.name)).toEqual(["tool_call"]);
    expect(validate(SseToolCallDataSchema, context.events[0]?.data).ok).toBe(true);
    // 没执行：既不在 toolCalls（成功/失败清单）里，也不产生证据。
    expect(result.pendingConfirmations).toEqual([{ callId: "call-pending", name: "run_command" }]);
    expect(result.toolCalls).toEqual([]);
    expect(result.evidence.count).toBe(0);
    expect(result.delivery).toBe("claimed");
    expect(result.reply).toBe("");
    expect(result.finishReason).toBe("tool_calls");
    // 挂起就是停下：不再打第二轮模型（stub 只收到一次请求）。
    expect(server.requests).toHaveLength(1);
    // messages 里没有 tool 行 —— "命令跑过了"的痕迹一个都不许有。
    expect(context.db.listMessages("session-loop-test").map((row) => row.role)).toEqual(["user"]);
    // 挂起登记在 run 注册表里（confirm 的唯一入口）。
    expect(getPendingCall("run-loop-test", "call-pending")?.name).toBe("run_command");
    expect(getPendingCall("run-loop-test", "call-pending")?.rawArgs).toBe(
      JSON.stringify({ cmd: "echo hi" }),
    );
  });

  it("write_file 越界 → 同样挂起：工作区外没有文件、库里没有工具行", async () => {
    const context = makeContext();
    const server = await stub([
      () =>
        toolCallReply([
          {
            id: "call-escape",
            name: "write_file",
            args: { path: "../escape.md", content: "越界内容", mode: "create" },
          },
        ]),
    ]);
    configuredEnv(server);

    const result = await turn(context, { message: "写到工作区外" });

    expect(result.pendingConfirmations).toEqual([{ callId: "call-escape", name: "write_file" }]);
    expect(context.events.map((entry) => entry.name)).toEqual(["tool_call"]);
    expect(existsSync(join(context.dir, "escape.md"))).toBe(false);
    expect(context.db.listMessages("session-loop-test").map((row) => row.role)).toEqual(["user"]);
  });

  it("同一批里排在挂起调用**之前**的工具照常执行落库（部分执行如实体现）", async () => {
    const context = makeContext();
    writeFileSync(join(context.workspaceRoot, "note.md"), "已有内容\n", "utf8");
    const server = await stub([
      () =>
        toolCallReply([
          { id: "call-read", name: "read_file", args: { path: "note.md" } },
          { id: "call-cmd", name: "run_command", args: { cmd: "echo hi" } },
        ]),
    ]);
    configuredEnv(server);

    const result = await turn(context, { message: "先读再跑命令" });

    expect(context.events.map((entry) => entry.name)).toEqual(["tool_call", "tool_result", "tool_call"]);
    expect(result.toolCalls).toEqual([{ name: "read_file", callId: "call-read", ok: true }]);
    expect(result.pendingConfirmations).toEqual([{ callId: "call-cmd", name: "run_command" }]);
    // read_file 真执行了（tool 行落库），run_command 没有（只有 user + 一条 tool 行）。
    const roles = context.db.listMessages("session-loop-test").map((row) => row.role);
    expect(roles).toEqual(["user", "tool"]);
    expect(getPendingCall("run-loop-test", "call-read")).toBeUndefined();
  });

  it("连续 8 轮工具调用 → 达上限后停下并如实标注 finishReason=tool_calls", async () => {
    const context = makeContext();
    let counter = 0;
    const server = await stub([
      () => {
        counter += 1;
        return toolCallReply([
          {
            id: `call-${counter}`,
            // 真实存在的目标（临时工作区里没有 package.json）：8 轮必须**真成功**，
            // 否则这条用例证明不了"用满上限"，只会证明"读了 8 次不存在的文件"。
            name: "write_file",
            args: { path: "loop-proof.md", content: `round ${counter}`, mode: "overwrite" },
          },
        ]);
      },
    ]);
    configuredEnv(server);

    const result = await turn(context, { message: "一直写文件" });

    expect(server.requests).toHaveLength(8);
    expect(result.finishReason).toBe("tool_calls");
    expect(result.reply).toBe("");
    expect(result.toolCalls).toHaveLength(8);
    expect(result.evidence.count).toBe(8);
    expect(result.evidence.toolCallIds).toEqual([
      "call-1",
      "call-2",
      "call-3",
      "call-4",
      "call-5",
      "call-6",
      "call-7",
      "call-8",
    ]);
    // 达上限 ≠ 静默截断：审计仍然写（事实口径 verified，因为有 8 条成功证据）。
    const audit = context.db.tailAudit({ sessionId: "session-loop-test" });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.status).toBe("verified");
  });

  it("memory_write 真落库（memoryDb 已接线），并能被 memory_search 检索到", async () => {
    const context = makeContext();
    const server = await stub([
      () =>
        toolCallReply([
          {
            id: "call-mem",
            name: "memory_write",
            args: { kind: "preference", text: "用户喜欢深烘咖啡" },
          },
        ]),
      () => textReply("记住了。"),
    ]);
    configuredEnv(server);

    const result = await turn(context, { message: "记住我喜欢深烘咖啡" });

    // 先确认模型真的调的是 memory_write（否则下面的"落库"断言会指向错误的原因）。
    expect(result.toolCalls).toEqual([{ name: "memory_write", callId: "call-mem", ok: true }]);
    expect(result.delivery).toBe("verified");
    // 真落库。FTS5 的 `unicode61` 把整段中文当**一个** token（本仓既有口径），
    // 因此按**整句**检索可命中；按"深烘"这类子串检索命不中是存储层的既有行为，
    // 与本任务无关（t15 只证明 memoryDb 已接线、记忆真进了库）。
    const found = context.db.searchMemories("用户喜欢深烘咖啡");
    expect(found).toHaveLength(1);
    expect(found[0]?.content).toBe("用户喜欢深烘咖啡");
    expect(found[0]?.scope).toBe("session");
    // 已调用 memory_write → 记忆建议不触发。
    expect(result.memorySuggestion).toBeUndefined();
  });

  it("成功写文件但未写记忆 → 产出记忆建议串（仅提示，不自动写库）", async () => {
    const context = makeContext();
    const server = await stub([
      () =>
        toolCallReply([
          { id: "call-w", name: "write_file", args: { path: "note.md", content: "便签正文", mode: "create" } },
        ]),
      () => textReply("写好了。"),
    ]);
    configuredEnv(server);

    const result = await turn(context, { message: "写个便签" });

    expect(result.memorySuggestion).toContain("memory_write");
    // 只是建议：库里不该凭空多出记忆（来源不可污染，ia §5）。
    expect(context.db.searchMemories("便签正文")).toEqual([]);
    // 交付口径仍是事实判定（写成功 = verified），建议不改变判定。
    expect(result.delivery).toBe("verified");
  });
});

describe("runTurn：错误与取消", () => {
  it("模型 4xx → LlmError(model_request_failed)，消息带状态码", async () => {
    const context = makeContext();
    const server = await stub([() => ({ status: 429, body: { error: { message: "rate limited" } } })]);
    configuredEnv(server);

    const error = await turn(context).then(
      () => null,
      (thrown: unknown) => thrown as Error & { code?: string },
    );
    expect(error).not.toBeNull();
    expect(error?.code).toBe("model_request_failed");
    expect(error?.message).toContain("429");
    // 失败回合不写 turn.end（没有交付结论可记）。
    expect(context.db.tailAudit({ sessionId: "session-loop-test" })).toEqual([]);
  });

  it("模型 5xx → 普通 Error（服务故障，不是调用错误）", async () => {
    const context = makeContext();
    const server = await stub([() => ({ status: 503, body: { error: "upstream down" } })]);
    configuredEnv(server);

    const error = await turn(context).then(
      () => null,
      (thrown: unknown) => thrown as Error & { code?: string },
    );
    expect(error).not.toBeNull();
    expect(error?.code).toBeUndefined();
    expect(error?.message).toContain("503");
  });

  it("模型未配置 → 上层据 readLlmConfig()===null 抛出诚实错误（绝不回放 mock）", async () => {
    const context = makeContext();
    expect(readLlmConfig()).toBeNull();
    expect(MODEL_NOT_CONFIGURED_MESSAGE).toContain("未配置模型 provider");
    // 未配置时不发起任何回合：库里不留消息（诚实路径的直接证据）。
    expect(context.db.listMessages("session-loop-test")).toEqual([]);
  });

  it("abort：signal 透传到模型请求（挂起的 stub），AbortError 收场且不落 assistant 正文", async () => {
    const context = makeContext();
    // 手工起一个"响应前先挂住"的 stub：模拟模型还在生成。
    const server: Server = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "太晚了" } }] }));
        }, 400);
      });
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    });
    stubs.push({
      port,
      base: `http://127.0.0.1:${port}`,
      requests: [],
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    });
    process.env.MODEL_API_BASE = `http://127.0.0.1:${port}`;
    process.env.MODEL_API_KEY = "test-model-key-0123456789";

    const controller = new AbortController();
    const config = readLlmConfig();
    if (config === null) {
      throw new Error("测试未配置模型 env");
    }
    const pending = runTurn({
      runId: "run-abort",
      sessionId: "session-abort",
      message: "开始一个长任务",
      signal: controller.signal,
      db: context.db,
      registry: context.registry,
      services: context.services,
      llm: createLlmClient(config, realFetch()),
      onEvent: context.sink,
    });
    // 请求已发出但模型还没回 → 取消：必须立刻以 AbortError 收场（不许等 120s 超时）。
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    const error = await pending.then(
      () => null,
      (thrown: unknown) => thrown as Error,
    );
    expect(error).not.toBeNull();
    expect(error?.name).toBe("AbortError");
    // 取消不是交付：没有 assistant 消息，也没有 turn.end 审计。
    expect(context.db.listMessages("session-abort").map((row) => row.role)).toEqual(["user"]);
    expect(context.db.tailAudit({ sessionId: "session-abort" })).toEqual([]);
  });
});

describe("runTurn：会话与历史", () => {
  it("归档会话拒绝追加回合（终态不可降级）", async () => {
    const context = makeContext();
    const session = context.db.createSession({ id: "session-archived" });
    context.db.archiveSession(session.id);
    const server = await stub([() => textReply("不该被调用")]);
    configuredEnv(server);

    const error = await turn(context, { sessionId: "session-archived" }).then(
      () => null,
      (thrown: unknown) => thrown as Error,
    );
    expect(error?.message).toContain("会话已归档");
    // 归档会话里不许留下任何新消息，也不许真的去打模型。
    expect(context.db.listMessages("session-archived")).toEqual([]);
    expect(server.requests).toHaveLength(0);
  });

  it("历史注入：只带最近 20 条，且本轮 user 追加在其后（seq 继续自增）", async () => {
    const context = makeContext();
    context.db.createSession({ id: "session-history" });
    for (let index = 1; index <= 25; index += 1) {
      context.db.appendMessage({
        sessionId: "session-history",
        seq: index,
        role: index % 2 === 0 ? "assistant" : "user",
        content: `历史消息 ${index}`,
      });
    }
    const server = await stub([() => textReply("收到")]);
    configuredEnv(server);

    await turn(context, { sessionId: "session-history", message: "最新问题" });

    const roles = server.requests[0]?.messageRoles ?? [];
    // system + 20 条历史 + 本轮 user
    expect(roles).toHaveLength(22);
    expect(roles[0]).toBe("system");
    const messages = server.requests[0]?.body.messages as { content: string }[];
    expect(messages[1]?.content).toBe("历史消息 6");
    expect(messages.at(-1)?.content).toBe("最新问题");
    // 落库 seq 连续：26 = 本轮 user，27 = assistant。
    const stored = context.db.listMessages("session-history");
    expect(stored.map((row) => row.seq).slice(-2)).toEqual([26, 27]);
    expect(stored.at(-1)?.role).toBe("assistant");
  });
});

/** 一次真 HTTP 往返的原始结果（状态码 / 头 / 正文 / 解析后的 JSON）。 */
interface LoopHttpResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly text: string;
  readonly json: unknown;
}

/** 真 HTTP 客户端：chat / confirm / messages 共用（`agent: false` 一次性连接）。 */
function httpSend(
  port: number,
  options: {
    readonly method: string;
    readonly path: string;
    readonly body?: unknown;
    readonly accept?: string;
    readonly token?: string;
  },
): Promise<LoopHttpResponse> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.token ?? "loop-token"}`,
    Accept: options.accept ?? "application/json",
  };
  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(Buffer.byteLength(payload));
  }
  return new Promise<LoopHttpResponse>((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, method: options.method, path: options.path, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown;
          try {
            json = text.length === 0 ? undefined : (JSON.parse(text) as unknown);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
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

/** 起一台真 HTTP server（状态库指向临时目录，模型打注入的回环 stub）。 */
async function listenServer(options: {
  readonly stateDbPath: string;
  readonly workspaceRoot: string;
  readonly fetchImpl: FetchLike;
}): Promise<{ server: Server; port: number }> {
  const server = createServer({
    token: "loop-token",
    version: "0.0.0-loop-test",
    workspaceRoot: options.workspaceRoot,
    stateDbPath: options.stateDbPath,
    runtime: { model: { fetchImpl: options.fetchImpl } },
  });
  const port = await new Promise<number>((resolve, reject) => {
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
  return { server, port };
}

/** 关掉 HTTP server 并断开所有连接（Windows 上不 closeAllConnections 会挂着临时目录）。 */
async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

/** POST /api/chat 并返回 SSE / JSON 正文。 */
async function sendChat(port: number, accept: string, body: unknown): Promise<string> {
  const response = await httpSend(port, { method: "POST", path: "/api/chat", body, accept });
  return response.text;
}

describe("HTTP 面：SSE 推送与错误码（真 server + 真 stub 模型）", () => {
  it("SSE：start/tool_call/tool_result/token/done + [DONE]，且 done.evidence 满足协议", async () => {
    const context = makeContext();
    const modelStub = await stub([
      () =>
        toolCallReply([
          { id: "call-http", name: "write_file", args: { path: "http.md", content: "hi", mode: "create" } },
        ]),
      () => textReply("已写入 http.md。"),
    ]);
    configuredEnv(modelStub);
    const { server, port } = await listenServer({
      stateDbPath: join(context.dir, "http.sqlite"),
      workspaceRoot: context.workspaceRoot,
      fetchImpl: realFetch(),
    });
    try {
      const text = await sendChat(port, "text/event-stream", { message: "写 http.md" });
      const events = [...text.matchAll(/^event: (\w+)$/gm)].map((match) => match[1]);
      expect(events).toEqual(["start", "tool_call", "tool_result", "token", "done"]);
      const dataLines = [...text.matchAll(/^data: (.+)$/gm)].map((match) => match[1] ?? "");
      expect(dataLines.at(-1)).toBe("[DONE]");
      const doneData = JSON.parse(dataLines.at(-2) ?? "{}") as unknown;
      expect(validate(SseDoneDataSchema, doneData).ok).toBe(true);
      expect(doneData).toMatchObject({
        finishReason: "stop",
        delivery: "verified",
        evidence: { toolName: "write_file", count: 1, toolCallIds: ["call-http"] },
      });
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  });

  it("非流式：200 + reply/delivery/evidence（同一判定口径）", async () => {
    const context = makeContext();
    const modelStub = await stub([
      () => textReply("接下来我会写文件。"),
    ]);
    configuredEnv(modelStub);
    const { server, port } = await listenServer({
      stateDbPath: join(context.dir, "http2.sqlite"),
      workspaceRoot: context.workspaceRoot,
      fetchImpl: realFetch(),
    });
    try {
      const text = await sendChat(port, "application/json", { message: "帮我写点东西" });
      const body = JSON.parse(text) as {
        reply: string;
        delivery: string;
        evidence?: unknown;
      };
      expect(body.reply).toBe("接下来我会写文件。");
      expect(body.delivery).toBe("claimed");
      expect(body.evidence).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  });

  it("模型 4xx → SSE error 事件（code=model_request_failed），无 token/done-stop", async () => {
    const context = makeContext();
    const modelStub = await stub([() => ({ status: 401, body: { error: { message: "bad key" } } })]);
    configuredEnv(modelStub);
    const { server, port } = await listenServer({
      stateDbPath: join(context.dir, "http3.sqlite"),
      workspaceRoot: context.workspaceRoot,
      fetchImpl: realFetch(),
    });
    try {
      const text = await sendChat(port, "text/event-stream", { message: "你好" });
      const events = [...text.matchAll(/^event: (\w+)$/gm)].map((match) => match[1]);
      expect(events).toEqual(["start", "error"]);
      const dataLines = [...text.matchAll(/^data: (.+)$/gm)].map((match) => match[1] ?? "");
      // data 行含结束帧 [DONE]：解析前先滤掉（它不是 JSON）。
      const errorData = dataLines
        .filter((line) => line !== "[DONE]")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((parsed) => typeof parsed.code === "string");
      expect(validate(SseErrorDataSchema, errorData).ok).toBe(true);
      expect(errorData).toMatchObject({ code: "model_request_failed" });
      expect(dataLines.at(-1)).toBe("[DONE]");
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  });

  it("显式未配置（runtime.model.llm = null）→ 400 + code=model_unconfigured 的诚实路径", async () => {
    const context = makeContext();
    const server = createServer({
      token: "loop-token",
      version: "0.0.0-loop-test",
      workspaceRoot: context.workspaceRoot,
      stateDbPath: join(context.dir, "http4.sqlite"),
      runtime: { model: { llm: null } },
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    });
    try {
      const text = await sendChat(port, "application/json", { message: "你好" });
      const body = JSON.parse(text) as { code: string; message: string };
      expect(body.code).toBe("model_unconfigured");
      expect(body.message).toBe(MODEL_NOT_CONFIGURED_MESSAGE);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  });
});

/** SSE 正文 → 事件列表（`[DONE]` 结束帧没有 event 名，天然被滤掉）。 */
function sseEvents(text: string): { name: string; data: Record<string, unknown> }[] {
  const events: { name: string; data: Record<string, unknown> }[] = [];
  for (const block of text.split("\n\n")) {
    const name = /^event: (\w+)$/m.exec(block)?.[1];
    const raw = /^data: (.+)$/m.exec(block)?.[1];
    if (name === undefined || raw === undefined || raw === "[DONE]") {
      continue;
    }
    events.push({ name, data: JSON.parse(raw) as Record<string, unknown> });
  }
  return events;
}

describe("就地确认协议（M1-9 ③：挂起 → confirm → 执行 / 拒绝）", () => {
  interface SuspendedRun {
    readonly server: Server;
    readonly port: number;
    readonly dbPath: string;
    readonly runId: string;
    readonly sessionId: string;
    readonly callId: string;
    readonly events: { name: string; data: Record<string, unknown> }[];
  }

  /**
   * 跑一次真 HTTP chat，停在确认处（stub 模型给一个要确认的工具调用）。
   *
   * 全部走生产路径：真 server + 真 SQLite + 真回环 stub 模型；确认用的 `runId`/`callId`
   * 就是从 SSE 帧里解析出来的（前端也是这么拿的）。
   */
  async function suspendChat(
    context: TestContext,
    options: {
      readonly dbName: string;
      readonly message: string;
      readonly calls: readonly { id: string; name: string; args: unknown }[];
    },
  ): Promise<SuspendedRun> {
    const modelStub = await stub([() => toolCallReply(options.calls)]);
    configuredEnv(modelStub);
    const dbPath = join(context.dir, options.dbName);
    const { server, port } = await listenServer({
      stateDbPath: dbPath,
      workspaceRoot: context.workspaceRoot,
      fetchImpl: realFetch(),
    });
    const text = await sendChat(port, "text/event-stream", { message: options.message });
    const events = sseEvents(text);
    const start = events.find((entry) => entry.name === "start");
    const call = events.find((entry) => entry.name === "tool_call");
    return {
      server,
      port,
      dbPath,
      runId: String(start?.data.runId ?? ""),
      sessionId: String(start?.data.sessionId ?? ""),
      callId: String(call?.data.callId ?? ""),
      events,
    };
  }

  it("挂起：SSE 只有 start/tool_call/done（无 tool_result），done 无 evidence", async () => {
    const context = makeContext();
    const run = await suspendChat(context, {
      dbName: "confirm-hang.sqlite",
      message: "跑个命令",
      calls: [{ id: "call-1", name: "run_command", args: { cmd: "echo hi" } }],
    });
    try {
      expect(run.events.map((entry) => entry.name)).toEqual(["start", "tool_call", "done"]);
      const done = run.events[2]?.data ?? {};
      expect(validate(SseDoneDataSchema, done).ok).toBe(true);
      expect(done).toMatchObject({ finishReason: "tool_calls", delivery: "claimed" });
      expect(done.evidence).toBeUndefined();
      // callId 只能从 tool_call 帧拿到（挂起卡片就是这么渲染的）。
      expect(run.events[1]?.data).toMatchObject({ callId: "call-1", name: "run_command" });
    } finally {
      await closeServer(run.server);
    }
  });

  it("无 confirm → 挂起的工具**永不执行**（messages 无 tool 行、审计无 tool.* 行）", async () => {
    const context = makeContext();
    const run = await suspendChat(context, {
      dbName: "confirm-never.sqlite",
      message: "跑个命令",
      calls: [{ id: "call-never", name: "run_command", args: { cmd: "echo never" } }],
    });
    try {
      const dao = openStateDatabase(run.dbPath).dao;
      expect(dao.listMessages(run.sessionId).map((row) => row.role)).toEqual(["user"]);
      expect(dao.tailAudit({ sessionId: run.sessionId }).map((row) => row.kind)).toEqual(["turn.end"]);
      // 挂起仍在注册表里等确认（"永不执行"是"没人确认"，不是"被丢弃"）。
      expect(getPendingCall(run.runId, "call-never")?.name).toBe("run_command");
    } finally {
      await closeServer(run.server);
    }
  });

  it("allow → 真执行（run_command 真跑）→ tool 行落库 + allowed/tool.result 审计", async () => {
    const context = makeContext();
    const run = await suspendChat(context, {
      dbName: "confirm-allow.sqlite",
      message: "跑个命令",
      calls: [{ id: "call-allow", name: "run_command", args: { cmd: "echo agentplant-confirm-ok" } }],
    });
    try {
      const confirmed = await httpSend(run.port, {
        method: "POST",
        path: "/api/chat/confirm",
        body: { runId: run.runId, toolCallId: "call-allow", decision: "allow" },
      });
      expect(confirmed.status).toBe(200);
      expect(validate(ChatConfirmResponseSchema, confirmed.json).ok).toBe(true);
      expect(confirmed.json).toMatchObject({ confirmed: true, executed: true, ok: true });

      const dao = openStateDatabase(run.dbPath).dao;
      const messages = dao.listMessages(run.sessionId);
      expect(messages.map((row) => row.role)).toEqual(["user", "tool"]);
      expect(messages[1]?.toolName).toBe("run_command");
      expect(messages[1]?.toolCallId).toBe("call-allow");
      // 真跑了：命令的 stdout 原样在库里（不是"看起来成功"的占位）。
      expect(messages[1]?.content).toContain("agentplant-confirm-ok");
      expect(messages[1]?.content).toContain("exitCode=0");

      const audit = dao.tailAudit({ sessionId: run.sessionId });
      expect(audit.map((row) => [row.kind, row.status])).toEqual([
        ["turn.end", "claimed"],
        ["tool.call", "allowed"],
        ["tool.result", "ok"],
      ]);
      // 账本只记元数据：命令正文不进 payload_meta。
      expect(audit[1]?.payloadMeta).toContain("argKeys");
      expect(audit[1]?.payloadMeta).not.toContain("agentplant-confirm-ok");
      // 挂起已解决：再摘一次拿不到。
      expect(getPendingCall(run.runId, "call-allow")).toBeUndefined();

      // M1 口径：确认结果**不同流续推**，调用方用 GET messages 拉（这里就是那条路）。
      const listed = await httpSend(run.port, {
        method: "GET",
        path: `/api/sessions/${run.sessionId}/messages`,
      });
      expect(listed.status).toBe(200);
      const body = listed.json as { messages: { role: string; toolName?: string }[] };
      expect(body.messages.at(-1)).toMatchObject({ role: "tool", toolName: "run_command" });
    } finally {
      await closeServer(run.server);
    }
  });

  it("deny → 落「用户拒绝了本次执行」且**不执行**（越界文件没有产生）", async () => {
    const context = makeContext();
    const run = await suspendChat(context, {
      dbName: "confirm-deny.sqlite",
      message: "写到工作区外",
      calls: [
        {
          id: "call-deny",
          name: "write_file",
          args: { path: "../escape.md", content: "不该出现的内容", mode: "create" },
        },
      ],
    });
    try {
      const denied = await httpSend(run.port, {
        method: "POST",
        path: "/api/chat/confirm",
        body: { runId: run.runId, toolCallId: "call-deny", decision: "deny" },
      });
      expect(denied.status).toBe(200);
      expect(validate(ChatConfirmResponseSchema, denied.json).ok).toBe(true);
      expect(denied.json).toEqual({ confirmed: true, executed: false });

      const dao = openStateDatabase(run.dbPath).dao;
      const messages = dao.listMessages(run.sessionId);
      expect(messages.map((row) => row.role)).toEqual(["user", "tool"]);
      expect(messages[1]?.content).toBe("用户拒绝了本次执行");
      expect(messages[1]?.toolName).toBe("write_file");
      expect(messages[1]?.toolCallId).toBe("call-deny");
      // 拒绝了就是没执行：文件不存在。
      expect(existsSync(join(context.dir, "escape.md"))).toBe(false);
      const audit = dao.tailAudit({ sessionId: run.sessionId });
      expect(audit.map((row) => [row.kind, row.status])).toEqual([
        ["turn.end", "claimed"],
        ["tool.call", "denied"],
      ]);
    } finally {
      await closeServer(run.server);
    }
  });

  it("重复 confirm → 400 already_resolved（不会执行第二次）", async () => {
    const context = makeContext();
    const run = await suspendChat(context, {
      dbName: "confirm-twice.sqlite",
      message: "跑个命令",
      calls: [{ id: "call-twice", name: "run_command", args: { cmd: "echo once" } }],
    });
    try {
      const body = { runId: run.runId, toolCallId: "call-twice", decision: "deny" as const };
      const first = await httpSend(run.port, { method: "POST", path: "/api/chat/confirm", body });
      expect(first.status).toBe(200);
      const second = await httpSend(run.port, { method: "POST", path: "/api/chat/confirm", body });
      expect(second.status).toBe(400);
      expect(second.json).toMatchObject({ code: "already_resolved" });
      // 第二次没有产生第二条 tool 行。
      const dao = openStateDatabase(run.dbPath).dao;
      expect(dao.listMessages(run.sessionId).filter((row) => row.role === "tool")).toHaveLength(1);
    } finally {
      await closeServer(run.server);
    }
  });

  it("未知 runId → 404 run_not_found；未知 toolCallId → 404 tool_call_not_found", async () => {
    const context = makeContext();
    const run = await suspendChat(context, {
      dbName: "confirm-404.sqlite",
      message: "跑个命令",
      calls: [{ id: "call-known", name: "run_command", args: { cmd: "echo hi" } }],
    });
    try {
      const unknownRun = await httpSend(run.port, {
        method: "POST",
        path: "/api/chat/confirm",
        body: { runId: "run-does-not-exist", toolCallId: "call-known", decision: "allow" },
      });
      expect(unknownRun.status).toBe(404);
      expect(unknownRun.json).toMatchObject({ code: "run_not_found" });

      const unknownCall = await httpSend(run.port, {
        method: "POST",
        path: "/api/chat/confirm",
        body: { runId: run.runId, toolCallId: "call-nope", decision: "allow" },
      });
      expect(unknownCall.status).toBe(404);
      expect(unknownCall.json).toMatchObject({ code: "tool_call_not_found" });
      // 两次失败都**没有**动过挂起集合：真调用仍可确认。
      expect(getPendingCall(run.runId, "call-known")?.name).toBe("run_command");
    } finally {
      await closeServer(run.server);
    }
  });

  it("请求体非法（缺 toolCallId / decision 非 allow|deny）→ 400 bad_request", async () => {
    const context = makeContext();
    const run = await suspendChat(context, {
      dbName: "confirm-400.sqlite",
      message: "跑个命令",
      calls: [{ id: "call-bad", name: "run_command", args: { cmd: "echo hi" } }],
    });
    try {
      const missing = await httpSend(run.port, {
        method: "POST",
        path: "/api/chat/confirm",
        body: { runId: run.runId, decision: "allow" },
      });
      expect(missing.status).toBe(400);
      expect(missing.json).toMatchObject({ code: "bad_request" });

      const badDecision = await httpSend(run.port, {
        method: "POST",
        path: "/api/chat/confirm",
        body: { runId: run.runId, toolCallId: "call-bad", decision: "always" },
      });
      expect(badDecision.status).toBe(400);
      expect(badDecision.json).toMatchObject({ code: "bad_request" });
      // 未认证同样不放行（与其余端点同一条认证路径）。
      const noToken = await httpSend(run.port, {
        method: "POST",
        path: "/api/chat/confirm",
        body: { runId: run.runId, toolCallId: "call-bad", decision: "allow" },
        token: "wrong-token",
      });
      expect(noToken.status).toBe(401);
    } finally {
      await closeServer(run.server);
    }
  });

  it("run 已取消 → 400 run_finished，且不执行（服务层判定，不依赖 HTTP 时序）", async () => {
    const context = makeContext();
    // 直接构造"已 abort 的 run + 一条挂起调用"：这是 run_finished 分支唯一可达的状态
    // （正常回合收尾后 abort 不可能再发生，故 HTTP 面无法稳定复现这个时序）。
    registerRun("run-aborted", "session-aborted");
    registerPendingCall("run-aborted", "session-aborted", {
      callId: "call-aborted",
      name: "run_command",
      args: { cmd: "echo hi" },
      rawArgs: JSON.stringify({ cmd: "echo hi" }),
    });
    expect(abortRun("run-aborted")).toBe(true);

    const outcome = await resolveConfirmation({
      runId: "run-aborted",
      toolCallId: "call-aborted",
      decision: "allow",
      dao: context.db,
      registry: context.registry,
      services: context.services,
    });
    expect(outcome).toMatchObject({ ok: false, status: 400, code: "run_finished" });
    // 未执行：没有消息、没有工具审计（挂起条目仍留着，取消是终态、不伪造"已处理"）。
    expect(context.db.listMessages("session-aborted")).toEqual([]);
    expect(context.db.tailAudit({ sessionId: "session-aborted" })).toEqual([]);
  });
});
