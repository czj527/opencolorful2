/**
 * builtin/net：出网工具共用件（SSRF 守卫 + 手动重定向 + HTML→text）。
 *
 * SSRF 守卫（t4 §5「SSRF 守卫默认开：禁私网/重定向到私网」）的口径：
 * 1. **字面量**：`localhost`、`127.0.0.0/8`、`::1`、`10/8`、`172.16/12`、`192.168/16`、
 *    `169.254/16`（含云元数据 `169.254.169.254`）、`100.64/10`（CGNAT）、`0.0.0.0`、
 *    `::`、`fc00::/7`、`fe80::/10`、IPv4-mapped IPv6（`::ffff:10.0.0.1`）一律拒绝。
 * 2. **域名**：走真实 DNS 解析，**任一**解析结果落在私网即拒绝（fail-closed；
 *    多变体 DNS 里混一个内网地址是经典绕过手法）。
 * 3. **重定向**：`redirect: "manual"` 逐跳检查，最多 3 跳，每一跳都重新过完整守卫。
 *
 * **诚实标注**：DNS 校验与真正的连接之间存在 TOCTOU 窗口（DNS rebinding）——彻底修掉需要
 * 把解析结果钉到 socket 层（`connect` 钩子），属二期 OS 沙箱一并做（t4 §6）。
 *
 * `resolveHost` 可注入：**仅测试**用来在本地回环 stub 上验证守卫逻辑（生产走真实 DNS）。
 */
import { lookup } from "node:dns/promises";
import { ToolInputError } from "@agentplant/agent-core";
import type {
  FetchLike,
  FetchResponseLike,
  ResolveHostAddresses,
  ToolServices,
} from "../types.js";

/** 允许的最大重定向跳数（t4 §5「重定向跟随最多 3 跳」）。 */
export const MAX_REDIRECTS = 3;

const PRIVATE_V4_PATTERNS: readonly RegExp[] = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];

/**
 * IPv4 的**十进制/八进制/十六进制**写法归一化（`127.1`、`2130706433`、`0x7f.1`）。
 *
 * 为什么必须做：`new URL()` 只对"标准四段点分"做规范化，`http://127.1/` 这类写法的
 * `hostname` 保持原样，而底层解析器（Windows 与 glibc）会把它连到 127.0.0.1——
 * 只看点分字面量的守卫会被这种写法绕过。返回 null 表示"不是数字形式的 IPv4"。
 */
function parseNumericIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length > 4 || parts.length === 0) {
    return null;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (part.length === 0) {
      return null;
    }
    let parsed: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) {
      parsed = Number.parseInt(part.slice(2), 16);
    } else if (/^0[0-7]+$/.test(part)) {
      parsed = Number.parseInt(part.slice(1), 8);
    } else if (/^\d+$/.test(part)) {
      parsed = Number.parseInt(part, 10);
    } else {
      return null;
    }
    if (!Number.isInteger(parsed) || parsed < 0) {
      return null;
    }
    octets.push(parsed);
  }
  return octets;
}

/** 把数字形式的 IPv4 展开成四段（`127.1` → `127.0.0.1`）。导出给模型侧守卫复用同一套展开规则。 */
export function expandNumericIpv4(value: string): string | null {
  const octets = parseNumericIpv4(value);
  if (octets === null) {
    return null;
  }
  if (octets.length === 4) {
    return octets.every((octet) => octet <= 255) ? octets.join(".") : null;
  }
  // 少于四段：最后一段承载剩余位宽（`127.1` = 127.0.0.1）
  const head = octets.slice(0, -1);
  const tail = octets[octets.length - 1];
  if (tail === undefined) {
    return null;
  }
  const remaining = 4 - head.length;
  const maxTail = 256 ** remaining;
  if (tail >= maxTail || head.some((octet) => octet > 255)) {
    return null;
  }
  const expanded: number[] = [...head];
  for (let index = remaining - 1; index >= 0; index -= 1) {
    expanded.push(Math.floor(tail / 256 ** index) % 256);
  }
  return expanded.join(".");
}

