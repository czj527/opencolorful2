/**
 * policy/redactor：日志脱敏（t4 §6「密钥永不落日志」）。
 *
 * 口径（t4 §6 逐条）：
 * 1. **精确值注册表**：`registerSecrets(values)` 把已知密钥字面量（来自进程 env / `.env`）
 *    连同其 **percent-encoded** 与 **JSON-escaped** 形态一起注册。三形态都要，因为
 *    密钥可能出现在 URL query、JSON 串里——只掩码原文等于给这两条路径留后门。
 * 2. **正则刷**：token / cookie / 长随机串 / `C:\Users\<name>` → `[user]`。
 * 3. **只掩码、不删除**：替换成 `[redacted]` 而不是空串——"这里原本有东西"本身是信息，
 *    抹掉会让日志看起来像从没出现过密钥。
 *
 * **诚实标注**：脱敏是**尽力而为**的兜底，不是安全边界。它只能识别"长得像密钥的东西"；
 * 真正不可绕过的保证来自源头纪律——密钥不进日志、不进审计（t4 §4 metadata-only）。
 *
 * 用法：日志路径（`routes.ts` 的 500 兜底、工具错误消息）先 `redact(text)` 再写。
 * **工具正常输出不做脱敏**：模型要求读某个文件时把内容掩码掉，等于撒谎。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 掩码占位符（前端/日志检索用同一个常量，别在别处硬编码字面量）。 */
export const REDACTED = "[redacted]";
/** Windows 用户名掩码占位符。 */
export const REDACTED_USER = "[user]";

export interface Redactor {
  /** 注册密钥字面量（连同 percent-encoded / JSON-escaped 形态）。 */
  registerSecrets(values: readonly string[]): void;
  /** 脱敏一段文本。 */
  redact(text: string): string;
  /** 已注册的精确值掩码片段数（测试与健康检查用，不暴露片段本身）。 */
  secretPatternCount(): number;
}

/** 低于该长度的值不注册 percent-encoded 变体：3 字符的编码结果是 `%20` 之类通用串，会误伤。 */
const MIN_ENCODED_VARIANT_LENGTH = 8;

/**
 * 正则刷（**顺序敏感**：先具体令牌、后通用长随机串）。
 *
 * 每条都带一个"不能太短"的下限（`{20,}` 这类），避免把正常英文单词当密钥抹掉。
 */
