# t4 后端架构与模块划分规划（TS 同仓 / 单 Agent 先行）

> 输入：t1 对标结论（`docs/decisions/t1-reference-benchmark.md`）+ t2 定位与 MVP
> （`docs/decisions/t2-positioning-mvp.md`，用户已拍板 2026-09-11）+ 三份子 agent
> 实读源码报告（openclaw 后端解剖 / SQLite 状态内核 / 工具运行时与 API）。
> 本稿只做规划：架构决策 + 模块划分 + 接口边界 + M2 扩展位 + 落地分派清单。
> 待 t6 建立 `design.md` 基线后，本稿并入其"架构"部分。

## 0. 决策摘要（一页）

| 决策点 | 结论 | 对标来源 |
|---|---|---|
| 同仓形态 | pnpm monorepo：`packages/*`（纯库）+ `apps/server` + `apps/web` + `plugins/*`（M2 才启用） | openclaw `packages/* + extensions/*` |
| 进程模型 | 单进程：HTTP + SSE 同端口，**MVP 不需要 WS**（入口无关，后续桌面壳/Electron 直接套） | openclaw SSE 兼容面 |
| 状态存储 | SQLite 单文件是**唯一**运行时状态存储；驱动 `node:sqlite`（`DatabaseSync`，零原生编译）+ Kysely 类型化查询；engines `>=22.22.3` 并启动时显式校验 SQLite 版本 | openclaw 全仓 134 处 `requireNodeSqlite()`，无 better-sqlite3 |
| 初始表 | 5 张：`schema_migrations / sessions / messages / memories / audit_events`（§4 DDL） | hermes kanban + openclaw agent schema 简化 |
| 工具形状 | `{name, description, parameters: TypeBox, execute(ctx, params)}`；失败一律 throw；注册表 `Map + allow/deny` | openclaw `defineToolPlugin` |
| MVP 工具 | 6 个：`fs_read / fs_write / shell_exec / web_fetch / web_search / memory` | §5 |
| 约束标注 | workspace-only 是**约定级**约束（诚实标注，非安全边界）；`.git`/凭据强制 blocked | openhanako PathGuard（简化版） |
| P0 治理代码点 | 终态不可降级门禁 + CAS 领取模块，MVP 即写进代码（二期才做多 Agent 调度） | openclaw `shouldApplyRunScopedStatusUpdate` + hermes CAS |

用户拍板已落实：桌面优先入口（后端入口无关故不受影响）→ HTTP+SSE；记忆=偏好+事实
（FTS5 检索，向量放二期）→ §4 `memories` + FTS5；允许 shell+沙箱初版 → §6；
M2 先网关后多 Agent → §7 扩展位顺序。

## 1. 同仓布局与模块划分

```
assistant-platform/
  packages/
    protocol/        # TypeBox schema：SSE 事件、API 请求/响应、工具参数。前后端共享，零依赖
    agent-core/      # 纯函数：状态机门禁、截断、redaction、prompt 组装（禁 import apps/*）
  apps/
    server/          # 单进程 HTTP+SSe：路由、agent 主循环、工具运行时、SQLite 访问
      src/
        routes/      # chat / sessions / memory / health（§3 端点表）
        agent/       # 主循环：turn → tool_calls → 结果回写
          tools/     # types.ts / registry.ts / builtin/（一工具一文件）/ ext/（M2）
        store/       # SQLite：连接、pragma、迁移、DAO（sessions/messages/memories/audit）
        policy/      # PathGuard 简化版、exec 分类、secret redactor
    web/             # 本地 Web 聊天 UI（t5 负责视觉；只依赖 packages/protocol）
  plugins/           # M2 启用：manifest-first 发现，编译期注册表先行（§7）
```

依赖纪律（openclaw 照抄）：`packages/*` 禁 import `apps/*`；`plugins/*`
只能 import 公开 SDK barrel；用一条 import-boundary 测试守住（t3 落 CI）。
窄腰纪律（t1-P2-14）：新能力优先 skill/插件/MCP，最后才加核心 tool。

