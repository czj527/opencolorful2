/**
 * web-search-tool.test.ts：`web_search`（**本地回环 HTTP stub 服务器**，非 mock 函数）。
 *
 * 两条主线：
 * 1. **未配置 provider 时诚实报错**（不返回伪造结果）——M1 防假绿的直接证据。
 * 2. 配置 provider 后：真 socket 请求、带 Bearer 头、query/count 拼接、不可信信封、
 *    形状不认识时**报错而不是编造/降级成空结果**；endpoint 也过 SSRF 守卫。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolInputError } from "@agentplant/agent-core";
import { SEARCH_NOT_CONFIGURED_MESSAGE, createWebSearchTool } from "../builtin/web-search.js";
import {
  createContext,
  createHostResolver,
  createServices,
  createStubFetch,
  createTestWorkspace,
  sendJson,
  startStubServer,
  type StubServer,
  type TestWorkspace,
} from "./harness.js";

let workspace: TestWorkspace;
let stub: StubServer | undefined;
const savedEnv = { ...process.env };
const SEARCH_ENV_KEYS = ["SEARCH_PROVIDER", "SEARCH_API_KEY", "SEARCH_API_BASE"] as const;

beforeEach(() => {
  workspace = createTestWorkspace();
  for (const key of SEARCH_ENV_KEYS) {
    delete process.env[key];
  }
});

afterEach(async () => {
  workspace.cleanup();
  if (stub !== undefined) {
    await stub.close();
    stub = undefined;
  }
  for (const key of SEARCH_ENV_KEYS) {
    const previous = savedEnv[key];
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
});

/**
 * 造工具：`hostMap` 覆盖"域名 → 地址"（默认解析到公网地址，让 URL 过 SSRF 守卫），
 * `fetchImpl` 把主机名换成 127.0.0.1 真打本地 stub（真 socket，非 mock fetch）。
 */
function tool(hostMap: Record<string, readonly string[]> = {}) {
  const { resolver } = createHostResolver({ ...hostMap });
  const services = createServices(workspace, {
    resolveHost: resolver,
    fetchImpl: createStubFetch({ port: () => stub?.port ?? 1 }),
  });
  return {
    tool: createWebSearchTool(services),
    ctx: createContext({ workspaceRoot: services.workspaceRoot }),
  };
}

describe("web_search：未配置 provider 时诚实报错", () => {
  it("缺 SEARCH_PROVIDER/SEARCH_API_KEY 时抛 ToolInputError，且消息说明不伪造结果", async () => {
    const { tool: search, ctx } = tool();
    const error = await search
      .execute(ctx as never, { query: "今天天气" })
      .then(() => null)
      .catch((thrown: unknown) => thrown as ToolInputError);
    expect(error).toBeInstanceOf(ToolInputError);
    expect(error?.message).toBe(SEARCH_NOT_CONFIGURED_MESSAGE);
    expect(error?.message).toContain("未配置搜索 provider");
    expect(error?.message).toContain("伪造");
  });

  it("只给 provider 不给 key 仍算未配置", async () => {
    process.env.SEARCH_PROVIDER = "stub-provider";
    const { tool: search, ctx } = tool();
    await expect(search.execute(ctx as never, { query: "x" })).rejects.toBeInstanceOf(
      ToolInputError,
    );
  });

  it("未配置时**不发起任何网络请求**", async () => {
    stub = await startStubServer((_request, response) => sendJson(response, 200, { results: [] }));
    process.env.SEARCH_API_BASE = `http://stub.test:${stub.port}/search`;
    const { tool: search, ctx } = tool();
    await expect(search.execute(ctx as never, { query: "x" })).rejects.toBeInstanceOf(
      ToolInputError,
    );
    expect(stub.requests).toHaveLength(0);
  });
});

