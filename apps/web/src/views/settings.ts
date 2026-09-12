/**
 * 设置模态（IA §6.6：唯一的设置面，且极简）。含「关于」区版本戳。
 *
 * 4 项只读信息 + 1 项外观（§12.8）+ 两处 M1 特有的真实配置（服务端地址 / 访问令牌）：
 *   1. 服务端与模型：地址、认证是否已配置（**不显示明文**）、`/api/health` 的 version/workspaceRoot
 *   2. 工作目录：`/api/health` 的 `workspaceRoot`（本地绝对路径）
 *   3. 数据位置：说明"所有会话、记忆与任务都在这一个 SQLite 文件里"（路径由 server 侧配置，UI 不猜）
 *   4. 版本戳：desktop 环境经 `window.agentplant.getBuildInfo()`（**构建期注入，禁硬编码**）；
 *      纯 web 环境显示「版本信息不可用（未在桌面壳内运行）」的诚实分支
 *   5. 外观：跟随系统 / 浅色 / 深色（写 `ap.colorScheme`）
 *
 * 焦点陷阱仅限模态（IA §7.4）：`Tab` 循环在弹窗内、`Esc` 关闭并归还焦点。
 */
import { div, el, button, span } from "../lib/dom.js";
import { hasBridge, type BuildInfoPayload } from "../lib/bridge.js";
import { STORAGE_KEYS } from "../lib/storage.js";
import type { AppState } from "../lib/store.js";
import type { Actions } from "./actions.js";

export interface SettingsDeps {
  /** 读取 desktop 注入的版本戳；纯 web 环境返回 `null`（**不**回退到硬编码版本）。 */
  readonly buildInfo: () => Promise<BuildInfoPayload | null>;
  /** 版本戳加载结果（首次打开时拉取，之后复用）。 */
  readonly buildInfoPayload: BuildInfoPayload | null;
  readonly onRequestBuildInfo: () => void;
}

export const BUILD_INFO_UNAVAILABLE = "版本信息不可用：未在桌面壳内运行（无构建期注入的版本戳）。";

export function renderSettings(state: AppState, actions: Actions, deps: SettingsDeps): HTMLElement | null {
  if (!state.settings.open) {
    return null;
  }
  const dialog = el("div", {
    class: "ap-scrim",
    attrs: { role: "presentation" },
    on: {
      click: (event) => {
        if (event.target === dialog) {
          actions.closeSettings();
        }
      },
    },
  });
  const modal = el("div", {
    class: "ap-modal ap-settings",
    attrs: { role: "dialog", "aria-modal": "true", "aria-label": "设置" },
  });

  const health = state.connection.health;
  modal.append(
    div({ class: "ap-modal-head" }, [
      el("h2", { class: "ap-modal-title", text: state.settings.openSection === "about" ? "关于" : "设置" }),
      span({ class: "ap-spacer" }),
      button(
        { class: "ap-icon-btn", attrs: { "aria-label": "关闭设置（Esc）" }, on: { click: () => actions.closeSettings() } },
        [span({ class: "ap-icon", text: "✕", attrs: { "aria-hidden": "true" } })],
      ),
    ]),
  );

  const body = div({ class: "ap-modal-body" });

  body.append(
    section("服务端与模型", [
      row("服务端地址", inputRow(state.preferences.serverUrl, "http://127.0.0.1:43121", (value) => actions.setServerUrl(value))),
      row(
        "访问令牌",
        inputRow(
          state.preferences.serverToken,
          "Bearer token（APP_TOKEN）",
          (value) => actions.setServerToken(value),
          "password",
        ),
      ),
      row("认证状态", span({ text: state.preferences.serverToken === "" ? "未配置（受保护端点会返回 401）" : "已配置（不回显明文）" })),
      row("本地服务", span({ text: health === null ? state.connection.message : `v${health.version} · ${health.sandboxMode}` })),
      row("存储可用性", span({ text: state.storageAvailable ? `localStorage 可用（键 ${STORAGE_KEYS.serverToken}）` : "本机存储不可用：偏好仅在本次会话内有效" })),
    ]),
  );

  body.append(
    section("工作目录与数据", [
      row("工作目录", span({ class: "ap-mono", text: health?.workspaceRoot ?? "不可用（未连接本地服务）" })),
      row("数据位置", span({ text: "所有会话、记忆与任务都在这一个 SQLite 文件里（路径由 server 的 STATE_DB_PATH 决定，UI 不猜）" })),
      row("沙箱模式", span({ text: health?.sandboxMode ?? "不可用" })),
    ]),
  );

  body.append(section("外观", [appearanceControls(state, actions)]));

  body.append(section("版本", [versionBlock(deps)]));

  modal.append(body);
  dialog.append(modal);
  return dialog;
}

