/**
 * presence 状态机（tokens.md §3.1 / §6.3 + IA §3.6）。
 *
 * 五态：`idle` / `thinking` / `streaming` / `acting` / `awaiting`，由**后端事实**驱动，
 * 不由前端推断时态（P3「状态以库为准」）。硬约定：
 *   - `idle`：**静态、无动画**（不假装活着、不白耗电）；
 *   - `thinking`：呼吸（`--ap-duration-breath` + `--ap-ease-breathe`）；
 *   - `streaming`：**无脉冲**（文本 + 光标已足够可见，避免双重动效）；
 *   - `acting`：节拍（`--ap-duration-pulse`）；
 *   - `awaiting`：**入场一次后完全静止**（禁止持续动效——否则用户会以为系统还在忙而不去操作）。
 *
 * 每个状态都必须同时渲染**文字标签**：颜色不是唯一信息载体（WCAG 1.4.1），
 * 且 reduced-motion 下文字标签是唯一信息源。
 */
export const PRESENCE_STATES = [
  "idle",
  "thinking",
  "streaming",
  "acting",
  "awaiting",
] as const;

export type PresenceState = (typeof PRESENCE_STATES)[number];

/** 每态的静态契约：文字标签 + 是否持续动效（`animation: none` 类的判据）。 */
export interface PresenceSpec {
  readonly label: string;
  readonly animated: boolean;
  readonly animation: "none" | "breathe" | "pulse" | "settle";
}

export const PRESENCE_SPECS: Readonly<Record<PresenceState, PresenceSpec>> = {
  idle: { label: "在", animated: false, animation: "none" },
  thinking: { label: "思考中", animated: true, animation: "breathe" },
  streaming: { label: "输出中", animated: false, animation: "none" },
  acting: { label: "执行中", animated: true, animation: "pulse" },
  awaiting: { label: "待你确认", animated: false, animation: "settle" },
};

/** 驱动 presence 的输入事实（全部来自后端事件/本地交互，不含猜测）。 */
export interface PresenceInput {
  /** 本回合是否已发出请求且首 token 未到。 */
  readonly thinking: boolean;
  /** 是否正在流式追加。 */
  readonly streaming: boolean;
  /** 是否有工具在 running（`tool_calls.status === 'running'`）。 */
  readonly acting: boolean;
  /** 是否有待用户确认的卡片（`pending_confirmation`）或限额拒绝后等待。 */
  readonly awaiting: boolean;
}

/**
 * 状态判定（**优先级即语义**）：
 * `awaiting > acting > streaming > thinking > idle`。
 *
 * 为什么 `awaiting` 最高：等待用户决定时必须静止且优先，不能被"工具在跑"的节拍覆盖
 * （IA §3.6 硬规则 + §4.4：确认期间该回合不判完成）。
 */
export function presenceOf(input: PresenceInput): PresenceState {
  if (input.awaiting) {
    return "awaiting";
  }
  if (input.acting) {
    return "acting";
  }
  if (input.streaming) {
    return "streaming";
  }
  if (input.thinking) {
    return "thinking";
  }
  return "idle";
}

/** 是否必须静止（reduced-motion 与 awaiting 硬规则的共同判据）。 */
export function mustBeStatic(state: PresenceState): boolean {
  return !PRESENCE_SPECS[state].animated;
}

/** 允许的 CSS 类名（全部来自 tokens 层的 `animate-ap-*`，组件不自造时长）。 */
export function presenceAnimationClass(state: PresenceState): string | null {
  const spec = PRESENCE_SPECS[state];
  return spec.animation === "none" ? null : `animate-ap-presence-${spec.animation}`;
}
