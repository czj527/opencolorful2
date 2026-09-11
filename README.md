# AgentPlant

> 单人自托管的私人 AI 助理——本地可跑、有记忆、能办事，网关与图形入口随身。
> （产品定位见 `docs/decisions/t2-positioning-mvp.md`，用户 2026-09-11 拍板）

**当前状态：仓库与 CI 骨架（M1 尚未实现）。** 本仓现在只有 pnpm 同仓结构、类型契约
与 CI 门禁；聊天主循环、工具、记忆、SQLite 内核、桌面 UI 均**未实现**。

## 快速开始

前置：Node 22（本仓 CI 用 22）、corepack 启用的 pnpm、git。

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build          # 全 workspace 真实构建产物（非 dev server）
pnpm test           # vitest run
pnpm lint           # eslint（flat config）
pnpm typecheck      # tsc --noEmit（全 workspace）
pnpm check:ratchet  # 工程棘轮：LOC / lint suppression 只减不增
```

## 仓库结构

```
pnpm-workspace.yaml        # packages/*, apps/*
package.json               # 根脚本：dev/build/lint/typecheck/test/check:ratchet
tsconfig.base.json         # 共享 TS 基线
eslint.config.mjs          # eslint flat config（全仓）
vitest.config.ts           # 测试入口
.github/workflows/ci.yml   # 唯一必需 workflow（Node 22）
config/size-baseline.json  # 工程棘轮基线（只减不增）
scripts/check-ratchet.mjs  # 棘轮检查脚本
packages/
  agent-core/              # M1: agent 主循环 + 最小工具集 + 记忆（纯内核）
  state/                   # M1: SQLite 单库状态内核（任务/会话/记忆同库，WAL）
  gateway-protocol/        # M2 预留：网关协议 types stub（二期启用，禁止提前实现）
  plugin-sdk/              # M2+ 预留：插件 SDK stub（二期启用，禁止提前实现）
apps/
  desktop/                 # M1 入口：Electron + renderer（桌面优先）
docs/decisions/            # t1/t2/t3/t4/t5/t7 决策记录（进仓）
docs/design/               # IA / tokens（t5）
```

`references/` 与 `.agent-teams/` **不进仓**（前者为本机对标源码，后者为 agent 编排状态）。

## 工程纪律（硬约束）

- **SQLite 是唯一运行时状态存储**（无 Redis/MQ）；`*.sqlite`、`.env` 永不进仓。
- `packages/*` 禁止 import `apps/*`；窄腰纪律：新能力先 skill/插件/MCP，最后才加核心 tool。
- 破坏性变更（SQLite schema、config 形状）必须在 PR 描述中声明迁移路径；
  schema 版本升级需用户显式同意。
- 提交信息用 Conventional Commits；`main` 只接受 CI 全绿的合入。

## 文档

| 文档 | 内容 |
|---|---|
| `docs/decisions/t1-reference-benchmark.md` | 对标结论（openclaw / hermes / openhanako） |
| `docs/decisions/t2-positioning-mvp.md` | 定位与 MVP 边界（已拍板） |
| `docs/decisions/t3-repo-ci.md` | 仓库、CI、发布流程规范 |
| `docs/decisions/t4-backend-architecture.md` | 后端架构与模块划分 |
| `docs/decisions/t5-frontend-visual-design.md` | 前端视觉与交互 |
| `docs/decisions/t7-acceptance-gates.md` / `t7-click-paths.md` | 验收门禁与点击链路 |

## License

MIT（见 `LICENSE`）。
