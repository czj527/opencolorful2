/**
 * 任务视图（IA §6）：**轻量纵向列表 + 右侧详情**，不做 Kanban、不做泳道、不做依赖图。
 *
 * 只回答三个问题：现在在做什么？做完了没有？凭什么说做完了？
 *
 * 治理语义（t1 P0-1 / AT-503，执行层不得翻案）：
 *   - 终态徽标 + **锁定图标** + **不提供任何状态变更入口**（无取消、无重跑、无手改下拉，A10）；
 *   - 终态**不显示计时器**（计时停走、最终耗时作为静态文本）；
 *   - 终态色与文字**渲染后不再变化、不带动效**（进行时与终态严格分离）。
 *
 * 诚实边界：M1 后端**没有任务读端点**（`tasks` 表与治理内核已在 packages/state 落地，
 * 但 `apps/server` 未暴露 `/api/tasks`），因此本视图显式说明"后端不提供任务读端点"，
 * 不把空列表渲染成"当前没有进行中的任务"。
 */
import { div, el, button, span } from "../lib/dom.js";
import { presenceAnimationClass } from "../lib/presence.js";
import { deliveryShortLabel } from "../lib/delivery.js";
import { formatRelative } from "../lib/timeline.js";
import type { TaskStatus } from "../lib/protocol.js";
import type { AppState, TaskItem } from "../lib/store.js";
import type { Actions } from "./actions.js";

/** 7 态在 UI 上的投影（IA §6.2 表：文案 + 徽标 + 色 + 是否可变）。 */
const TASK_STATUS_VIEW: Readonly<
  Record<TaskStatus, { readonly label: string; readonly glyph: string; readonly tone: string; readonly terminal: boolean }>
> = {
  pending: { label: "待开始", glyph: "○", tone: "neutral", terminal: false },
  running: { label: "进行中", glyph: "◔", tone: "acting", terminal: false },
  blocked: { label: "阻塞", glyph: "‖", tone: "warning", terminal: false },
  needs_input: { label: "需要你确认", glyph: "?", tone: "warning", terminal: false },
  completed: { label: "已完成", glyph: "✓", tone: "success", terminal: true },
  failed: { label: "失败", glyph: "！", tone: "danger", terminal: true },
  cancelled: { label: "已取消", glyph: "⊘", tone: "neutral", terminal: true },
};

export const TASKS_UNSUPPORTED_HINT =
  "当前后端不提供任务读端点（tasks 表与治理内核已在 packages/state 落地，apps/server 未暴露 /api/tasks）。" +
  "列表为空是因为取不到数据，不等于「当前没有任务」（见 apps/web/README「已知缺口」）。";

export function taskStatusView(status: TaskStatus): (typeof TASK_STATUS_VIEW)[TaskStatus] {
  return TASK_STATUS_VIEW[status];
}

/** 终态判定（终态不可降级的 UI 语义基础）。 */
export function isTerminal(status: TaskStatus): boolean {
  return TASK_STATUS_VIEW[status].terminal;
}

/** 按筛选条件取可见任务：`进行中` 在前（`updated_at` 倒序），终态在后（同序）。 */
export function visibleTasks(
  tasks: readonly TaskItem[],
  filter: "running" | "completed" | "all",
): TaskItem[] {
  const sorted = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt);
  if (filter === "all") {
    return [...sorted.filter((task) => !isTerminal(task.status)), ...sorted.filter((task) => isTerminal(task.status))];
  }
  if (filter === "completed") {
    return sorted.filter((task) => isTerminal(task.status));
  }
  return sorted.filter((task) => !isTerminal(task.status));
}

export function renderTasks(state: AppState, actions: Actions): HTMLElement {
  const main = el("section", { class: "ap-main", attrs: { "aria-label": "任务" } });
  const items = visibleTasks(state.tasks.items, state.tasks.filter);
  const running = state.tasks.items.filter((task) => !isTerminal(task.status)).length;

  main.append(
    div({ class: "ap-view-head" }, [
      el("h1", { class: "ap-view-title", text: "任务" }),
      span({ class: "ap-count-badge", text: `进行中 ${String(running)} · 共 ${String(state.tasks.items.length)}` }),
      span({ class: "ap-spacer" }),
      div({ class: "ap-seg" }, [
        renderFilterTab("running", "进行中", state, actions),
        renderFilterTab("completed", "已完成", state, actions),
        renderFilterTab("all", "全部", state, actions),
      ]),
    ]),
  );

  const list = el("ul", { class: "ap-task-list", attrs: { role: "list" } });
  if (state.tasks.loading) {
    list.append(el("li", {}, [div({ class: "ap-skeleton-row", attrs: { "aria-hidden": "true" } })]));
  } else if (state.tasks.error !== null) {
    list.append(
      div({ class: "ap-inline-notice ap-tone-danger", attrs: { role: "alert" } }, [
        span({ class: "ap-notice-title", text: "数据读取失败" }),
        span({ class: "ap-notice-detail", text: state.tasks.error }),
        button({ class: "ap-text-btn", text: "重试", on: { click: () => actions.reloadTasks() } }),
      ]),
    );
  } else if (!state.tasks.supported) {
    list.append(
      div({ class: "ap-inline-notice ap-tone-warning", attrs: { role: "status" } }, [
        span({ class: "ap-notice-title", text: "无法读取任务列表" }),
        span({ class: "ap-notice-detail", text: TASKS_UNSUPPORTED_HINT }),
      ]),
    );
  } else if (items.length === 0) {
    list.append(
      div({
        class: "ap-empty-hint",
        text: state.tasks.filter === "running"
          ? "当前没有进行中的任务。任务会在你让我办事时自动出现。"
          : "没有符合条件的任务。",
      }),
    );
  } else {
    for (const task of items) {
      list.append(renderTaskRow(state, actions, task));
    }
  }

  main.append(list);
  return main;
}

