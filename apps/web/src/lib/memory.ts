/**
 * 记忆视图的**纯逻辑**（IA §5）：排序、子串过滤、类型过滤、搜索态判定。
 *
 * 口径（IA §5.1 + §12.7）：
 *   - 排序：`created_at` **倒序**（最新在上）；后端 FTS 可能按相关度返回，视图层统一重排，
 *     保证"列表顺序"这一可见事实只由一处决定；
 *   - 搜索：**内容子串匹配**（MVP 不做向量检索，t2 §5-3）。服务端是 FTS5 检索（词前缀 + 分词），
 *     与"子串"并非同一件事，故前端在拿到结果后再做一次**子串**过滤：宁可少显示，
 *     也不显示"不匹配用户输入"的条目（`allOf` 语义，见 `matchesSubstring`）；
 *   - 过滤 → 排序不可颠倒：先按 kind/子串筛，再按时间倒序，避免"看起来乱序"。
 */
import type { MemoryItem, MemoryKind } from "./protocol.js";

export type MemoryFilter = "all" | MemoryKind;

/** 内容子串匹配（大小写不敏感；空查询匹配一切）。 */
export function matchesSubstring(item: MemoryItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return true;
  }
  return item.text.toLowerCase().includes(needle);
}

export function matchesKind(item: MemoryItem, filter: MemoryFilter): boolean {
  return filter === "all" || item.kind === filter;
}

/** 视图层统一排序：`created_at` 倒序，同秒按 id 稳定排序（避免每次渲染顺序漂移）。 */
export function sortByCreatedAtDesc(items: readonly MemoryItem[]): MemoryItem[] {
  return [...items].sort((a, b) => (b.createdAt - a.createdAt) || a.id.localeCompare(b.id));
}

/** 过滤 + 排序（记忆列表的唯一入口）。 */
export function visibleMemories(
  items: readonly MemoryItem[],
  filter: MemoryFilter,
  query: string,
): MemoryItem[] {
  return sortByCreatedAtDesc(
    items.filter((item) => matchesKind(item, filter) && matchesSubstring(item, query)),
  );
}

export type MemorySearchState =
  | { readonly kind: "idle" }
  | { readonly kind: "unsupported"; readonly reason: string }
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly items: readonly MemoryItem[] };

/**
 * 搜索态判定：**没有查询词时不发请求**。
 *
 * 原因（后端缺口，见 README「已知缺口」）：M1 的读端点只有 `GET /api/memory/search`，
 * 它的 `q` 是 `minLength: 1` 且 DAO 对空串直接返回 `[]`——即**没有"列出全部记忆"的端点**。
 * 此时前端必须显式呈现"当前后端不提供列表"，而不是把空数组渲染成"还没有记忆"
 * （那会把"后端没这个能力"伪装成"你确实没有记忆"，属静默降级，违反 P5）。
 */
export function planSearch(hasQuery: boolean, listSupported: boolean): MemorySearchState {
  if (hasQuery) {
    return { kind: "loading" };
  }
  if (listSupported) {
    return { kind: "idle" };
  }
  return {
    kind: "unsupported",
    reason:
      "当前后端不提供「列出全部记忆」的读端点（仅有 GET /api/memory/search?q=），无法列出全部条目",
  };
}

/** `kind` 的中文标签（IA §5.1 的类型图标 + §5.2 的徽标文案）。 */
export function kindLabel(kind: MemoryKind): string {
  return kind === "preference" ? "偏好" : "事实";
}

/** `kind` 的图形标记（色不是唯一编码，WCAG 1.4.1）。 */
export function kindGlyph(kind: MemoryKind): string {
  return kind === "preference" ? "◆" : "●";
}

/** 来源行文案（IA §5.2）：有来源会话 / 已删除 / 无来源三分支，全部显式。 */
export function sourceText(item: MemoryItem, sessionTitle: string | null): string {
  if (item.sourceSessionId === undefined) {
    return "手动添加";
  }
  if (sessionTitle === null) {
    return "来自已删除的对话";
  }
  return `来自「${sessionTitle}」`;
}
