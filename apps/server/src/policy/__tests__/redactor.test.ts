/**
 * redactor.test.ts：日志脱敏（t4 §6「密钥永不落日志」）——精确值三形态 + 正则刷。
 *
 * 断言的是**真实字符串替换结果**，不是"函数被调用过"：脱敏的失败模式是
 * "看起来做了但没盖住"，只有逐字比对能抓住它。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REDACTED,
  REDACTED_USER,
  createRedactor,
  redact as defaultRedact,
  registerDotEnvSecrets,
  secretsFromEnv,
} from "../redactor.js";

describe("redactor：精确值三形态", () => {
  const secret = "sk-live-9f3a2b7c1d4e5f60718293a4b5c6d7e8";

  it("原文被掩码", () => {
    const redactor = createRedactor([secret]);
    expect(redactor.redact(`key=${secret} end`)).toBe(`key=${REDACTED} end`);
  });

  it("percent-encoded 形态被掩码（URL query 里的密钥）", () => {
    const raw = "p@ss word/+secret-value-123456";
    const encoded = encodeURIComponent(raw);
    const redactor = createRedactor([raw]);
    expect(encoded).not.toBe(raw);
    const output = redactor.redact(`https://x.test/cb?token=${encoded}&other=1`);
    expect(output).not.toContain(encoded);
    expect(output).toContain("other=1");
  });

  it("JSON-escaped 形态被掩码（JSON 串里的密钥）", () => {
    const raw = 'quote"inside\\secret-value-abcdef';
    const redactor = createRedactor([raw]);
    const asJson = JSON.stringify({ token: raw });
    expect(asJson).toContain('\\"');
    const output = redactor.redact(asJson);
    expect(output).not.toContain("secret-value-abcdef");
    expect(output).toContain(REDACTED);
  });

  it("同一段文本里的多处出现全部被掩码", () => {
    const redactor = createRedactor([secret]);
    const output = redactor.redact(`${secret} 和 ${secret}`);
    expect(output).toBe(`${REDACTED} 和 ${REDACTED}`);
  });

  it("过短的值不注册（避免把通用短串抹成噪声）", () => {
    const redactor = createRedactor(["abc"]);
    expect(redactor.secretPatternCount()).toBe(0);
    expect(redactor.redact("abc def")).toBe("abc def");
  });

  it("空串/空白值不注册", () => {
    const redactor = createRedactor(["", "   "]);
    expect(redactor.secretPatternCount()).toBe(0);
  });

  it("registerSecrets 可在构造后追加", () => {
    const redactor = createRedactor();
    redactor.registerSecrets(["another-live-secret-0001"]);
    expect(redactor.redact("x another-live-secret-0001 y")).toBe(`x ${REDACTED} y`);
  });

  it("长值优先替换：短值不会把长值切成残段", () => {
    const redactor = createRedactor(["abcdefgh", "abcdefgh-ijklmnop-1234"]);
    const output = redactor.redact("token=abcdefgh-ijklmnop-1234");
    expect(output).toBe(`token=${REDACTED}`);
  });
});

describe("redactor：正则刷", () => {
  const redactor = createRedactor();

  it("Bearer token 被掩码", () => {
    const output = redactor.redact("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(output).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(output).toContain("Bearer");
  });

  it("Cookie 头被掩码", () => {
    const output = redactor.redact("Cookie: session=abcdefghijklmnop; theme=dark");
    expect(output).not.toContain("abcdefghijklmnop");
  });

  it("GitHub token 前缀被掩码", () => {
    const output = redactor.redact("push with ghp_0123456789abcdefghijklmnopqrstuvwx failed");
    expect(output).not.toContain("ghp_0123456789abcdefghijklmnopqrstuvwx");
  });

  it("键值对形态的 api_key/password 被掩码", () => {
    const output = redactor.redact('api_key="abcdef123456" and password: hunter2hunter2');
    expect(output).not.toContain("abcdef123456");
    expect(output).not.toContain("hunter2hunter2");
  });

  it("URL query 里的 token 被掩码", () => {
    const output = redactor.redact("GET /cb?token=abcdef123456&x=1");
    expect(output).not.toContain("abcdef123456");
    expect(output).toContain("x=1");
  });

  it("长随机串（未知形状）被兜底掩码", () => {
    const output = redactor.redact("value 7f3a9b2c4d5e6f708192a3b4c5d6e7f8 done");
    expect(output).not.toContain("7f3a9b2c4d5e6f708192a3b4c5d6e7f8");
  });

  it("C:\\Users\\<name> 掩码成 [user]", () => {
    const output = redactor.redact("日志路径 C:\\Users\\alice\\project\\x.log");
    expect(output).toContain(REDACTED_USER);
    expect(output).not.toContain("alice");
  });

  it("正常中文/短文本不被误伤", () => {
    expect(redactor.redact("工具运行时已就绪，exitCode=0")).toBe("工具运行时已就绪，exitCode=0");
  });

  it("连字符长串（UUID/密钥形态）被掩码，不残留原值片段", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const output = redactor.redact(`id=${uuid}`);
    expect(output).not.toContain(uuid);
    expect(output).not.toContain("550e8400");
  });
});

describe("redactor：来源采集", () => {
  it("secretsFromEnv 只收像密钥的键且值够长", () => {
    const values = secretsFromEnv({
      OPENAI_API_KEY: "sk-abcdefghijklmnop",
      SOME_TOKEN: "short",
      PATH: "/usr/bin:/bin",
      USER: "alice",
    } as NodeJS.ProcessEnv);
    expect(values).toContain("sk-abcdefghijklmnop");
    expect(values).not.toContain("short");
    expect(values).not.toContain("alice");
  });

  it("registerDotEnvSecrets 从真实文件读密钥（只读，不造环境变量）", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentplant-redactor-test-"));
    try {
      const envPath = join(dir, ".env");
      writeFileSync(envPath, 'SEARCH_API_KEY="dotenv-secret-123456"\nPLAIN=hello\n', "utf8");
      const redactor = createRedactor();
      const count = registerDotEnvSecrets(redactor, envPath);
      expect(count).toBe(1);
      expect(redactor.redact("using dotenv-secret-123456 now")).toBe(`using ${REDACTED} now`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registerDotEnvSecrets 对不存在的路径返回 0（不抛错）", () => {
    const redactor = createRedactor();
    expect(registerDotEnvSecrets(redactor, join(tmpdir(), "no-such-file-xyz", ".env"))).toBe(0);
  });

  it("模块级 redact 走默认脱敏器（进程 env 里的密钥）", () => {
    expect(defaultRedact("nothing sensitive here")).toBe("nothing sensitive here");
  });
});
