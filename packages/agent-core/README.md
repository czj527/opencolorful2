# @agentplant/agent-core（M1）

> 角色：agent 主循环 + 最小工具集 + 记忆的**纯内核**，外加**治理内核的判定层**
> （完成判定 / 审计元数据）。落地口径见 `docs/decisions/t4-backend-architecture.md`
> （§4 治理内核、§5 工具运行时、§6 沙箱）与 `docs/design/ia-and-interaction.md`
> （§6.3「进度文本≠交付」）。

## 当前状态

已落定：

- `src/types.ts` —— 工具契约（`Tool` / `ToolContext` / `ToolResult`）与错误类型。
  失败一律 `throw`（`ToolInputError` 400 / `ToolAuthorizationError` 403），
  由运行时统一转 `tool_result error`（t4 §5）。
- `src/completion.ts` —— **完成判定**：`decideTurnDelivery`（claimed/verified）、
  `isTerminalStatus`（终态词表 task ∪ tool）、`PLAN_PATTERN_HINTS`（未来时表述清单）。
- `src/audit.ts` —— **审计元数据**：`buildAuditMeta`（metadata-only、超 2048 抛错不截断）、
  `AUDIT_KINDS`（t4 §4 冻结的 7 种 kind）、`PAYLOAD_META_MAX_CHARS`。
- `src/index.ts` —— 公开 barrel；`src/version.ts` —— `AGENT_CORE_VERSION`。

**未落定（后续任务）**：LLM 主循环（turn → tool_calls → 回写 → SSE 推送）、
7 个内置工具（`read_file`/`write_file`/`run_command`/`web_search`/`browse_page`/
`memory_write`/`memory_search`）、工具注册表、PathGuard、命令分类、secret redactor、
记忆读写、断线 abort 的消费端。

## 治理内核职责（t4 §4 四个不变量 → 本包落点）

| 不变量 | 本包（纯判定层） | 存储 / 运行侧 | 测试证据 |
|---|---|---|---|
| ① 终态不可降级 | `isTerminalStatus`（task ∪ tool 终态词表） | `state.shouldApplySessionStatus`（**唯一**写库门禁，拒绝即保留原值不抛错） | `src/completion.test.ts`；`apps/server/src/governance.test.ts`（真库 `archived→active` 拒绝） |
| ② CAS 领取 | 无（本包无状态，刻意不做） | `state.tryClaim` / `releaseClaim`（条件 UPDATE 即 CAS） | `apps/server/src/governance.test.ts`（双 claim 恰一成功、过期 reclaim） |
| ③ 进度文本≠交付 | `decideTurnDelivery`（有成功工具调用 **且** 有证据 → `verified`，否则 `claimed`）；`PLAN_PATTERN_HINTS` 只导出清单 | `apps/server` 的 `/api/chat` 调用点；前端只消费后端给的 `delivery`（t5 §6.3：UI 不做语义推断） | `src/completion.test.ts`；`apps/server/src/server.test.ts`（响应/SSE 的 delivery 与函数同源） |
| ④ 审计只记元数据 | `buildAuditMeta`（只含键名/计数/长度/布尔）、`PAYLOAD_META_MAX_CHARS` | `state.appendAudit` + DDL `CHECK (length(payload_meta)<=2048)`；server 侧先用**内存环形缓冲**过渡 | `src/audit.test.ts`；`apps/server/src/audit-buffer.test.ts` + `server.test.ts`（账本序列化后不含正文） |

要点：**本包只做纯判定，不写库、不看时钟、不解析文本**。"文本里有没有未来时表述"的匹配由
t15 主循环用 `PLAN_PATTERN_HINTS` 做，且**不得覆盖事实**——事实口径以 `decideTurnDelivery` 为准。

## 依赖纪律（硬约束）

- `packages/*` **禁止** import `apps/*`（t4 §1 依赖纪律）。
- 本包**只依赖 `@agentplant/protocol`**（纯 schema，无环）。**不依赖 `packages/state`**：
  state 是存储层（`node:sqlite`），依赖它会把纯函数内核污染成带 I/O 的内核
  （跨包复用断言因此放在 `apps/server` 的测试里，见上表）。
- 本包为纯函数内核：不做 I/O 直连、不持有全局单例；`ToolContext` 由调用方注入。
- 禁把进度文本（`progress`）送进模型上下文（t1-P0-3「进度文本≠交付」）。

## 命令

```bash
pnpm --filter @agentplant/agent-core run build      # tsc → dist/
pnpm --filter @agentplant/agent-core run typecheck  # tsc --noEmit
```