function section(title: string, children: readonly (Node | string)[]): HTMLElement {
  return el("section", { class: "ap-settings-section" }, [
    el("h3", { class: "ap-settings-title", text: title }),
    ...children,
  ]);
}

function row(label: string, value: Node): HTMLElement {
  return div({ class: "ap-settings-row" }, [span({ class: "ap-settings-label", text: label }), value]);
}

function inputRow(
  value: string,
  placeholder: string,
  onChange: (value: string) => void,
  type: "text" | "password" = "text",
): HTMLElement {
  const input = el("input", {
    class: "ap-input ap-input-inline",
    attrs: { type, placeholder, "aria-label": placeholder },
  });
  input.value = value;
  input.addEventListener("change", () => onChange(input.value.trim()));
  return input;
}

const APPEARANCE: readonly { readonly value: "auto" | "light" | "dark"; readonly label: string }[] = [
  { value: "auto", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

function appearanceControls(state: AppState, actions: Actions): HTMLElement {
  return div(
    { class: "ap-seg" },
    APPEARANCE.map((option) =>
      button(
        {
          class: state.preferences.colorScheme === option.value ? "ap-seg-item ap-seg-item-active" : "ap-seg-item",
          attrs: { "aria-pressed": state.preferences.colorScheme === option.value ? "true" : "false" },
          on: { click: () => actions.setColorScheme(option.value) },
        },
        [option.label],
      ),
    ),
  );
}

/**
 * 版本戳（IA §6.6 第 4 行）：
 *   - `available: true` → `version` + `构建 <gitSha 前 8 位>` + `构建于 <buildTime>`
 *   - `available: false` → 显示服务端的**明确原因**（不猜、不编）
 *   - 无 bridge（纯 web）→ 诚实分支，**不回退硬编码版本号**（t7 FG-05）
 */
function versionBlock(deps: SettingsDeps): HTMLElement {
  // 纯 web 环境（无 preload 桥接）：走**诚实分支**，不回退任何硬编码版本（t7 FG-05）。
  if (!hasBridge()) {
    return div({ class: "ap-settings-value ap-tone-warning", text: BUILD_INFO_UNAVAILABLE });
  }
  const payload = deps.buildInfoPayload;
  if (payload === null) {
    // 还没取到：给一个显式的读取入口（禁用"猜一个版本"这种假绿路径）。
    const trigger = el("button", {
      class: "ap-text-btn",
      on: { click: () => deps.onRequestBuildInfo() },
    });
    trigger.textContent = "读取版本戳…";
    return div({ class: "ap-settings-row" }, [trigger]);
  }
  if (!payload.available) {
    return div({ class: "ap-settings-value ap-tone-warning", text: `版本信息不可用：${payload.reason}` });
  }
  const shortSha = payload.buildInfo.gitSha === null ? "未知" : payload.buildInfo.gitSha.slice(0, 8);
  return div({ class: "ap-settings-value" }, [
    div({ class: "ap-mono", text: `版本 ${payload.buildInfo.version}${payload.buildInfo.isReleaseVersion ? "" : "（非发布版本）"}` }),
    div({ text: `构建 ${shortSha} · 构建于 ${payload.buildInfo.buildTime}` }),
    div({ text: `运行时 Node ${payload.buildInfo.node} · pnpm ${payload.buildInfo.pnpm ?? "未知"}` }),
    ...(payload.versionConsistent
      ? []
      : [div({ class: "ap-tone-danger", text: `⚠ 版本戳不一致：app.getVersion()=${payload.appVersion} ≠ build-info.version=${payload.buildInfo.version}` })]),
  ]);
}
