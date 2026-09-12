/**
 * 渲染层状态（唯一可变状态容器）。
 *
 * 设计纪律（对齐 P3「状态以库为准」）：
 *   - store 只存"后端给的事实 + 用户本地动作"，**不存推断结果**：
 *     交付状态来自 `done.delivery`，任务状态来自 `tasks.status`，工具状态来自 `tool_result`；
 *   - 任何"看起来像完成"的展示都必须能指回一个后端字段；
 *   - 视图切换**不销毁聊天状态**（IA §1.1：切回即续）。
 */
import { Client, DEFAULT_BASE_URL } from "./client.js";
import { newAssistantTurn, type AssistantTurn } from "./chat.js";
import { loadPreferences, savePreference, type Preferences } from "./storage.js";
import type { HealthResponse, MemoryItem, Message, SessionSummary, TaskStatus } from "./protocol.js";

/** 本地会话消息 + 乐观发送的叠加层（`seq` 为 null = 尚未落库）。 */
export interface LiveUserMessage {
  readonly kind: "user";
  readonly id: string;
  readonly text: string;
  readonly createdAt: number;
  readonly seq: number | null;
  readonly failed?: string;
}

export interface LiveAssistantTurn {
  readonly kind: "assistant";
  readonly id: string;
  readonly turn: AssistantTurn;
}

export type LiveSegment = LiveUserMessage | LiveAssistantTurn;

/** 任务轻量列表项（IA §6.2 的库中字段投影；M1 的读端点为 `GET /api/tasks`，尚未落地）。 */
export interface TaskItem {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly updatedAt: number;
  readonly sessionId: string | null;
  readonly delivery: AssistantTurn["delivery"];
}

export type ViewId = "chat" | "memory" | "tasks";

export type InspectorTarget =
  | { readonly kind: "none" }
  | { readonly kind: "memory"; readonly id: string }
  | { readonly kind: "task"; readonly id: string };

export interface ConnectionState {
  readonly phase: "connecting" | "online" | "offline" | "unauthorized";
  readonly message: string;
  readonly health: HealthResponse | null;
}

export interface MemoryState {
  readonly query: string;
  readonly filter: "all" | "preference" | "fact";
  readonly items: readonly MemoryItem[];
  readonly loading: boolean;
  readonly error: string | null;
  /** 后端是否提供"列出全部"能力（M1 = false，见 README 已知缺口）。 */
  readonly listSupported: boolean;
  /** 行内确认中的条目 id（IA §5.3：删除走行内确认，不弹模态）。 */
  readonly pendingDeleteId: string | null;
  /** 已删除但仍在撤销窗口内的条目（IA §5.3：`--ap-duration-dwell-toast` = 6s）。 */
  readonly undo: { readonly item: MemoryItem; readonly expiresAt: number } | null;
}

export interface ChatState {
  readonly sessions: readonly SessionSummary[];
  readonly activeSessionId: string | null;
  readonly messages: readonly Message[];
  readonly live: readonly LiveSegment[];
  readonly loading: boolean;
  readonly error: string | null;
  /** 当前是否有回合在流式（决定输入区显示 停止 / 发送）。 */
  readonly streaming: boolean;
  /** 用户上滑后停止跟随（IA §3.4 滚动锚定）。 */
  readonly following: boolean;
  readonly queue: readonly string[];
  /** 待发/失败回注的输入框内容。 */
  readonly draft: string;
  /** 输入区辅助行提示（优先级见 IA §3.7-10）。 */
  readonly hint: string | null;
}

export interface SettingsState {
  readonly open: boolean;
  readonly openSection: "main" | "about";
}

export interface AppState {
  readonly view: ViewId;
  readonly sidebarCollapsed: boolean;
  readonly inspector: InspectorTarget;
  readonly preferences: Preferences;
  readonly theme: "light" | "dark";
  readonly storageAvailable: boolean;
  readonly connection: ConnectionState;
  readonly chat: ChatState;
  readonly memory: MemoryState;
  readonly tasks: {
    readonly items: readonly TaskItem[];
    readonly filter: "running" | "completed" | "all";
    readonly loading: boolean;
    readonly error: string | null;
    /** 后端是否提供任务读端点（M1 = false，见 README 已知缺口）。 */
    readonly supported: boolean;
  };
  readonly settings: SettingsState;
  /** 工具卡确认动线的服务端支持标记（M1 = false；UI 必须据此如实提示）。 */
  readonly confirmSupported: boolean;
}

