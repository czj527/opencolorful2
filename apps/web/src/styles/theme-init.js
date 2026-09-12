/**
 * 首帧主题解析（tokens.md §7.4）：在任何样式生效前把 data-theme / data-motion 写到 <html>。
 *
 * 与 tokens.md §7.4 的内联脚本**行为一致**，只是搬到了外部文件（CSP 更严，无 'unsafe-inline'）。
 * 契约：`data-theme` 只写解析后的具体值（'light' | 'dark'），永不写 'auto'；
 * localStorage 不可用时**保留 HTML 上的字面兜底值（浅色）**，不猜测、不报错。
 *
 * 该文件是**构建产物的一部分**（拷入 dist/styles/），不是源文件的"示例"。
 */
const STORAGE_KEY = "ap.colorScheme";
const MOTION_KEY = "ap.motion";
const root = document.documentElement;

try {
  const pref = localStorage.getItem(STORAGE_KEY) ?? "auto";
  const resolved =
    pref === "auto"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : pref === "dark"
        ? "dark"
        : "light";
  root.setAttribute("data-theme", resolved);
  root.setAttribute(
    "data-motion",
    localStorage.getItem(MOTION_KEY) === "reduced" ? "reduced" : "full",
  );
} catch {
  // localStorage 不可用（隐私模式等）：保留 HTML 字面兜底（浅色 + full）。
}
