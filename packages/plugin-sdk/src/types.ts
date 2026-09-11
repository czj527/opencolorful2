/**
 * @agentplant/plugin-sdk —— **M2+ 预留 stub（二期启用）**。
 *
 * 本文件只声明插件作者可见的**类型词汇**，不含任何实现、不含运行时依赖。
 * 依据 `docs/decisions/t3-repo-ci.md` §1（M2 目录只留 stub + README，禁止提前实现）。
 *
 * ⚠️ 落地纪律：MVP（M1）只用**编译期注册表**（t4 §7-4）；插件体系到 M2 按
 * manifest-first 落地（`openclaw.plugin.json` 式发现与校验不执行代码 + 安装索引 +
 * 信任审批）。窄腰纪律（t1-P2-14）：新能力优先 skill/插件/MCP，最后才加核心 tool。
 */

/** 插件清单：发现与校验阶段**不执行插件代码**（t4 §7-4）。 */
export interface PluginManifest {
  /** 插件名（全局唯一，安装索引主键）。 */
  readonly name: string;
  /** 语义化版本。 */
  readonly version: string;
  /** 本插件提供的工具名列表（校验阶段只读字符串，不加载实现）。 */
  readonly tools?: readonly string[];
  /** 兼容的宿主 SDK 版本范围。 */
  readonly engines?: { readonly agentplant?: string };
}

/** 插件声明式注册项：MVP 不做，二期 SDK 落地时定形。 */
export interface PluginRegistration {
  readonly manifest: PluginManifest;
  /** 插件根目录（用于 allowlist 与完整性校验）。 */
  readonly root: string;
}

/** 二期未实现标记：调用即抛，防止 stub 被误当作可用实现。 */
export class PluginSdkNotImplementedError extends Error {
  readonly kind = "m2_not_implemented";
  constructor(readonly feature: string) {
    super(`${feature} 属于 M2+（插件体系），当前为 stub：见 packages/plugin-sdk/README.md`);
    this.name = "PluginSdkNotImplementedError";
  }
}
