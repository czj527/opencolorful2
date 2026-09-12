/**
 * 记忆视图（IA §5）：列表（`created_at` 倒序）+ 来源徽标 + 子串搜索 + **行内删除确认** + 撤销窗口。
 *
 * 两处**诚实边界**必须可见（不得静默降级）：
 *   1. M1 后端只有 `GET /api/memory/search?q=`（`q` 必填、空串返回 `[]`），
 *      **没有"列出全部记忆"的读端点**——空查询时如实显示"当前后端不提供列表"，
 *      而不是把空数组渲染成"还没有记忆"（那会把"后端没这个能力"伪装成"你确实没有记忆"）；
 *   2. 搜索走服务端 FTS5（词前缀 + 分词），前端在结果上再做一次**子串**过滤
 *      （`memory.ts` 的 `matchesSubstring`），宁可少显示也不显示不匹配的条目。
 *
 * 删除动线（IA §5.3）：悬停/聚焦出现 `删除` → **行内确认行**（替换该条目，不弹模态）→
 * 确认后条目消失 + 顶部「已删除 · 撤销」（窗口 `--ap-duration-dwell-toast` = 6000ms，交互时间轴）。
 * MVP **不提供编辑 / 手动新增 / 批量清理**（§5.3 明确二期）。
 */
import { div, el, button, iconButton, span } from "../lib/dom.js";
import { kindGlyph, kindLabel, visibleMemories } from "../lib/memory.js";
import { formatAbsolute, formatRelative } from "../lib/timeline.js";
import type { MemoryItem } from "../lib/protocol.js";
import type { AppState } from "../lib/store.js";
import type { Actions } from "./actions.js";

/** 撤销窗口（与 `--ap-duration-dwell-toast` 同值；属交互时间轴，见 IA §1.5-⑥）。 */
export const UNDO_WINDOW_MS = 6000;

export const MEMORY_UNSUPPORTED_HINT =
  "当前后端不提供「列出全部记忆」的读端点（仅有 GET /api/memory/search?q=），无法列出全部条目。" +
  "输入关键词即可检索——这是 M1 的能力边界，不等于「你没有记忆」（见 apps/web/README「已知缺口」）。";

export function renderMemory(state: AppState, actions: Actions): HTMLElement {
  const main = el("section", { class: "ap-main", attrs: { "aria-label": "记忆" } });
  const all = visibleMemories(state.memory.items, state.memory.filter, state.memory.query);

  main.append(
    div({ class: "ap-view-head" }, [
      el("h1", { class: "ap-view-title", text: "记忆" }),
      span({ class: "ap-count-badge", text: `共 ${String(all.length)} 条` }),
      span({ class: "ap-spacer" }),
      renderSearchInput(state, actions),
    ]),
  );

  main.append(
    div({ class: "ap-filter-row" }, [
      renderFilterTab("all", "全部", state, actions),
      renderFilterTab("preference", "偏好", state, actions),
      renderFilterTab("fact", "事实", state, actions),
    ]),
  );

  if (state.memory.undo !== null) {
    main.append(
      div({ class: "ap-undo-bar", attrs: { role: "status" } }, [
        span({ text: "已删除" }),
        button({ class: "ap-text-btn", text: "撤销", on: { click: () => actions.undoDeleteMemory() } }),
      ]),
    );
  }

  const list = el("ul", { class: "ap-memory-list", attrs: { role: "list" } });
  const hidden = state.memory.undo?.item.id ?? null;

  if (state.memory.loading) {
    for (let index = 0; index < 3; index += 1) {
      list.append(el("li", {}, [div({ class: "ap-skeleton-row", attrs: { "aria-hidden": "true" } })]));
    }
  } else if (state.memory.error !== null) {
    list.append(
      div({ class: "ap-inline-notice ap-tone-danger", attrs: { role: "alert" } }, [
        span({ class: "ap-notice-title", text: "数据读取失败" }),
        span({ class: "ap-notice-detail", text: state.memory.error }),
        button({ class: "ap-text-btn", text: "重试", on: { click: () => actions.reloadMemory() } }),
      ]),
    );
  } else if (state.memory.query.trim() === "" && !state.memory.listSupported) {
    list.append(
      div({ class: "ap-inline-notice ap-tone-warning", attrs: { role: "status" } }, [
        span({ class: "ap-notice-title", text: "无法列出全部记忆" }),
        span({ class: "ap-notice-detail", text: MEMORY_UNSUPPORTED_HINT }),
      ]),
    );
  } else if (all.length === 0) {
    list.append(
      div({
        class: "ap-empty-hint",
        text:
          state.memory.query.trim() === ""
            ? "还没有记忆。聊过几轮后，偏好和事实会自动沉淀在这里。"
            : "没有匹配的记忆",
      }),
    );
    if (state.memory.query.trim() !== "") {
      list.append(
        button({ class: "ap-text-btn", text: "清除搜索", on: { click: () => actions.setMemoryQuery("") } }),
      );
    }
  } else {
    for (const item of all) {
      if (item.id === hidden) {
        continue; // 撤销窗口内先从列表移除（撤销后恢复原位置由重排保证）
      }
      list.append(
        state.memory.pendingDeleteId === item.id
          ? renderConfirmRow(item, actions)
          : renderMemoryItem(state, actions, item),
      );
    }
  }

  main.append(list);
  return main;
}