## 2. 进程与接口边界：HTTP + SSE（无 WS）

- 单 HTTP server 同端口服务 API + SSE；前端（Web/Electron 壳/未来桌面）只走这套面。
- SSE 事件名（对齐 openclaw/openhanako，便于以后抄 WS 控制面）：
  `start / token / thinking / tool_call / tool_result / usage / error / done`，
  结束帧 `data: [DONE]`；头 `text/event-stream + no-cache + keep-alive + flushHeaders()`。
- **必须做 `watchClientDisconnect`**：监听 socket `close` → abort 本次 run，
  否则断线后模型还在跑（openclaw `http-common.ts` 教训）。
- 认证：单机 token（`~/.app/token`，0600；绑 loopback 可留空自生成，非 loopback
  强制 `Authorization: Bearer`）。断线续传（`Last-Event-ID`）、OpenAI 兼容层
  `/v1/chat/completions` 均为 M2（后者几乎零成本，可提前顺手做）。

## 3. HTTP 端点（MVP）

| Method | Endpoint | 说明 |
|---|---|---|
| `POST` | `/api/chat` | 主入口 `{sessionId?, message}` → SSE；无 `Accept: text/event-stream` 时回非流式 JSON |
| `POST` | `/api/chat/abort` | `{runId}` → `{aborted}` |
| `GET` | `/api/sessions` | `{sessions:[{id,title,updatedAt,messageCount}]}` |
| `POST` / `DELETE` | `/api/sessions`、`/api/sessions/:id` | 新建 / 删除 |
| `GET` | `/api/sessions/:id/messages` | 历史（`?since=` 增量） |
| `GET/POST/DELETE` | `/api/memory`（+ `GET /api/memory/search?q=`） | 列出 / 写入 `{kind,text}` / 删除 |
| `GET` | `/api/health` | `{ok, version, workspaceRoot, sandboxMode}` |

## 4. SQLite 状态内核（唯一存储）

驱动与连接（照抄 openclaw `src/infra/`）：
- `node:sqlite`（`DatabaseSync` 同步 API）+ Kysely（`db:gen` 出类型，CI 校验）；
  engines 卡 `node >=22.22.3`；启动时在 `:memory:` 查 `sqlite_version()`，
  低于 WAL 安全线（3.51.3+ / 3.50.7+ / 3.44.6+）**拒绝运行**（上游 WAL-reset 损坏 bug）。
- pragma 顺序：busy_timeout → `journal_mode=WAL` → `wal_autocheckpoint=1000` →
  `journal_size_limit=64MiB` → `synchronous=NORMAL` → `foreign_keys=ON`；
  NFS/SMB/FUSE 上拒绝 WAL。
- 迁移：`schema_migrations(version, name, checksum, applied_at)` 记账 + 幂等执行；
  纯增量 DDL 不 bump 版本；时间戳统一 `INTEGER` unix epoch seconds。
- 事务纪律：规划完再 BEGIN，事务回调内禁 `await`（`node:sqlite` 同步 API 天然契合）。

DDL（5 张表，子 agent 取证草图原文落定）：

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY, name TEXT NOT NULL,
  checksum TEXT, applied_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, title TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','archived')),
  model TEXT, provider TEXT, cwd TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER,
  metadata TEXT);
CREATE INDEX IF NOT EXISTS idx_sessions_status_updated ON sessions(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
  content TEXT, tool_name TEXT, tool_call_id TEXT,
  token_in INTEGER, token_out INTEGER, created_at INTEGER NOT NULL,
  UNIQUE (session_id, seq));
CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  scope TEXT NOT NULL CHECK (scope IN ('session','global')),
  kind TEXT NOT NULL, content TEXT NOT NULL,
  source_msg_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  confidence REAL, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, expires_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_memories_scope_kind ON memories(scope, kind);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, content='memories', content_rowid='rowid');

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
  session_id TEXT, run_id TEXT,
  kind TEXT NOT NULL, actor TEXT, subject_id TEXT,
  status TEXT, error_code TEXT, duration_ms INTEGER,
  bytes_in INTEGER, bytes_out INTEGER, payload_meta TEXT,
  CHECK (length(COALESCE(payload_meta,'')) <= 2048));
CREATE INDEX IF NOT EXISTS idx_audit_session_ts ON audit_events(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_audit_run ON audit_events(run_id, id);
```

治理内核（MVP 即写，各约 50 行；二期才接多 Agent 调度）：
- **终态不可降级**（抄 openclaw）：`shouldApplyStatusUpdate(current, next)` ——
  终态→非终态拒绝并保留原值（不抛错不改写）；时间戳 `Math.max` 单调。
  当前 `sessions.status` 仅 `active|archived`，`archived` 不可回退。
- **CAS 领取**（抄 hermes）：条件 UPDATE 即 CAS（无 SELECT-then-UPDATE），
  `rowcount != 1` 即抢输；`claim_lock/claim_expires` 三件套 + TTL+心跳 reclaim
  现在只做单 Agent 占位（防重复 run），M2 加 `tasks` 表时复用。
- **audit 只记元数据**：正文永不进账本；`payload_meta` 过 redaction 白名单；
  自增 PK + `(session_id, ts)` 游标可 tail（抄 hermes `task_events`），未来 UI 事件流免改表。
- **进度文本≠交付**（t1-P0-3）：agent 输出纯文本计划不得标记完成→blocked，
  落 `agent/` 主循环的完成判定。

## 5. 工具运行时（最小集 6 个）

接口（抄 openclaw `AgentTool`，简化 capability）：

```ts
export interface Tool<P extends TSchema = TSchema, D = unknown> {
  name: string; label: string; description: string; // description 写清"何时用/何时不用"
  parameters: P; outputSchema?: TSchema;
  sideEffect?: { kind: "fs_write"|"fs_delete"|"command"|"network"; capability: string };
  risk: "safe" | "review";
  execute(ctx: ToolContext, params: Static<P>): Promise<ToolResult<D>>;
}
// 失败一律 throw（ToolInputError 400 / ToolAuthorizationError 403），
// 运行时统一转 tool_result error；content 给模型，details 给日志/UI，progress 永不进模型。
```

| 工具 | 输入 | 输出 |
|---|---|---|
| `fs_read` | `{path, offset?, limit?}` | `{text(带行号), truncated{by,totalLines,totalBytes}}` |
| `fs_write` | `{path, content, mode:"create"\|"overwrite"\|"append"}` | `{path, bytesWritten, created, guardDecision}` |
| `shell_exec` | `{cmd, cwd?, timeoutMs=10000, maxOutputBytes=51200}` | `{exitCode, stdout, stderr, timedOut, truncated, risk}` |
| `web_fetch` | `{url, timeoutMs?, maxBytes=51200}` | `{finalUrl, status, contentType, text, truncated, blockedReason?}`（SSRF 守卫默认开：禁私网/重定向到私网） |
| `web_search` | `{query, count=5, site?}` | 封闭分支 + 不可信信封 `externalContent:{untrusted:true,…}`（防 provider 伪造信任标记） |
| `memory` | `{op:"remember"\|"recall"\|"forget", kind:"preference"\|"fact", …}` | `{items:[{id,kind,text,createdAt,source}], changed?}`（FTS5 检索；CJK 2/3-gram；偏好=置顶语义） |

注册表：`Map<name, tool> + resolve({allow?, deny?})`；`builtin/` 一文件一工具；
`registerModule` 为 M2 插件留扩展点 B；core 放纯数据、工厂注入 ctx。

## 6. 沙箱初版约束（用户已拍板"允许 shell + 沙箱初版"）

- PathGuard 简化版：`workspaceRoot` 内 `rw`、外 `blocked`（或 `ro`）；
  `<root>/.git`、`.env`、凭据文件强制 `blocked`；所有 fs/shell 工具写前调
  `guard.check(path, op)`；先 realpath 再匹配，不存在路径向上找祖先 realpath；
  包含判定 `target === base || startsWith(base + sep)`。
- 命令：默认超时 10s 真杀进程（含 kill-tree）；输出截断 2000 行/50KB
  （`truncateTail` 保留尾部报错 + 滚动缓冲防 OOM）；exec 分类
  `safe|probe|mutation|dangerous|unknown` 只做**审批提示**，**不当拦截**
  （字符串查表可被 `bash -c`/变量拼接绕过——诚实标注）。
- **诚实标注**：无 OS 沙箱前，workspace-only 是约定级约束；硬保证只来自
  "密钥永不落日志"源头纪律 + 精确值红黑名单（ percent-encoded/JSON-escaped
  形态同注册）+ 日志 redactor（token/cookie/长随机串/`C:\Users\<name>`）。
- secrets：优先级 进程 env > `./.env` > `~/.app/.env` > 配置文件；`.env` 永不入 git；
  凭据单独存放且 PathGuard-blocked；UI 凭据走掩码语义（`"********"`=保持不变）；
  启动时 env 出现占位值（`sk-.../changeme`）**拒绝启动**。
- 子权限不超父（openhanako 唯一决策点 + `SUBAGENT_BLOCKED_TOOLS`）：MVP 单 Agent
  不实现，但预置接口位——`ToolContext` 预留 `permissionMode` 字段，M2 照抄
  "显式 access + 缺省继承 + 写升级校验"三件套（不做集合求交，保 prompt 缓存前缀）。

## 7. M2 扩展位（明确二期，不提前抽象）

按 t2 拍板顺序——网关先（1–2 渠道），再多 Agent：

1. **网关**：channel 抽象（inbound-event/turn/去重/allowlist）+ 1–2 渠道插件；
   别提前抽接口（openclaw：很贵）。
2. **定时任务/cron**：cron 表 + runs 历史 + 保留/补跑 + `heartbeat_outcomes`。
3. **多 Agent**：`tasks(status, claim_lock, claim_expires)` 三件套 + task_runs 账本
   + 完整 CAS/reclaim + 子权限三件套 + 审批/中断原语（exec/question approval +
   `waitDecision`）；每 agent 独立 DB（`agent_databases` 注册表 + 租约 + 删除日志）。
4. **插件体系**：`openclaw.plugin.json` manifest-first（发现与校验不执行代码）+
   安装索引 + 信任审批；M1 只用编译期注册表。
5. **记忆升级**：向量检索（`memory_index_chunks/embedding_cache` 形状已预留位）、
   上下文压缩与索引水位、journal 断点恢复。
6. **网关加固**：设备配对、细粒度 scopes、controlPlaneWrite 预算、TLS、优雅重启；
   OpenAI 兼容层可提前顺手做。

## 8. 落地分派清单（给后续实现任务拆解用，本稿不执行）

1. `packages/protocol`：TypeBox SSE/API schema（前后端共享）。
2. `apps/server` 骨架：单进程 HTTP+SSE + 路由表（§3）+ token 认证 + 健康检查。
3. `store`：连接/pragma/版本校验/迁移 + 5 表 DAO + FTS5。
4. 治理内核：`shouldApplyStatusUpdate` + 单 Agent run 占位 CAS + audit 写入点。
5. 工具运行时：types/registry + 6 内置工具 + PathGuard/exec 分类/redactor。
6. agent 主循环：turn→tool_calls→回写→SSE 推送 + disconnect-abort + 完成判定
   （进度文本≠交付）。
7. 联调：t7 点击链路（聊天→工具→记忆→重启不丢）+ P0 治理演示三项。

---
* predates 说明：`design.md` 尚由 t6 建立；本稿先落 `docs/decisions/`，t6 基线就绪后并入其架构章节。
