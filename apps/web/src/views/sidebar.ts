/**
 * 左侧栏（IA §1.2）：应用头 + 新建对话 + 一级导航（对话/记忆/任务）+ 会话列表 + 应用脚。
 *
 * 尺寸与状态全部走 token：展开宽 `--ap-size-sidebar`、折叠宽 `--ap-space-64`、
 * 区块间距 `--ap-space-8`、行高 `--ap-space-48`、选中竖条 `--ap-size-indicator-rail`。
 * 折叠态只保留图标（图标按钮必须有 aria-label，IA §7.5）。
 */
import { button, div, el, iconButton, span } from "../lib/dom.js";
import { formatRelative, sessionGroupOf } from "../lib/timeline.js";
import { presenceAnimationClass, PRESENCE_SPECS, type PresenceState } from "../lib/presence.js";
import type { SessionSummary } from "../lib/protocol.js";
import type { AppState, ViewId } from "../lib/store.js";
import type { Actions } from "./actions.js";

const NAV_ITEMS: readonly { readonly id: ViewId; readonly label: string; readonly glyph: string; readonly key: string }[] = [
  { id: "chat", label: "对话", glyph: "▤", key: "Ctrl/Cmd+1" },
  { id: "memory", label: "记忆", glyph: "◆", key: "Ctrl/Cmd+2" },
  { id: "tasks", label: "任务", glyph: "☰", key: "Ctrl/Cmd+3" },
];

export function renderSidebar(state: AppState, actions: Actions, presence: PresenceState): HTMLElement {
  const collapsed = state.sidebarCollapsed;
  const aside = el("aside", {
    class: collapsed ? "ap-sidebar ap-sidebar-collapsed" : "ap-sidebar",
    attrs: { "aria-label": "主导航与会话列表" },
  });

  aside.append(renderAppHeader(actions, presence, collapsed));
  aside.append(renderNav(state, actions, collapsed));
  if (state.view === "chat" && !collapsed) {
    aside.append(renderSessionList(state, actions));
  }
  aside.append(renderAppFooter(state, actions, collapsed));
  return aside;
}

function renderAppHeader(
  actions: Actions,
  presence: PresenceState,
  collapsed: boolean,
): HTMLElement {
  const spec = PRESENCE_SPECS[presence];
  const animation = presenceAnimationClass(presence);
  const dot = span({
    class: `ap-dot ap-dot-sm ap-presence-${presence}${animation === null ? "" : ` ${animation}`}`,
    attrs: { "aria-hidden": "true" },
  });
  const header = div({ class: "ap-sidebar-head" }, [
    ...(collapsed ? [] : [span({ class: "ap-brand", text: "助理" })]),
    span({ class: "ap-presence-chip", attrs: { role: "status" } }, [dot, ...(collapsed ? [] : [span({ text: spec.label })])]),
    iconButton(collapsed ? "展开侧栏" : "折叠侧栏（Ctrl/Cmd+B）", collapsed ? "»" : "«", () =>
      actions.toggleSidebar(),
    ),
  ]);
  return header;
}

function renderNav(state: AppState, actions: Actions, collapsed: boolean): HTMLElement {
  const nav = el("nav", { class: "ap-nav", attrs: { "aria-label": "主导航" } });

  const newButton = button(
    {
      class: "ap-nav-item ap-nav-item-primary",
      attrs: { "aria-label": "新建对话（Ctrl/Cmd+N）" },
      on: { click: () => actions.createSession() },
    },
    [
      span({ class: "ap-icon", text: "+", attrs: { "aria-hidden": "true" } }),
      ...(collapsed ? [] : [span({ text: "新建对话" })]),
    ],
  );
  nav.append(newButton);

  for (const item of NAV_ITEMS) {
    const active = state.view === item.id;
    const count =
      item.id === "memory" ? state.memory.items.length : item.id === "tasks" ? state.tasks.items.length : null;
    nav.append(
      button(
        {
          class: active ? "ap-nav-item ap-nav-item-active" : "ap-nav-item",
          attrs: {
            "aria-current": active ? "page" : "false",
            "aria-label": `${item.label}（${item.key}）`,
            title: `${item.label} · ${item.key}`,
          },
          on: { click: () => actions.setView(item.id) },
        },
        [
          span({ class: "ap-icon", text: item.glyph, attrs: { "aria-hidden": "true" } }),
          ...(collapsed
            ? []
            : [
                span({ text: item.label }),
                ...(count === null ? [] : [span({ class: "ap-count", text: String(count) })]),
              ]),
        ],
      ),
    );
  }
  return nav;
}

function renderSessionList(state: AppState, actions: Actions): HTMLElement {
  const container = div({ class: "ap-session-list" });
  if (state.chat.loading) {
    container.append(div({ class: "ap-skeleton-block", attrs: { "aria-hidden": "true" } }));
    return container;
  }
  if (state.chat.error !== null && state.chat.sessions.length === 0) {
    container.append(
      div({ class: "ap-inline-notice ap-tone-danger" }, [
        span({ text: "会话列表不可用" }),
        span({ class: "ap-notice-detail", text: state.chat.error }),
        button({ class: "ap-text-btn", text: "重试", on: { click: () => actions.reloadSessions() } }),
      ]),
    );
    return container;
  }
  if (state.chat.sessions.length === 0) {
    container.append(div({ class: "ap-empty-hint", text: "还没有对话。直接说话就行，我会记住重要的部分。" }));
    return container;
  }

  const groups = new Map<string, SessionSummary[]>();
  for (const session of state.chat.sessions) {
    const group = sessionGroupOf(session.updatedAt);
    const list = groups.get(group) ?? [];
    list.push(session);
    groups.set(group, list);
  }
  for (const [group, sessions] of groups) {
    container.append(div({ class: "ap-group-title", text: group }));
    const list = el("ul", { class: "ap-list", attrs: { role: "list" } });
    for (const session of sessions) {
      const active = session.id === state.chat.activeSessionId;
      list.append(
        el("li", {}, [
          button(
            {
              class: active ? "ap-session-item ap-row-selected" : "ap-session-item",
              attrs: { "aria-current": active ? "true" : "false" },
              on: { click: () => actions.selectSession(session.id) },
            },
            [
              span({ class: "ap-session-title", text: session.title === "" ? "新对话" : session.title }),
              span({ class: "ap-session-meta", text: `${formatRelative(session.updatedAt)} · ${String(session.messageCount)} 条` }),
            ],
          ),
        ]),
      );
    }
    container.append(list);
  }
  return container;
}

function renderAppFooter(state: AppState, actions: Actions, collapsed: boolean): HTMLElement {
  const health = state.connection.health;
  const versionText = health === null ? "版本信息不可用" : `服务 v${health.version}`;
  return div({ class: "ap-sidebar-foot" }, [
    button(
      {
        class: "ap-nav-item ap-nav-item-quiet",
        attrs: { "aria-label": "设置（Ctrl/Cmd+,）" },
        on: { click: () => actions.openSettings("main") },
      },
      [
        span({ class: "ap-icon", text: "⚙", attrs: { "aria-hidden": "true" } }),
        ...(collapsed ? [] : [span({ text: "设置" })]),
      ],
    ),
    ...(collapsed
      ? []
      : [
          button(
            {
              class: "ap-version-chip",
              title: "关于与版本信息",
              on: { click: () => actions.openSettings("about") },
            },
            [versionText],
          ),
        ]),
  ]);
}
