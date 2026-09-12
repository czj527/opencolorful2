# agentplant 设计与架构基线（design.md）

> 版本 **v1.0.0** ｜ 日期 **2026-09-11** ｜ 状态：**已基线**（t6 文档治理落定）
>
> **输入来源**：`docs/decisions/t1-reference-benchmark.md`（对标蒸馏）、
> `docs/decisions/t2-positioning-mvp.md`（定位与 MVP，用户 2026-09-11 拍板）、
> `docs/decisions/t3-repo-ci.md`（仓库与 CI，§1/§8 同仓落定口径）、
> `docs/decisions/t4-backend-architecture.md`（后端架构源稿）、
> `docs/decisions/t5-frontend-visual-design.md`（前端视觉源稿）、
> `docs/decisions/t7-acceptance-gates.md`（验收门禁，含 §F-15 文档节制）。
>
> **本文件是什么**：t4/t5 两份源稿的**并入基线** + t6 的文档治理条款。
> §2 架构 = t4 全文实质内容（按 t3 §1/§8 落定口径改写布局）；§3 视觉 = t5 摘要 + 两份真相源指针；
> §4 治理与验收指针；§5 文档责任矩阵。
>
> **效力**：`docs/decisions/` 保留为决策留痕（拍板过程与理由），**工程口径以本文件为准**。
> t4 文末的 "predates 说明"（*design.md 尚由 t6 建立*）已并入本基线，不再有效。

---

## 1. 定位与 MVP

**一句话**：单人自托管的私人 AI 助理——**本地可跑、有记忆、能办事**。

- **MVP 定义**：单人、单机、单 Agent；能聊、能干活、能记住，**下线重开不丢人**。
- **入口**：**M1 = Electron 桌面优先**（`apps/desktop`，t3 §1 权威口径）；**Web 仅为调试/次入口**
  （`apps/web`，desktop 壳复用其构建）；**移动端 PWA = M3**，不在 MVP 内。
- **技术形态**：TS 全栈 pnpm monorepo；SQLite 单文件为**唯一**运行时状态存储（无 Redis/MQ）；
  发布走**本地优先**流程（t3 §4）。
- **场景优先级**：日常陪伴问答 → 办事执行（文件/命令/网页/搜索）→ 记忆沉淀 → 定时任务（二期）。
- **边界**：In/Out of scope 清单与逐条判据见 `docs/decisions/t2-positioning-mvp.md` §2（本文不复制）。
  网关 / 多 Agent / cron / 插件市场均为二期；技术栈与路线图见 t2 §3。

---

## 2. 架构（源：t4 全文 + t3 §1/§8 落定口径）

### 2.0 决策摘要（一页）

| 决策点 | 结论 | 对标来源 |
|---|---|---|
| 同仓形态 | pnpm monorepo：`packages/*`（纯库）+ `apps/server` + `apps/web` + `apps/desktop`（M1 壳）+ `plugins/*`（M2 才启用） | openclaw `packages/* + extensions/*`；落定口径 t3 §1/§8 |
| 进程模型 | 单进程：HTTP + SSE 同端口，**MVP 不需要 WS**（入口无关，桌面壳/Electron 直接套） | openclaw SSE 兼容面 |
| 状态存储 | SQLite 单文件是**唯一**运行时状态存储；驱动 `node:sqlite`（`DatabaseSync`，零原生编译）+ Kysely 类型化查询；engines `>=22.22.3` 并启动时显式校验 SQLite 版本 | openclaw 全仓 134 处 `requireNodeSqlite()`，无 better-sqlite3 |
| 初始表 | 5 张：`schema_migrations / sessions / messages / memories / audit_events`（§2.4 DDL） | hermes kanban + openclaw agent schema 简化 |
| 工具形状 | `{name, description, parameters: TypeBox, execute(ctx, params)}`；失败一律 throw；注册表 `Map + allow/deny` | openclaw `defineToolPlugin` |
| MVP 工具 | 6 个：`fs_read / fs_write / shell_exec / web_fetch / web_search / memory` | §2.5 |
| 约束标注 | workspace-only 是**约定级**约束（诚实标注，非安全边界）；`.git`/凭据强制 blocked | openhanako PathGuard（简化版） |
| P0 治理代码点 | 终态不可降级门禁 + CAS 领取模块，MVP 即写进代码（二期才做多 Agent 调度） | openclaw `shouldApplyRunScopedStatusUpdate` + hermes CAS |

