/**
 * 外壳与渲染入口（IA §1.1：单窗口 + 三主干视图 + 右侧检查器 320px）。
 *
 * 断点（IA §1.4，一律用 `--ap-breakpoint-compact` 判定，不写死中间档魔数）：
 *   `xl`（≥1440）三栏停靠；`lg`（1280–1439）三栏停靠；`md`（1024–1279）检查器转**覆盖式浮层**；
 *   `below-compact`（<1024）侧栏折叠为 64px 图标栏、检查器收起 → `xs`（<768）仅保证不破版。
 *
 * 渲染策略：`change kind = "chat-text"` 时只做**定点追加**（流式每帧都重建 DOM 会整屏闪）；
 * 其余变更重建当前视图子树。滚动锚定由 chat 视图声明、外壳保证"在底部才跟随"。
 */
import { AppController } from "../lib/controller.js";
import { div, el } from "../lib/dom.js";
import { presenceOf, type PresenceState } from "../lib/presence.js";
import type { AppState } from "../lib/store.js";
import { hasPendingConfirm, hasRunningTool } from "../lib/chat.js";
import type { Actions } from "./actions.js";
import { renderChat } from "./chat.js";
import { renderMemory, renderMemoryInspector } from "./memory.js";
import { renderSettings } from "./settings.js";
import { renderSidebar } from "./sidebar.js";
import { renderTaskInspector, renderTasks } from "./tasks.js";

export function mount(root: HTMLElement, controller: AppController): void {
  const state = controller.store.state;
  root.classList.add("ap-app");
  root.replaceChildren();
  root.removeAttribute("aria-busy");

  const shell = div({ class: "ap-shell" });
  root.append(shell);

  const presence = computePresence(state);
  const actions = createActions(controller);
  const sidebar = renderSidebar(state, actions, presence);
  const main =
    state.view === "memory" ? renderMemory(state, actions) : state.view === "tasks" ? renderTasks(state, actions) : null;
  const chat =
    state.view === "chat"
      ? renderChat(state, actions, {
          onScrollAnchored: (atBottom) => {
            if (controller.store.state.chat.following !== atBottom) {
              controller.store.updateChat({ following: atBottom });
            }
          },
        })
      : (main ?? div({ class: "ap-main" }));

  shell.append(sidebar, chat);

  const inspector = renderInspector(state, actions, controller);
  if (inspector !== null) {
    shell.append(inspector);
  }

  if (state.connection.phase !== "online") {
    shell.prepend(
      div(
        {
          class:
            state.connection.phase === "unauthorized"
              ? "ap-banner ap-tone-danger"
              : "ap-banner ap-tone-warning",
          attrs: { role: "status" },
        },
        [
          el("span", { text: state.connection.message }),
        ],
      ),
    );
  }

  const settings = renderSettings(state, actions, {
    buildInfo: () => controller.loadBuildInfo(),
    buildInfoPayload: controller.buildInfo,
    onRequestBuildInfo: () => {
      void controller.loadBuildInfo();
    },
  });
  if (settings !== null) {
    root.append(settings);
  }

  root.append(buildKeyHint());
}

function buildKeyHint(): HTMLElement {
  return div({ class: "ap-keyhint", text: "Enter 发送 · Shift+Enter 换行 · Ctrl/Cmd+1/2/3 切视图 · Ctrl/Cmd+, 设置" });
}

/** presence 五态由后端事实推导（controller 的 chat 状态），不由 UI 猜。 */
export function computePresence(state: AppState): PresenceState {
  const assistant = [...state.chat.live].reverse().find((segment) => segment.kind === "assistant");
  if (assistant === undefined || assistant.kind !== "assistant") {
    return "idle";
  }
  const turn = assistant.turn;
  return presenceOf({
    awaiting: hasPendingConfirm(turn),
    acting: hasRunningTool(turn),
    streaming: turn.blocks.some((block) => block.kind === "text" && block.streaming),
    thinking: state.chat.streaming && turn.blocks.length === 0,
  });
}

function renderInspector(state: AppState, actions: Actions, controller: AppController): HTMLElement | null {
  if (state.inspector.kind === "none") {
    return null;
  }
  const panel = el("aside", { class: "ap-inspector", attrs: { "aria-label": "详情" } });
  panel.append(
    div({ class: "ap-inspector-head" }, [
      el("span", { class: "ap-inspector-crumb", text: state.inspector.kind === "memory" ? "记忆详情" : "任务详情" }),
      el("span", { class: "ap-spacer" }),
      el(
        "button",
        {
          class: "ap-icon-btn",
          attrs: { "aria-label": "关闭详情" },
          on: { click: () => (state.inspector.kind === "memory" ? actions.setInspectorMemory(null) : actions.setInspectorTask(null)) },
        },
        [el("span", { class: "ap-icon", text: "✕", attrs: { "aria-hidden": "true" } })],
      ),
    ]),
  );
  panel.append(
    state.inspector.kind === "memory"
      ? renderMemoryInspector(state, actions, state.inspector.id)
      : renderTaskInspector(state, actions, state.inspector.id),
  );
  void controller;
  return panel;
}

/** 把控制器接到 `Actions` 接口（视图不 import 控制器，便于替换）。 */
export function createActions(controller: AppController): Actions {
  return {
    setView: (view) => controller.setView(view),
    toggleSidebar: () => controller.store.toggleSidebar(),
    openSettings: (section) => controller.store.openSettings(section ?? "main"),
    closeSettings: () => controller.store.closeSettings(),
    setInspectorMemory: (id) => controller.store.setInspector(id === null ? { kind: "none" } : { kind: "memory", id }),
    setInspectorTask: (id) => controller.store.setInspector(id === null ? { kind: "none" } : { kind: "task", id }),
    cycleColorScheme: () => controller.cycleColorScheme(),
    setColorScheme: (value) => controller.setColorScheme(value),
    createSession: () => void controller.createSession(),
    selectSession: (id) => void controller.selectSession(id),
    reloadSessions: () => void controller.loadSessions(),
    send: (text) => void controller.send(text),
    stop: () => void controller.stop(),
    cancelQueued: (index) => controller.cancelQueued(index),
    retry: () => controller.retry(),
    setDraft: (text) => controller.store.updateChat({ draft: text }),
    allowOnce: (callId) => controller.allowOnce(callId),
    denyOnce: (callId) => controller.denyOnce(callId),
    setMemoryQuery: (query) => controller.setMemoryQuery(query),
    setMemoryFilter: (filter) => controller.store.updateMemory({ filter }),
    requestDeleteMemory: (id) => controller.requestDeleteMemory(id),
    cancelDeleteMemory: () => controller.cancelDeleteMemory(),
    deleteMemory: (id) => void controller.deleteMemory(id),
    undoDeleteMemory: () => controller.undoDeleteMemory(),
    reloadMemory: () => void controller.loadMemory(controller.store.state.memory.query),
    setTaskFilter: (filter) => controller.store.updateTasks({ filter }),
    reloadTasks: () => void controller.loadTasks(),
    setServerUrl: (url) => controller.setServerUrl(url),
    setServerToken: (token) => controller.setServerToken(token),
  };
}
