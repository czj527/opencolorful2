/**
 * audit-buffer：审计事件的**进程内存环形缓冲**（cap 200，超了丢最旧）。
 *
 * 为什么是内存：骨架期本服务还没接 `packages/state`（t4 §4 SQLite 唯一存储）——
 * 审计口径（kind 枚举 / payload_meta 上限 / metadata-only）先在这里成立并可测，
 * 一旦接库，**整体替换为 `state.appendAudit`**（条目形状已与 state 的 `AppendAuditInput`
 * 对齐，替换时不必改调用点的字段）。绝不用 JSON 落盘之类的旁路（AGENTS.md 硬约束 1）。
 *
 * 关键纪律：
 * - **只记元数据**：`payloadMeta` 一律由 `@agentplant/agent-core` 的 `buildAuditMeta` 产出
 *   （只含键名/计数/长度）；本模块再兜一道上限检查，让"内存实现"与"落库实现"行为一致
 *   （state DAO 超限抛错、不截断）。
 * - **时间戳 unix 秒**：复用 state 的 `nowSeconds()`，不在本包另立时间口径（t4 §4）。
 * - **进程重启即丢**：这是过渡实现的已知代价，UI 事件流的持久化归接库任务。
 */
import { PAYLOAD_META_MAX_CHARS } from "@agentplant/agent-core";
import { nowSeconds, type AppendAuditInput } from "@agentplant/state";

/** 环形缓冲容量：写满后每写一条丢最旧一条（保留最近 200 条）。 */
export const AUDIT_BUFFER_CAP = 200;

/**
 * 缓冲内的一条审计事件。
 *
 * 形状 = state 的 `AppendAuditInput`，唯一差别是 `ts` 在这里**必填**（入缓冲时就定死，
 * 便于按时间断言）；因此后续换成 `dao.appendAudit(event)` 时形状天然兼容。
 */
export type BufferedAuditEvent = Omit<AppendAuditInput, "ts"> & { readonly ts: number };

/** 写入入参：与条目同形状，`ts` 可省（缺省取 `nowSeconds()`）。 */
export type BufferedAuditInput = Omit<AppendAuditInput, "ts"> & { readonly ts?: number };

const buffer: BufferedAuditEvent[] = [];

/**
 * 写入一条审计事件（自动补 `ts`）。
 *
 * `payloadMeta` 超过上限**抛错**（与 state 的 DAO / DDL CHECK 同口径）：调用方必须用
 * `buildAuditMeta` 构造它；在这里静默截断等于悄悄丢审计。
 */
export function appendAudit(event: BufferedAuditInput): void {
  const payloadMeta = event.payloadMeta;
  if (payloadMeta !== undefined && payloadMeta.length > PAYLOAD_META_MAX_CHARS) {
    throw new Error(
      `payloadMeta 超过 ${PAYLOAD_META_MAX_CHARS} 字符（${payloadMeta.length}）：` +
        `审计不截断，请用 buildAuditMeta 只传元数据（t4 §4）`,
    );
  }
  if (buffer.length >= AUDIT_BUFFER_CAP) {
    buffer.shift();
  }
  const { ts, ...rest } = event;
  buffer.push({ ...rest, ts: ts ?? nowSeconds() });
}

/** 当前缓冲内容（按写入顺序，最旧在前）——返回副本，外部改不动内部状态。 */
export function listAuditEvents(): readonly BufferedAuditEvent[] {
  return [...buffer];
}

/** 当前条数（`<= AUDIT_BUFFER_CAP`）。 */
export function auditEventCount(): number {
  return buffer.length;
}

/** 仅测试用：清空缓冲，避免跨用例串味。 */
export function resetAuditForTest(): void {
  buffer.length = 0;
}