用户拍板已落实：桌面优先入口（后端入口无关故不受影响）→ HTTP+SSE；记忆=偏好+事实
（FTS5 检索，向量放二期）→ §2.4 `memories` + FTS5；允许 shell+沙箱初版 → §2.6；
M2 先网关后多 Agent → §2.7 扩展位顺序。

### 2.1 同仓布局与模块划分

> **落定口径**（t3 §1/§8，2026-09-11）：`apps/server` + `apps/web` 为运行内核；`apps/desktop`
> 为 Electron 壳（复用 web 构建）；`packages` 按 t4 纯度分层 `protocol` / `agent-core`，
> `state` 为 SQLite 层；原领域划分作废。t4 原稿的 `apps/server/src/store/` 职责
> （连接、pragma、迁移、DAO、DDL）按该口径上移为 `packages/state`，`apps/server` 只做路由装配与调用。

```
assistant-platform/              # 仓库根（= 本仓）
  pnpm-workspace.yaml            # packages/*, apps/*
  packages/
    protocol/                    # TypeBox schema：SSE 事件、API 请求/响应、工具参数。前后端共享，零依赖
    agent-core/                  # 纯函数：状态机门禁、截断、redaction、prompt 组装（禁 import apps/*）
    state/                       # SQLite 层：连接、pragma、版本校验、迁移、5 表 DAO + FTS5（§2.4）
    gateway-protocol/            # M2 预留：types stub + README，禁止提前实现
    plugin-sdk/                  # M2+ 预留：types stub + README，禁止提前实现
  apps/
    server/                      # 运行内核：单进程 HTTP+SSE（§2.2 / §2.3）
      src/
        routes/                  # chat / sessions / memory / health（§2.3 端点表）
        agent/                   # 主循环：turn → tool_calls → 结果回写
          tools/                 # types.ts / registry.ts / builtin/（一工具一文件）/ ext/（M2）
        policy/                  # PathGuard 简化版、exec 分类、secret redactor
    web/                         # 运行内核：本地 Web 聊天 UI（视觉见 §3；只依赖 packages/protocol）
    desktop/                     # M1 主入口：Electron 壳（复用 web 构建 + 关于页版本戳）
  plugins/                       # M2 启用：manifest-first 发现，编译期注册表先行（§2.7）
```

**依赖纪律**（openclaw 照抄）：`packages/*` 禁 import `apps/*`；`plugins/*` 只能 import 公开
SDK barrel；用一条 import-boundary 测试守住（t3 落 CI）。
**窄腰纪律**（t1-P2-14）：新能力优先 skill/插件/MCP，最后才加核心 tool。

### 2.2 进程与接口边界：HTTP + SSE（无 WS）

- 单 HTTP server 同端口服务 API + SSE；前端（Web / Electron 壳 / 未来桌面）只走这套面。
- SSE 事件名（对齐 openclaw/openhanako，便于以后抄 WS 控制面）：
  `start / token / thinking / tool_call / tool_result / usage / error / done`，
  结束帧 `data: [DONE]`；头 `text/event-stream + no-cache + keep-alive + flushHeaders()`。
- **必须做 `watchClientDisconnect`**：监听 socket `close` → abort 本次 run，
  否则断线后模型还在跑（openclaw `http-common.ts` 教训）。
- 认证：单机 token（`~/.app/token`，0600；绑 loopback 可留空自生成，非 loopback
  强制 `Authorization: Bearer`）。断线续传（`Last-Event-ID`）、OpenAI 兼容层
  `/v1/chat/completions` 均为 M2（后者几乎零成本，可提前顺手做）。

### 2.3 HTTP 端点（MVP）

