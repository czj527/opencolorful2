/**
 * audit：审计元数据构造（t4 §4 不变量「审计只记元数据」）。
 *
 * 三件必须成立的事：
 * 1. **正文永不进账本**：`payload_meta` 只允许出现键名、计数、长度、布尔标志；
 *    工具参数的值、工具输出、模型正文一律不进。
 * 2. **超限抛错，不截断**：上限 2048 字符（与 `packages/state` 的
 *    `PAYLOAD_META_MAX_CHARS` 及 DDL 的 `CHECK (length(payload_meta) <= 2048)` 同口径）。
 *    截断 = 静默丢审计，比报错危险得多，因此这里直接 `throw`。
 * 3. **不依赖运行环境**：纯函数（无 I/O、无时钟），因此可在纯逻辑单测里穷举边界。
 *
 * 本文件不写库：落库是 `packages/state` 的 `appendAudit`（server 侧调用）。
 */

/**
 * 审计事件种类（t4 §4 kind 枚举，**已冻结**）。
 *
 * 冻结的含义：新增 kind 意味着账本语义变更，需在 PR 里单独说明；消费方（UI 事件流、
 * 审计 tail 游标）可以按"取值必属本清单"做穷举/校验。
 */
export const AUDIT_KINDS = [
  "session.start",
  "turn.end",
  "tool.call",
  "tool.result",
  "memory.write",
  "error",
  "state.transition",
] as const satisfies readonly string[];

export type AuditKind = (typeof AUDIT_KINDS)[number];

/**
 * `payload_meta` 字符上限（与 state 的 DDL CHECK / `PAYLOAD_META_MAX_CHARS` 同值）。
 *
 * agent-core 保持**只依赖 protocol**（不 import state）：两边靠常量相等 + 跨包断言对齐
 * （见 `apps/server/src/governance.test.ts`），而不是靠共享模块。
 */
export const PAYLOAD_META_MAX_CHARS = 2048;

/** `buildAuditMeta` 的输入：全部是"关于正文的形状"，没有正文本身。 */
export interface AuditMetaInput {
  /** 工具名；本回合无工具调用时传 `"none"`（见 routes 的 turn.end 审计）。 */
  readonly toolName: string;
  /** 参数**键名**清单（不是参数值）。 */
  readonly argKeys: readonly string[];
  /** 结果字节数（长度，不是内容）。 */
  readonly resultBytes: number;
  /** 结果是否被截断（长度口径的布尔，不回填原文）。 */
  readonly truncated: boolean;
}

/**
 * 构造 `payload_meta` JSON（metadata-only）。
 *
 * 形状固定为 `{toolName, argKeys, argCount, resultBytes, truncated}`，键顺序固定 →
 * 同一输入产出同一字符串（可断言、可去重）。`argCount` 单独冗余存一份，是为了让
 * "键名清单被截断"这类怀疑能被直接核对（`argCount !== argKeys.length` 即异常）。
 *
 * 长度口径用 JS `String.length`（UTF-16 码元）而 DDL 用 SQLite `length()`（码点）：
 * 前者 ≥ 后者，因此本函数放行的字符串**绝不会**被 SQLite 的 CHECK 拒掉（宁严不宽）。
 *
 * `resultBytes` 必须是非负整数：脏值（`NaN` / 负数 / 小数）直接抛错，不做静默取整
 * ——审计里的"字节数"被悄悄改写，等于账本失真。
 */
export function buildAuditMeta(input: AuditMetaInput): string {
  if (!Number.isInteger(input.resultBytes) || input.resultBytes < 0) {
    throw new Error(
      `resultBytes 必须是非负整数（收到 ${String(input.resultBytes)}）：审计只记长度，不许静默改写`,
    );
  }
  const payload = JSON.stringify({
    toolName: input.toolName,
    argKeys: [...input.argKeys],
    argCount: input.argKeys.length,
    resultBytes: input.resultBytes,
    truncated: input.truncated,
  });
  if (payload.length > PAYLOAD_META_MAX_CHARS) {
    throw new Error(
      `payloadMeta 超过 ${PAYLOAD_META_MAX_CHARS} 字符（${payload.length}）：` +
        `审计正文不截断，请只传元数据（t4 §4）`,
    );
  }
  return payload;
}