export function initialState(): AppState {
  const preferences = loadPreferences();
  return {
    view: "chat",
    sidebarCollapsed: false,
    inspector: { kind: "none" },
    preferences,
    theme: "light",
    storageAvailable: true,
    connection: { phase: "connecting", message: "正在连接本地服务…", health: null },
    chat: {
      sessions: [],
      activeSessionId: null,
      messages: [],
      live: [],
      loading: false,
      error: null,
      streaming: false,
      following: true,
      queue: [],
      draft: "",
      hint: null,
    },
    memory: {
      query: "",
      filter: "all",
      items: [],
      loading: false,
      error: null,
      listSupported: false,
      pendingDeleteId: null,
      undo: null,
    },
    tasks: { items: [], filter: "running", loading: false, error: null, supported: false },
    settings: { open: false, openSection: "main" },
    confirmSupported: false,
  };
}

/** 变更类型（视图据此决定"整体重绘"或"定点更新"，避免流式期间整屏重绘）。 */
export type ChangeKind = "all" | "chat-text" | "chat" | "memory" | "tasks" | "connection" | "settings";

export class Store {
  state: AppState = initialState();
  private listeners = new Set<(state: AppState, kind: ChangeKind) => void>();
  private readonly client: Client;

  constructor() {
    this.client = new Client({
      baseUrl: this.state.preferences.serverUrl,
      token: () => this.state.preferences.serverToken,
    });
  }

  subscribe(listener: (state: AppState, kind: ChangeKind) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(kind: ChangeKind): void {
    for (const listener of this.listeners) {
      listener(this.state, kind);
    }
  }

  /** 局部更新辅助：只改一处，避免视图里到处写 spread。 */
  update(partial: Partial<AppState>, kind: ChangeKind = "all"): void {
    this.state = { ...this.state, ...partial };
    this.emit(kind);
  }

  updateChat(partial: Partial<ChatState>): void {
    this.state = { ...this.state, chat: { ...this.state.chat, ...partial } };
    this.emit("chat");
  }

  appendLive(segment: LiveSegment): void {
    this.updateChat({ live: [...this.state.chat.live, segment] });
  }

  /** 流式期间的正文更新：只通知"文本变了"，视图走定点追加。 */
  touchChatText(): void {
    this.emit("chat-text");
  }

  get api(): Client {
    return this.client;
  }

  // ── 偏好 ────────────────────────────────────────────────────────────────

  setPreference<K extends keyof Preferences>(key: K, value: Preferences[K]): void {
    const preferences: Preferences = { ...this.state.preferences, [key]: value };
    savePreference(
      key === "colorScheme" ? "colorScheme" : key === "motion" ? "motion" : key === "serverUrl" ? "serverUrl" : "serverToken",
      String(value),
    );
    this.update({ preferences }, "settings");
  }

  setTheme(theme: "light" | "dark"): void {
    this.update({ theme }, "settings");
  }

  openSettings(openSection: "main" | "about" = "main"): void {
    this.update({ settings: { open: true, openSection } }, "settings");
  }

  closeSettings(): void {
    this.update({ settings: { open: false, openSection: this.state.settings.openSection } }, "settings");
  }

  setView(view: ViewId): void {
    this.update({ view }, "all");
  }

  setInspector(inspector: InspectorTarget): void {
    this.update({ inspector }, "all");
  }

  toggleSidebar(): void {
    this.update({ sidebarCollapsed: !this.state.sidebarCollapsed }, "all");
  }

  setConnection(connection: ConnectionState): void {
    this.update({ connection }, "connection");
  }

  setChatError(error: string | null): void {
    this.updateChat({ error });
  }

  updateMemory(partial: Partial<MemoryState>): void {
    this.state = { ...this.state, memory: { ...this.state.memory, ...partial } };
    this.emit("memory");
  }

  updateTasks(partial: Partial<AppState["tasks"]>): void {
    this.state = { ...this.state, tasks: { ...this.state.tasks, ...partial } };
    this.emit("tasks");
  }

  queueMessage(text: string): void {
    this.updateChat({ queue: [...this.state.chat.queue, text] });
  }

  /** 新建一个空助手回合并挂到 live 序列尾部（返回引用供流式增量原地更新）。 */
  startAssistantTurn(): AssistantTurn {
    const turn = newAssistantTurn();
    this.appendLive({ kind: "assistant", id: turn.id, turn });
    this.update({ chat: { ...this.state.chat, streaming: true } }, "chat");
    return turn;
  }
}

/** 供 UI 与测试引用的默认地址常量（避免各处硬编码 URL）。 */
export const DEFAULT_SERVER_URL = DEFAULT_BASE_URL;
