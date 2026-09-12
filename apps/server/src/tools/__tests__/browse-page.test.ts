/**
 * browse-page.test.ts：`browse_page`（**真实本地回环 HTTP stub 服务器**，非 mock 函数）。
 *
 * 覆盖：真 socket 抓取、HTML→text（去 script/style）、重定向跟随后 finalUrl/status、
 * 最多 3 跳、`maxBytes` 保头截断、超时、以及 **SSRF 四断言**：
 *   ① 字面量私网 ② localhost ③ 解析到私网 ④ 重定向到私网。
 *
 * stub 服务器监听 `127.0.0.1`（本身就是私网），所以测试经 `resolveHost` 把 `stub.test`
 * 映射到回环 —— 守卫链路照走，只是"域名→地址"这一步在测试里固定（生产走真实 DNS）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolInputError } from "@agentplant/agent-core";
import { createBrowsePageTool } from "../builtin/browse-page.js";
import { guardOutboundUrl, isPrivateAddress } from "../builtin/net.js";
import {
  createContext,
  createHostResolver,
  createServices,
  createStubFetch,
  createTestWorkspace,
  sendHtml,
  sendJson,
  startStubServer,
  type StubServer,
  type TestWorkspace,
} from "./harness.js";

let workspace: TestWorkspace;
let stub: StubServer | undefined;

beforeEach(() => {
  workspace = createTestWorkspace();
});

afterEach(async () => {
  workspace.cleanup();
  if (stub !== undefined) {
    await stub.close();
    stub = undefined;
  }
});

/**
 * 造工具：URL 用 `stub.test` 主机名（守卫看到的是公网地址），
 * `fetchImpl` 把主机名换成 127.0.0.1 真打本地 stub（真 socket）。
 * `hostMap` 可把某个域名覆盖成私网地址，用于拒绝类断言。
 */
function toolFor(hostMap: Record<string, readonly string[]> = {}) {
  const { resolver } = createHostResolver({ ...hostMap });
  const services = createServices(workspace, {
    resolveHost: resolver,
    fetchImpl: createStubFetch({ port: () => stub?.port ?? 1 }),
  });
  return {
    tool: createBrowsePageTool(services),
    ctx: createContext({ workspaceRoot: services.workspaceRoot }),
  };
}

function urlFor(port: number, path: string, host = "stub.test"): string {
  return `http://${host}:${port}${path}`;
}

describe("browse_page：真实抓取与提取", () => {
  it("抓 HTML 并粗提取正文，返回 status/contentType/finalUrl", async () => {
    stub = await startStubServer((_request, response) => {
      sendHtml(
        response,
        200,
        "<html><head><title>T</title><style>body{color:red}</style></head>" +
          "<body><h1>标题</h1><script>alert('xss')</script><p>正文段落</p></body></html>",
      );
    });
    const stubPort = stub.port;
    const { tool, ctx } = toolFor();
    const result = await tool.execute(ctx as never, { url: urlFor(stubPort, "/page") });
    expect(result.details?.status).toBe(200);
    expect(result.details?.contentType).toContain("text/html");
    expect(result.details?.finalUrl).toBe(urlFor(stubPort, "/page"));
    expect(result.content).toContain("标题");
    expect(result.content).toContain("正文段落");
    expect(result.content).not.toContain("alert('xss')");
    expect(result.content).not.toContain("body{color:red}");
    expect(result.details?.externalContent.untrusted).toBe(true);
  });

  it("JSON 响应原样返回（不做 HTML 提取）", async () => {
    stub = await startStubServer((_request, response) => {
      sendJson(response, 200, { hello: "world", n: 2 });
    });
    const { tool, ctx } = toolFor();
    const result = await tool.execute(ctx as never, { url: urlFor(stub.port, "/data.json") });
    expect(result.content).toContain('"hello":"world"');
    expect(result.details?.status).toBe(200);
  });

  it("跟随重定向并在同一守卫链路上记录 finalUrl", async () => {
    stub = await startStubServer((request, response) => {
      if (request.path === "/start") {
        response.writeHead(302, { Location: "/end" });
        response.end();
        return;
      }
      sendHtml(response, 200, "<p>落地页</p>");
    });
    const { tool, ctx } = toolFor();
    const result = await tool.execute(ctx as never, { url: urlFor(stub.port, "/start") });
    expect(result.details?.redirects).toBe(1);
    expect(result.details?.finalUrl).toBe(urlFor(stub.port, "/end"));
    expect(result.content).toContain("落地页");
  });

  it("超过 3 跳时报错（不吃掉无限重定向）", async () => {
    stub = await startStubServer((request, response) => {
      const step = Number((request.path ?? "/").replace("/", "")) || 0;
      response.writeHead(302, { Location: `/${step + 1}` });
      response.end();
    });
    const { tool, ctx } = toolFor();
    await expect(
      tool.execute(ctx as never, { url: urlFor(stub.port, "/0") }),
    ).rejects.toBeInstanceOf(ToolInputError);
  });

  it("HTTP 404 原样返回（不是工具失败：状态码是结论）", async () => {
    stub = await startStubServer((_request, response) => {
      sendHtml(response, 404, "<p>not found</p>");
    });
    const { tool, ctx } = toolFor();
    const result = await tool.execute(ctx as never, { url: urlFor(stub.port, "/missing") });
    expect(result.details?.status).toBe(404);
  });

  it("maxBytes 保头截断（truncated=true 且正文变短）", async () => {
    stub = await startStubServer((_request, response) => {
      sendHtml(response, 200, `<p>${"A".repeat(20_000)}</p><p>尾部标记</p>`);
    });
    const { tool, ctx } = toolFor();
    const result = await tool.execute(ctx as never, {
      url: urlFor(stub.port, "/big"),
      maxBytes: 1024,
    });
    expect(result.details?.truncated).toBe(true);
    expect(result.details?.bytesReturned).toBeLessThanOrEqual(1024);
    expect(result.content).not.toContain("尾部标记");
  });

  it("超时抛 ToolInputError（stub 故意不响应）", async () => {
    stub = await startStubServer(() => {
      // 故意不响应：等客户端超时
    });
    const { tool, ctx } = toolFor();
    await expect(
      tool.execute(ctx as never, { url: urlFor(stub.port, "/hang"), timeoutMs: 300 }),
    ).rejects.toBeInstanceOf(ToolInputError);
  });

  it("非 http(s) scheme 被拒", async () => {
    const { tool, ctx } = toolFor();
    await expect(tool.execute(ctx as never, { url: "file:///etc/passwd" })).rejects.toBeInstanceOf(
      ToolInputError,
    );
  });
});

