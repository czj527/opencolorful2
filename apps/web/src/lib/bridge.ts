/**
 * desktop 壳桥接的类型声明（与 `apps/desktop/src/main/preload.cts` 的形状一致）。
 *
 * 纪律（t7 FG-05）：**禁止硬编码版本号**。纯 web 环境（无 `window.agentplant`）时
 * 必须走"版本信息不可用"的诚实分支，不得回退到任何字面版本。
 */
export interface BuildInfo {
  readonly version: string;
  readonly gitSha: string | null;
  readonly buildTime: string;
  readonly isReleaseVersion: boolean;
  readonly source: string;
  readonly node: string;
  readonly pnpm: string | null;
}

export type BuildInfoPayload =
  | {
      readonly available: true;
      readonly buildInfo: BuildInfo;
      readonly appVersion: string;
      readonly versionConsistent: boolean;
    }
  | { readonly available: false; readonly reason: string };

interface AgentPlantBridge {
  getBuildInfo(): Promise<BuildInfoPayload>;
}

declare global {
  interface Window {
    readonly agentplant?: AgentPlantBridge;
  }
}

/** 取桥接（不存在 = 纯 web 环境；调用方必须走诚实分支）。 */
export function bridge(): AgentPlantBridge | null {
  return typeof window === "undefined" ? null : window.agentplant ?? null;
}

/** 是否运行在 Electron 壳内（有 preload 桥接）。 */
export function hasBridge(): boolean {
  return bridge() !== null;
}

/** 读取版本戳：无桥接时返回 `null`（**不**返回任何编造的版本）。 */
export async function readBuildInfo(): Promise<BuildInfoPayload | null> {
  const api = bridge();
  if (api === null) {
    return null;
  }
  try {
    return await api.getBuildInfo();
  } catch (error) {
    return {
      available: false,
      reason: `读取构建信息失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