/** 判断一个字面量 IP 是否属于私网/保留段。非 IP 形态一律返回 `false`（由 DNS 分支处理）。 */
export function isPrivateAddress(address: string): boolean {
  const value = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/%.*$/, "");
  if (value.length === 0) {
    return false;
  }
  if (value.includes(":")) {
    // IPv6：先剥掉 IPv4-mapped 前缀，再判内层
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
    if (mapped !== null && mapped[1] !== undefined) {
      return isPrivateAddress(mapped[1]);
    }
    if (value === "::" || value === "::1") {
      return true;
    }
    if (/^f[cd][0-9a-f]{2}:/.test(value)) {
      return true; // fc00::/7 唯一本地地址
    }
    if (/^fe[89ab][0-9a-f]?:/.test(value)) {
      return true; // fe80::/10 链路本地（含 `fe80::1` 这种省略写法）
    }
    if (value.startsWith("2002:") || value.startsWith("64:ff9b:")) {
      return true; // 6to4 / NAT64：内层可能是私网，fail-closed
    }
    return false;
  }
  const expanded = expandNumericIpv4(value) ?? value;
  return PRIVATE_V4_PATTERNS.some((pattern) => pattern.test(expanded));
}

/** 主机名字面量黑名单（不解析也知道是本地/内部）。 */
const PRIVATE_HOST_NAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata",
  "metadata.google.internal",
]);

/** 保留域名后缀（RFC 6761 `.localhost` / 云元数据常用的 `.internal`）。 */
function reservedHostName(hostname: string): boolean {
  return (
    PRIVATE_HOST_NAMES.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".local")
  );
}

export interface GuardedUrl {
  readonly url: URL;
  readonly hostname: string;
}

/**
 * 解析 + 校验一个出网 URL。
 *
 * 失败一律 `ToolInputError`（400 口径）：URL 不合法/指向私网属于**调用错误**，
 * 应当在模型侧被纠正，而不是当成服务器故障（500）。
 */
export async function guardOutboundUrl(
  raw: string,
  options: { readonly tool: string; readonly resolveHost?: ResolveHostAddresses },
): Promise<GuardedUrl> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolInputError(`${options.tool}：URL 不合法（${raw}）`, { url: raw });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ToolInputError(`${options.tool}：只允许 http/https，收到 ${url.protocol}`, {
      url: raw,
    });
  }
  // `URL.hostname` 对 IPv6 字面量带方括号形式（`[::1]`）
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname.length === 0) {
    throw new ToolInputError(`${options.tool}：URL 缺少主机名`, { url: raw });
  }
  if (reservedHostName(hostname)) {
    throw new ToolInputError(
      `${options.tool}：SSRF 守卫拒绝本地/内部主机名（${hostname}）`,
      { url: raw, blockedReason: "private-host" },
    );
  }
  if (isPrivateAddress(hostname)) {
    throw new ToolInputError(`${options.tool}：SSRF 守卫拒绝私网地址（${hostname}）`, {
      url: raw,
      blockedReason: "private-address",
    });
  }
  if (!isIpLiteral(hostname)) {
    const resolver = options.resolveHost ?? defaultResolveHost;
    let addresses: readonly string[];
    try {
      addresses = await resolver(hostname);
    } catch (error) {
      throw new ToolInputError(
        `${options.tool}：解析主机失败（${hostname}：${error instanceof Error ? error.message : String(error)}）`,
        { url: raw },
      );
    }
    if (addresses.length === 0) {
      throw new ToolInputError(`${options.tool}：解析主机无结果（${hostname}）`, { url: raw });
    }
    for (const address of addresses) {
      if (isPrivateAddress(address)) {
        // 消息里**不**回显解析到的地址：错误消息会进模型上下文与日志，
        // 内网拓扑属于"不该因为一次误调用而外泄"的信息（地址放在 details 供本地排查）。
        throw new ToolInputError(
          `${options.tool}：SSRF 守卫拒绝"解析到私网"的域名（${hostname}）`,
          { url: raw, blockedReason: "private-resolved", hostname },
        );
      }
    }
  }
  return { url, hostname };
}

function isIpLiteral(hostname: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":");
}

const defaultResolveHost: ResolveHostAddresses = async (hostname) => {
  const results = await lookup(hostname, { all: true });
  return results.map((entry) => entry.address);
};

/**
 * 选 fetch 实现：生产一律 `globalThis.fetch`；只有测试注入了 `fetchImpl` 才换。
 *
 * `globalThis.fetch` 在 Node ≥18 恒存在，因此"没有 fetch"不是运行时分支，而是环境不满足
 * engines（`>=22`）——这时直接抛错比静默降级成假结果诚实。
 */
