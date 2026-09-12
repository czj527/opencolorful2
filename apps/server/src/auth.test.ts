/**
 * auth 测试：纯函数级（不起进程），覆盖 t4 §2 的单机 token 语义。
 *
 * 依据：t4 §2「绑 loopback 可留空自生成，非 loopback 强制 Authorization: Bearer」。
 */
import { describe, expect, it } from "vitest";
import {
  AUTH_EXEMPT_PATHS,
  checkAuth,
  generateEphemeralToken,
  isAuthExemptPath,
  isLoopbackHost,
  readBearerToken,
  resolveAuthConfig,
} from "./auth.js";

const headers = (value?: string): { headers: Record<string, string> } =>
  value === undefined ? { headers: {} } : { headers: { authorization: value } };

describe("resolveAuthConfig：token 来源与拒绝启动分支", () => {
  it("loopback + 未设置 APP_TOKEN → 生成临时 token（ephemeral=true）", () => {
    const resolved = resolveAuthConfig("127.0.0.1", undefined);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.config.ephemeral).toBe(true);
      expect(resolved.config.token).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("loopback + APP_TOKEN 为空串 → 仍视为未设置（避免空 token 等于无认证）", () => {
    const resolved = resolveAuthConfig("127.0.0.1", "   ");
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.config.ephemeral).toBe(true);
    }
  });

  it("显式 APP_TOKEN → 直接采用，ephemeral=false", () => {
    const resolved = resolveAuthConfig("127.0.0.1", "user-token");
    expect(resolved).toEqual({ ok: true, config: { token: "user-token", ephemeral: false } });
  });

  it("非 loopback + 未设置 APP_TOKEN → 拒绝启动（return ok=false，调用方 exit 1）", () => {
    const resolved = resolveAuthConfig("0.0.0.0", undefined);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.reason).toContain("APP_TOKEN");
    }
  });

  it("非 loopback + 局域网地址同样拒绝；带 token 则允许", () => {
    expect(resolveAuthConfig("192.168.1.20", undefined).ok).toBe(false);
    const withToken = resolveAuthConfig("0.0.0.0", "user-token");
    expect(withToken.ok).toBe(true);
    if (withToken.ok) {
      expect(withToken.config.ephemeral).toBe(false);
    }
  });

  it("localhost 视为 loopback；'::1' 视为 loopback", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
    expect(isLoopbackHost("  10.0.0.5 ")).toBe(false);
    expect(resolveAuthConfig("localhost", undefined).ok).toBe(true);
  });

  it("generateEphemeralToken 每次不同且为 64 位 hex", () => {
    const first = generateEphemeralToken();
    const second = generateEphemeralToken();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
  });
});

describe("checkAuth / readBearerToken", () => {
  it("无 Authorization 头 → missing", () => {
    expect(checkAuth(headers(), "test-token")).toBe("missing");
    expect(readBearerToken(headers())).toBeUndefined();
  });

  it("token 正确 → ok（scheme 大小写不敏感）", () => {
    expect(checkAuth(headers("Bearer test-token"), "test-token")).toBe("ok");
    expect(checkAuth(headers("bearer test-token"), "test-token")).toBe("ok");
    expect(readBearerToken(headers("Bearer test-token"))).toBe("test-token");
  });

  it("token 错误 → invalid（同长度与不同长度都算 invalid）", () => {
    expect(checkAuth(headers("Bearer wrong"), "test-token")).toBe("invalid");
    expect(checkAuth(headers("Bearer test-tokenn"), "test-token")).toBe("invalid");
  });

  it("非 Bearer scheme / 空 token / 只有 scheme → missing", () => {
    expect(checkAuth(headers("Basic dXNlcjpwYXNz"), "test-token")).toBe("missing");
    expect(checkAuth(headers("Bearer   "), "test-token")).toBe("missing");
    expect(readBearerToken(headers("Bearer"))).toBeUndefined();
    expect(readBearerToken(headers(""))).toBeUndefined();
  });
});

describe("免认证路径", () => {
  it("只有 /api/health 免认证", () => {
    expect(AUTH_EXEMPT_PATHS).toEqual(["/api/health"]);
    expect(isAuthExemptPath("/api/health")).toBe(true);
    expect(isAuthExemptPath("/api/chat")).toBe(false);
    expect(isAuthExemptPath("/api/sessions")).toBe(false);
  });
});
