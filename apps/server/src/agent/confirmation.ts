/**
 * agent/confirmation：就地确认判据（M1-9 ③）。
 *
 * 「哪些调用必须先问用户」是一条**纯判定**，不属于主循环也不属于路由：放这里是为了
 * 能被穷举单测（`confirmation.test.ts`），且主循环只在执行前问一句
 * `needsConfirmation(...)`，不把策略写进自己的控制流里。
 *
 * M1 判据（刻意最小，宁少不多）：
 * 1. `run_command` **一律**要确认。命令没有 OS 沙箱（`policy/guard.ts` 的诚实标注），
 *    它是唯一能产生"工作区之外的副作用"的工具，且 `classifyCommand` 的风险分级**不当门禁**
 *    （t4 §6：字符串查表可被 `bash -c` 绕过）。既然后端拦不住，就必须让人看一眼。
 * 2. `write_file` 且目标路径在 `workspaceRoot` **之外** → 要确认。工作区内的写是"用户让他
 *    干的活"，工作区外的写是"越界"——虽然守卫（`assertAllowed`）最终会拒它，但让用户先
 *    看到并拒绝，比让模型撞一次 403 更符合"人始终在环里"（t4 §4 治理）。
 * 3. 其余**一律** false：`read_file` / `web_search` / `browse_page` / `memory_write` /
 *    `memory_search` 都不确认，未知工具名也不确认（未知工具由执行出口如实报"未知工具"，
 *    不是"等你确认"）。
 *
 * 两条刻意的不做（写下来是为了让读者不必猜）：
 * - 工作区**内**的禁区写（`.git` / `.env` 等）**不**进确认面：执行时守卫必然拒它（403），
 *   给一个"按了也执行不了"的确认按钮是假动作。
 * - 参数不合法（`path` 缺失/不是字符串）**不**进确认面：判不出危险性，执行出口会以
 *   `[input]` 如实报参数错——不为"判不了的参数"弹确认。
 */
import type { PathGuard } from "../policy/guard.js";
import { isInside, resolveRealPath, toAbsolute } from "../policy/guard.js";

/** 确认决策（`POST /api/chat/confirm` 的 `decision`，取值面与 protocol schema 一致）。 */
export const CONFIRM_DECISIONS = ["allow", "deny"] as const;
export type ConfirmDecision = (typeof CONFIRM_DECISIONS)[number];

/** 一律要确认的工具名（见文件头理由 1；用 `as const` 保证取值面可被穷举断言）。 */
export const ALWAYS_CONFIRM_TOOLS = ["run_command"] as const;

/** 永不确认的工具名（见文件头理由 3；测试逐条断言它确实是 false）。 */
export const NEVER_CONFIRM_TOOLS = [
  "read_file",
  "web_search",
  "browse_page",
  "memory_write",
  "memory_search",
] as const;

/** 取 `write_file` 的目标路径；参数不合法（缺失/非字符串/纯空白）返回 null。 */
function writePathOf(params: unknown): string | null {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return null;
  }
  const raw = (params as Record<string, unknown>).path;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }
  return raw;
}

/** 目标路径是否**越出**工作区（realpath 先行：符号链接不得把"外"变成"内"）。 */
function isOutsideWorkspace(path: string, guard: PathGuard): boolean {
  const absolute = toAbsolute(guard.workspaceRoot, path);
  return !isInside(guard.workspaceRoot, resolveRealPath(absolute));
}

/**
 * 这次调用是否需要用户就地确认。
 *
 * `params` 是模型给的**原始**参数（未物化）：判定必须发生在执行之前，此时还拿不到
 * `materializeParams` 的结果（见文件头"不做"第二条）。
 */
export function needsConfirmation(toolName: string, params: unknown, guard: PathGuard): boolean {
  if (ALWAYS_CONFIRM_TOOLS.some((name) => name === toolName)) {
    return true;
  }
  if (toolName !== "write_file") {
    return false;
  }
  const path = writePathOf(params);
  if (path === null) {
    return false;
  }
  return isOutsideWorkspace(path, guard);
}
