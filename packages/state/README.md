# @agentplant/state（M1）

> 角色：**唯一**运行时状态存储——SQLite 单文件（WAL），任务/会话/记忆同库。
> 落地口径见 `docs/decisions/t4-backend-architecture.md` §4 与
> `docs/decisions/t2-positioning-mvp.md`（§2-4 状态内核、§2-5 P0 治理）。

## 当前状态：骨架（t3 落地，尚未实现业务逻辑）

本包当前**只有类型与常量**，没有连接、没有迁移、没有 DAO。真正的实现由后续
分派任务落地（t7 归属表：`packages/state/**` 由 t5/t4 提供口径）。

已落定：

- `src/types.ts` —— `STATE_DB_FILENAME`、`SCHEMA_VERSION = 1`、状态/记忆类型词表、
  `TaskClaim`、`StatusUpdateDecision`。
- `src/index.ts` —— 公开 barrel。

**未落定（后续任务）**：`node:sqlite`（`DatabaseSync`）连接与 SQLite 版本安全线校验、
pragma 顺序（busy_timeout → WAL → autocheckpoint → journal_size_limit →
synchronous=NORMAL → foreign_keys=ON）、5 表迁移（`schema_migrations`/`sessions`/
`messages`/`memories`/`audit_events`）+ FTS5、DAO、治理内核
（终态不可降级门禁 `shouldApplyStatusUpdate`、单 Agent run 占位 CAS、audit 只记元数据）。

## 硬约束

- **SQLite 是唯一运行时状态存储**：禁止引入 Redis/MQ/JSON 落盘旁路（t7 会断言同库）。
- `*.sqlite`、`*.sqlite-wal`、`*.sqlite-shm`、`.env` **永不进仓**（t3 §1 约束）。
- schema 版本升级 = 破坏性变更：需用户显式同意 + PR 声明迁移路径（t3 §2）。

## 命令

```bash
pnpm --filter @agentplant/state run build      # tsc → dist/
pnpm --filter @agentplant/state run typecheck  # tsc --noEmit
```