describe("web_search：已配置 provider（真 socket）", () => {
  function configure(port: number): void {
    process.env.SEARCH_PROVIDER = "stub-provider";
    process.env.SEARCH_API_KEY = "test-search-key-0123456789";
    process.env.SEARCH_API_BASE = `http://stub.test:${port}/search`;
  }

  it("请求带 query/count 与 Bearer 头，返回结果并包不可信信封", async () => {
    stub = await startStubServer((_request, response) => {
      sendJson(response, 200, {
        results: [
          { title: "结果一", url: "https://example.com/1", snippet: "摘要一" },
          { title: "结果二", url: "https://example.com/2", snippet: "摘要二" },
        ],
      });
    });
    configure(stub.port);
    const { tool: search, ctx } = tool();
    const result = await search.execute(ctx as never, { query: "工具运行时", count: 2 });

    expect(stub.requests).toHaveLength(1);
    const request = stub.requests[0];
    expect(request?.method).toBe("GET");
    expect(request?.url).toContain("q=%E5%B7%A5%E5%85%B7%E8%BF%90%E8%A1%8C%E6%97%B6");
    expect(request?.url).toContain("count=2");
    expect(request?.headers.authorization).toBe("Bearer test-search-key-0123456789");

    expect(result.details?.items).toHaveLength(2);
    expect(result.details?.provider).toBe("stub-provider");
    expect(result.details?.externalContent.untrusted).toBe(true);
    expect(result.content).toContain("不可信外部内容");
    expect(result.content).toContain("结果一");
  });

  it("site 参数拼成 site: 限定词", async () => {
    stub = await startStubServer((_request, response) => sendJson(response, 200, { results: [] }));
    configure(stub.port);
    const { tool: search, ctx } = tool();
    await search.execute(ctx as never, { query: "协议", site: "example.com" });
    expect(stub.requests[0]?.url).toContain("site%3Aexample.com");
  });

  it("空结果如实返回 0 条（不编造）", async () => {
    stub = await startStubServer((_request, response) => sendJson(response, 200, { results: [] }));
    configure(stub.port);
    const { tool: search, ctx } = tool();
    const result = await search.execute(ctx as never, { query: "非常冷门的词" });
    expect(result.details?.items).toEqual([]);
    expect(result.content).toContain("无结果");
  });

  it("provider 结果缺 url 时报错，不降级成空结果", async () => {
    stub = await startStubServer((_request, response) => {
      sendJson(response, 200, { results: [{ title: "没有链接" }] });
    });
    configure(stub.port);
    const { tool: search, ctx } = tool();
    await expect(search.execute(ctx as never, { query: "x" })).rejects.toBeInstanceOf(ToolInputError);
  });

  it("provider 响应缺 results 数组时报错", async () => {
    stub = await startStubServer((_request, response) => {
      sendJson(response, 200, { unexpected: true });
    });
    configure(stub.port);
    const { tool: search, ctx } = tool();
    await expect(search.execute(ctx as never, { query: "x" })).rejects.toBeInstanceOf(ToolInputError);
  });

  it("provider 返回非 JSON 时报错", async () => {
    stub = await startStubServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("not json at all");
    });
    configure(stub.port);
    const { tool: search, ctx } = tool();
    await expect(search.execute(ctx as never, { query: "x" })).rejects.toBeInstanceOf(ToolInputError);
  });

  it("provider 返回 5xx 时报错（不当成没有结果）", async () => {
    stub = await startStubServer((_request, response) => sendJson(response, 502, { error: "bad" }));
    configure(stub.port);
    const { tool: search, ctx } = tool();
    await expect(search.execute(ctx as never, { query: "x" })).rejects.toMatchObject({
      message: expect.stringContaining("502"),
    });
  });

  it("endpoint 解析到私网时被 SSRF 守卫拒绝（配置也不能绕过）", async () => {
    stub = await startStubServer((_request, response) => sendJson(response, 200, { results: [] }));
    configure(stub.port);
    // 该用例把 stub.test 解析到 10.9.9.9（私网）：请求必须在建连之前就被拒
    const { tool: search, ctx } = tool({ "stub.test": ["10.9.9.9"] });
    await expect(search.execute(ctx as never, { query: "x" })).rejects.toBeInstanceOf(
      ToolInputError,
    );
    expect(stub.requests).toHaveLength(0);
  });
});
