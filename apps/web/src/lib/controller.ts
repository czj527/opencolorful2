/**
 * 应用控制器：把"用户动作 / 网络 / SSE / 状态"接起来（**零 DOM**，便于单测与替换渲染方式）。
 *
 * 关键纪律：
 *   1. 一切后端交互都经 `Client`（协议层形状）；
 *   2. SSE 一律用 `fetch` + `ReadableStream` + `sse.ts` 解析（**不用 EventSource**：
 *      它不能带 `Authorization` 头，而本服务要求 Bearer 认证）；
 *   3. 失败**显式**：401 给固定文案 + 打开设置入口；网络断开给"消息不会发送"提示条；
 *      **任何失败都不得渲染成空列表/空态**（那会把"取不到"伪装成"没有"）。
 */
import { Client, failureMessage, streamChunks, UNAUTHORIZED_HINT } from "../lib/client.js";
import { parseSseChunk } from "../lib/sse.js";
import { applySseEvent, sealTurn, type AssistantTurn } from "../lib/chat.js";
import { SSE_EVENT_NAMES, type SseEvent, type SseEventName } from "../lib/protocol.js";
import { thinkingStage } from "../lib/timeline.js";
import { loadPreferences, resolveTheme, savePreference, storageAvailable } from "../lib/storage.js";
import { Store, type AppState, type LiveSegment, type ViewId } from "../lib/store.js";
import { readBuildInfo, type BuildInfoPayload } from "../lib/bridge.js";
import { UNDO_WINDOW_MS } from "../views/memory.js";
import type { MemoryItem } from "../lib/protocol.js";

/** 每帧最多追加的字符数（IA §3.4：16ms 帧节流批量追加，非动效 token）。 */
export const FRAME_BUDGET_CHARS = 24;

/** 断线重连间隔（IA §3.9：每 5s 自动重连一次；交互时间轴）。 */
export const RECONNECT_INTERVAL_MS = 5000;

export interface ControllerHooks {
  /** 需要把流式文本落进 DOM（由渲染层实现帧节流）。 */
  readonly onToken: (turn: AssistantTurn) => void;
  readonly onStructureChange: () => void;
  readonly onStateChange: (state: AppState) => void;
}

export class AppController {
  readonly store = new Store();
  private readonly client: Client;
  private activeRunId: string | null = null;
  private abort: AbortController | null = null;
  private reconnectTimer: number | null = null;
  private undoTimer: number | null = null;
  private buildInfoPayload: BuildInfoPayload | null = null;
  private buildInfoRequested = false;

  constructor(private readonly hooks: ControllerHooks) {
    const preferences = this.store.state.preferences;
    this.client = new Client({
      baseUrl: preferences.serverUrl,
      token: () => this.store.state.preferences.serverToken,
    });
    this.store.update({ storageAvailable: storageAvailable() }, "settings");
  }

