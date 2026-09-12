/**
 * auth：单机 token 认证（t4 §2「认证：单机 token，绑 loopback 可留空自生成，
 * 非 loopback 强制 Authorization: Bearer」）。
 *
 * 语义（骨架期口径）：
 * - token 来源是 `process.env.APP_TOKEN`；未设置且绑 loopback → 生成本次进程有效的临时 token，
 *   **只打印"已生成临时 token"的提示，绝不把 token 明文写进日志**（t4 §2 安全语义）。
 * - 绑非 loopback 地址且没有显式 APP_TOKEN → `resolveAuthConfig` 返回拒绝，启动流程据此 exit 1。
 * - `GET /api/health` 免认证（探活 / desktop 壳启动探测）；其余 `/api/*` 必须带合法 Bearer token。
 *
 * 决策函数是纯函数（`resolveAuthConfig` / `checkAuth`），便于不起进程做函数级单测。
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** 未设置 APP_TOKEN 时打到 stderr 的唯一提示（一行，不含 token 本体）。 */
export const EPHEMERAL_TOKEN_WARNING = "APP_TOKEN not set, generated ephemeral token (not printed)";

/** 免认证端点：只允许探活（其余端点一律要 token）。 */
export const AUTH_EXEMPT_PATHS = ["/api/health"] as const;

/**
 * loopback 主机名集合。
 *
 * t4 §2 写的是"绑 loopback 可留空自生成"；这里把 `localhost` 也算 loopback
 * （它解析到 127.0.0.1/::1），避免本机配置写成 `HOST=localhost` 时被误判成对外暴露。
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/** 生成本次进程有效的临时 token（32 字节 → 64 位 hex）。 */
export function generateEphemeralToken(): string {
  return randomBytes(32).toString("hex");
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

/** 本次进程实际生效的认证配置。 */
export interface AuthConfig {
  readonly token: string;
  /** true = 临时生成（非用户提供），用于"非 loopback 拒绝启动"的判定。 */
  readonly ephemeral: boolean;
}

export type AuthResolution =
  | { readonly ok: true; readonly config: AuthConfig }
  | { readonly ok: false; readonly reason: string };

/**
 * 纯函数：给定绑定 host 与环境里的 APP_TOKEN，决定能否启动、以及用哪个 token。
 *
 * 拒绝条件是"非 loopback **且** 无显式 token"（临时 token 只对本机有意义，
 * 对外暴露时必须由用户显式给 token，否则等于无认证）。
 */
export function resolveAuthConfig(host: string, envToken: string | undefined): AuthResolution {
  const provided = envToken !== undefined && envToken.trim().length > 0 ? envToken : undefined;
  if (provided !== undefined) {
    return { ok: true, config: { token: provided, ephemeral: false } };
  }
  if (!isLoopbackHost(host)) {
    return {
      ok: false,
      reason:
        `拒绝启动：HOST=${host} 不是 loopback，必须显式设置 APP_TOKEN 才能对外监听（t4 §2）`,
    };
  }
  return { ok: true, config: { token: generateEphemeralToken(), ephemeral: true } };
}

/** 认证判定结果：`missing` = 没带 Bearer；`invalid` = 带了但对不上。 */
export type AuthCheck = "ok" | "missing" | "invalid";

/** 从 `Authorization: Bearer <token>` 取出 token（scheme 大小写不敏感）。 */
export function readBearerToken(req: Pick<IncomingMessage, "headers">): string | undefined {
  const raw = req.headers.authorization;
  if (typeof raw !== "string") {
    return undefined;
  }
  const parts = raw.trim().split(/\s+/);
  const scheme = parts[0];
  if (scheme === undefined || scheme.toLowerCase() !== "bearer") {
    return undefined;
  }
  const value = parts.slice(1).join(" ").trim();
  return value.length > 0 ? value : undefined;
}

/** 定长比较，避免按字节泄露 token 前缀（本地单机也顺手做对）。 */
function isSameToken(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (actualBytes.length !== expectedBytes.length) {
    return false;
  }
  return timingSafeEqual(actualBytes, expectedBytes);
}

/**
 * 认证中间件的判定函数。
 *
 * 与 spec 的 `checkAuth(req)` 相比多一个显式 `expectedToken` 形参：token 由启动流程
 * （`resolveAuthConfig`）决定后注入，避免把配置塞进模块级可变状态（否则并行测试互相污染）。
 */
export function checkAuth(req: Pick<IncomingMessage, "headers">, expectedToken: string): AuthCheck {
  const token = readBearerToken(req);
  if (token === undefined) {
    return "missing";
  }
  return isSameToken(token, expectedToken) ? "ok" : "invalid";
}

/** 该路径是否免认证。 */
export function isAuthExemptPath(pathname: string): boolean {
  return (AUTH_EXEMPT_PATHS as readonly string[]).includes(pathname);
}