function renderFilterTab(
  value: "all" | "preference" | "fact",
  label: string,
  state: AppState,
  actions: Actions,
): HTMLButtonElement {
  const active = state.memory.filter === value;
  return button(
    {
      class: active ? "ap-seg-item ap-seg-item-active" : "ap-seg-item",
      attrs: { "aria-pressed": active ? "true" : "false" },
      on: { click: () => actions.setMemoryFilter(value) },
    },
    [label],
  );
}

function renderSearchInput(state: AppState, actions: Actions): HTMLElement {
  const input = el("input", {
    class: "ap-search",
    attrs: { type: "search", placeholder: "搜索记忆内容…", "aria-label": "搜索记忆内容" },
  });
  input.value = state.memory.query;
  input.addEventListener("input", () => {
    actions.setMemoryQuery(input.value);
  });
  return input;
}

/** 行内确认行（IA §5.3）：替换该条目，**不弹模态**、不自动超时。 */
function renderConfirmRow(item: MemoryItem, actions: Actions): HTMLElement {
  return el("li", { class: "ap-memory-item ap-memory-confirm" }, [
    span({ text: "删除这条记忆？删除后不会再被回忆起。" }),
    span({ class: "ap-spacer" }),
    button({ class: "ap-text-btn", text: "取消", on: { click: () => actions.cancelDeleteMemory() } }),
    button(
      { class: "ap-btn ap-btn-danger", on: { click: () => actions.deleteMemory(item.id) } },
      ["删除"],
    ),
  ]);
}

function renderMemoryItem(state: AppState, actions: Actions, item: MemoryItem): HTMLElement {
  const selected = state.inspector.kind === "memory" && state.inspector.id === item.id;
  const session = state.chat.sessions.find((candidate) => candidate.id === item.sourceSessionId) ?? null;
  const source =
    item.sourceSessionId === undefined
      ? "手动添加"
      : session === null
        ? "来自已删除的对话"
        : `来自「${session.title}」`;

  return el("li", { class: selected ? "ap-memory-item ap-row-selected" : "ap-memory-item" }, [
    button(
      {
        class: "ap-memory-main",
        attrs: { "aria-expanded": selected ? "true" : "false" },
        on: { click: () => actions.setInspectorMemory(selected ? null : item.id) },
      },
      [
        div({ class: "ap-memory-row1" }, [
          span({ class: "ap-kind-glyph", text: kindGlyph(item.kind), attrs: { "aria-hidden": "true" } }),
          span({ class: "ap-memory-content", text: item.text }),
        ]),
        div({ class: "ap-memory-row2" }, [
          span({ class: `ap-kind-badge ap-kind-${item.kind}`, text: kindLabel(item.kind) }),
          span({ text: source }),
          span({ text: `· ${formatRelative(item.createdAt)}（${formatAbsolute(item.createdAt)}）` }),
        ]),
      ],
    ),
    div({ class: "ap-memory-actions" }, [
      iconButton(`删除记忆：${item.text.slice(0, 20)}`, "🗑", () => actions.requestDeleteMemory(item.id)),
    ]),
  ]);
}

/** 记忆详情（右侧检查器，IA §5.3）：完整内容 + 类型 + id + 来源 + 关联工具卡摘要。 */
export function renderMemoryInspector(state: AppState, actions: Actions, id: string): HTMLElement {
  const item = state.memory.items.find((candidate) => candidate.id === id);
  if (item === undefined) {
    return div({ class: "ap-inspector-body" }, [div({ class: "ap-empty-hint", text: "该记忆已不在当前列表中" })]);
  }
  const session = state.chat.sessions.find((candidate) => candidate.id === item.sourceSessionId) ?? null;
  return div({ class: "ap-inspector-body" }, [
    el("h2", { class: "ap-inspector-title", text: kindLabel(item.kind) }),
    div({ class: "ap-memory-detail", text: item.text }),
    el("dl", { class: "ap-kv" }, [
      el("dt", { text: "id" }),
      el("dd", { class: "ap-mono", text: item.id }),
      el("dt", { text: "创建时间" }),
      el("dd", { text: formatAbsolute(item.createdAt) }),
      el("dt", { text: "来源会话" }),
      el("dd", {
        text:
          item.sourceSessionId === undefined
            ? "（无来源：手动添加）"
            : session === null
              ? `${item.sourceSessionId}（已删除）`
              : session.title,
      }),
      el("dt", { text: "来源消息" }),
      el("dd", { class: "ap-mono", text: item.sourceMessageId ?? "（未记录）" }),
    ]),
    div({ class: "ap-inspector-actions" }, [
      button({ class: "ap-text-btn", text: "在聊天中查看来源", on: { click: () => actions.setView("chat") } }),
      button({ class: "ap-btn ap-btn-danger", on: { click: () => actions.requestDeleteMemory(item.id) } }, ["删除"]),
    ]),
  ]);
}