export function resolveFetch(services: ToolServices): FetchLike {
  if (services.fetchImpl !== undefined) {
    return services.fetchImpl;
  }
  const globalFetch = globalThis.fetch;
  if (typeof globalFetch !== "function") {
    throw new ToolInputError("本运行时没有 globalThis.fetch（需要 Node ≥18）");
  }
  // 结构兼容（`Response` 满足 `FetchResponseLike`）；lib.dom 里 `signal` 不接受 undefined，
  // 故此处显式转一次，避免为一个签名差异引入类型适配层。
  return globalFetch as unknown as FetchLike;
}

export interface FetchTextOptions {
  readonly fetchImpl: FetchLike;
  readonly timeoutMs: number;
  readonly maxRedirects: number;
  readonly resolveHost?: ResolveHostAddresses;
  readonly tool: string;
  readonly signal?: AbortSignal;
  readonly headers?: Record<string, string>;
}

export interface FetchTextResult {
  readonly finalUrl: string;
  readonly status: number;
  readonly contentType: string;
  readonly text: string;
  /** 跟随的重定向跳数（0 = 没有重定向）。 */
  readonly redirects: number;
}

/**
 * 带守卫的文本抓取：逐跳校验 + 超时 + 限制跳数。
 *
 * `redirect: "manual"` 是**不可省**的：自动跟随会把"第一跳合法、第二跳 302 到 169.254.169.254"
 * 的经典绕过变成既成事实（t4 §5 点名"每跳都过 SSRF 检查"）。
 */
export async function fetchText(
  rawUrl: string,
  options: FetchTextOptions,
): Promise<FetchTextResult> {
  let current = rawUrl;
  let redirects = 0;
  for (;;) {
    const guarded = await guardOutboundUrl(current, {
      tool: options.tool,
      ...(options.resolveHost === undefined ? {} : { resolveHost: options.resolveHost }),
    });
    const response = await requestOnce(guarded.url.toString(), options);
    if (isRedirect(response.status)) {
      const location = response.headers.get("location");
      if (location === null || location.trim().length === 0) {
        throw new ToolInputError(`${options.tool}：重定向缺少 Location 头`, { url: current });
      }
      if (redirects >= options.maxRedirects) {
        throw new ToolInputError(
          `${options.tool}：重定向超过 ${options.maxRedirects} 跳（起点 ${rawUrl}）`,
          { url: rawUrl },
        );
      }
      redirects += 1;
      current = new URL(location, guarded.url).toString();
      continue;
    }
    const text = await response.text();
    return {
      finalUrl: response.url.length === 0 ? guarded.url.toString() : response.url,
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      text,
      redirects,
    };
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function requestOnce(url: string, options: FetchTextOptions): Promise<FetchResponseLike> {
  const signals: AbortSignal[] = [AbortSignal.timeout(options.timeoutMs)];
  if (options.signal !== undefined) {
    signals.push(options.signal);
  }
  try {
    return await options.fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "text/html,application/json;q=0.9,*/*;q=0.8", ...options.headers },
      signal: AbortSignal.any(signals),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ToolInputError(`${options.tool}：请求失败（${url}：${detail}）`, { url });
  }
}

/**
 * HTML → 纯文本粗提取（t4 §5「HTML→text 粗提取」）。
 *
 * 只做"够用就去 script/style、压空白、解常见实体"三件事，**不写 HTML 解析器**：
 * 忠实渲染 HTML 是浏览器的事，这里的目标只是让模型能读正文。
 */
export function htmlToText(html: string): string {
  let text = html;
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  for (const tag of ["script", "style", "noscript", "template", "svg", "head"]) {
    text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
  }
  // 块级标签换行，行内标签空格（否则 `<p>a</p><p>b</p>` 会粘成 "ab"）
  text = text.replace(
    /<\/?(p|div|br|li|tr|h[1-6]|section|article|header|footer|blockquote|pre|table|ul|ol|dl|dt|dd)\b[^>]*>/gi,
    "\n",
  );
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeEntities(text);
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/** 常见实体解码（够用即止；数字实体一并处理）。 */
export function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    hellip: "…",
    mdash: "—",
    ndash: "–",
    ldquo: "“",
    rdquo: "”",
  };
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return named[body] ?? whole;
  });
}
