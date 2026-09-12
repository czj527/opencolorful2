/**
 * test-harness：工具测试的共用脚手架（**测试专用，不进产品路径**）。
 *
 * AGENTS.md 禁"mock 回放充数"（t7 §1.2 FG-03）——因此这里提供的是**真东西**：
 * - 真工作区：`os.tmpdir()` 下的临时目录（真盘读写，`cleanup()` 删干净，仓内不留残留）。
 * - 真网络：`node:http` 起的本地 stub 服务器（ephemeral 端口 + 真 socket），
 *   `ToolServices.fetchImpl` 注入（**接口注入**：真实 fetch 语义 + 真 socket，只把"连哪个
 *   主机"换成回环；测试目录里不存在任何 mock 框架 API，AGENTS.md 硬约束 6）。
 * - 真进程：命令类用例直接跑 `node -e`（见 `run-command.test.ts`）。
 *
 * SSRF 守卫的口径决定了 stub 不能直接被访问（127.0.0.1 是私网）——这是**设计如此**。
 * 因此测试用 `createHostResolver`（= 生产里可替换的 DNS 解析函数）把测试域名映射到
 * 回环地址，既走完真实守卫链路，又让本地 socket 可测。守卫本身另有专门的拒绝断言。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  request,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createPathGuard } from "../../policy/guard.js";
import { createRedactor } from "../../policy/redactor.js";
import type {
  FetchLike,
  ResolveHostAddresses,
  ToolContext,
  ToolServices,
} from "../../tools/index.js";

/**
 * 删临时目录：Windows 上被杀进程（或刚结束的进程 / 刚关闭的 SQLite）可能**短暂持有
 * 目录句柄**，此时 `rmSync` 抛 `EPERM`/`EBUSY`。清理失败不该让整个用例判负
 * （断言早就过了），因此退避重试；仍失败只 warn，把残留目录路径打出来人工排查——
 * `os.tmpdir()` 下的残留会随系统清理，而"清理时序 flake 误杀整轮"代价大得多。
 *
 * 导出给各测试文件的 `afterEach`（临时 SQLite 目录也走同一条退避路径）。
 */
export function removeTempDirRetrying(dir: string): void {
  const delays = [200, 200, 200, 200, 200];
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = code === "EPERM" || code === "EBUSY" || code === "ENOTEMPTY";
      if (!retryable || attempt >= delays.length) {
        process.stderr.write(
          `[test-harness] 临时目录清理失败（${String(code)}），残留 ${dir}：` +
            `${error instanceof Error ? error.message : String(error)}\n`,
        );
        return;
      }
      // 同步退避：cleanup 是同步 API（调用点遍布 afterEach），
      // 用 `Atomics.wait` 做同步 sleep，不引入 async 化改造。
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delays[attempt] ?? 200);
    }
  }
}

export interface TestWorkspace {
  readonly root: string;
  writeFile(relativePath: string, content: string): string;
  mkdir(relativePath: string): string;
  /** 工作区外的真实临时文件（越权用例的目标）。 */
  readonly outsideDir: string;
  path(relativePath: string): string;
  cleanup(): void;
}

