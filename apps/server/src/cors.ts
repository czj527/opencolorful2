/**
 * cors：`OPTIONS` 预检放行（M1-9 ②）。
 *
 * 背景：GUI 是**本地** Web 壳（DSH Web / 桌面渲染层）跑在另一个端口上，浏览器对
 * `POST /api/chat`（JSON body + `Authorization` 头）会先发一次预检；没有 `OPTIONS` 应答，
 * 请求根本到不了业务路由（服务端只看到"某个未知路由 404"，前端只看到 CORS 报错）。
 *
 * 三条纪律：
 * 1. **只回显 loopback origin**：`http(s)://127.0.0.1|localhost|[::1]` 才写
 *    `Access-Control-Allow-Origin`。来自局域网/公网的 origin 一律**不写该头**——
 *    本服务是单机私人助理，没有"跨站共享"的需求；把 ACAO 一律写成 `*` 等于让任意网页
 *    在用户浏览器里读他的记忆与会话（t4 §2 单机边界）。
 * 2. **预检不动业务**：`OPTIONS` 在路由匹配与认证**之前**收场（预检请求按浏览器规范
 *    不带 `Authorization`；让它走认证只会得到 401，前端拿到的是"CORS 失败"这种误导性错误）。
 * 3. **204 且无 body**：预检没有内容可返回（`Content-Length: 0`）。
 *
 * 诚实标注：ACAO 白名单是**浏览器侧**的礼貌，不是安全边界——本服务的真实门禁是
 * `Authorization: Bearer <token>`（`auth.ts`）；非浏览器客户端可以直接不带 Origin 调用。
 */
import type { ServerResponse } from "node:http";

/** 预检允许的方法（与 `matchRoute` 里真正存在的方法面一致）。 */
export const CORS_ALLOWED_METHODS = "GET, POST, DELETE, OPTIONS";

/** 预检允许的请求头：`Authorization` 是认证、`Content-Type` 是 JSON body、`Accept` 选 SSE。 */
export const CORS_ALLOWED_HEADERS = "Content-Type, Authorization, Accept";

/** 预检结果缓存秒数（本机 loopback，缓存久一点无妨；改策略时重启进程即失效）。 */
export const CORS_MAX_AGE_SECONDS = 600;

/** 回显白名单里的主机名（`URL.hostname` 对 IPv6 会带方括号，故两者都列）。 */
export const LOOPBACK_HOSTNAMES: readonly string[] = [
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]",
];

/**
 * origin 是否来自本机回环。
 *
 * 只接受 `http:`/`https:` 的**绝对** origin（`null` / `file://` / 非法串一律 false）：
 * 一个解析不出主机名的 origin 没有任何理由被回显。
 */
export function isLoopbackOrigin(origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  return LOOPBACK_HOSTNAMES.includes(parsed.hostname);
}

/**
 * 预检响应头。
 *
 * `Access-Control-Allow-Origin` **条件出现**：非 loopback origin 时整个键都不写
 * （不是写空串——空串会让某些客户端把它当成"匹配所有"的退化值）。
 * `Vary: Origin` 必须带上：同一 URL 的响应体随 Origin 变化，缺了它中间缓存可能把
 * 一个 origin 的放行结果发给另一个（本机场景少见，但这条成本近乎为零）。
 */
export function corsPreflightHeaders(origin: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": CORS_ALLOWED_METHODS,
    "Access-Control-Allow-Headers": CORS_ALLOWED_HEADERS,
    "Access-Control-Max-Age": String(CORS_MAX_AGE_SECONDS),
    Vary: "Origin",
  };
  if (origin !== undefined && isLoopbackOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

/** 取请求的 `Origin` 头（Node 的头值可能是数组；非字符串一律当"没给"）。 */
export function originOf(headers: { origin?: string | string[] | undefined }): string | undefined {
  return typeof headers.origin === "string" ? headers.origin : undefined;
}

/** 应答一次预检：204 + 上面的头，无 body。 */
export function sendCorsPreflight(res: ServerResponse, origin: string | undefined): void {
  res.writeHead(204, { ...corsPreflightHeaders(origin), "Content-Length": "0" });
  res.end();
}