| Method | Endpoint | 说明 |
|---|---|---|
| `POST` | `/api/chat` | 主入口 `{sessionId?, message}` → SSE；无 `Accept: text/event-stream` 时回非流式 JSON |
| `POST` | `/api/chat/abort` | `{runId}` → `{aborted}` |
| `GET` | `/api/sessions` | `{sessions:[{id,title,updatedAt,messageCount}]}` |
| `POST` / `DELETE` | `/api/sessions`、`/api/sessions/:id` | 新建 / 删除 |
| `GET` | `/api/sessions/:id/messages` | 历史（`?since=` 增量） |
| `GET/POST/DELETE` | `/api/memory`（+ `GET /api/memory/search?q=`） | 列出 / 写入 `{kind,text}` / 删除 |
| `GET` | `/api/health` | `{ok, version, workspaceRoot, sandboxMode}` |

### 2.4 SQLite 状态内核（唯一存储）

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

**治理内核**（MVP 即写，各约 50 行；二期才接多 Agent 调度）：
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

> 落点（落定口径）：纯函数门禁 → `packages/agent-core`；CAS/audit 的 SQL 与 DAO →
> `packages/state`；完成判定调用位 → `apps/server/src/agent/`。

### 2.5 工具运行时（最小集 6 个）

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

### 2.6 沙箱初版约束（用户已拍板"允许 shell + 沙箱初版"）

- PathGuard 简化版：`workspaceRoot` 内 `rw`、外 `blocked`（或 `ro`）；
  `<root>/.git`、`.env`、凭据文件强制 `blocked`；所有 fs/shell 工具写前调
  `guard.check(path, op)`；先 realpath 再匹配，不存在路径向上找祖先 realpath；
  包含判定 `target === base || startsWith(base + sep)`。
- 命令：默认超时 10s 真杀进程（含 kill-tree）；输出截断 2000 行/50KB
  （`truncateTail` 保留尾部报错 + 滚动缓冲防 OOM）；exec 分类
  `safe|probe|mutation|dangerous|unknown` 只做**审批提示**，**不当拦截**
  （字符串查表可被 `bash -c`/变量拼接绕过——诚实标注）。
- **诚实标注**：无 OS 沙箱前，workspace-only 是约定级约束；硬保证只来自
  "密钥永不落日志"源头纪律 + 精确值红黑名单（percent-encoded/JSON-escaped
  形态同注册）+ 日志 redactor（token/cookie/长随机串/`C:\Users\<name>`）。
- secrets：优先级 进程 env > `./.env` > `~/.app/.env` > 配置文件；`.env` 永不入 git；
  凭据单独存放且 PathGuard-blocked；UI 凭据走掩码语义（`"********"`=保持不变）；
  启动时 env 出现占位值（`sk-.../changeme`）**拒绝启动**。
- 子权限不超父（openhanako 唯一决策点 + `SUBAGENT_BLOCKED_TOOLS`）：MVP 单 Agent
  不实现，但预置接口位——`ToolContext` 预留 `permissionMode` 字段，M2 照抄
  "显式 access + 缺省继承 + 写升级校验"三件套（不做集合求交，保 prompt 缓存前缀）。

### 2.7 M2 扩展位（明确二期，不提前抽象）

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

### 2.8 实现期约束（原 t4 §8 落地清单转写）

以下为 M1 实现必须满足的约束（不是"待派任务清单"，而是实现正确性的判据；排期由后续实现任务自定）：

1. `packages/protocol`：TypeBox SSE/API schema（前后端共享）。
2. `apps/server` 骨架：单进程 HTTP+SSE + 路由表（§2.3）+ token 认证 + 健康检查。
3. `packages/state`：连接/pragma/版本校验/迁移 + 5 表 DAO + FTS5。
4. 治理内核：`shouldApplyStatusUpdate` + 单 Agent run 占位 CAS + audit 写入点（§2.4）。
5. 工具运行时：types/registry + 6 内置工具 + PathGuard/exec 分类/redactor（§2.5 / §2.6）。
6. agent 主循环：turn→tool_calls→回写→SSE 推送 + disconnect-abort + 完成判定
   （进度文本≠交付）。
