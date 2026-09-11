# @agentplant/agent-core（M1）

> 角色：agent 主循环 + 最小工具集 + 记忆的**纯内核**。落地口径见
> `docs/decisions/t4-backend-architecture.md`（§5 工具运行时、§6 沙箱）与
> `docs/decisions/t2-positioning-mvp.md`（MVP 边界）。

## 当前状态：骨架（t3 落地，尚未实现业务逻辑）

本包当前**只有类型契约与常量**，没有主循环、没有工具实现、没有提示词、没有 provider
调用。真正的实现由 t4 分派的任务落地。

已落定：

- `src/types.ts` —— 工具契约（`Tool` / `ToolContext` / `ToolResult`）与错误类型。
  失败一律 `throw`（`ToolInputError` 400 / `ToolAuthorizationError` 403），
  由运行时统一转 `tool_result error`（t4 §5）。
- `src/index.ts` —— 公开 barrel。
- `src/version.ts` —— `AGENT_CORE_VERSION`。

**未落定（后续任务）**：主循环（turn → tool_calls → 回写 → SSE 推送）、
6 个内置工具（`fs_read`/`fs_write`/`shell_exec`/`web_fetch`/`web_search`/`memory`）、
工具注册表（`Map` + allow/deny）、PathGuard、命令分类、secret redactor、记忆读写、
断线 abort、完成判定（进度文本≠交付）。

## 依赖纪律（硬约束）

- `packages/*` **禁止** import `apps/*`（t4 §1 依赖纪律）。
- 本包为纯函数内核：不做 I/O 直连、不持有全局单例；`ToolContext` 由调用方注入。
- 禁把进度文本（`progress`）送进模型上下文（t1-P0-3「进度文本≠交付」）。

## 命令

```bash
pnpm --filter @agentplant/agent-core run build      # tsc → dist/
pnpm --filter @agentplant/agent-core run typecheck  # tsc --noEmit
```