describe("SSRF 守卫：四断言", () => {
  it("① 字面量私网地址被拒（127.0.0.1 / 10.x / 192.168.x / 169.254.169.254）", async () => {
    const { tool, ctx } = toolFor();
    for (const url of [
      "http://127.0.0.1:8080/x",
      "http://10.0.0.5/admin",
      "http://192.168.1.1/router",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]:8080/x",
    ]) {
      await expect(tool.execute(ctx as never, { url }), url).rejects.toBeInstanceOf(ToolInputError);
    }
  });

  it("①b 非标准写法也拦（`127.1` / 十进制 / 十六进制 / `*.localhost` / `.internal`）", async () => {
    const { tool, ctx } = toolFor();
    for (const url of [
      "http://127.1/x",
      "http://2130706433/x",
      "http://0x7f.1/x",
      "http://something.localhost/x",
      "http://config.internal/x",
    ]) {
      await expect(tool.execute(ctx as never, { url }), url).rejects.toBeInstanceOf(ToolInputError);
    }
  });

  it("② localhost 主机名被拒（不做 DNS 也不放行）", async () => {
    const { tool, ctx } = toolFor();
    await expect(
      tool.execute(ctx as never, { url: "http://localhost:8080/x" }),
    ).rejects.toBeInstanceOf(ToolInputError);
  });

  it("③ 域名解析到私网被拒（fail-closed，且错误消息不回显内网地址）", async () => {
    const { tool, ctx } = toolFor({ "private.test": ["10.1.2.3"] });
    const error = await tool
      .execute(ctx as never, { url: "http://private.test/x" })
      .then(() => null)
      .catch((thrown: unknown) => thrown as ToolInputError);
    expect(error).toBeInstanceOf(ToolInputError);
    expect(error?.message).toContain("解析到私网");
    expect(error?.message).not.toContain("10.1.2.3");
  });

  it("④ 重定向到私网被拒（第一跳合法也不行）", async () => {
    stub = await startStubServer((_request, response) => {
      response.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
      response.end();
    });
    const { tool, ctx } = toolFor();
    const error = await tool
      .execute(ctx as never, { url: urlFor(stub.port, "/redirect") })
      .then(() => null)
      .catch((thrown: unknown) => thrown as ToolInputError);
    expect(error).toBeInstanceOf(ToolInputError);
    expect(error?.message).toContain("私网");
    // 关键：私网那一跳**没有建连**（stub 只收到第一跳）
    expect(stub.requests).toHaveLength(1);
  });

  it("isPrivateAddress 覆盖 IPv4-mapped IPv6 与 CGNAT/6to4", () => {
    expect(isPrivateAddress("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("100.64.0.1")).toBe(true);
    expect(isPrivateAddress("2002:0a00:0001::1")).toBe(true);
    expect(isPrivateAddress("fc00::1")).toBe(true);
    expect(isPrivateAddress("fe80::1")).toBe(true);
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
    expect(isPrivateAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
  });

  it("guardOutboundUrl 放行公网字面量（守卫不是'一律拒绝'）", async () => {
    const guarded = await guardOutboundUrl("https://93.184.216.34/x", { tool: "test" });
    expect(guarded.hostname).toBe("93.184.216.34");
  });
});