7. 联调：t7 点击链路（聊天→工具→记忆→重启不丢）+ P0 治理演示三项。

---

## 3. 视觉与体验（源：t5；取舍依据：tokens.md / ia-and-interaction.md）

> **不复制原则**：`docs/design/tokens.md`（2002 行）与 `docs/design/ia-and-interaction.md`
> （1167 行）是各自层面的**唯一真相源**，本节只写定位、原则、摘要与落地路径。
> 实现时**必须直接读这两份**，不得以本节摘要替代取值。

### 3.1 体验定位

**陪伴感 × 克制 × 本地工具的信任感。**

- 陪伴感来自**在场感**（它一直在、在做什么可感知），不是通知感：无弹窗、无红点、无提示音、
  无自动切视图（依据：t1 §6 hanako 的图形/人格侧是差异化方向；t2 把"日常陪伴问答"列为第一场景）。
- 信任感来自**可见即可信**：一切越界动作（写文件/执行命令/联网）以结构化卡片留在消息流，
  参数与结果可展开、可追溯（依据：t1 §3 审计、P0-3 进度文本≠交付）。
- 载体：M1 为 Electron 桌面壳 + Web 渲染层（t3 §1 `apps/desktop`），**桌面宽屏优先**
  （min 1024px，设计基准 1440×900），移动端仅保证不破版。

### 3.2 设计原则（双层，各 5 条）

**视觉层（`tokens.md` §1）**：P1 在场感优先于装饰感 / P2 克制用色（一个强调色 + 低饱和纸感基调）/
P3 状态可解释、后果可预期（治理信息禁情绪化）/ P4 动效只承担信息职责 / P5 桌面宽屏清晰度。

**交互层（`ia-and-interaction.md` §0.3）**：P1 克制不打扰 / P2 可见即可信 / P3 状态以库为准
（UI 是 `tasks.status`/`tool_calls.status` 的直接投影）/ P4 计划不是交付 / P5 失败显式
（禁止静默截断/静默降级）。

### 3.3 信息架构摘要（详见 `ia-and-interaction.md` §1）

**单窗口 + 三主干视图 + 右侧检查器**（否决多窗口与单页长滚动）：

- 左栏（248px / 折叠 64px）：应用头 + 新建对话 + 一级导航（对话/记忆/任务）+ 会话列表 + 设置。
- 中间聊天主列：内容区 max-width 760px 居中——**唯一的注意力中心**。
- 右侧检查器 320px（`--ap-size-detail`）：记忆详情/任务详情/工具详情共用；compact 断点以下转覆盖式浮层。
- **断点 5 档**（xs/sm/md/lg/xl），最小可用宽 1024px；窗口 1280×840 启动，min 1024×640。

其余骨架（本文件不展开，实现直读真相源；下列章节号均为 `ia-and-interaction.md` 的章节）：
聊天流四层 + 流式硬指标（该文 §3）、工具卡片四层与危险三级 + 边界触发就地确认（§4）、
记忆视图（§5）、任务轻量列表（§6）、快捷键/ARIA/组件清单（§7/§8）。

### 3.4 设计系统 tokens 摘要 + 品牌色

- **三层模型**（`tokens.md` §0.1，唯一真相源）：L1 原始色板（11 色相，组件禁用）→ L2 语义层
  （组件唯一入口，主题在此切换）→ L3 结构层（间距/圆角/动效等恒定值）。
  命名 `--ap-{类}-{子类}-{变体}`，可机器解析；组件中禁止裸 hex / 裸 ms / 裸 px 字号，
  CI 静态检查拦截（`tokens.md` §0.1 硬约束）。
- **色彩**：暖纸基调（paper/ink/night/mist 中性族）+ 单强调色
  **印章青蓝 seal `#45708A`（终版）**；success/warning/danger/info 只承载真实语义。
