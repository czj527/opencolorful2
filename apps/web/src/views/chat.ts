/**
 * 聊天视图（IA §3）：四层消息流 + 流式呈现 + 工具卡片四层 + 输入区。
 *
 * 层级（IA §3.2）：L0 日期分隔 → L1 回合 → L2 有序块（text / tool_call / error / plan_note）
 * → L3 行内元信息（悬停显形）。**块顺序严格等于后端事件顺序**（chat.ts 保证）。
 *
 * 三处"正确性编码"在此落地：
 *   1. 交付标签只认 `done.delivery`（delivery.ts），缺失渲染「未提供交付状态」；
 *   2. 工具卡 `denied` / 失败**自动展开并显示原因原文**，绝不显示成"成功但无输出"；
 *   3. 危险工具的就地确认区**不阻塞输入**（A9），且服务端未实现该协议时如实说明。
 */
import {
  div,
  el,
  button,
  iconButton,
  primaryButton,
  span,
} from "../lib/dom.js";
import type { AssistantTurn, Block } from "../lib/chat.js";
import type { ConfirmState, DangerLevel } from "../lib/danger.js";
import { dangerBadge, dangerLevelOf, needsConfirmation, statusLabel, statusTone } from "../lib/danger.js";
import { deliveryView } from "../lib/delivery.js";
import { presenceAnimationClass, PRESENCE_SPECS, type PresenceState } from "../lib/presence.js";
import { formatClock, truncate } from "../lib/timeline.js";
import { thinkingStage, thinkingText } from "../lib/timeline.js";
import type { Message } from "../lib/protocol.js";
import type { AppState, LiveSegment } from "../lib/store.js";
import type { Actions } from "./actions.js";

/** 工具中文名 + 图标（IA §4.2 映射表；未登记工具走保守降级形态）。 */
const TOOL_META: Readonly<Record<string, { readonly label: string; readonly glyph: string }>> = {
  read_file: { label: "读取文件", glyph: "▤" },
  write_file: { label: "写入文件", glyph: "✎" },
  run_command: { label: "执行命令", glyph: "▸_" },
  web_search: { label: "网页搜索", glyph: "⌕" },
  browse_page: { label: "打开网页", glyph: "◎" },
  memory_write: { label: "记住", glyph: "◆" },
  memory_search: { label: "检索记忆", glyph: "◇" },
};

function toolMeta(name: string): { readonly label: string; readonly glyph: string } {
  return TOOL_META[name] ?? { label: name, glyph: "⚙" };
}

export interface ChatRenderHooks {
  /**
   * 滚动锚定回调（IA §3.4）：用户在底部则自动跟随；上滑超过阈值后停止跟随
   * 并出现「回到最新 ↓」。`true` = 处于底部。
   */
  readonly onScrollAnchored: (atBottom: boolean) => void;
}

export function renderChat(
  state: AppState,
  actions: Actions,
  hooks: ChatRenderHooks,
): HTMLElement {
  const main = el("section", { class: "ap-main", attrs: { "aria-label": "聊天" } });
  main.append(renderChatHeader(state, actions));

  const stream = div({
    class: "ap-stream",
    attrs: {
      role: "log",
      "aria-live": "polite",
      "aria-relevant": "additions text",
      "aria-busy": state.chat.streaming ? "true" : "false",
    },
  });
  stream.addEventListener("scroll", () => {
    const distance = stream.scrollHeight - stream.scrollTop - stream.clientHeight;
    hooks.onScrollAnchored(distance <= 0);
  });

  if (state.chat.activeSessionId === null) {
    stream.append(renderEmptyState(state, actions, "noSession"));
  } else if (state.chat.messages.length === 0 && state.chat.live.length === 0) {
    stream.append(renderEmptyState(state, actions, "firstRun"));
  } else {
    stream.append(...renderTurns(state, actions, hooks));
  }
  main.append(stream);

  if (state.chat.following === false) {
    main.append(
      button(
        {
          class: "ap-jump-latest",
          attrs: { "aria-label": "回到最新" },
          on: { click: () => hooks.onScrollAnchored(true) },
        },
        [span({ text: "回到最新 ↓" })],
      ),
    );
  }

  main.append(renderComposer(state, actions));
  return main;
}

