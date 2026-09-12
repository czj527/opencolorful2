/**
 * completion：回合完成判定（t4 §4「进度文本≠交付」+ t5 §4.2 / §6.3）。
 *
 * 本文件只做**纯判定**：输入是"本回合发生的事实"（有无成功工具调用、有几条可复核证据），
 * 输出是 protocol 的 `TurnDelivery` 取值。不读时钟、不读文件、不调模型。
 *
 * 为什么判定放在 agent-core 而不是前端（t5 §6.3 明文）：UI **不做语义推断**
 * （不解析中文时态），只消费后端显式给出的 `delivery`；判定逻辑本身是内核职责。
 *
 * 骨架期口径（重要）：本包尚无 LLM 主循环，"未来时文本检测"是 t15 主循环的事
 * ——那里用 `PLAN_PATTERN_HINTS` 做**文本**提示，再与本文件的"工具调用事实"联合判定。
 * 本文件**不做任何文本匹配**，只导出提示词清单供主循环与前端参考。
 */
import type { TaskStatus, ToolStatus, TurnDelivery } from "@agentplant/protocol";

/**
 * 本函数能给出的判定：`claimed` / `verified`。
 *
 * `unknown`（"无法判定"，t5 §4.2 三态之一）**不由本函数产出**：它是"调用方拿不到事实"
 * 时的显式取值（例如主循环崩了、事件流截断），必须由调用方主动传，不许把"没算出来"
 * 伪装成"算出来了"。从 protocol 的 `TurnDelivery` 里 `Extract` 出来，避免两处词表漂移。
 */
export type DecidedTurnDelivery = Extract<TurnDelivery, "claimed" | "verified">;

/** 判定取值范围（与 `DecidedTurnDelivery` 同源，供调用方遍历/前端对照）。 */
export const DECIDED_TURN_DELIVERIES = [
  "claimed",
  "verified",
] as const satisfies readonly DecidedTurnDelivery[];

/** 任务终态（t4 §4 治理内核对"终态不可降级"的同一份词表；t5 §6.2 七态）。 */
export const TERMINAL_TASK_STATUSES = [
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly TaskStatus[];

/** 工具调用终态（t5 §4.3 六态里的四个）。 */
export const TERMINAL_TOOL_STATUSES = [
  "success",
  "error",
  "denied",
  "cancelled",
] as const satisfies readonly ToolStatus[];

/** 任务非终态（`blocked` / `needs_input` 都是"等"而不是"完"）。 */
export const NON_TERMINAL_TASK_STATUSES = [
  "pending",
  "running",
  "blocked",
  "needs_input",
] as const satisfies readonly TaskStatus[];

/** 工具非终态。 */
export const NON_TERMINAL_TOOL_STATUSES = ["pending", "running"] as const satisfies readonly ToolStatus[];

const TERMINAL_STATUS_SET: ReadonlySet<string> = new Set<string>([
  ...TERMINAL_TASK_STATUSES,
  ...TERMINAL_TOOL_STATUSES,
]);

/**
 * 是否终态（task ∪ tool 两份词表的并集）。
 *
 * - `true`：`completed` / `failed` / `cancelled`（task）与 `success` / `error` / `denied` /
 *   `cancelled`（tool）——`cancelled` 两份词表都有，语义一致。
 * - `false`：`running` / `pending` / `blocked` / `needs_input`，以及**任何未知取值**。
 *
 * 未知值返回 `false`（而不是抛错/猜终态）：本函数只回答"是不是终态"，未知值**不是已知终态**；
 * 对未知值的 fail-closed 拦截发生在 state 的状态门禁（`unknown_status` → 拒绝写入），
 * 不在这个纯谓词里（两处职责不同，合在一起会让"未知"既被拒又被当终态）。
 */
export function isTerminalStatus(status: TaskStatus | ToolStatus | string): boolean {
  return TERMINAL_STATUS_SET.has(status);
}

/** `decideTurnDelivery` 的输入事实：只描述"本回合真的发生了什么"，不含正文。 */
export interface TurnDeliveryFacts {
  /** 本回合是否存在**成功**的工具调用（失败/被拒的调用不算交付依据）。 */
  readonly hasSuccessfulToolCall: boolean;
  /** 可复核的证据条数（如成功的 `tool_result` 数量）；`> 0` 才可能 `verified`。 */
  readonly evidenceCount: number;
}

/**
 * 回合交付判定（t5 §6.3 判定表）：
 *
 * | hasSuccessfulToolCall | evidenceCount | 结果 |
 * |---|---|---|
 * | `true` | `> 0` | `verified`（已核验交付，前端渲染「✓ 已核验交付」+ `依据：<工具名> ×N`） |
 * | 其余任意组合 | 任意 | `claimed`（仅声明/仅计划，前端渲染「◷ 仅计划，尚未执行」） |
 *
 * 关键点：**单一条件不成证据**。有工具调用但拿不出证据（`evidenceCount === 0`）→ 仍是
 * `claimed`；没有工具调用却有"证据计数"（调用方传错/被污染）→ 也仍是 `claimed`。
 * 宁可少判 `verified`，也不许把"计划"渲染成"已交付"（t1-P0-3 的方向性：宁可保守）。
 *
 * `evidenceCount` 非有限数（`NaN`/`Infinity`）或非正数一律按"无证据"处理，不抛错
 * ——判定函数必须对任意输入可终止、可预期，脏数据不该在渲染路径上抛异常。
 */
export function decideTurnDelivery(facts: TurnDeliveryFacts): DecidedTurnDelivery {
  if (facts.hasSuccessfulToolCall && Number.isFinite(facts.evidenceCount) && facts.evidenceCount > 0) {
    return "verified";
  }
  return "claimed";
}

/**
 * 未来时表述提示词清单（t5 §6.3「待验证声明」的触发面）。
 *
 * **本包不消费它**：agent-core 骨架期没有 LLM，文本匹配属 t15 主循环；导出清单是为了
 * "主循环判定"与"前端提示"引用同一份词表，避免两边各写一份而漂移。
 *
 * 用法（t15）：正文命中清单**且**本回合无成功工具调用 → `claimed`；命中清单但已有成功
 * 工具调用 → 由 `decideTurnDelivery` 的事实口径决定（文本不得覆盖事实）。
 */
export const PLAN_PATTERN_HINTS: readonly string[] = [
  "接下来",
  "将要",
  "即将",
  "正在准备",
  "计划",
  "打算",
  "待办",
  "稍后",
  "下一步",
  "随后",
  "我会",
  "我准备",
];
