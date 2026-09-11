# @agentplant/desktop（M1 入口 —— 桌面优先）

> 用户 2026-09-11 拍板：**桌面优先**（t2 §5-2），Electron 桌面端在 MVP 范围内
> （`docs/decisions/t3-repo-ci.md` §1、`docs/decisions/t5-frontend-visual-design.md` A6）。
> 本包即 M1 的唯一用户入口。

## 当前状态：最小 Electron 占位（t3 落地，尚未实现业务逻辑）

**已落定（骨架）**：

- `src/main/main.ts` —— 开窗 + `loadFile(dist/renderer/index.html)` + `ready-to-show`
  再显示（避免白屏闪烁）；`contextIsolation: true` / `nodeIntegration: false` /
  `sandbox: true`。
- `src/renderer/main.ts` —— 渲染层最小占位（只显示"构建产物已加载"，无业务）。
- `src/index.html` —— HTML 契约占位（`#app` 挂载点 + `./styles/tokens.css`）+
  严格 CSP（`default-src 'none'`，脚本/样式仅 `'self'`）。
- `src/styles/tokens.css` —— token **层占位**：落地路径按
  `docs/design/tokens.md` §7.2 与 `docs/design/ia-and-interaction.md` 文首约定；
  完整 token 表 + `scripts/check-tokens.mjs` 由 t5 规范驱动落地。
- `scripts/copy-assets.mjs` —— 把 HTML/CSS 拷贝进 `dist/`，保证构建产物可运行。

**未落定（后续任务）**：聊天主循环 UI、消息流（SSE 消费）、工具卡、任务轻量列表、
记忆视图、关于页、preload + contextBridge、IPC 契约、electron-builder 打包与
`dist/release/<version>/` 产物清单（t7 §4 发布口径）。

## 产物路径契约（t7 会按此断言，勿随意改）

| 产物 | 路径 |
|---|---|
| 主进程入口 | `apps/desktop/dist/main/main.cjs` |
| 渲染层入口 | `apps/desktop/dist/renderer/index.html` |
| 发布产物 | `dist/release/<version>/`（由后续发布任务实现） |

## 命令

```bash
pnpm --filter @agentplant/desktop run build      # tsc（main+renderer）+ 拷贝静态资源
pnpm --filter @agentplant/desktop run typecheck  # tsc --noEmit（两份 tsconfig）
pnpm --filter @agentplant/desktop run start      # electron .（需先 build）
```

> 注意：`pnpm dev` / 未打包 `electron .` **不算**"发布可跑"——t7 FG-01/FG-02
> 明确把 dev-only 演示判为假绿。M1 骨架阶段只保证 `pnpm build` 产出真实产物。
