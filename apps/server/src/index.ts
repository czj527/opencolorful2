/**
 * @agentplant/server —— 单进程 HTTP+SSE 运行内核（M1-2 骨架）。
 *
 * 职责（骨架期）：一条 `node:http` 进程提供 t4 §3 的 HTTP 端点面 + t4 §2 的 SSE 推送面，
 * 零 Web 框架、零新增运行时依赖（唯一依赖是 `@agentplant/protocol` 的契约）。
 *
 * 环境变量：
 * - `PORT`（默认 43121，与 DSH 的 43120 错开一位，避免本机冲突）
 * - `HOST`（默认 127.0.0.1）
 * - `APP_TOKEN`（不设置则生成临时 token，仅本机有效；非 loopback 绑定时必须显式设置，否则拒绝启动）
 * - `APP_VERSION`（默认 `0.0.0-scaffold`；发布版本号一律由构建期注入，不在源码里硬编码）
 *
 * 启动（必须跑构建产物，禁用 dev 冒充发布，t7 §1.2）：
 *   pnpm --filter @agentplant/server run build && node apps/server/dist/index.js
 */
import { createServer as createHttpServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { EPHEMERAL_TOKEN_WARNING, resolveAuthConfig } from "./auth.js";
import { createRequestHandler, type RouteRuntimeOverrides } from "./routes.js";

/**
 * 工具运行时公开面（t4 §5 / t14）：注册表工厂 + 注入面 + 策略对象。
 *
 * 这里只做**再导出**：t15 主循环按下例组装，本包不在启动期自动构造工具运行时
 * （没有主循环就没有工具调用，提前起一套只会让人以为"工具已经在跑了"）。
 *
 * ```ts
 * const guard = createPathGuard(workspaceRoot);
 * const services: ToolServices = { workspaceRoot: guard.workspaceRoot, guard, redactor };
 * const registry = createCoreRegistry(services);   // 7 个内置工具
 * const tools = registry.resolve({ deny: ["run_command"] });
 * ```
 */
export { createPathGuard, assertAllowed } from "./policy/guard.js";
export type { GuardCheckResult, GuardOperation, PathGuard } from "./policy/guard.js";
export { createRedactor, defaultRedactor, redact } from "./policy/redactor.js";
export type { Redactor } from "./policy/redactor.js";
export { createCoreRegistry, createToolRegistry } from "./tools/index.js";
export type { ToolRegistry, ToolServices } from "./tools/index.js";
export { mapChatError } from "./routes.js";
// `createServer` 由本文件定义（下方 `startServer` 之前），不从 routes 转发，避免与本地定义重名遮蔽。
export type { RouteRuntimeOverrides } from "./routes.js";

/**
 * M1-6 主循环公开面（t15）：主循环入口 + LLM 客户端 + 状态库单例。
 *
 * 桌面壳 / 测试从这里拿 `runTurn` 等，不再各自组装一套（避免两处漂移）。
 */
export {
  MODEL_NOT_CONFIGURED_MESSAGE,
  STATE_DB_PATH_ENV,
  closeStateDatabasesForTest,
  createLlmClient,
  defaultStateDbPath,
  openStateDatabase,
  readLlmConfig,
  runTurn,
} from "./agent/index.js";
export type {
  LlmConfig,
  RunTurnOptions,
  StateDbHandle,
  TurnEventSink,
  TurnResult,
} from "./agent/index.js";

export const DEFAULT_PORT = 43121;
export const DEFAULT_HOST = "127.0.0.1";
/** 骨架期版本戳默认值；真实发布版本由构建期注入 APP_VERSION（禁硬编码发布号）。 */
export const SCAFFOLD_VERSION = "0.0.0-scaffold";

export interface ServerOptions {
  readonly host?: string;
  readonly port?: number;
  /** 显式 token（测试注入用）；缺省时读 `process.env.APP_TOKEN`。 */
  readonly token?: string;
  readonly version?: string;
  readonly workspaceRoot?: string;
  /** 状态库路径（测试注入 tmpdir；缺省读 `STATE_DB_PATH`，否则 `~/.agentplant/agentplant.sqlite`）。 */
  readonly stateDbPath?: string;
  /** 运行期注入面（**仅测试用**：临时库 / 回环 stub 模型 / 额外工具）。 */
  readonly runtime?: RouteRuntimeOverrides;
}

/** 解析端口：非法值回退默认并提示（不静默）。 */
export function resolvePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_PORT;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`PORT 非法（${raw}），回退默认端口 ${DEFAULT_PORT}\n`);
    return DEFAULT_PORT;
  }
  return port;
}

/**
 * 创建（但**不**监听）HTTP server。
 *
 * 测试用法：`createServer({ token, version }).listen(0)` 取 ephemeral 端口直连；
 * 绑定 host 非 loopback 且无显式 token 时抛错（拒绝启动语义见 `resolveAuthConfig`）。
 */
export function createServer(options: ServerOptions = {}): Server {
  const host = options.host ?? process.env.HOST ?? DEFAULT_HOST;
  const resolved = resolveAuthConfig(host, options.token ?? process.env.APP_TOKEN);
  if (!resolved.ok) {
    throw new Error(resolved.reason);
  }
  if (resolved.config.ephemeral) {
    process.stderr.write(`${EPHEMERAL_TOKEN_WARNING}\n`);
  }
  const handler = createRequestHandler({
    token: resolved.config.token,
    version: options.version ?? process.env.APP_VERSION ?? SCAFFOLD_VERSION,
    workspaceRoot: options.workspaceRoot ?? process.cwd(),
    ...(options.stateDbPath === undefined ? {} : { stateDbPath: options.stateDbPath }),
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
  });
  return createHttpServer(handler);
}

/** 拒绝启动分支（t4 §2）：只打印原因到 stderr，然后 exit 1。 */
function createServerOrExit(options: ServerOptions): Server {
  try {
    return createServer(options);
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

/** 启动入口：拒绝启动时 exit 1；成功则打印一行 `server listening on http://<host>:<port>`。 */
export function startServer(options: ServerOptions = {}): Server {
  const host = options.host ?? process.env.HOST ?? DEFAULT_HOST;
  const port = options.port ?? resolvePort(process.env.PORT);
  const server = createServerOrExit({ ...options, host });

  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address !== null ? address.port : port;
    process.stdout.write(`server listening on http://${host}:${actualPort}\n`);
  });
  return server;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  startServer();
}
