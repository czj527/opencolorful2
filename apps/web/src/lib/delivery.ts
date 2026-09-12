/**
 * 交付状态标签映射（t5 §5 / t7 AT-504 / IA §6.3）——**本设计的正确性核心之一**。
 *
 * 铁律：**前端不做时态推断**。UI 只消费后端 `done.delivery` / `ChatResponse.delivery` 的取值；
 *   - `claimed`  → 「◷ 仅计划，尚未执行」（warning）
 *   - `verified` → 「✓ 已核验交付」+「依据：<工具名> ×N」（success）
 *   - `unknown`  → 「未提供交付状态」（既不是成功也不是失败）
 *   - **字段缺失** → 同样渲染「未提供交付状态」，**绝不**渲染成成功
 */
import type { DeliveryEvidence, TurnDelivery } from "./protocol.js";

/** 三态 + 缺失（缺 `delivery` 字段时由调用方传 `null`）。 */
export type DeliveryInput = TurnDelivery | null | undefined;

export type DeliveryTone = "warning" | "success" | "unknown";

export interface DeliveryView {
  /** 是否渲染标签行（元素不是助手回合时调用方直接不渲染）。 */
  readonly tone: DeliveryTone;
  readonly label: string;
  /** 依据文本（仅 verified 且给了 evidence 时非空）。 */
  readonly evidenceLabel: string | null;
  /** 是否可展开依据（verified + 有 toolCallIds）。 */
  readonly evidenceClickable: boolean;
  /**
   * 是否为"未提供交付状态"分支（`unknown` 或字段缺失）。
   * 调用方据此渲染中性/warning 文字，**且不得**在任务视图里据此标记完成。
   */
  readonly missingOrUnknown: boolean;
}

const CLAIMED: DeliveryView = {
  tone: "warning",
  label: "◷ 仅计划，尚未执行",
  evidenceLabel: null,
  evidenceClickable: false,
  missingOrUnknown: false,
};

const NOT_PROVIDED: DeliveryView = {
  tone: "unknown",
  label: "未提供交付状态",
  evidenceLabel: null,
  evidenceClickable: false,
  missingOrUnknown: true,
};

/** 把 delivery(+evidence) 映射成可直接渲染的标签视图。 */
export function deliveryView(
  delivery: DeliveryInput,
  evidence?: DeliveryEvidence | undefined,
): DeliveryView {
  if (delivery === "claimed") {
    return CLAIMED;
  }
  if (delivery === "verified") {
    const hasEvidence = evidence !== undefined && evidence.count > 0 && evidence.toolName !== "";
    return {
      tone: "success",
      label: hasEvidence ? "✓ 已核验交付" : "✓ 已核验交付",
      evidenceLabel: hasEvidence ? `依据：${evidence.toolName} ×${evidence.count}` : null,
      evidenceClickable: evidence !== undefined && evidence.toolCallIds.length > 0,
      missingOrUnknown: false,
    };
  }
  // `unknown` 与"字段缺失"同一条诚实分支：既不敢说成功，也不说失败。
  return NOT_PROVIDED;
}

/** 任务条/详情用的短文案（同一判定，不同措辞密度）。 */
export function deliveryShortLabel(delivery: DeliveryInput): string {
  switch (delivery) {
    case "claimed":
      return "仅计划";
    case "verified":
      return "已核验交付";
    default:
      return "未提供交付状态";
  }
}