function renderChatHeader(state: AppState, actions: Actions): HTMLElement {
  const active = state.chat.sessions.find((session) => session.id === state.chat.activeSessionId) ?? null;
  const presence: PresenceState = state.chat.streaming ? "streaming" : "idle";
  const spec = PRESENCE_SPECS[presence];
  const animation = presenceAnimationClass(presence);
  return div({ class: "ap-chat-head" }, [
    span({ class: "ap-chat-title", text: active === null ? "新对话" : active.title === "" ? "新对话" : active.title }),
    span({ class: "ap-presence-chip", attrs: { role: "status" } }, [
      span({
        class: `ap-dot ap-dot-sm ap-presence-${presence}${animation === null ? "" : ` ${animation}`}`,
        attrs: { "aria-hidden": "true" },
      }),
      span({ text: spec.label }),
    ]),
    span({ class: "ap-spacer" }),
    iconButton("关于与版本信息", "ⓘ", () => actions.openSettings("about")),
  ]);
}

function renderEmptyState(state: AppState, actions: Actions, variant: "firstRun" | "noSession"): HTMLElement {
  if (variant === "noSession") {
    return div({ class: "ap-empty-card" }, [
      el("h2", { class: "ap-empty-title", text: "还没有对话" }),
      el("p", { class: "ap-empty-body", text: "直接说话就行，我会记住重要的部分。" }),
      primaryButton("新建对话", () => actions.createSession()),
    ]);
  }
  const suggestions = ["让助理看看桌面上的文件", "记住：我常去的目录是…"];
  const box = div({ class: "ap-guide" }, [
    el("h2", { class: "ap-guide-title", text: "你好，我是你的本地助理。" }),
    el("p", {
      class: "ap-guide-body",
      text: "我能读你的文件、执行命令、上网查资料，也能记住你的偏好。每一项操作都会留在这里可查。",
    }),
    div(
      { class: "ap-guide-chips" },
      suggestions.map((text) =>
        button(
          {
            class: "ap-chip",
            on: { click: () => actions.setDraft(text) },
          },
          [text],
        ),
      ),
    ),
  ]);
  if (state.chat.error !== null) {
    box.append(notice("danger", "本地状态读取失败", state.chat.error, actions.reloadSessions));
  }
  return box;
}

/** 把"历史消息 + 本地 live 叠加"按顺序摊成回合序列（IA §3.2 的 L1）。 */
function renderTurns(state: AppState, actions: Actions, hooks: ChatRenderHooks): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  let lastDateKey = "";
  const segments: LiveSegment[] = [
    ...state.chat.messages.map(historyToSegment),
    ...state.chat.live,
  ];

  for (const segment of segments) {
    const createdAt = segment.kind === "user" ? segment.createdAt : Date.now() / 1000;
    const dateKey = new Date(createdAt * 1000).toDateString();
    if (dateKey !== lastDateKey) {
      lastDateKey = dateKey;
      nodes.push(div({ class: "ap-date-divider", text: formatDayLabel(createdAt) }));
    }
    nodes.push(
      segment.kind === "user"
        ? renderUserMessage(segment)
        : renderAssistantTurn(segment.id, segment.turn, state, actions, hooks),
    );
  }
  return nodes;
}

function historyToSegment(message: Message): LiveSegment {
  return {
    kind: "user",
    id: message.id,
    text: message.content ?? "",
    createdAt: message.createdAt,
    seq: message.seq,
  };
}

function formatDayLabel(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return "今天";
  }
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) {
    return "昨天";
  }
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function renderUserMessage(segment: Extract<LiveSegment, { kind: "user" }>): HTMLElement {
  const wrap = div({ class: "ap-turn ap-turn-user" });
  const bubble = div({ class: "ap-bubble" }, [span({ text: segment.text })]);
  if (segment.seq === null) {
    bubble.classList.add("ap-bubble-pending");
  }
  wrap.append(bubble);
  if (segment.failed !== undefined) {
    wrap.append(
      div({ class: "ap-inline-notice ap-tone-danger" }, [
        span({ text: "消息未保存" }),
        span({ class: "ap-notice-detail", text: segment.failed }),
      ]),
    );
  }
  const meta = div({ class: "ap-meta", attrs: { "aria-hidden": "true" } }, [
    span({ text: formatClock(segment.createdAt) }),
  ]);
  wrap.append(meta);
  return wrap;
}