const PATTERN_RULES: readonly { readonly pattern: RegExp; readonly replacement: string }[] = [
  // `Authorization: Bearer <token>`
  { pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, replacement: `$1${REDACTED}` },
  // `Authorization: Basic <base64>`
  { pattern: /\b(Basic\s+)[A-Za-z0-9+/=]{12,}/gi, replacement: `$1${REDACTED}` },
  // Cookie / Set-Cookie 值
  {
    pattern: /\b((?:set-)?cookie\s*:\s*)[^\r\n]{4,}/gi,
    replacement: `$1${REDACTED}`,
  },
  // 常见密钥前缀 + 长串（OpenAI / GitHub / Slack / AWS / Stripe）
  { pattern: /\b(sk|pk|rk|ghp|gho|ghu|ghs|github_pat|xox[baprs]|AKIA|ASIA)[-_A-Za-z0-9]{12,}\b/g, replacement: REDACTED },
  // `api_key=...` / `token: ...` / `password="..."` 之类键值对
  // （`Authorization` 不在此列：它的值通常还要进一步解析出 `Bearer <token>`，
  //  交给上面的 Bearer/Basic 规则处理，否则整行会被掩成 `Bearer [redacted]` 丢语义）
  {
    pattern:
      /\b(api[-_]?key|apikey|access[-_]?token|auth[-_]?token|refresh[-_]?token|client[-_]?secret|secret|password|passwd|pwd)(\s*[:=]\s*)["']?([^\s"'&,;]{4,})["']?/gi,
    replacement: `$1$2${REDACTED}`,
  },
  // URL query 里的敏感参数（`?token=...`）
  {
    pattern: /([?&](?:token|key|api_key|apikey|secret|password|access_token)=)[^&\s#]{4,}/gi,
    replacement: `$1${REDACTED}`,
  },
  // 长随机串（32+ 位连续十六进制/base64 风格）：兜底捕获"未知形状"的密钥
  { pattern: /\b[A-Za-z0-9_-]{32,}\b/g, replacement: REDACTED },
  // Windows 用户目录 → 掩码用户名
  { pattern: /([A-Za-z]:\\Users\\)[^\\/\s"']+/g, replacement: `$1${REDACTED_USER}` },
  { pattern: /([A-Za-z]:\/Users\/)[^\\/\s"']+/g, replacement: `$1${REDACTED_USER}` },
];

/** JSON 字符串转义形态（只处理 `"` 与 `\`，与 `JSON.stringify` 的关键差异一致）。 */
function jsonEscaped(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * 构造脱敏器。
 *
 * 精确值用 `split/join` 而不是正则替换：密钥里可能有正则元字符，且我们要"任意位置字面量替换"
 * 的直觉语义。长值优先替换（短值可能是长值的子串，先替换短的会把长的切碎、留下残段）。
 */
export function createRedactor(initialSecrets: readonly string[] = []): Redactor {
  const exact = new Set<string>();

  function register(value: string): void {
    const trimmed = value.trim();
    if (trimmed.length < 4) {
      return;
    }
    exact.add(trimmed);
    if (trimmed.length >= MIN_ENCODED_VARIANT_LENGTH) {
      const encoded = encodeURIComponent(trimmed);
      if (encoded !== trimmed) {
        exact.add(encoded);
      }
    }
    const escaped = jsonEscaped(trimmed);
    if (escaped !== trimmed) {
      exact.add(escaped);
    }
  }

  for (const value of initialSecrets) {
    register(value);
  }

  function redact(text: string): string {
    let output = text;
    // 长值先替换：保证 `sk-abcdef...` 被整体掩码，而不是被更短的注册值切成两半。
    const values = [...exact].sort((left, right) => right.length - left.length);
    for (const value of values) {
      if (output.includes(value)) {
        output = output.split(value).join(REDACTED);
      }
    }
    for (const rule of PATTERN_RULES) {
      output = output.replace(rule.pattern, rule.replacement);
    }
    return output;
  }

  return {
    registerSecrets(values) {
      for (const value of values) {
        register(value);
      }
    },
    redact,
    secretPatternCount: () => exact.size,
  };
}

/**
 * 从进程 env 采集候选密钥（值够长且键名像密钥才收）。
 *
 * 与 t4 §6 的 secrets 优先级一致：进程 env 是最外层，`.env` 由 `registerDotEnvSecrets` 补。
 */
export function secretsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value.length < 8) {
      continue;
    }
    if (/(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE)/i.test(key)) {
      out.push(value);
    }
  }
  return out;
}

/**
 * 读 `.env` 里的值作为候选密钥（**只读、只用于掩码**，不写任何环境变量）。
 *
 * 路径不存在直接返回空数组（骨架期允许没有 `.env`）；文件内容只做 `KEY=VALUE` 粗解析，
 * 解析不出来就不收——脱敏器不该因为一个格式怪异的 `.env` 抛错挡住启动。
 */
export function registerDotEnvSecrets(redactor: Redactor, envPath: string): number {
  if (!existsSync(envPath)) {
    return 0;
  }
  let raw: string;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch {
    return 0;
  }
  const values: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) {
      continue;
    }
    const key = match[1] ?? "";
    const value = (match[2] ?? "").trim().replace(/^["']|["']$/g, "");
    if (value.length >= 8 && /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)) {
      values.push(value);
    }
  }
  redactor.registerSecrets(values);
  return values.length;
}

/** 进程级默认脱敏器（`routes.ts` 的 500 兜底与工具错误消息用）。 */
export const defaultRedactor: Redactor = createDefaultRedactor();

/** 构造默认脱敏器：进程 env + 仓内 `.env`（若存在）里的密钥候选一并注册。 */
function createDefaultRedactor(): Redactor {
  const redactor = createRedactor(secretsFromEnv());
  for (const candidate of [".env", join(".agentplant", ".env")]) {
    registerDotEnvSecrets(redactor, join(process.cwd(), candidate));
  }
  return redactor;
}

/** 模块级便捷函数（固定用 `defaultRedactor`）。 */
export function redact(text: string): string {
  return defaultRedactor.redact(text);
}
