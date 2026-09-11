/**
 * preload：把"版本戳读取"这一个能力经 contextBridge 暴露给渲染层。
 *
 * 渲染层保持 `contextIsolation: true` + `nodeIntegration: false` + `sandbox: true`：
 * 除本桥接外无任何 Node 能力。业务 IPC（聊天 / 工具 / 会话）由后续任务按同一模式扩展。
 *
 * 编译为 CJS：tsc 把 `preload.cts` 输出为 `dist/main/preload.cjs`。
 * 类型信息只做透传（值由主进程决定），避免在 preload 里复制 schema。
 */
import { contextBridge, ipcRenderer } from "electron";

/** 与 apps/desktop/src/renderer/env.d.ts 中的声明保持一致。 */
const BRIDGE = {
  getBuildInfo: (): Promise<unknown> => ipcRenderer.invoke("agentplant:build-info"),
};

contextBridge.exposeInMainWorld("agentplant", BRIDGE);
