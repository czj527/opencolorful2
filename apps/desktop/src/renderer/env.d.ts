/**
 * 渲染层环境声明：preload 桥接的全局类型（由 apps/desktop/src/main/preload.cts 注入）。
 *
 * 骨架期只有"版本戳读取"一个能力；聊天 / 工具 / 会话等 IPC 由后续任务按同一模式追加。
 */
export {};

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

/** 主进程回给渲染层的载荷；不可用时必须显式给 reason（禁止假版本，t7 FG-05）。 */
type BuildInfoPayload =
  | { available: true; buildInfo: BuildInfo; appVersion: string; versionConsistent: boolean }
  | { available: false; reason: string };

declare global {
  interface Window {
    /** 未注入时为 undefined：渲染层必须显式提示，不得回退到硬编码版本。 */
    agentplant?: {
      getBuildInfo(): Promise<BuildInfoPayload>;
    };
  }
}
