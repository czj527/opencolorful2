# @agentplant/gateway-protocol（M2 预留 stub —— 二期启用）

**本包在 M1 不实现任何功能，只有 types stub。禁止提前实现。**

依据：

- `docs/decisions/t3-repo-ci.md` §1：M2 目录只留 stub + README 说明二期启用，
  禁止提前实现。
- `docs/decisions/t2-positioning-mvp.md` §2：网关（多渠道消息接入：
  Telegram/飞书/QQ/微信等）明确列为 Out of scope（二期）。
- `docs/decisions/t2-positioning-mvp.md` §5-5 / `t4 §7-1`：M2 顺序为
  **先网关（1–2 个渠道），再多 Agent**；网关层"别提前抽接口"（很贵）。

## 现在有什么

- `src/types.ts`：`ChannelKind`、`InboundEvent`、`OutboundMessage`、
  `AllowlistDecision` 类型词汇 + `GatewayNotImplementedError`（调用即抛的哨兵）。
- `src/index.ts`：barrel（只导出类型与上述错误）。

## 明确不做（二期才做）

- 渠道适配器实现（Telegram/飞书/…）、轮询/webhook 接入、去重存储、allowlist 实现、
  turn 编排、网关加固（设备配对 / 细粒度 scopes / controlPlaneWrite 预算 / TLS / 优雅重启）。

## 二期落地时的入口

`docs/decisions/t4-backend-architecture.md` §7-1（channel 抽象 + 1–2 渠道插件）、§7-6（加固）。

## 命令

```bash
pnpm --filter @agentplant/gateway-protocol run build      # tsc → dist/
pnpm --filter @agentplant/gateway-protocol run typecheck  # tsc --noEmit
```