- **品牌色终版（2026-09-11 用户拍板："青蓝；方案B采纳"）**：强调色**锁定印章青蓝 seal
  `#45708A`**（tokens.md 既有 L1 值，不新增色板）；暖棕 `#8C6845` 淘汰、备选 `#0D5FBF` 封存、
  Kimi 原色 `#1783ff` 禁止直抄（落暖纸最差 3.01:1，破契约）。**方案 B 已采纳**（主按钮中性墨色 +
  同心圆角公式 + 3px 浅底 focus ring，零 hex 改动）。取舍依据与代价表见 `t5 §7`，此处不复制。
- **陪伴感专属**（差异化核心，占 L2 的 37%）：`presence-*` 五态（暖色=心智态 / 冷色=动手态的
  **色温通道**）+ `ambient-*`（≤0.12 alpha，永不承载信息）+ `emotion-*`（禁止用于安全/治理信息）。
- **动效与主题**：11 档语义时长 + 6 条 cubic-bezier；reduced-motion 降级为**"换成静态可读状态"
  而非变快**；主题默认 **auto 跟随系统**，`:root` 字面兜底浅色，暗色为体验锚点。
- **质量证据**：109 项对比度检查 0 项未达标（判定口径 = 每个文字 token × 9 个背景表面取最差值）；
  CSS 引用完整性脚本核验（悬空引用/死档位/未定义 token 均为 0）。262 个 token。

### 3.5 治理语义的视觉编码（本设计最关键的正确性决策，详见 t5 §5）

| 治理语义（t1 P0 / t7） | UI 编码（摘要） |
|---|---|
| 终态不可降级 | 终态徽标 + 锁定图标 + 无状态变更入口；冲突更新时**保持终态显示** + 显式错误条 |
| 进度文本 ≠ 交付 | 「仅计划，尚未执行」vs「已核验交付」双形态；**前端不做时态推断**，只消费后端 `turn.delivery`；字段缺失渲染为「未提供交付状态」，禁止把未知渲染为成功 |
| 显式报错不静默降级 | denied 卡片展示拒绝/拦截原因原文；沙箱拦截绝不显示为"成功但无输出"；确认不设自动超时 |
| CAS 领取 | 冲突提示条 + 不出现第二个 running 指示 |
| 三层限额 | 限额拒绝文案含上限数值，行内可见 |

### 3.6 落地路径与真相源边界

- token 层落 `apps/desktop/src/styles/tokens.css`；对比度 + 引用完整性校验脚本
  `scripts/check-tokens.mjs`（调用位已在 t3 §1 预留）纳入门禁。
- 视图与组件落 `apps/desktop`（t3 §1）；关于页版本号/gitSha/buildTime 必须构建期注入，
  **禁止硬编码**（t7 FG-05）。
- **真相源（唯一，冲突时以它们为准）**：
  - token 取值/命名/主题 → `docs/design/tokens.md`（`tokens.md` §0.3 为范围守门）。
  - IA / 交互 / 组件清单 → `docs/design/ia-and-interaction.md`。
  - 架构与本文其余口径 → 本文件 §2。
- 裁决记录：t5 §6 的 A1–A11（token 真相源、presence 模型、时长阶梯、默认主题、
  Electron 在 M1、危险操作确认动线等）为**执行层不得翻案**的定案，已在上述真相源中对齐。

---

## 4. 治理与验收指针

**P0 治理五项**（t1 §4，逐条判据见 t7 §2.1，本文不复制判定表）：

1. **任务终态不可降级** —— 终态一旦落定不允许回退（AT-503）。
2. **SQLite 本地状态 + CAS 领取** —— 条件 UPDATE 即 CAS，并发恰一个成功（AT-502）。
3. **进度文本≠交付** —— 纯"我接下来要…"文本不得标记完成（AT-504）。
4. **子权限不超父 + 显式报错不静默降级** —— MVP 预置接口位，越权显式报错（AT-506）。
5. **三层硬限额** —— 生成深度 / 子任务数 / 并发 lane 超限显式拒绝并入审计（AT-505）。

