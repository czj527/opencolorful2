/**
 * @agentplant/gateway-protocol —— **M2 预留 stub（二期启用）**。
 *
 * 本文件只声明跨包共享的**类型词汇**，不含任何实现、不含运行时依赖。
 * 依据 `docs/decisions/t3-repo-ci.md` §1："M2 目录只留 stub + README 说明二期启用，
 * 禁止提前实现"；`docs/decisions/t2-positioning-mvp.md` §2 把网关列为 Out of scope。
 *
 * ⚠️ 落地纪律：二期实到时按 `docs/decisions/t4-backend-architecture.md` §7-1
 * 执行"channel 抽象（inbound-event/turn/去重/allowlist）+ 1–2 渠道插件"，
 * **别提前抽接口**（t4 §7 明确：openclaw 经验表明此层很贵）。
 */

/** 网关渠道标识：MVP 无渠道；M2 先支持 1–2 个。 */
export type ChannelKind = "telegram" | "feishu" | "qq" | "wechat" | "http";

/** 入站事件：渠道归一化后的最小形状（M2 落地时按真实渠道再扩展）。 */
export interface InboundEvent {
  readonly channel: ChannelKind;
  /** 渠道侧消息 id：用于**去重**（t4 §7-1）。 */
  readonly externalMessageId: string;
  /** 渠道侧会话 id。 */
  readonly externalConversationId: string;
  /** 发送者标识：allowlist 判定用。 */
  readonly senderId: string;
  readonly text: string;
  /** unix epoch seconds（全仓时间戳统一口径，t4 §4）。 */
  readonly receivedAt: number;
}

/** 出站消息：一轮 turn 的回复（分段由渠道适配器负责）。 */
export interface OutboundMessage {
  readonly channel: ChannelKind;
  readonly externalConversationId: string;
  readonly text: string;
  /** 回复投递失败时的可读原因；成功为 undefined。 */
  readonly error?: string;
}

/** allowlist 判定结果（未配置 = 拒绝，默认关闭而非默认放开）。 */
export interface AllowlistDecision {
  readonly allowed: boolean;
  readonly reason?: "not_allowlisted" | "channel_disabled";
}

/** 二期未实现标记：调用即抛，防止 stub 被误当作可用实现。 */
export class GatewayNotImplementedError extends Error {
  readonly kind = "m2_not_implemented";
  constructor(readonly feature: string) {
    super(`${feature} 属于 M2（网关），当前为 stub：见 packages/gateway-protocol/README.md`);
    this.name = "GatewayNotImplementedError";
  }
}
