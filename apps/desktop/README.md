# @agentplant/desktop（M1 入口 —— 桌面优先）

> 用户 2026-09-11 拍板：**桌面优先**（t2 §5-2），Electron 桌面端在 MVP 范围内
> （`docs/decisions/t3-repo-ci.md` §1、`docs/decisions/t5-frontend-visual-design.md` A6）。
> 本包即 M1 的唯一用户入口。

## 本包只剩"壳"：渲染层复用 `apps/web` 的构建产物（t21 起）

**口径统一**：渲染层唯一真相源（SoT）是 **`apps/web`**；本包只保留 Electron 特有部分——
主进程、preload 桥接、以及 `src/index.html` 这份 **CSP + `loadFile` 目标**。
`scripts/copy-assets.mjs` 会把 `apps/web/dist` 的产物（`main.js` + 拆分模块 + `styles/`）
原样拷进 `dist/renderer/`，**不在本包复制任何渲染源码**。

原占位物已删除：`src/renderer/main.ts`、`src/renderer/env.d.ts`、`src/styles/tokens.css`、
`tsconfig.renderer.json`（token 层与视图层都归 `apps/web`）。

**本包内容**：

- `src/main/main.cts` —— 开窗 + `loadFile(dist/renderer/index.html)` + `ready-to-show` 再显示
  （避免白屏闪烁）；`contextIsolation: true` / `nodeIntegration: false` / `sandbox: true`；
  窗口 1280×840、最小 1024×640（IA §1.1）；`backgroundColor` 取 `--ap-surface-0` 同值。
- `src/main/preload.cts` —— `contextBridge` 暴露 `window.agentplant.getBuildInfo()`（版本戳读取）。
- `src/index.html` —— 与 `apps/web/src/index.html` 结构逐字一致，仅 CSP 与 `<title>` 不同；
  `copy-assets.mjs` 会逐片段校验，漂移即构建失败。
- `scripts/clean.mjs` / `scripts/copy-assets.mjs` / `scripts/gen-build-info.mjs` —— 清产物、
  复用 web 产物、注入版本戳。
- `tsconfig.main.json` —— 只编译 `src/main/**/*.cts`（Electron 主进程为 CJS）。

## 产物路径契约（t7 会按此断言，勿随意改）

| 产物 | 路径 |
|---|---|
| 主进程入口 | `apps/desktop/dist/main/main.cjs` |
| preload | `apps/desktop/dist/main/preload.cjs` |
| 渲染层入口 | `apps/desktop/dist/renderer/index.html` |
| 渲染层脚本 | `apps/desktop/dist/renderer/main.js`（+ 同目录模块） |
| 渲染层样式 | `apps/desktop/dist/renderer/styles/tokens.css`（`app.css`、`theme-init.js` 同目录） |
| 版本戳 | `apps/desktop/dist/build-info.json`（单一来源 = 根 `package.json` version） |
| 发布产物 | `dist/release/<version>/`（由后续发布任务实现） |

## CSP

`connect-src` 只放开本地 server：`http://127.0.0.1:43121 ws://127.0.0.1:43121`
（`apps/server` 默认 `PORT=43121`；`ws://` 为二期预留——M1 用 fetch + ReadableStream 读 SSE）。
其余保持最严：`default-src 'none'`、无远程脚本/样式/字体/frame、`object-src 'none'`、
`base-uri 'none'`、`form-action 'none'`。`script-src`/`style-src`/`img-src` 含 `file:`
是因为本页经 `loadFile` 以 file:// 加载，Chromium 对 file 文档的 `'self'` 匹配不可靠；
改自定义协议或 packaged app 的 `app://` 后可去掉（收紧时机见本文件末）。

## 命令

```bash
pnpm --filter @agentplant/web run build          # 先出渲染层产物（根 build 链已保证顺序）
pnpm --filter @agentplant/desktop run build      # clean + tsc(main) + 复用 web 产物 + 版本戳
pnpm --filter @agentplant/desktop run typecheck  # tsc --noEmit（tsconfig.main.json）
pnpm --filter @agentplant/desktop run start      # electron .（需先 build）
```

> 注意：`pnpm dev` / 未打包 `electron .` **不算**"发布可跑"——t7 FG-01/FG-02
> 明确把 dev-only 演示判为假绿。`pnpm build` 产出的是**真实产物**：
> 主进程从 `dist/renderer/index.html` 加载渲染层，渲染层脚本/样式均来自 `apps/web/dist`。
