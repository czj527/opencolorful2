# AGENTS.md

给在本仓工作的 agent / 贡献者的操作说明。**先读本文件，再读 `docs/decisions/`。**

## 这是什么

单人自托管的私人 AI 助理（本地可跑、有记忆、能办事）。定位与 MVP 边界见
`docs/decisions/t2-positioning-mvp.md`。

**当前阶段：仓库与 CI 骨架（t3 已落地）。M1 业务逻辑尚未实现。**

## 命令（根目录）

```bash
corepack enable
pnpm install --frozen-lockfile   # CI 用同一命令；不要提交 lockfile 之外的变动
pnpm lint                        # eslint flat config（全仓）
pnpm typecheck                   # 全 workspace tsc --noEmit
pnpm test                        # vitest run
pnpm build                       # 全 workspace 真实构建产物（非 dev server）
pnpm check:ratchet               # 工程棘轮：LOC / lint suppression 只减不增
pnpm version:check               # 版本戳单一来源一致性（根 package.json）
pnpm verify:release dist/release/<version>   # 发布产物校验（t7 §1.1，本地验收用）
```

`pnpm check:ratchet` 因新增代码超限而红时：**先考虑删减**；确属有意上调，需在 PR 中单独
说明理由，再运行 `node scripts/check-ratchet.mjs --update` 更新基线文件。

## 硬约束（违反即打回）

1. **SQLite 是唯一运行时状态存储**（`packages/state`，单文件 WAL）。禁止引入 Redis/MQ/
   JSON 落盘等旁路；`*.sqlite`、`.env` 永不进仓。
2. **`packages/*` 禁止 import `apps/*`**；插件只能 import 公开 SDK barrel（t4 §1）。
3. **M2 目录禁止提前实现**：`packages/gateway-protocol`、`packages/plugin-sdk` 只留
   types stub + README 二期声明（t3 §1）。
4. **窄腰纪律**：新能力优先 skill / 插件 / MCP，最后才加核心 tool（t1-P2-14）。
5. **破坏性变更需声明迁移路径**：SQLite schema、config 形状的变更必须在 PR 描述中写明；
   schema 版本升级需**用户显式同意**，agent 不得自主升版本（t3 §2）。
6. **禁止假绿**：不得用 `pnpm dev` / 未打包 `electron .` / 硬编码版本号 / mock 回放充当
   "已发布、已通过"（t7 §1.2 FG-01…FG-07）。
7. **四个不变量**：终态不可降级、CAS 领取、进度文本≠交付、审计只记元数据（t4 §4）。

## 结构与产物契约（勿随意改）

| 项 | 路径 |
|---|---|
| 桌面主进程入口 | `apps/desktop/dist/main/main.cjs` |
| 桌面渲染层入口 | `apps/desktop/dist/renderer/index.html` |
| 版本戳（构建期注入） | `apps/desktop/dist/build-info.json`（单一来源 = 根 `package.json` version） |
| 发布产物 | `dist/release/<version>/`（含 `release-manifest.json` + `SHA256SUMS.txt`） |
| CI | `.github/workflows/ci.yml`（Node 22，唯一必需 workflow） |
| 棘轮基线 | `config/size-baseline.json` |

## 提交与分支

- 提交信息：Conventional Commits（`feat/fix/docs/chore`），squash 合入。
- `main` 唯一常驻分支，CI 全绿才合入；开发用 `feat/*` 短分支（t3 §2）。

## 文档地图

`design.md`（根基线：§2 架构 + §3 视觉，真相源见 `docs/design/`）→
`docs/decisions/t1`（对标）→ `t2`（定位/MVP）→ `t3`（仓库与 CI）→ `t4`（后端架构）→
`t5`（前端视觉）→ `t7`（验收门禁）；`docs/design/` 为 IA 与 tokens 规范。
`references/`（对标源码）与 `.agent-teams/`（编排状态）**仅本地**，不进仓。
