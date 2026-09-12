# AgentPlant

> 单人自托管的私人 AI 助理——本地可跑、有记忆、能办事，网关与图形入口随身。
> （产品定位见 `docs/decisions/t2-positioning-mvp.md`，用户 2026-09-11 拍板）

**当前状态：M1 进行中。** 已落地：pnpm 同仓结构 + 类型契约 + CI 门禁（t3）、单进程
HTTP+SSE 服务骨架（t4 §2/§3）、SQLite 状态内核（t4 §4）、工具运行时初版（t14，见下）。
**尚未实现**：聊天主循环（工具调用与结果回写，t15）、真实 LLM provider 接线、桌面 UI。

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
scripts/check-tokens.mjs   # token 门禁（tokens.md ↔ tokens.css + 对比度 + 明暗完整）
packages/
  agent-core/              # M1: agent 主循环 + 最小工具集 + 记忆（纯内核）
  state/                   # M1: SQLite 单库状态内核（任务/会话/记忆同库，WAL）
  gateway-protocol/        # M2 预留：网关协议 types stub（二期启用，禁止提前实现）
  plugin-sdk/              # M2+ 预留：插件 SDK stub（二期启用，禁止提前实现）
apps/
  web/                     # M1 渲染层唯一真相源：三视图 + 检查器 + 设置（聊天 UI）
  desktop/                 # M1 入口：Electron 壳（复用 apps/web 的构建产物）
docs/decisions/            # t1/t2/t3/t4/t5/t7 决策记录（进仓）
docs/design/               # IA / tokens（t5）
```

`references/` 与 `.agent-teams/` **不进仓**（前者为本机对标源码，后者为 agent 编排状态）。

## 工具运行时（t14：M1-5 初版）

7 个内置工具（命名以 `packages/protocol/src/tools.ts` 的 `TOOL_NAMES` 为准，t5 §4.2 冻结；
t4 §5 表里的 `fs_read/fs_write/shell_exec/web_fetch/memory` 旧名**作废**）：

| 工具 | 做什么 | 关键约束 |
|---|---|---|
| `read_file` | 读工作区内文本文件（带行号） | 行窗口默认 2000 行 / 50KiB，返回 `truncated/totalLines/totalBytes` |
| `write_file` | 写 / 覆盖 / 追加 | `mode:"create"` 遇已存在**报错**；写后回读磁盘的 `lines/bytes/mtimeMs` |
| `run_command` | 跑真实命令 | 默认 10s 超时**真杀进程树**（Windows `taskkill /T /F`，POSIX 进程组）；输出保尾 50KiB；退出码原样返回 |
| `web_search` | 联网搜索 | **未配置 provider 时明确报错**（见下）；结果包不可信信封 |
| `browse_page` | 抓网页转文本 | SSRF 守卫默认开；重定向最多 3 跳且每跳都过守卫 |
| `memory_write` / `memory_search` | 记忆写入 / FTS5 检索 | 经 `packages/state` 的 DAO；未注入 DAO 时**明确报错** |

代码位置：`apps/server/src/tools/`（`types.ts` / `registry.ts` / `params.ts` / `builtin/` 一工具一文件）
+ `apps/server/src/policy/`（PathGuard、redactor）。接线方式（t15 主循环负责）：

```ts
import { createPathGuard, createRedactor, createCoreRegistry } from "@agentplant/server";
const guard = createPathGuard(process.cwd());
const services = { workspaceRoot: guard.workspaceRoot, guard, redactor: createRedactor() };
const tools = createCoreRegistry(services).resolve({ deny: [] });
```

**约定级约束（诚实标注）**：MVP 没有 OS 级沙箱，`workspace-only` 只是**约定级**约束，
不是安全边界——PathGuard 拦得住"工具按自己的参数读写文件"，拦不住"被执行的命令自己往
工作区外写"。硬保证只来自密钥源头纪律 + 日志 redactor（token/cookie/长随机串/
`C:\Users\<name>` → `[user]`，routes 的 500 兜底走同一脱敏器）。真正强制随二期 OS 沙箱
（seatbelt / landlock / job object）。命令风险分类 `classifyCommand`
（`safe/probe/mutation/dangerous/unknown`）**只做审批提示，不当拦截**：字符串查表能被
`bash -c`、变量拼接绕过，把它当门禁只会制造"我以为被拦住了"的错觉。

**`web_search` 未配置口径**：M1 没有真实搜索 key，未设置 `SEARCH_PROVIDER` + `SEARCH_API_KEY`
时该工具**抛参数错误并说明未配置**，绝不返回伪造结果（t7 FG-03）。

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