/** 建一个真实临时工作区；同时在系统临时目录里备一个"工作区外"目录用于越权断言。 */
export function createTestWorkspace(): TestWorkspace {
  const base = mkdtempSync(join(tmpdir(), "agentplant-tools-test-"));
  const root = join(base, "workspace");
  const outsideDir = join(base, "outside");
  mkdirSync(root, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  return {
    root,
    outsideDir,
    path: (relativePath) => join(root, relativePath),
    writeFile(relativePath, content) {
      const full = join(root, relativePath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, "utf8");
      return full;
    },
    mkdir(relativePath) {
      const full = join(root, relativePath);
      mkdirSync(full, { recursive: true });
      return full;
    },
    cleanup: () => removeTempDirRetrying(base),
  };
}

/** 组装 `ToolServices`（真守卫 + 真脱敏器；`fetchImpl`/`memoryDb` 按需注入）。 */
export function createServices(
  workspace: TestWorkspace,
  overrides: Partial<ToolServices> = {},
): ToolServices {
  const guard = createPathGuard(workspace.root);
  return {
    workspaceRoot: guard.workspaceRoot,
    guard,
    redactor: createRedactor(),
    ...overrides,
  };
}

/** 工具上下文（`signal` 默认未触发；取消用例自己造 controller）。 */
export function createContext(options: {
  readonly workspaceRoot: string;
  readonly runId?: string;
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
}): ToolContext {
  const context: ToolContext = {
    workspaceRoot: options.workspaceRoot,
    runId: options.runId ?? "run-test",
    sessionId: options.sessionId ?? "session-test",
    signal: options.signal ?? new AbortController().signal,
  };
  return context;
}

export interface StubRequest {
  readonly method: string;
  readonly url: string;
  readonly path: string;
  readonly headers: NodeJS.Dict<string | string[]>;
}

export type StubHandler = (request: StubRequest, response: ServerResponse) => void;

export interface StubServer {
  readonly port: number;
  readonly url: string;
  readonly requests: StubRequest[];
  close(): Promise<void>;
}

/** 起一个真实 HTTP stub 服务器（ephemeral 端口；记录收到的请求供断言）。 */
export async function startStubServer(handler: StubHandler): Promise<StubServer> {
  const requests: StubRequest[] = [];
  const server: Server = createHttpServer((req, res) => {
    const url = req.url ?? "/";
    const request: StubRequest = {
      method: req.method ?? "GET",
      url,
      path: url.split("?")[0] ?? "/",
      headers: req.headers,
    };
    requests.push(request);
    handler(request, res);
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
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** 发送 JSON 响应的小工具。 */
export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    ...headers,
  });
  response.end(payload);
}

/** 发送 HTML 响应的小工具。 */
export function sendHtml(
  response: ServerResponse,
  status: number,
  html: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    ...headers,
  });
  response.end(html);
}

/**
 * 测试用主机解析替身：默认把一切域名解析到**公网地址**（让 URL 通过 SSRF 守卫），
 * `map` 里的域名解析到指定地址（用于"解析到私网"的拒绝断言）。
 *
 * 注意：守卫只认地址是否私网，**不做真实解析**（生产走 `node:dns/promises`）。
 * 所以这里给公网地址并不等于"放行了不可信目标"——真正的连接发生在
 * `createStubFetch` 里，它只连本地 stub。这样既走完守卫链路，又不需要放开守卫本身。
 */
export function createHostResolver(
  map: Record<string, readonly string[]> = {},
  fallback: readonly string[] = ["93.184.216.34"],
): { resolver: ResolveHostAddresses; calls: string[] } {
  const calls: string[] = [];
  const resolver: ResolveHostAddresses = async (hostname) => {
    calls.push(hostname);
    const mapped = map[hostname];
    if (mapped !== undefined) {
      return mapped;
    }
    if (fallback.length === 0) {
      const error = new Error(`测试解析替身没有 ${hostname} 的映射`) as Error & { code?: string };
      error.code = "ENOTFOUND";
      throw error;
    }
    return fallback;
  };
  return { resolver, calls };
}

/**
 * 测试用 `fetchImpl`：把 URL 的**主机名换成 127.0.0.1**，端口保留 → 真打到本地 stub。
 *
 * 这不是 mock fetch：它是一次真实的 HTTP 请求（真 socket、真头、真状态码）。
 * 唯一被替换的是"域名 → 连哪儿"这一步，等价于生产里 DNS 解析之后的连接行为。
 * `redirect: "manual"` 语义照实实现（返回 3xx + Location，由工具逐跳判定）。
 */
export function createStubFetch(options: {
  /** 端口或端口取值函数（stub 后启动时用函数，避免读到旧值）。 */
  readonly port: number | (() => number);
  readonly hostHeader?: string;
}): FetchLike {
  const portOf = typeof options.port === "function" ? options.port : () => options.port as number;
  return (input, init) => {
    const target = new URL(typeof input === "string" ? input : input.toString());
    const headers: Record<string, string | number> = { ...(init?.headers ?? {}) };
    if (options.hostHeader !== undefined) {
      headers.host = options.hostHeader;
    }
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: portOf(),
          method: init?.method ?? "GET",
          path: `${target.pathname}${target.search}`,
          headers,
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            resolve({
              status: res.statusCode ?? 0,
              url: target.toString(),
              headers: { get: (name: string) => res.headers[name.toLowerCase()]?.toString() ?? null },
              text: async () => body,
            });
          });
        },
      );
      const signal = init?.signal;
      if (signal !== undefined) {
        const abort = (): void => {
          req.destroy(new Error("aborted"));
        };
        if (signal.aborted) {
          abort();
        } else {
          signal.addEventListener("abort", abort, { once: true });
        }
      }
      req.on("error", reject);
      req.end();
    });
  };
}
