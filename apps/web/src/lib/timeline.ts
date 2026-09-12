/**
 * 交互时间轴 + 时间/体积格式化（IA §1.5-⑥：这些是**行为契约**，不是动效 token，
 * 故以具体毫秒书写，不受 tokens.md §6.1 约束）。
 */

/** thinking 分级时间轴（IA §3.6 P-B）：250ms 出打字指示 / 2.5s 文案 / 8s 提示可 Esc / 30s 超时。 */
export const THINKING_TIMELINE = {
  indicatorAfterMs: 250,
  textAfterMs: 2500,
  stopHintAfterMs: 8000,
  timeoutAfterMs: 30_000,
} as const;

export type ThinkingStage = "none" | "dots" | "dots-text" | "dots-text-stophint" | "timeout";

/** 纯函数：按已耗时判定当前阶段（可单测，无需真实计时器）。 */
export function thinkingStage(elapsedMs: number): ThinkingStage {
  if (elapsedMs >= THINKING_TIMELINE.timeoutAfterMs) {
    return "timeout";
  }
  if (elapsedMs >= THINKING_TIMELINE.stopHintAfterMs) {
    return "dots-text-stophint";
  }
  if (elapsedMs >= THINKING_TIMELINE.textAfterMs) {
    return "dots-text";
  }
  if (elapsedMs >= THINKING_TIMELINE.indicatorAfterMs) {
    return "dots";
  }
  return "none";
}

/** 阶段文案（`null` = 只渲染圆点）。 */
export function thinkingText(stage: ThinkingStage): string | null {
  switch (stage) {
    case "dots-text":
      return "正在思考…";
    case "dots-text-stophint":
      return "还在处理，可能需要一点时间…";
    case "timeout":
      return "30 秒内没有收到任何内容。";
    default:
      return null;
  }
}

/** 工具卡"长时间命令"提示阈值（IA §3.6 P-C：> 10s 追加灰字 + 「停止」）。 */
export const LONG_RUNNING_MS = 10_000;

/** 时长显示：`0.8s` / `12.4s`（IA §3.6 P-C 的 100ms 步进由调用方控制刷新频率）。 */
export function formatDuration(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

/** `HH:mm`（消息元数据行）。 */
export function formatClock(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `HH:mm:ss`（确认记录行 / mtime）。 */
export function formatClockSeconds(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 相对时间（IA §5.2 来源行）：今天 / 昨天 / N 天前 + 绝对时间。 */
export function formatRelative(unixSeconds: number, now = Date.now()): string {
  const then = new Date(unixSeconds * 1000);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const days = Math.floor((startOfToday.getTime() - then.getTime()) / 86_400_000);
  if (days < 0) {
    return `今天 ${formatClock(unixSeconds)}`;
  }
  if (days === 0) {
    return `今天 ${formatClock(unixSeconds)}`;
  }
  if (days === 1) {
    return "昨天";
  }
  return `${days} 天前`;
}

/** 绝对时间（`2026-09-08 10:16`），与相对时间并列显示。 */
export function formatAbsolute(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${formatClock(unixSeconds)}`;
}

/** 体积（工具结果摘要）：B / KB / MB。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 截断显示（单行省略的文案，超出不吞掉信息量标记）。 */
export function truncate(text: string, max = 120): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** 会话分组（IA §1.2：今天 / 近 7 天 / 更早）。 */
export function sessionGroupOf(unixSeconds: number, now = Date.now()): "今天" | "近 7 天" | "更早" {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const days = Math.floor((startOfToday.getTime() - unixSeconds * 1000) / 86_400_000);
  if (days <= 0) {
    return "今天";
  }
  return days < 7 ? "近 7 天" : "更早";
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