**机制落点**：见本文 §2.4「治理内核」；**行为级判据**见
`docs/decisions/t7-acceptance-gates.md` §2.1（含 metadata-only 审计旁证）。
**验收门禁**（真实发布产物、防假绿 FG-01…FG-07、F-01…F-16、一键跑通清单）全部以 t7 为准；
**文档节制**由 t7 §F-15 检查：`README` + `AGENTS.md` + `design.md` + `docs/decisions/t1..t7` 齐备
且与实现一致。CI 与 t7 的分工边界见 t7 §5（CI 绿是 t7 的输入条件，t7 通过才发版）。

---

## 5. 文档责任矩阵（t6 治理条款）

### 5.1 职责与责任

| 文档 | 单一职责（写什么／不写什么） | 必须遵守者 | 更新责任与触发条件 |
|---|---|---|---|
| `README.md` | 门面：是什么、一键跑通、最小示例 | 所有人 | 用户 + 主 Agent；入口命令/发布流程变化时更新 |
| `AGENTS.md` | agent/贡献者**操作说明 + 硬约束**（命令、禁止事项、产物契约） | **所有 agent 与贡献者（先读）** | 主 Agent；硬约束/命令/目录契约变化时更新（t6 已确认基线） |
| `design.md`（本文件） | **工程基线**：§2 架构 + §3 视觉 + §5 文档治理；不写实现细节 | 所有实现任务 | 主 Agent + 架构/视觉 owner；架构决策或体验裁决变化时更新 |
| `docs/decisions/t1..t7` | **决策留痕**：拍板过程、理由、对标依据（含本文未复制的清单与判定表） | 需要追溯依据者 | 对应任务 owner；仅在本决策范围内追加/修订 |
| `docs/design/tokens.md` | **token 层唯一真相源**：全部取值/命名/主题/对比度证据 | 所有 UI 实现（禁止绕开写裸值） | 视觉 owner（frontend-visual）；token 变化须重跑对比度校验 |
| `docs/design/ia-and-interaction.md` | **IA 与交互唯一真相源**：视图结构、状态矩阵、组件清单、可达性 | 所有 UI 实现 | 视觉 owner；视图/交互变化时更新，取值仍引 tokens.md |
| `.github/workflows/ci.yml` + `scripts/*` | 机械执行（非文档）：门禁、棘轮、发布校验 | CI 本身 | 按 t3 §3/§5 维护；文档不得与脚本口径冲突 |

### 5.2 新增文档门槛（三条同时满足才允许新增）

1. **不可替代**：职责明确且现有文档在不破坏其单一职责的前提下无法承载；先尝试并入
   `design.md` / `AGENTS.md` 或既有真相源（**优先合并，不新增文件**）。
2. **有主**：写明 owner 与触发更新条件，并登记进 §5.1 矩阵；未登记者视为不存在。
3. **无重叠**：与既有文档零重叠（尤其禁止第二份 token 稿 / IA 稿 / 架构稿）。

### 5.3 禁止文档泛滥（硬条款）

- **禁止**新增"规划稿 / 总结稿 / 说明稿 / 进度报告 / 评审记录"类文档进仓；进度与编排状态
  只留 `.agent-teams/`（**仅本地，不进仓**）。
- 决策留痕只在 `docs/decisions/`，命名沿用 `t{N}-{slug}.md`；**同一议题不得存在两份并列稿**，
  出现并列即视为冲突，须先裁决、再去重（并入或删除）。
- **任何文档不得成为第二真相源**：token 引 `docs/design/tokens.md`，IA/交互引
  `docs/design/ia-and-interaction.md`，架构/视觉基线引本文件；重复贴取值即为违规（会腐化）。
- t7 §F-15 只检查 `README` + `AGENTS.md` + `design.md` + `docs/decisions/t1..t7`；
  新增文件**不自动**进入门禁清单，也不因新增而豁免 F-15。
- **文档与实现不符 = blocked**（t7 F-15）：实现口径变化时必须同 PR 更新对应文档，
  不允许"代码先走、文档后补"长期悬挂。

---

*基线落定：t6（文档治理）2026-09-11。源稿 t4/t5 保留在 `docs/decisions/` 作为决策留痕；
t4 文末 predates 说明已并入本基线，不再有效。*