function renderAssistantTurn(
  turnId: string,
  turn: AssistantTurn,
  state: AppState,
  actions: Actions,
  hooks: ChatRenderHooks,
): HTMLElement {
  const wrap = div({ class: "ap-turn ap-turn-assistant", dataset: { turnId } });

  // presence：thinking（首 token 未到）与 streaming 的区分来自 turn 自身事实。
  const hasText = turn.blocks.some((block) => block.kind === "text");
  if (!hasText && !turn.streamDone) {
    // 打字指示：分级文案由 `turn.startedAt` 推导（IA §3.6 P-B 的交互时间轴：
    // 250ms 出点、2.5s 文案、8s 提示可 Esc）；
    // 结构更新会重建本节点，故文案必须由时间决定，不能依赖"渲染次数"。
    const stage = thinkingStage(Date.now() - turn.startedAt);
    const indicator = div(
      { class: "ap-thinking", attrs: { role: "status", "aria-label": "助理正在思考" } },
      [
        dot("thinking"),
        dot("thinking"),
        dot("thinking"),
        span({ class: "ap-thinking-text", text: thinkingText(stage) ?? "" }),
      ],
    );
    wrap.append(indicator);
  }

  for (const block of turn.blocks) {
    wrap.append(renderBlock(turnId, block, state, actions, hooks));
  }

  // 交付标签行（IA §6.3：只消费后端 delivery，缺失也显式呈现）。
  const view = deliveryView(turn.delivery, turn.evidence ?? undefined);
  if (turn.streamDone && turn.blocks.length > 0) {
    const labelRow = div({ class: `ap-delivery ap-tone-${view.tone}` }, [
      span({ text: view.label }),
      ...(view.evidenceLabel === null
        ? []
        : [
            view.evidenceClickable
              ? button({ class: "ap-text-btn ap-tone-accent", on: { click: () => undefined } }, [view.evidenceLabel])
              : span({ class: "ap-delivery-evidence", text: view.evidenceLabel }),
          ]),
    ]);
    wrap.append(labelRow);
  }

  if (turn.stopped) {
    wrap.append(div({ class: "ap-stopped", text: "已中断 · 已保留上述内容" }));
  }
  return wrap;
}

function dot(presence: PresenceState): HTMLElement {
  const animation = presenceAnimationClass(presence);
  return span({
    class: `ap-dot ap-dot-sm ap-presence-${presence}${animation === null ? "" : ` ${animation}`}`,
    attrs: { "aria-hidden": "true" },
  });
}

function renderBlock(
  turnId: string,
  block: Block,
  state: AppState,
  actions: Actions,
  hooks: ChatRenderHooks,
): HTMLElement {
  switch (block.kind) {
    case "text": {
      const node = div({ class: "ap-text" }, [span({ text: block.text })]);
      if (block.streaming) {
        node.dataset.streaming = turnId;
        node.append(span({ class: "ap-caret animate-ap-caret", attrs: { "aria-hidden": "true" } }));
      }
      return node;
    }
    case "error":
      return notice("danger", "回复失败", `${block.message}（${block.code}）`, actions.retry);
    case "plan_note":
      return div({ class: "ap-plan-note" }, [span({ text: block.text })]);
    case "tool_call":
      return renderToolCard(turnId, block, state, actions, hooks);
  }
}

function notice(
  tone: "danger" | "warning" | "success" | "info",
  title: string,
  detail: string,
  onRetry?: () => void,
): HTMLElement {
  return div({ class: `ap-inline-notice ap-tone-${tone}`, attrs: { role: tone === "danger" ? "alert" : "status" } }, [
    span({ class: "ap-notice-title", text: title }),
    ...(detail === "" ? [] : [span({ class: "ap-notice-detail", text: detail })]),
    ...(onRetry === undefined
      ? []
      : [button({ class: "ap-text-btn", text: "重试", on: { click: () => onRetry() } })]),
  ]);
}

/**
 * 工具卡片四层（IA §4.1）：L1 头部 / L2 参数摘要 / L3 结果摘要 / L4 展开详情。
 * 危险三级用头部徽标 + 左缘竖条区分（IA §4.4 表）。
 */