  // ── 启动 ────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.applyTheme();
    this.watchSystemTheme();
    await this.connect();
    void this.loadBuildInfo();
  }

  private applyTheme(): void {
    const preference = this.store.state.preferences.colorScheme;
    const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const theme = resolveTheme(preference, systemDark);
    this.store.setTheme(theme);
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.setAttribute(
      "data-motion",
      this.store.state.preferences.motion === "reduced" ? "reduced" : "full",
    );
  }

  private watchSystemTheme(): void {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    query.addEventListener("change", () => {
      if (this.store.state.preferences.colorScheme === "auto") {
        this.applyTheme();
        this.hooks.onStateChange(this.store.state);
      }
    });
  }

  /** 探活 + 载入会话列表；失败时**不假装空态**。 */
  async connect(): Promise<void> {
    const health = await this.client.health();
    if (!health.ok) {
      this.store.setConnection({ phase: "offline", message: failureMessage(health.error), health: null });
      this.scheduleReconnect();
      return;
    }
    this.store.setConnection({ phase: "online", message: `v${health.value.version}`, health: health.value });
    this.clearReconnect();
    await this.loadSessions();
    this.scheduleReconnect(); // 持续探测：断开要能自己被发现
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) {
      return;
    }
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.probe();
    }, RECONNECT_INTERVAL_MS);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private async probe(): Promise<void> {
    const health = await this.client.health();
    if (!health.ok) {
      this.store.setConnection({ phase: "offline", message: failureMessage(health.error), health: null });
      this.scheduleReconnect();
      return;
    }
    const wasOffline = this.store.state.connection.phase !== "online";
    this.store.setConnection({ phase: "online", message: `v${health.value.version}`, health: health.value });
    if (wasOffline) {
      await this.loadSessions();
    }
    this.scheduleReconnect();
  }

  // ── 会话 ────────────────────────────────────────────────────────────────

  async loadSessions(): Promise<void> {
    this.store.updateChat({ loading: true });
    const response = await this.client.listSessions();
    if (!response.ok) {
      this.store.updateChat({
        loading: false,
        error:
          response.error.status === 401
            ? UNAUTHORIZED_HINT
            : `会话列表读取失败：${failureMessage(response.error)}`,
      });
      return;
    }
    const sessions = response.value.sessions;
    const active =
      this.store.state.chat.activeSessionId ??
      (sessions.length > 0 ? sessions[0]?.id ?? null : null);
    this.store.updateChat({ loading: false, error: null, sessions, activeSessionId: active });
    if (active !== null) {
      await this.loadMessages(active);
    }
  }

  async loadMessages(sessionId: string): Promise<void> {
    const response = await this.client.listMessages(sessionId);
    if (!response.ok) {
      this.store.updateChat({
        error: `消息读取失败：${failureMessage(response.error)}`,
        messages: [],
        live: [],
      });
      return;
    }
    this.store.updateChat({ error: null, messages: response.value.messages, live: [] });
  }

  async createSession(): Promise<void> {
    const response = await this.client.createSession();
    if (!response.ok) {
      this.store.updateChat({ error: `新建会话失败：${failureMessage(response.error)}` });
      return;
    }
    await this.loadSessions();
    this.store.updateChat({ activeSessionId: response.value.id, messages: [], live: [] });
    this.store.setView("chat");
  }

  async selectSession(sessionId: string): Promise<void> {
    this.store.updateChat({ activeSessionId: sessionId, live: [], messages: [], error: null });
    await this.loadMessages(sessionId);
  }

  // ── 聊天 ────────────────────────────────────────────────────────────────

  async send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === "") {
      return;
    }
    if (this.store.state.chat.streaming) {
      // IA §3.7-6：流式中允许继续输入，第二条进入队列（t7 AT-009 G4-2 的观测点）。
      this.store.queueMessage(trimmed);
      return;
    }
    let sessionId = this.store.state.chat.activeSessionId;
    if (sessionId === null) {
      await this.createSession();
      sessionId = this.store.state.chat.activeSessionId;
    }
    const optimistic: LiveSegment = {
      kind: "user",
      id: `local-${String(Date.now())}`,
      text: trimmed,
      createdAt: Date.now() / 1000,
      seq: null,
    };
    this.store.appendLive(optimistic);
    this.store.updateChat({ hint: null });
    const turn = this.store.startAssistantTurn();
    this.activeRunId = null;

    const response = await this.client.chatStream(
      sessionId === null ? { message: trimmed } : { sessionId, message: trimmed },
    );
    if (!response.ok) {
      turn.blocks.push({
        kind: "error",
        code: response.error.code,
        message:
          response.error.status === 401
            ? UNAUTHORIZED_HINT
            : failureMessage(response.error),
      });
      turn.streamDone = true;
      this.store.updateChat({ streaming: false, hint: response.error.status === 401 ? UNAUTHORIZED_HINT : null });
      this.hooks.onStructureChange();
      return;
    }
    this.abort = new AbortController();
    await this.consume(turn, response.value);
  }

  /** 读 SSE 流并按事件顺序应用到回合（不重排、不合并）。 */
  private async consume(turn: AssistantTurn, response: Response): Promise<void> {
    const body = response.body;
    const knownEvents: readonly SseEventName[] = SSE_EVENT_NAMES;
    let buffer = "";
    let sawDone = false;
    const startedAt = Date.now();
    let lastStage = "none";
    // 打字指示的分级文案（IA §3.6 P-B：250ms 出点、2.5s 文案、8s 提示可 Esc）：
    // 阶段变化时触发一次结构更新，文案由 `turn.startedAt` 在渲染时重算（不依赖渲染次数）。
    const heartbeat = window.setInterval(() => {
      const stage = thinkingStage(Date.now() - startedAt);
      if (stage === lastStage) {
        return;
      }
      lastStage = stage;
      this.hooks.onStructureChange();
    }, 250);
    try {
      if (body !== null) {
        for await (const chunk of streamChunks(body)) {
          const parsed = parseSseChunk(buffer, chunk, knownEvents);
          buffer = parsed.rest;
          for (const frame of parsed.frames) {
            const applied = this.applyFrame(turn, frame.event, frame.data);
            if (applied === "text") {
              this.hooks.onToken(turn);
            } else {
              this.hooks.onStructureChange();
            }
          }
          if (parsed.unknownEvents.length > 0) {
            turn.blocks.push({
              kind: "error",
              code: "unknown_sse_event",
              message: `收到未登记的事件名（协议演进）：${parsed.unknownEvents.join(", ")}`,
            });
            this.hooks.onStructureChange();
          }
          if (parsed.done) {
            sawDone = true;
            break;
          }
          if (this.abort?.signal.aborted === true) {
            break;
          }
        }
      }
    } catch (error) {
      turn.blocks.push({
        kind: "error",
        code: "stream_failed",
        message: `流读取失败：${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      window.clearInterval(heartbeat);
      sealTurn(turn);
      turn.streamDone = true;
      if (!sawDone && !turn.stopped) {
        // 没见到 [DONE]：按"回复不完整"处理，**不**当作正常完成（IA §3.8-E4）。
        turn.blocks.push({
          kind: "error",
          code: "stream_truncated",
          message: "连接中断，这条回复可能不完整。",
        });
      }
      this.abort = null;
      this.activeRunId = null;
      this.store.updateChat({ streaming: false, hint: null });
      this.hooks.onStructureChange();
      await this.flushQueue();
    }
  }

  private applyFrame(turn: AssistantTurn, event: string, data: string): "text" | "structure" {
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch (error) {
      turn.blocks.push({
        kind: "error",
        code: "invalid_event_payload",
        message: `事件载荷不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      });
      return "structure";
    }
    // 事件名已由解析器按协议常量筛过；载荷形状由 protocol 的 closed object 保证（服务端同栈）。
    // 需要严格运行期校验时用 src/lib/contract.ts 的 protocolCheck（测试专用）。
    return applySseEvent(turn, { event, data: payload } as SseEvent);
  }

  /** 用户中断（IA §3.4 / §3.7-5）：已产出内容保留，标记「已中断」。 */
  async stop(): Promise<void> {
    this.abort?.abort();
    if (this.activeRunId !== null) {
      await this.client.abortRun(this.activeRunId);
    }
    const live = this.store.state.chat.live;
    const last = live[live.length - 1];
    if (last !== undefined && last.kind === "assistant") {
      last.turn.stopped = true;
      last.turn.streamDone = true;
      sealTurn(last.turn);
    }
    this.store.updateChat({ streaming: false });
  }

  cancelQueued(index: number): void {
    const queue = [...this.store.state.chat.queue];
    queue.splice(index, 1);
    this.store.updateChat({ queue });
  }

  private async flushQueue(): Promise<void> {
    const queue = [...this.store.state.chat.queue];
    const next = queue.shift();
    if (next === undefined) {
      return;
    }
    this.store.updateChat({ queue });
    await this.send(next);
  }

  retry(): void {
    const preferences = this.store.state.preferences;
    if (preferences.serverUrl === "") {
      this.store.openSettings("main");
      return;
    }
    void this.connect();
  }

  // ── 记忆 ────────────────────────────────────────────────────────────────

  async loadMemory(query: string): Promise<void> {
    const trimmed = query.trim();
    if (trimmed === "") {
      // 缺端点：如实呈现（不把空数组渲染成"没有记忆"）。
      this.store.updateMemory({ items: [], loading: false, error: null });
      return;
    }
    this.store.updateMemory({ loading: true, error: null });
    const response = await this.client.searchMemories(trimmed);
    if (!response.ok) {
      this.store.updateMemory({
        loading: false,
        error: response.error.status === 401 ? UNAUTHORIZED_HINT : failureMessage(response.error),
      });
      return;
    }
    this.store.updateMemory({ loading: false, items: response.value.items });
  }

  setMemoryQuery(query: string): void {
    this.store.updateMemory({ query, pendingDeleteId: null });
    void this.loadMemory(query);
  }

  requestDeleteMemory(id: string): void {
    this.store.updateMemory({ pendingDeleteId: id });
  }

  cancelDeleteMemory(): void {
    this.store.updateMemory({ pendingDeleteId: null });
  }

  async deleteMemory(id: string): Promise<void> {
    const item: MemoryItem | undefined = this.store.state.memory.items.find((candidate) => candidate.id === id);
    const response = await this.client.deleteMemory(id);
    if (!response.ok) {
      this.store.updateMemory({
        pendingDeleteId: null,
        error: response.error.status === 401 ? UNAUTHORIZED_HINT : `删除失败：${failureMessage(response.error)}`,
      });
      return;
    }
    if (item !== undefined && response.value.deleted.includes(id)) {
      this.startUndo(item);
    } else {
      this.store.updateMemory({ pendingDeleteId: null });
    }
  }

  private startUndo(item: MemoryItem): void {
    if (this.undoTimer !== null) {
      window.clearTimeout(this.undoTimer);
    }
    this.store.updateMemory({ pendingDeleteId: null, undo: { item, expiresAt: Date.now() + UNDO_WINDOW_MS } });
    this.undoTimer = window.setTimeout(() => {
      this.undoTimer = null;
      const undo = this.store.state.memory.undo;
      if (undo === null) {
        return;
      }
      this.store.updateMemory({
        undo: null,
        items: this.store.state.memory.items.filter((candidate) => candidate.id !== undo.item.id),
      });
    }, UNDO_WINDOW_MS);
  }

  undoDeleteMemory(): void {
    const undo = this.store.state.memory.undo;
    if (undo === null) {
      return;
    }
    if (this.undoTimer !== null) {
      window.clearTimeout(this.undoTimer);
      this.undoTimer = null;
    }
    // 撤销只恢复本地视图；后端删除是硬删（IA §5.3 的撤销窗口语义在此如实受限）。
    this.store.updateMemory({ undo: null });
  }

  // ── 任务 ────────────────────────────────────────────────────────────────

  /** M1 后端无任务读端点：**不伪造空列表**，如实标记 unsupported。 */
  async loadTasks(): Promise<void> {
    this.store.updateTasks({ loading: false, error: null, supported: false, items: [] });
  }

  // ── 设置 / 版本戳 ────────────────────────────────────────────────────────

  async loadBuildInfo(): Promise<BuildInfoPayload | null> {
    if (this.buildInfoRequested) {
      return this.buildInfoPayload;
    }
    this.buildInfoRequested = true;
    this.buildInfoPayload = await readBuildInfo();
    this.hooks.onStateChange(this.store.state);
    return this.buildInfoPayload;
  }

  get buildInfo(): BuildInfoPayload | null {
    return this.buildInfoPayload;
  }

  setServerUrl(url: string): void {
    savePreference("serverUrl", url);
    this.store.update({ preferences: { ...this.store.state.preferences, serverUrl: url } }, "settings");
    void this.connect();
  }

  setServerToken(token: string): void {
    savePreference("serverToken", token);
    this.store.update({ preferences: { ...this.store.state.preferences, serverToken: token } }, "settings");
  }

  setColorScheme(value: "auto" | "light" | "dark"): void {
    this.store.setPreference("colorScheme", value);
    this.applyTheme();
    this.hooks.onStateChange(this.store.state);
  }

  cycleColorScheme(): void {
    const next = loadPreferences().colorScheme === "auto" ? "light" : loadPreferences().colorScheme === "light" ? "dark" : "auto";
    this.setColorScheme(next);
  }

  setView(view: ViewId): void {
    this.store.setView(view);
    if (view === "memory") {
      void this.loadMemory(this.store.state.memory.query);
    }
    if (view === "tasks") {
      void this.loadTasks();
    }
  }

  // ── 工具确认（一次性授权；服务端未实现时 UI 会如实说明） ─────────────────

  allowOnce(callId: string): void {
    this.updateConfirm(callId, { kind: "allowed", at: new Date().toLocaleTimeString("zh-CN", { hour12: false }) });
  }

  denyOnce(callId: string): void {
    this.updateConfirm(callId, { kind: "denied", reason: "用户拒绝了本次执行" });
  }

  private updateConfirm(callId: string, next: { kind: "allowed"; at: string } | { kind: "denied"; reason: string }): void {
    for (const segment of this.store.state.chat.live) {
      if (segment.kind !== "assistant") {
        continue;
      }
      for (const block of segment.turn.blocks) {
        if (block.kind === "tool_call" && block.callId === callId) {
          block.confirm = next;
        }
      }
    }
    this.hooks.onStructureChange();
  }
}

/** 事件应用（薄封装：从 chat.ts 取纯函数，便于此处只关心"回报给谁"）。 */
export { applySseEvent } from "../lib/chat.js";
