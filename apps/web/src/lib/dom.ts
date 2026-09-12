/**
 * 极简 DOM 构造工具（零依赖、零框架）。
 *
 * 为什么要它：IA §8 的组件清单有 60+ 项，若每个组件都手写
 * `document.createElement` + `setAttribute` + `append`，噪声会淹没语义。
 * 这里只提供"建元素 / 设属性 / 挂子节点"三件事，**不含状态、不含模板字符串**
 * —— 一切文本走 `textContent`（**禁用 innerHTML**，从根上排除 XSS 面）。
 *
 * 样式纪律：所有类名以 `ap-` 前缀，取值一律来自 `var(--ap-*)`（check-tokens 门禁）。
 */

export interface ElementOptions {
  readonly class?: string;
  readonly text?: string;
  readonly title?: string;
  readonly attrs?: Readonly<Record<string, string>>;
  readonly dataset?: Readonly<Record<string, string>>;
  readonly on?: Readonly<Record<string, (event: Event) => void>>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  children: readonly (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.class !== undefined) {
    node.className = options.class;
  }
  if (options.text !== undefined) {
    node.textContent = options.text;
  }
  if (options.title !== undefined) {
    node.title = options.title;
  }
  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    node.setAttribute(name, value);
  }
  for (const [name, value] of Object.entries(options.dataset ?? {})) {
    node.dataset[name] = value;
  }
  for (const [name, handler] of Object.entries(options.on ?? {})) {
    node.addEventListener(name, handler);
  }
  for (const child of children) {
    node.append(child);
  }
  return node;
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}

export function div(options: ElementOptions = {}, children: readonly (Node | string)[] = []): HTMLDivElement {
  return el("div", options, children);
}

export function span(options: ElementOptions = {}, children: readonly (Node | string)[] = []): HTMLSpanElement {
  return el("span", options, children);
}

export function button(options: ElementOptions = {}, children: readonly (Node | string)[] = []): HTMLButtonElement {
  const node = el("button", { attrs: { type: "button" }, ...options }, children);
  return node;
}

/** 图标按钮：**必须**有 aria-label（IA §7.5「全站无仅图标无名称的控件」）。 */
export function iconButton(label: string, glyph: string, onClick: () => void): HTMLButtonElement {
  return button(
    { class: "ap-icon-btn", attrs: { "aria-label": label }, title: label, on: { click: () => onClick() } },
    [span({ class: "ap-icon", text: glyph, attrs: { "aria-hidden": "true" } })],
  );
}

/** 文字按钮（32px 高，IA §8.6）。 */
export function textButton(label: string, onClick: () => void, tone?: string): HTMLButtonElement {
  return button(
    { class: tone === undefined ? "ap-text-btn" : `ap-text-btn ap-tone-${tone}`, on: { click: () => onClick() } },
    [label],
  );
}

/** 主按钮（`--ap-accent` 底 + `--ap-accent-on` 字；方案B 后为中性墨色实心）。 */
export function primaryButton(label: string, onClick: () => void, disabled = false): HTMLButtonElement {
  return button(
    {
      class: "ap-btn ap-btn-primary",
      attrs: disabled ? { disabled: "" } : {},
      on: { click: () => onClick() },
    },
    [label],
  );
}

/** 危险按钮（`--ap-danger` 底 + `--ap-danger-on` 字）。 */
export function dangerButton(label: string, onClick: () => void): HTMLButtonElement {
  return button({ class: "ap-btn ap-btn-danger", on: { click: () => onClick() } }, [label]);
}

/** 状态点（presence）：色 + **文字标签**一起给，色不作唯一信息载体。 */
export function statusDot(presenceClass: string, label: string, size: "sm" | "lg" = "sm"): HTMLSpanElement {
  return span({
    class: `ap-dot ap-dot-${size} ${presenceClass}`,
    attrs: { role: "img", "aria-label": label },
  });
}

/**
 * 卡片底：`ap-card` + 可选的波浪层次。
 * 所有卡片都必须显式声明层级（surface-1 / surface-2 / surface-inset），便于 grep 审计。
 */
export function card(layer: "base" | "raised" | "inset" | "code", options: ElementOptions = {}): HTMLDivElement {
  const layerClass = layer === "base" ? "ap-card" : `ap-card ap-card-${layer}`;
  return div({ class: options.class === undefined ? layerClass : `${layerClass} ${options.class}` });
}
