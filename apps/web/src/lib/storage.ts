/**
 * 本地偏好与运行时配置（localStorage 键名是**契约**，见 tokens.md §7.4）。
 *
 * 键表（单一真相，禁止散落多处）：
 *   `ap.colorScheme` → `'auto' | 'light' | 'dark'`（默认 auto）
 *   `ap.motion`      → `'full' | 'reduced'`（与系统 prefers-reduced-motion 取并集）
 *   `ap.serverUrl`   → 本地 server 地址（默认 `http://127.0.0.1:43121`）
 *   `ap.serverToken` → Bearer token（**只存本机 localStorage**；401 时给出明确提示）
 *
 * localStorage 不可用（隐私模式 / file:// 限制）时不抛错：返回默认值，UI 用内存态继续跑，
 * 并在设置里显式说明"本次会话内有效"（诚实分支，不假装已保存）。
 */
import { DEFAULT_BASE_URL } from "./client.js";

export const STORAGE_KEYS = {
  colorScheme: "ap.colorScheme",
  motion: "ap.motion",
  serverUrl: "ap.serverUrl",
  serverToken: "ap.serverToken",
} as const;

export type ColorSchemePreference = "auto" | "light" | "dark";
export type MotionPreference = "full" | "reduced";

export interface Preferences {
  readonly colorScheme: ColorSchemePreference;
  readonly motion: MotionPreference;
  readonly serverUrl: string;
  readonly serverToken: string;
}

export const DEFAULT_PREFERENCES: Preferences = {
  colorScheme: "auto",
  motion: "full",
  serverUrl: DEFAULT_BASE_URL,
  serverToken: "",
};

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** localStorage 是否可用（不可用时设置界面必须如实说明）。 */
export function storageAvailable(): boolean {
  try {
    const probe = "__ap_probe__";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

export function loadPreferences(): Preferences {
  const scheme = readRaw(STORAGE_KEYS.colorScheme);
  const motion = readRaw(STORAGE_KEYS.motion);
  const url = readRaw(STORAGE_KEYS.serverUrl);
  const token = readRaw(STORAGE_KEYS.serverToken);
  return {
    colorScheme: scheme === "light" || scheme === "dark" ? scheme : "auto",
    motion: motion === "reduced" ? "reduced" : "full",
    serverUrl: url === null || url.trim() === "" ? DEFAULT_BASE_URL : url.trim(),
    serverToken: token ?? "",
  };
}

export function savePreference(key: keyof typeof STORAGE_KEYS, value: string): void {
  try {
    localStorage.setItem(STORAGE_KEYS[key], value);
  } catch {
    // 存不下就只保留内存态：设置界面会如实显示"本机存储不可用"。
  }
}

/** 解析 `auto` → 具体主题（`data-theme` 只写解析后的值，永不写 `auto`）。 */
export function resolveTheme(
  preference: ColorSchemePreference,
  systemDark: boolean,
): "light" | "dark" {
  if (preference === "auto") {
    return systemDark ? "dark" : "light";
  }
  return preference;
}

/** 三态循环（IA §7.1：`Ctrl/Cmd + Shift + .`）。 */
export function cycleColorScheme(current: ColorSchemePreference): ColorSchemePreference {
  if (current === "auto") {
    return "light";
  }
  return current === "light" ? "dark" : "auto";
}