function renderFilterTab(
  value: "running" | "completed" | "all",
  label: string,
  state: AppState,
  actions: Actions,
): HTMLButtonElement {
  const active = state.tasks.filter === value;
  return button(
    {
      class: active ? "ap-seg-item ap-seg-item-active" : "ap-seg-item",
      attrs: { "aria-pressed": active ? "true" : "false" },
      on: { click: () => actions.setTaskFilter(value) },
    },
    [label],
  );
}

function renderTaskRow(state: AppState, actions: Actions, task: TaskItem): HTMLElement {
  const view = taskStatusView(task.status);
  const selected = state.inspector.kind === "task" && state.inspector.id === task.id;
  const dotClass =
    task.status === "running"
      ? `ap-presence-acting ${presenceAnimationClass("acting") ?? ""}`
      : task.status === "needs_input"
        ? "ap-presence-awaiting"
        : `ap-tone-${view.tone}`;

  return el("li", { class: selected ? "ap-task-row ap-row-selected" : "ap-task-row" }, [
    button(
      {
        class: "ap-task-main",
        attrs: { "aria-expanded": selected ? "true" : "false" },
        on: { click: () => actions.setInspectorTask(selected ? null : task.id) },
      },
      [
        span({ class: `ap-dot ap-dot-sm ${dotClass}`, attrs: { "aria-hidden": "true" } }),
        span({ class: "ap-task-title", text: task.title }),
        span({ class: "ap-task-meta", text: `${view.label} · ${formatRelative(task.updatedAt)}` }),
        span({ class: "ap-spacer" }),
        span({ class: `ap-status-badge ap-tone-${view.tone}`, attrs: { role: "status" } }, [
          span({ text: `${view.glyph} ${view.label}` }),
          // 终态：锁定图标 + aria 说明（状态不可再变更）。
          ...(view.terminal
            ? [span({ class: "ap-lock", text: "🔒", attrs: { "aria-label": "终态，状态不可再变更" } })]
            : []),
        ]),
      ],
    ),
  ]);
}

/** 任务详情（右侧检查器，IA §6.4）。MVP **不提供**取消/重跑/手改状态入口。 */
export function renderTaskInspector(state: AppState, actions: Actions, id: string): HTMLElement {
  const task = state.tasks.items.find((candidate) => candidate.id === id);
  if (task === undefined) {
    return div({ class: "ap-inspector-body" }, [div({ class: "ap-empty-hint", text: "该任务已不在当前列表中" })]);
  }
  const view = taskStatusView(task.status);
  return div({ class: "ap-inspector-body" }, [
    el("h2", { class: "ap-inspector-title", text: task.title }),
    div({ class: `ap-status-badge ap-tone-${view.tone}` }, [
      span({ text: `${view.glyph} ${view.label}` }),
      ...(view.terminal ? [span({ class: "ap-lock", text: "🔒", attrs: { "aria-label": "终态，状态不可再变更" } })] : []),
    ]),
    el("dl", { class: "ap-kv" }, [
      el("dt", { text: "任务 id" }),
      el("dd", { class: "ap-mono", text: task.id }),
      el("dt", { text: "更新时间" }),
      el("dd", { text: formatRelative(task.updatedAt) }),
      el("dt", { text: "所属会话" }),
      el("dd", { text: task.sessionId ?? "（未记录）" }),
      el("dt", { text: "交付状态" }),
      el("dd", { text: deliveryShortLabel(task.delivery) }),
    ]),
    // 进度陈述（非交付）与终态徽标**永不并列**（IA §6.4 第 3 条）。
    div({ class: "ap-progress-note" }, [
      el("h3", { text: "进度陈述（非交付）" }),
      div({ class: "ap-progress-body", text: view.terminal ? "—" : "（暂无进度文本）" }),
    ]),
    div({ class: "ap-inspector-actions" }, [
      button({ class: "ap-text-btn", text: "在聊天中查看来源", on: { click: () => actions.setView("chat") } }),
    ]),
    div({ class: "ap-inspector-note", text: "MVP 不提供取消 / 重跑 / 手改状态入口（避免绕过 CAS 与终态语义）。" }),
  ]);
}
