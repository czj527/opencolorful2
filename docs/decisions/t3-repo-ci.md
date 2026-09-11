# t3 仓库与 CI 规范（用户已拍板，captain 当面核实 2026-09-11：放行推仓）

> 输入：t2 拍板（私人助理 / 桌面优先 / TS 同仓 / SQLite 单库）。
> 对标：openclaw pnpm monorepo 形态；工程侧 ratchet 抄 openclaw/hanako（只减不增基线文件）。

## 1. 同仓结构（已落定：server+web 内核 + desktop 壳调和，captain 当面核实 2026-09-11）

```
/
  pnpm-workspace.yaml          # packages/*, apps/*
  package.json                 # root scripts: dev/build/lint/typecheck/test/ratchet
  tsconfig.base.json
  .github/workflows/ci.yml     # 唯一必需 workflow（lint→type→test→build）
  config/size-baseline.json    # 工程棘轮基线（只减不增）
  scripts/check-ratchet.mjs    # 棘轮检查脚本
  scripts/verify-release.mjs   # 发布产物校验（t7 §1.1）
  scripts/check-tokens.mjs     # 调用位已留，脚本本体 t5 落地
  packages/
    protocol/                  # 前后端共享 TypeBox schema（t4 纯度分层）
    agent-core/                # 纯函数：状态机门禁、截断、redaction、prompt 组装
    state/                     # SQLite 层（任务/会话/记忆同库，WAL）
    gateway-protocol/          # M2 预留：先 types stub，不实现
    plugin-sdk/                # M2+ 预留：先 stub，不实现
  apps/
    server/                    # 运行内核：单进程 HTTP+SSE（t4 §2）
    web/                       # 运行内核：本地 Web 聊天 UI（调试/次入口；desktop 壳复用其构建）
    desktop/                   # M1 主入口：Electron 壳（复用 web 构建 + 关于页版本戳）
  docs/decisions/              # 已有 t1/t2，本规范为 t3（保留并纳入版本管理）
```

约束：SQLite 为唯一运行时状态存储；`*.sqlite`、`.env` 永不进仓；
M2 目录只留 stub + README 说明二期启用，禁止提前实现。

## 2. 分支策略（单人轻量）

- `main` 唯一常驻分支，CI 全绿才合入；`feat/*` 短分支开发。
- 提交信息 Conventional Commits（`feat/fix/docs/chore`），squash 合并。
- 破坏性变更（SQLite schema、config 形状）必须在 PR 描述中声明迁移路径；
  schema 版本升级需用户显式同意（抄 openclaw：agent 不得自主升版本）。

## 3. CI 门禁（.github/workflows/ci.yml，Node 22）

顺序执行，任一失败即红：
1. `pnpm install --frozen-lockfile`
2. `pnpm lint`（eslint flat，全仓）
3. `pnpm typecheck`（tsc --noEmit 全 workspace）
4. `pnpm test`（vitest run）
5. `pnpm build`（全 workspace 真实构建产物）
6. `pnpm check:ratchet`（见 §5）

`main` 分支保护：要求 ci 全绿；暂不要求 review（单人），M2 有外部贡献者再加。

## 4. 发布流程（本地优先）

- 版本号 `YYYY.M.PATCH`（跟随 openclaw 风格，月度序列）。
- MVP 发布 = `pnpm build` 真实产物 + `scripts/smoke.mjs` 本地冒烟（启动→聊天一轮→记忆写入→重启不丢）。
- GitHub Release：tag 推送触发打包 desktop 安装包（M1 可先只做 tag + 产物归档，安装器签名后补）。
- t7 验收直接消费本流程（防假绿）。

## 5. 工程棘轮（防退化，抄 t1 清单 #13）

- `config/size-baseline.json`：记录每包 LOC 上限与 lint suppression 数量，
  CI 只允许减少、不允许增加；有意上调需单独说明并更新基线文件。
- `scripts/check-ratchet.mjs`：对比基线，超限即失败并提示更新命令。
- 二期可加：config surface 计数、SDK 声明体积预算（抄 openclaw）。

## 6. 落地任务（派给子 agent，分两阶段：先本地 scaffold+验证，推仓待用户当面确认后放行）

本地阶段（现行）：
1. `git init` + 本地提交（含现有 `docs/`；`references/`、`.agent-teams/`
   仅本地参考，**不进仓**：加入 `.gitignore`）。
2. 按 §1 建 pnpm 同仓骨架（含 M2 stub + README 二期声明）+ 根脚本占位。
3. 写 `.github/workflows/ci.yml`（§3）+ `scripts/check-ratchet.mjs` + 基线初值。
4. 落地 `scripts/verify-release.mjs`（t7 §1.1：校验 P1–P4、sha256、版本戳四方一致，
   输出 `VERIFY-OK <version> <gitSha>` 或非 0 退出；根 `package.json` 加
   `verify:release` 脚本；CI 中仅 `node --check` + `--self-test` fixture 自检，
   真实目录校验留 t7 本地验收）。
5. 预留 `scripts/check-tokens.mjs` 的 CI 调用位（t5：解析 token 源文件复核对比度+
   引用完整性，与 `pnpm test` 同级门禁；脚本本体 t5 落地，t3 只留调用位与门禁顺序声明）。
6. 版本戳注入机制：单一版本源（根 `package.json` version）→ 构建时注入
   `apps/desktop` 关于页/`app.getVersion()` 显示（t7 P2 四方一致待验；骨架阶段
   无真实来源时明确报错，禁止硬编码通过）。
7. 本地验证：`pnpm install` + lint/typecheck/test/build/ratchet 自检全绿。

推仓阶段（待用户当面确认后放行，captain 指令为准）：
8. `gh repo create <name> --<visibility> --source=. --push`。
9. 开 `main` 分支保护（要求 ci 全绿）。
10. 回报：仓库 URL、首个 CI 运行链接、本地验证结果、可执行证据。

## 7. 用户拍板结果（captain 当面核实，2026-09-11：推仓放行）

- 仓库：`czj527/opencolorful2`，私有，MIT。
- 同仓口径：server+web 内核 + desktop 壳调和（§1/§8 落定）；packages 按 t4
  纯度分层（protocol/agent-core），领域划分作废。
- 品牌色：未二选一，要求先参考 kimi code web 极简优雅实用风（已转 frontend-visual，
  t3 按青蓝默认继续，不阻塞）。
- MVP 时间盒：不设。

## 8. 与 t4 §1 的同仓结构差异（已落定 2026-09-11）

| 维度 | 落定口径 |
|---|---|
| 应用入口 | `apps/server` + `apps/web` 为运行内核（HTTP+SSE）；`apps/desktop` 为 Electron 壳（复用 web 构建） |
| packages 划分 | 按 t4 纯度分层：`protocol`（共享 schema）/ `agent-core`（纯函数）；`state` 为 SQLite 层；原领域划分作废 |
| 插件目录 | `plugins/*` M2 启用（t4 §1），t3 骨架不建目录，仅 stub 包占位 |

本地骨架已按此建成（desktop/server/web/protocol 均就位），无分叉。
