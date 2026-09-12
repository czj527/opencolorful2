/**
 * Electron 主进程（M1 壳 + 版本戳注入的消费端）。
 *
 * 只做两件事：开一个窗口加载**构建产物**、把构建期注入的版本戳经 IPC 交给渲染层。
 * 渲染层（聊天 / 工具 / 记忆 / 任务 / 设置）**不在本包**：
 * SoT 是 `apps/web`，其构建产物由 `scripts/copy-assets.mjs` 拷入 `dist/renderer/`。
 *
 * ⚠️ 文件必须是 `.cts`（不是 `.ts`）：tsc 只把 `.cts` 输出为 `.cjs`；而本包
 * `package.json` 是 `type: module`，若编译出 `.js` 会被 Electron 当 ESM 加载
 * （Electron 33 不支持 ESM 主进程入口）→ 启动即失败。产物路径契约见下方常量。
 *
 * 产物路径契约（勿改，t7 会按此断言）：
 *   apps/desktop/dist/main/main.cjs      ← 本文件
 *   apps/desktop/dist/main/preload.cjs   ← src/main/preload.cts
 *   apps/desktop/dist/renderer/index.html
 *   apps/desktop/dist/build-info.json
 *
 * 版本戳纪律（t3 §6-6 / t7 P2）：版本只来自 `dist/build-info.json`（构建期由根
 * package.json 注入）。**禁止**在本文件或渲染层硬编码版本号（t7 FG-05）；构建信息缺失
 * 时必须显式报错，而不是回退到假版本。
 */
import { app, BrowserWindow, ipcMain } from "electron";
import { readFileSync } from "node:fs";
import path from "node:path";

const RENDERER_HTML = path.join(__dirname, "..", "renderer", "index.html");
const PRELOAD = path.join(__dirname, "preload.cjs");
const BUILD_INFO_PATH = path.join(__dirname, "..", "build-info.json");

/** 构建期注入的版本戳（形状由 apps/desktop/scripts/gen-build-info.mjs 定义）。 */
interface BuildInfo {
  version: string;
  gitSha: string | null;
  buildTime: string;
  isReleaseVersion: boolean;
  source: string;
  node: string;
  pnpm: string | null;
}

/** 交给渲染层的载荷：可用时给出"应用内显示"的两个来源。 */
type BuildInfoPayload =
  | { available: true; buildInfo: BuildInfo; appVersion: string; versionConsistent: boolean }
  | { available: false; reason: string };

function readBuildInfo(): BuildInfo | null {
  try {
    return JSON.parse(readFileSync(BUILD_INFO_PATH, "utf8")) as BuildInfo;
  } catch {
    return null;
  }
}

function buildInfoPayload(): BuildInfoPayload {
  const buildInfo = readBuildInfo();
  if (buildInfo === null) {
    // 明确报错，不编造版本（t7 FG-05：禁止硬编码版本号冒充来源）。
    process.stderr.write(
      `[agentplant] 版本戳来源缺失：${BUILD_INFO_PATH}\n` +
        "  → 请先执行 `pnpm build`（apps/desktop 构建期会注入 build-info.json）。\n",
    );
    return { available: false, reason: "build-info.json 缺失（未构建或构建产物被删除）" };
  }
  const appVersion = app.getVersion();
  return {
    available: true,
    buildInfo,
    appVersion,
    versionConsistent: appVersion === buildInfo.version,
  };
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    // 窗口规格（ia-and-interaction.md §1.1）：默认 1280×840，最小可用宽 `--ap-breakpoint-compact` = 1024。
    width: 1280,
    height: 840,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: "AgentPlant",
    // 首帧背景：**与 `--ap-surface-0`（`--ap-paper-200`）同值**。这是 Electron 的窗口属性，
    // 无法在渲染层之前读 CSS 变量，故以字面值给出，并在注释里钉住"与哪个 token 同值"。
    // `scripts/check-tokens.mjs` 的"禁裸 hex"门禁不含主进程 .cts（它只扫渲染层源码与产物 CSS/HTML/JS），
    // 靠这条注释保持同步：token 改值时此值必须同步改。
    backgroundColor: "#F5EFE4",
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once("ready-to-show", () => {
    win.show();
  });

  void win.loadFile(RENDERER_HTML);
  return win;
}

ipcMain.handle("agentplant:build-info", () => buildInfoPayload());

void app.whenReady().then(() => {
  const payload = buildInfoPayload();
  if (payload.available && !payload.versionConsistent) {
    process.stderr.write(
      `[agentplant] 版本戳不一致：app.getVersion()=${payload.appVersion} ` +
        `vs build-info.version=${payload.buildInfo.version}\n` +
        "  → 运行 `node scripts/sync-version.mjs` 后重新构建（t7 P2 四方一致）。\n",
    );
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
