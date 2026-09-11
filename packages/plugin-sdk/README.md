# @agentplant/plugin-sdk（M2+ 预留 stub —— 二期启用）

**本包在 M1 不实现任何功能，只有 types stub。禁止提前实现。**

依据：

- `docs/decisions/t3-repo-ci.md` §1：M2 目录只留 stub + README 说明二期启用，
  禁止提前实现。
- `docs/decisions/t2-positioning-mvp.md` §2：插件市场/生态放在二期；
  M1 只用编译期注册表（`t4 §7-4`）。
- 窄腰纪律（t1-P2-14）：新能力优先 skill/插件/MCP，最后才加核心 tool——
  这条纪律恰好**要求**插件层二期再做，避免 MVP 期就把核心 tool 面撑大。

## 现在有什么

- `src/types.ts`：`PluginManifest`、`PluginRegistration` 类型词汇 +
  `PluginSdkNotImplementedError`（调用即抛的哨兵）。
- `src/index.ts`：barrel（只导出类型与上述错误）。

## 明确不做（二期才做）

- manifest-first 发现与校验、安装索引、信任审批、插件加载与沙箱、插件市场、
  `plugins/*` 目录与 SDK barrel 的 import-boundary 约束执行。

## 二期落地时的入口

`docs/decisions/t4-backend-architecture.md` §7-4（插件体系）。

## 命令

```bash
pnpm --filter @agentplant/plugin-sdk run build      # tsc → dist/
pnpm --filter @agentplant/plugin-sdk run typecheck  # tsc --noEmit
```
