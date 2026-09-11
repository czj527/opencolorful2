/**
 * Electron 主进程（M1 最小占位 + 版本戳注入的消费端）。
 *
 * 只做两件事：开一个窗口加载**构建产物**、把构建期注入的版本戳经 IPC 交给渲染层。
 * 聊天主循环 / 工具 / 记忆 / SQLite / P0 治理由后续任务落地，**本文件不实现业务逻辑**。
 *
 * 产物路径契约（勿改，t7 会按此断言）：
 *   apps/desktop/dist/main/main.cjs
 *   apps/desktop/dist/main/preload.cjs
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

/** 交给渲染层的载荷：可用时给出四方一致中的"应用内显示"两个来源。 */
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
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: "AgentPlant",
    backgroundColor: "#f7f7f8",
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
