/**
 * 工具卡片的危险分级 + **边界触发就地确认**状态机（IA §4.2 / §4.4，裁决 A7/A8/A9）。
 *
 * 三条不可翻案的定案：
 *   - A7 **边界触发**：读类/记忆类（safe）直接执行；域内写（caution）直接执行 + 「会写入磁盘」徽标；
 *     **越界写与全部命令执行**走就地非模态确认；
 *   - A8 **一次性授权**：只有 `允许一次`，**没有"会话始终允许"**（安全策略不许藏进会话状态）；
 *   - A9 **不阻塞输入**：确认期间用户可继续打字，但**该回合不判完成**。
 *
 * 沙箱拦截（非用户确认路径）**必须**呈现为 `denied` + 拦截原因原文，
 * **绝不**显示成"执行成功但无输出"（t1 P0-4 + IA §4.4）。
 */
import type { ToolStatus } from "./protocol.js";

export type DangerLevel = "safe" | "caution" | "danger";

/** 工具的危险级（IA §4.2 表；未列出的工具保守降级为 `caution`）。 */
export function dangerLevelOf(toolName: string, outsideWorkspace = false): DangerLevel {
  switch (toolName) {
    case "read_file":
    case "web_search":
    case "browse_page":
    case "memory_write":
    case "memory_search":
      return "safe";
    case "write_file":
      return outsideWorkspace ? "danger" : "caution";
    case "run_command":
      return "danger";
    default:
      // 未在 IA §4.2 表登记的工具：**保守默认 caution**（不假装它安全）。
      return "caution";
  }
}

/** 危险级徽标文案（空串 = 不渲染徽标）。 */
export function dangerBadge(level: DangerLevel, outsideWorkspace = false): string {
  if (level === "safe") {
    return "";
  }
  if (level === "danger") {
    return outsideWorkspace ? "会写入工作目录外" : "会执行命令";
  }
  return "会写入磁盘";
}

/** 是否需要就地确认（IA §4.4 的判定树）。 */
export function needsConfirmation(level: DangerLevel): boolean {
  return level === "danger";
}

/** 就地确认区的状态（IA §4.4：`pending_confirmation` → allowed / denied）。 */
export type ConfirmState =
  | { readonly kind: "idle" }
  | { readonly kind: "pending" }
  | { readonly kind: "allowed"; readonly at: string }
  | { readonly kind: "denied"; readonly reason: string };

export const CONFIRM_EVENTS = ["request", "allow", "deny"] as const;
export type ConfirmEvent = (typeof CONFIRM_EVENTS)[number];

/**
 * 确认状态机（纯函数）。
 *
 * - `request`：仅 `idle → pending`（重复请求不重置已决定的状态——终态不降级）；
 * - `allow`：仅 `pending → allowed`（**一次性**：批一次就销一次，留下的只是记录行）；
 * - `deny`：仅 `pending → denied`（原因原文必须带上传给 Agent）；
 * - 非法迁移**原样返回**当前状态（不抛错、不静默改写）。
 */
export function confirmTransition(
  state: ConfirmState,
  event: ConfirmEvent,
  payload?: { at?: string; reason?: string },
): ConfirmState {
  if (event === "request") {
    return state.kind === "idle" ? { kind: "pending" } : state;
  }
  if (event === "allow") {
    return state.kind === "pending" ? { kind: "allowed", at: payload?.at ?? "" } : state;
  }
  return state.kind === "pending"
    ? { kind: "denied", reason: payload?.reason ?? "用户拒绝了本次执行" }
    : state;
}

/** 卡片左侧竖条与状态色（IA §4.3 表；`denied`/`error` 用 danger 静态色）。 */
export function statusTone(status: ToolStatus): "neutral" | "acting" | "success" | "danger" {
  switch (status) {
    case "running":
      return "acting";
    case "success":
      return "success";
    case "error":
    case "denied":
      return "danger";
    default:
      return "neutral";
  }
}

/** 状态徽标文案（**必须带文字**，色不作为唯一编码）。 */
export function statusLabel(status: ToolStatus, durationMs?: number): string {
  const seconds = durationMs === undefined ? null : `${(durationMs / 1000).toFixed(1)}s`;
  switch (status) {
    case "pending":
      return "待执行";
    case "running":
      return seconds === null ? "执行中" : `执行中 · ${seconds}`;
    case "success":
      return seconds === null ? "成功" : `成功 · ${seconds}`;
    case "error":
      return seconds === null ? "失败" : `失败 · ${seconds}`;
    case "denied":
      return "已拒绝";
    case "cancelled":
      return "已取消";
  }
}

/**
 * 失败 / 被拒 / 沙箱拦截时是否自动展开 L4（IA §4.1：失败必须显式）。
 * 用户手动收起后不再自动展开 —— 由调用方记住"手动收起"标记。
 */
export function shouldAutoExpand(status: ToolStatus, manuallyCollapsed: boolean): boolean {
  if (manuallyCollapsed) {
    return false;
  }
  return status === "error" || status === "denied";
}
