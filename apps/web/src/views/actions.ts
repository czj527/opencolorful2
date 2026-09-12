/**
 * UI 动作面：视图层与"数据/网络/持久化"之间的唯一接口。
 *
 * 为什么要有它：视图文件只描述"长什么样、点了会怎样"，不直接 import Client / Store 的写方法。
 * 这样 ①可单测的纯逻辑（sse/delivery/presence/danger/memory）保持在 UI 之外；
 * ②将来换渲染方式（或加一个新的调用方）不必改数据层。
 */
import type { ViewId } from "../lib/store.js";

export interface Actions {
  // 导航
  setView(view: ViewId): void;
  toggleSidebar(): void;
  openSettings(section?: "main" | "about"): void;
  closeSettings(): void;
  setInspectorMemory(id: string | null): void;
  setInspectorTask(id: string | null): void;
  cycleColorScheme(): void;
  setColorScheme(value: "auto" | "light" | "dark"): void;

  // 会话
  createSession(): void;
  selectSession(id: string): void;
  reloadSessions(): void;

  // 聊天
  send(text: string): void;
  stop(): void;
  cancelQueued(index: number): void;
  retry(): void;
  setDraft(text: string): void;

  // 工具卡确认（一次性授权；服务端支持情况由 state.confirmSupported 决定提示文案）
  allowOnce(callId: string): void;
  denyOnce(callId: string): void;

  // 记忆
  setMemoryQuery(query: string): void;
  setMemoryFilter(filter: "all" | "preference" | "fact"): void;
  /** 进入行内删除确认（IA §5.3：不弹模态、不自动超时）。 */
  requestDeleteMemory(id: string): void;
  cancelDeleteMemory(): void;
  /** 已确认删除：调 `DELETE /api/memory` 并在本地开撤销窗口。 */
  deleteMemory(id: string): void;
  undoDeleteMemory(): void;
  reloadMemory(): void;

  // 任务
  setTaskFilter(filter: "running" | "completed" | "all"): void;
  reloadTasks(): void;

  // 设置
  setServerUrl(url: string): void;
  setServerToken(token: string): void;
}