function renderToolCard(
  turnId: string,
  block: Extract<Block, { kind: "tool_call" }>,
  state: AppState,
  actions: Actions,
  hooks: ChatRenderHooks,
): HTMLElement {
  void turnId;
  void hooks;
  const level: DangerLevel = dangerLevelOf(block.name);
  const tone = statusTone(block.status);
  const meta = toolMeta(block.name);
  const card = el("section", {
    class: `ap-tool-card ap-tool-${level} ap-tool-tone-${tone}`,
    attrs: { role: "group", "aria-label": `工具调用：${meta.label}` },
    dataset: { callId: block.callId },
  });

  const badge = dangerBadge(level);
  const head = div({ class: "ap-tool-head" }, [
    span({ class: "ap-icon", text: meta.glyph, attrs: { "aria-hidden": "true" } }),
    span({ class: "ap-tool-name", text: meta.label }),
    ...(badge === ""
      ? []
      : [span({ class: `ap-danger-badge ap-tone-${level}`, text: badge })]),
    span({ class: "ap-spacer" }),
    span({ class: "ap-tool-status", attrs: { role: "status" } }, [
      span({ text: statusLabel(block.status, block.durationMs ?? undefined) }),
    ]),
  ]);
  card.append(head);

  const argsText = summarizeArgs(block.name, block.args);
  card.append(div({ class: "ap-tool-args", text: truncate(argsText, 120), title: argsText }));

  if (block.status === "running") {
    card.append(div({ class: "ap-tool-skeleton", attrs: { "aria-hidden": "true" } }));
  } else if (block.summary !== null) {
    const failed = block.resultOk === false;
    card.append(
      div({ class: failed ? "ap-tool-result ap-tone-danger" : "ap-tool-result" }, [
        // 失败 / 被拒 / 沙箱拦截：**原文照显**，绝不显示成"成功但无输出"（IA §4.4）。
        span({ text: block.summary }),
      ]),
    );
  }

  const confirm = renderConfirmArea(block, state, actions);
  if (confirm !== null) {
    card.append(confirm);
  }
  void turnId;
  return card;
}

/** L2 参数摘要（IA §4.2 的逐工具规则；未登记工具降级为 JSON 截断）。 */
function summarizeArgs(name: string, args: unknown): string {
  const record = (args ?? {}) as Record<string, unknown>;
  switch (name) {
    case "read_file":
    case "write_file":
      return String(record.path ?? "");
    case "run_command":
      return String(record.command ?? "");
    case "web_search":
      return `"${String(record.query ?? "")}"`;
    case "browse_page":
      return String(record.url ?? "");
    case "memory_write":
      return `${String(record.kind ?? "")} · ${String(record.text ?? "")}`;
    case "memory_search":
      return String(record.query ?? "");
    default:
      return truncate(JSON.stringify(args ?? null), 120);
  }
}

/**
 * 就地确认区（IA §4.4，裁决 A7/A8/A9）。
 *
 * **诚实的边界提示**：M1 的服务端（apps/server 的 t15 主循环）在 `tool_call` 之后
 * 直接执行工具，尚无"等客户端批准再执行"的协议；因此这里必须显式说明
 * "服务端尚未实现就地确认协议"，而**不能**把两个按钮做成"点了才执行"的假象。
 */
function renderConfirmArea(
  block: Extract<Block, { kind: "tool_call" }>,
  state: AppState,
  actions: Actions,
): HTMLElement | null {
  const level = dangerLevelOf(block.name);
  if (!needsConfirmation(level) || block.status !== "running") {
    if (block.confirm.kind === "allowed") {
      return div({ class: "ap-confirm-record", text: `已由用户允许（${block.confirm.at}）` });
    }
    if (block.confirm.kind === "denied") {
      return div({ class: "ap-confirm-record ap-tone-danger", text: `已拒绝 · ${block.confirm.reason}` });
    }
    return null;
  }

  const area = div({
    class: "ap-confirm",
    attrs: {
      role: "group",
      "aria-labelledby": `confirm-title-${block.callId}`,
    },
  });
  area.append(
    div({ class: "ap-confirm-title", attrs: { id: `confirm-title-${block.callId}` } }, [
      span({
        text:
          block.name === "run_command"
            ? "这条命令会在你的机器上执行，是否继续？"
            : "这次写入会发生在工作目录之外，是否继续？",
      }),
    ]),
  );
  area.append(div({ class: "ap-confirm-command", text: summarizeArgs(block.name, block.args) }));
  if (!state.confirmSupported) {
    area.append(
      div({ class: "ap-confirm-gap", attrs: { role: "note" } }, [
        span({
          text:
            "服务端尚未实现「就地确认」协议：M1 主循环在收到工具调用后即执行，" +
            "此处的授权不会改变执行结果（不制造「点了才执行」的假象）。",
        }),
      ]),
    );
  }
  area.append(
    div({ class: "ap-confirm-actions" }, [
      button({ class: "ap-btn ap-btn-secondary", on: { click: () => actions.denyOnce(block.callId) } }, ["拒绝"]),
      primaryButton("允许一次", () => actions.allowOnce(block.callId)),
    ]),
  );
  return area;
}

