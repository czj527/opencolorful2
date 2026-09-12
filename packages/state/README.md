# @agentplant/state（M1-3 已落地）

> 角色：**唯一**运行时状态存储——SQLite 单文件（WAL），任务/会话/记忆同库。
> 落地口径见 `docs/decisions/t4-backend-architecture.md` §4 与
> `docs/decisions/t2-positioning-mvp.md`（§2-4 状态内核、§2-5 P0 治理）。

## 模块职责

| 文件 | 职责 |
|---|---|
| `types.ts` | 跨包类型契约与常量（`SCHEMA_VERSION`、状态/记忆词表）；**名称已冻结** |
| `db.ts` | `node:sqlite` 连接、版本安全线、pragma 顺序、事务助手、时间口径（unix 秒） |
| `migrate.ts` | `schema_migrations` 记账 + 幂等迁移；v1 = t4 §4 DDL 逐字 + FTS5 + 同步 triggers，v2 = sessions 终态禁回退触发器 |
| `rows.ts` | 库行（snake_case）→ TS 记录（camelCase）映射，含运行时类型守卫 |
| `dao.ts` | 5 张表的同步 DAO 工厂 `createStateDao(db)`（sessions / messages / memories / audit） |
| `governance.ts` | 终态门禁 `shouldApplySessionStatus` + CAS 原语 `tryClaim` / `releaseClaim` |
| `test-support.ts` | 测试脚手架：`os.tmpdir()` 下建真实库文件（测试专用，不进产品路径） |

## 关键口径（t4 §4）

- **零新增依赖**：只用 Node 内置 `node:sqlite`（`DatabaseSync` 同步 API）+ `node:crypto`
  / `node:fs`（仅测试）。没有 Kysely/better-sqlite3，没有第三方驱动。
- **版本安全线**：`openDatabase()` 先在 `:memory:` 查 `sqlite_version()`，低于 `3.44.6`
  **拒绝打开**（上游 WAL-reset 损坏 bug）；`isSqliteVersionSupported` 是纯函数，读不懂的
  版本号 fail-closed。
- **pragma 顺序即契约**：busy_timeout(5000) → `journal_mode=WAL` → `wal_autocheckpoint=1000`
  → `journal_size_limit=64MiB` → `synchronous=NORMAL` → `foreign_keys=ON`；设置后回读
  `journal_mode`，不是 `wal` 直接抛错（NFS/SMB/FUSE 上拒绝 WAL）。
- **时间戳统一 `INTEGER` unix epoch seconds**；`applied_at` / `created_at` / `ts` 全是秒。
- **迁移幂等**：重跑不报错、不重复记账；已记账版本的 SQL 被改动（checksum 不一致）抛错。
  **只追加**：v1 初始建表、v2 `sessions` 终态禁回退触发器；v1 老库直接 `migrate()` 自动补 v2
  （无需重建库、数据不丢）。`SCHEMA_VERSION = 2` 属**升版**：需用户显式同意（t3 §2）。
- **不变量**：终态不可降级（`archived` 只能归档、**无 unarchive API**；应用层门禁
  `shouldApplySessionStatus` 是第一道防线，DB 层 `sessions_no_status_regression` 触发器是
  第二道——原始 SQL 回退 `archived → 非 archived` 直接 ABORT，行不变）、CAS 领取
  （条件 UPDATE，`changes != 1` 即抢输）、审计只记元数据（`payloadMeta > 2048` 字符
  **直接抛错不截断**）。
- **FTS5**：`memories_fts` 外部内容表 + insert/delete/update 三个触发器同步，DAO 不手写
  FTS 维护语句；查询整体加引号做短语查询，用户输入的 `"` / `*` 不会变成语法错误。

## 已知边界（诚实记录，不是"待定"）

1. `tokenize='unicode61'`（t4 §4 的 FTS5 默认值，本次显式写出）：中文连续文本会被切成
   **一个整体 token**，因此**中文子串检索命中率低**（整串可命中，`深烘` 命不中 `喜欢深烘咖啡`）。
   二期换 trigram tokenizer 或加 LIKE 兜底。
2. CAS 原语是**表无关**的（表名/列名为入参）；M1 **不往 MVP 表加 `claim_*` 列**，
   M2 `tasks` 表按同形状复用，故本次用独立测试表验证语义。
3. `tryClaim` 的第 7 个形参 `now`（可选）是可注入时钟，用于确定性测试过期/reclaim 分支。

## 硬约束

- **SQLite 是唯一运行时状态存储**：禁止 Redis/MQ/JSON 落盘旁路
  （`src/purity.test.ts` 直接把这条约束读源码断言，防回归）。
- `packages/*` 不 import `apps/*`（同上有测试兜底）。
- `*.sqlite`、`*.sqlite-wal`、`*.sqlite-shm`、`.env` **永不进仓**：测试库一律建在
  `os.tmpdir()`，跑完删目录。
- schema 版本升级 = 破坏性变更：需用户显式同意 + PR 声明迁移路径（t3 §2）。

## 命令与测试

```bash
pnpm --filter @agentplant/state run build      # tsc → dist/
pnpm --filter @agentplant/state run typecheck  # tsc --noEmit
pnpm vitest run packages/state                 # 50 个用例（真实 sqlite 文件 + 纯函数分支）
```

测试分层：`db.test.ts`（连接/pragma/版本门禁）、`migrate.test.ts`（DDL/幂等/CHECK + v2 终态禁回退
触发器：原始 SQL 回退抛错且行不变、v1 老库升版不丢数据）、`dao.test.ts`（4 组 DAO 语义 +
库层第二道防线）、`governance.test.ts`（门禁 + CAS）、`purity.test.ts`（旁路/分层/同步纪律）。

> 测试侧注意：vite-node 2.1.8 不认识 `node:sqlite`（它不在 `node:module` 的
> `builtinModules` 里），根 `vitest.config.ts` 用一个虚拟 shim 绕开；生产源码仍是标准
> `import { DatabaseSync } from "node:sqlite"`，上游修好后 shim 可删。

## 依据

`docs/decisions/t4-backend-architecture.md` §4；`docs/design/ia-and-interaction.md` §4–§6；
`AGENTS.md` 硬约束 1/2/5/7。