/** 确认状态 → 展示文案（供 inspector/测试复用）。 */
export function confirmLabel(state: ConfirmState): string {
  switch (state.kind) {
    case "idle":
      return "待确认";
    case "pending":
      return "待确认";
    case "allowed":
      return `已允许（${state.at}）`;
    case "denied":
      return `已拒绝（${state.reason}）`;
  }
}

/** 输入区（IA §3.7）：多行输入 + 工具条 + 辅助行；IME 组合期间 Enter 不发送（硬要求）。 */
function renderComposer(state: AppState, actions: Actions): HTMLElement {
  const composer = div({ class: "ap-composer" });
  const hintNode = div({
    class: state.chat.hint === null ? "ap-composer-hint" : "ap-composer-hint ap-tone-warning",
    text: state.chat.hint ?? defaultHint(state),
  });
  const textarea = el("textarea", {
    class: "ap-input",
    attrs: {
      placeholder: state.chat.streaming ? "可以继续输入；Enter 发送会进入队列" : "说点什么…（Enter 发送 · Shift+Enter 换行）",
      rows: "1",
      "aria-label": "输入消息",
    },
  });
  textarea.value = state.chat.draft;

  let composing = false;
  textarea.addEventListener("compositionstart", () => {
    composing = true;
  });
  textarea.addEventListener("compositionend", () => {
    composing = false;
  });
  textarea.addEventListener("input", () => {
    actions.setDraft(textarea.value);
    const slash = textarea.value.startsWith("/");
    hintNode.textContent = slash ? "斜杠命令二期开放" : defaultHint(state);
  });
  textarea.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") {
      return;
    }
    if (composing || event.isComposing) {
      return; // IME 保护：选词回车不得误发
    }
    if (event.shiftKey) {
      return; // 换行
    }
    event.preventDefault();
    const text = textarea.value.trim();
    if (text === "") {
      return;
    }
    actions.send(text);
    textarea.value = "";
    actions.setDraft("");
    textarea.focus(); // 发送后焦点留在输入框（IA §7.4 第 5 条）
  });
  composer.append(textarea);

  const toolbar = div({ class: "ap-composer-toolbar" }, [
    iconButton("附件（二期）", "⊕", () => undefined),
    iconButton("斜杠命令（二期）", "/", () => undefined),
    span({ class: "ap-spacer" }),
    ...(state.chat.streaming
      ? [button({ class: "ap-btn ap-btn-stop", on: { click: () => actions.stop() } }, ["停止"])]
      : [primaryButton("发送", () => {
          const text = textarea.value.trim();
          if (text === "") {
            return;
          }
          actions.send(text);
          textarea.value = "";
          actions.setDraft("");
          textarea.focus();
        })]),
  ]);

  composer.append(toolbar);
  composer.append(hintNode);

  if (state.chat.queue.length > 0) {
    composer.append(
      div({ class: "ap-queue", attrs: { role: "status" } }, [
        span({ text: `已排队 ${String(state.chat.queue.length)} 条，将在当前回复结束后发送` }),
        button({ class: "ap-text-btn", text: "取消排队", on: { click: () => actions.cancelQueued(0) } }),
      ]),
    );
  }

  if (state.chat.error !== null) {
    composer.append(notice("danger", "本地状态读取失败", state.chat.error, actions.reloadSessions));
  }

  // 附件占位面板（IA §3.7-7）：**不出现"上传中"假进度**。
  const attachPanel = div({ class: "ap-attach-panel", attrs: { hidden: "" } }, [
    div({ class: "ap-attach-title", text: "附件（二期）" }),
    div({ class: "ap-attach-body", text: "M1 支持在消息里直接写文件路径，我会去读。" }),
    div({ class: "ap-attach-actions" }, [
      button({ class: "ap-text-btn", text: "知道了", on: { click: () => undefined } }),
    ]),
  ]);
  composer.append(attachPanel);

  queueMicrotask(() => {
    textarea.style.height = "auto";
    textarea.style.height = `${String(Math.min(240, Math.max(96, textarea.scrollHeight)))}px`;
  });
  return composer;
}

function defaultHint(state: AppState): string {
  if (state.connection.phase === "offline") {
    return "本地服务已断开，消息不会发送";
  }
  if (state.connection.phase === "unauthorized") {
    return "未授权：请在设置中填写访问令牌";
  }
  return "Enter 发送 · Shift+Enter 换行";
}
