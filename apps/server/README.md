# apps/server —— 单进程 HTTP+SSE 运行内核（M1-2 骨架）

## 职责

一条 `node:http` 进程提供**唯一接口面**：t4 §3 的 HTTP 端点 + t4 §2 的 SSE 推送。
零 Web 框架、零额外运行时依赖——依赖只有三个 workspace 包：`@agentplant/protocol`
（路由/事件形状的唯一来源）、`@agentplant/agent-core`（交付判定 + 审计元数据构造）、
`@agentplant/state`（治理内核：终态门禁 + CAS 原语；接库任务用）。

范围（骨架期）：
- 路由表 + 请求校验（`validate()`，失败 → 400 `ApiError{code:"bad_request"}`）
- 单机 token 认证（t4 §2）
- SSE 推送 + **断线监听**（断线即 abort 本次 run）
- run 注册表（一格一 run 的 `AbortController`）
- 治理内核接线（t4 §4）：`delivery` 判定 + `turn.end` / `state.transition` 审计（内存缓冲）

**不在范围**：Web UI。SQLite 状态内核已在 `packages/state` 落地（M1-3），工具运行时初版已在
`src/tools` + `src/policy` 落地（t14，见下节），**M1-6 主循环**（工具调用、结果回写、交付判定）
已在 `src/agent/loop.ts` 落地（t15），**记忆/会话读端点已接真库**（t17，见「状态落库」一节）。
仍未落地：审计落库（仍为内存环形缓冲）与 Web 前端。

## 工具运行时（t14）

| 路径 | 内容 |
|---|---|
| `src/tools/types.ts` | `ToolServices` 注入面（workspaceRoot / guard / redactor / memoryDb / fetchImpl）；Tool 契约本身从 `@agentplant/agent-core` 重导出，**不重定义** |
| `src/tools/registry.ts` | `ToolRegistry`（Map + `register`/`registerModule`/`resolve({allow,deny})`）+ `createCoreRegistry` 注册 7 工具（与 protocol `TOOL_NAMES` 双向比对，多一个少一个都抛错） |
| `src/tools/params.ts` | 参数校验（protocol `validate`）+ **默认值物化**（TypeBox 的 `default` 只是注解，`Value.Check` 不改写数据） |
| `src/tools/builtin/` | 一工具一文件：`read-file` / `write-file` / `run-command` / `web-search` / `browse-page` / `memory`（两个工具）+ `text`（截断纯函数）/ `net`（SSRF 守卫 + 重定向 + HTML→text） |
| `src/policy/guard.ts` | PathGuard 简化版（t4 §6）：realpath 先行 + 祖先回溯、`=== base \|\| startsWith(base+sep)`、`.git`/凭据文件强制拒 |
| `src/policy/redactor.ts` | 日志脱敏：精确值注册表（percent-encoded / JSON-escaped 同注册）+ 正则刷；`routes.ts` 的 500 兜底先过它再出网 |

错误语义（t4 §5）：工具失败**一律 throw**——`ToolInputError`（400 口径）、
`ToolAuthorizationError`（403 口径）、运行期错误留给主循环转 error 事件。
**SSE 转译是 t15 的事**：本包只保证抛出正确的错误类型，`tool_result` 事件由主循环产生。

`memory_write` 的 `sessionId` 是**调用方给的引用**，故与 `POST /api/memory` 同口径：空/纯空白
视同未给（全局作用域，不检查），非空则先判会话存在性——**未知会话 → `ToolInputError`（400）**，
绝不让 `memories.session_id` 的 FK 撞成运行期 500，也不静默跳过写入（`memory_search` 不涉 FK）。

**约定级约束（诚实标注）**：PathGuard 只约束"工具按自己的参数访问路径"；命令工具
**没有** OS 沙箱，被执行的命令自己可以往工作区外写。`classifyCommand` 的风险分级
**只做审批提示、不当拦截**（字符串查表可被 `bash -c`/变量拼接绕过）。
`web_search` 在未配置 `SEARCH_PROVIDER`/`SEARCH_API_KEY` 时**明确报错**，不返回伪造结果。
根 `README.md`「工具运行时」一节有完整口径表。


## 治理内核接线（t4 §4）

| 关注点 | 本包行为 | 依据 / 后续 |
|---|---|---|
| `delivery` | `/api/chat` 的响应与 SSE `done` 都由 `decideTurnDelivery(...)` 产出（**不硬编码**）。骨架期无工具调用 → `claimed`（前端渲染「◷ 仅计划，尚未执行」），`evidence` 字段不带 | t5 §6.3；t15 主循环把真实事实（成功 `tool_result` 数）填进调用点，形状不变 |
| `turn.end` 审计 | 每个**真正登记了 run** 的 chat（含非流式）写一条；400 校验失败不写（没有回合） | `audit-buffer.ts` → 后续 `state.appendAudit` |
| `state.transition` 审计 | `/api/chat/abort` 与客户端断线**共用** `abortRunWithAudit`，只有真的发生状态迁移才写（幂等重放不写） | 单一标记入口，避免两条路径语义漂移（t4 §2） |
| 元数据 | `payload_meta` 一律用 `buildAuditMeta` 构造（只有键名/计数/长度），正文永不进账本；超 2048 抛错不截断 | 与 DDL `CHECK (length(payload_meta)<=2048)` 同口径 |
| 探活 | `GET /api/health` **不写审计**（探活噪声不进账本） | — |


## 沙箱模式口径（t4 §6）

`GET /api/health` 的 `sandboxMode` 固定 `"workspace-only"`（protocol `SANDBOX_MODES`
的合法取值，响应体满足 `HealthResponseSchema`，见 `src/server.test.ts` 的 `validate()` 断言）。

**该取值是约定级约束，不是安全边界**：PathGuard（`src/policy/guard.ts`）已随 t14 落地，
它拦得住"工具按自己的参数读写工作区外的路径"（读写一律 403），但拦不住"被执行的命令
自己往工作区外写"——那道硬保证随二期 OS 沙箱（t4 §6）。本端点如实上报当前生效模式。

## 状态落库（t17：记忆 / 会话读端点接真库）

`sessions` / `messages` / `memories` 三个面**全部经 `packages/state` 的 `StateDao` 读写**
（`node:sqlite`，单文件 WAL）：路由层**零 SQL**（表结构 / 触发器 / FTS 全在 `packages/state`），
**没有内存影子状态**。端点与 chat 主循环共用**同一个 DAO**（`routes.ts` 的 `resolveDao`）
——同一库文件，"聊天写 → 列表查 → 消息查"端到端一致。

| 端点 | 实现 | 口径 |
|---|---|---|
| `GET /api/sessions` | `dao.listSessions("active")` | **只列 `active`**：`DELETE` 是归档（终态），归档即从列表消失（库行仍在、消息仍可查）。`messageCount` = 逐会话 `listMessages(id).length`（M1 量小可接受；**后续优化为一条 `COUNT(*) … GROUP BY session_id`**） |
| `POST /api/sessions` | `dao.createSession({title})` | 返回**库行**的 `{id,title,createdAt}`（`created_at` = unix **秒**，写后读回不自己拼时间）；`title` 空白/省略 → 默认「新会话」 |
| `DELETE /api/sessions/:id` | `dao.archiveSession(id)` | **归档**（终态、不物理删行、不级联删消息）；未知 id 仍 `204`（幂等，不 404） |
| `GET /api/sessions/:id/messages?since=` | `dao.listMessages(id, since)` | `since` = seq 水位；未知 session → `{messages:[]}` **200**（空态，不 404）；`content`/`tool_name`/`tool_call_id` 为 NULL 时**不带该键**（closed 对象多键即违约） |
| `POST /api/memory` | `dao.getSession(sessionId)` 判存在 → `dao.writeMemory({kind,content,sessionId?})` | 返回**库行真实 id**（AT-401 的唯一交付凭据）；`sessionId` 有则透传（作用域 `session`，无则 `global`）；`sessionId` 指向**不存在的会话** → `400 bad_request`（调用方错误，不进 FK 兜底报 500）；已归档会话的库行仍在，可写 |
| `GET /api/memory/search?q=&limit=` | `dao.searchMemories(q,{limit})` | **FTS5 `MATCH`**（触发器同步；空/纯空白 q → `[]`）；条目带 `sourceSessionId` / `sourceMessageId` 溯源 |
| `DELETE /api/memory` | `dao.forgetMemory(id)`，`query` 分支先 `searchMemories` 再逐个删 | 硬删 + FTS 触发器同步；返回**真实删除的 id**（未知 id / 无命中 → `{deleted:[]}`，不是错误）；`id`/`query` 皆无 → `400` |

库路径：`STATE_DB_PATH` → 否则 `~/.agentplant/agentplant.sqlite`（`agent/state-db.ts` 单例复用）。
`*.sqlite` 永不进仓（AGENTS.md 硬约束 1）；测试一律注入 tmpdir 库，绝不碰用户主目录。

仍未落库的只有**审计**（`audit-buffer.ts` 的进程内存环形缓冲，cap 200，形状已对齐
`state.AppendAuditInput`）与 **run 注册表**（`sse.ts`，进程内——run 是进程级活动状态）。

## 认证语义（t4 §2）

- 请求头：`Authorization: Bearer <token>`。
- token 来源：`APP_TOKEN`。未设置且绑 loopback → 启动时生成 `crypto.randomBytes(32)` 的临时
  token 并在 stderr 打一行 `APP_TOKEN not set, generated ephemeral token (not printed)`；
  **token 明文绝不进日志**（临时 token 只对本机有意义）。
- 豁免：`GET /api/health` 免认证（探活 / desktop 壳启动探测）。
- 其余 `/api/*` 无合法 token → 401 `ApiError{code:"unauthorized"}`。
- **拒绝启动**：`HOST` 不是 loopback（且不是 `localhost`）又没显式 `APP_TOKEN` → 打原因到
  stderr 并 `exit 1`。
- 路由判定先于认证：未匹配的路径一律 404（不因是否带 token 改变结论）。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `43121` | 与 DSH 的 43120 错开一位，避免本机冲突；非法值回退默认并提示 |
| `HOST` | `127.0.0.1` | 非 loopback 必须配 `APP_TOKEN`，否则拒绝启动 |
| `APP_TOKEN` | 无（loopback 下生成临时 token） | 见上「认证语义」 |
| `APP_VERSION` | `0.0.0-scaffold` | `/api/health` 的 `version`；禁止在源码硬编码发布版本号 |

## 端点

`POST /api/chat`（`Accept: text/event-stream` → SSE：`start` → `token`×2 → `done` → `data: [DONE]`；
否则非流式 JSON `{runId,sessionId,reply,delivery}`，`delivery` 由 `decideTurnDelivery` 判定产出
——骨架期恒为 `"claimed"`，且**不带** `evidence`）、
`POST /api/chat/abort`（`{aborted}` = 「本次是否真的发生状态迁移」；未知/已终态 → `false`）、
`GET|POST /api/sessions`、`DELETE /api/sessions/:id`、`GET /api/sessions/:id/messages?since=`、
`GET /api/memory/search?q=`、`POST|DELETE /api/memory`、`GET /api/health`。

SSE 事件名与结束帧一律取 `@agentplant/protocol` 的 `SSE_HEADERS` / `SSE_DONE_FRAME` /
`encodeSseEvent`，本包不重写线格式。

## 启动 / 验证（必须跑构建产物，禁用 dev 冒充发布）

```bash
pnpm --filter @agentplant/server run build && node apps/server/dist/index.js
# 等价的包脚本（就是上面那条）：APP_TOKEN=… pnpm --filter @agentplant/server run start
```

冒烟（真实产物）：

```bash
APP_TOKEN=test-token node apps/server/dist/index.js &
curl -s http://127.0.0.1:43121/api/health                     # 200，免认证
curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:43121/api/chat \
  -H 'Content-Type: application/json' -d '{"message":"hi"}'   # 401
curl -s -N -X POST http://127.0.0.1:43121/api/chat \
  -H 'Authorization: Bearer test-token' -H 'Accept: text/event-stream' \
  -H 'Content-Type: application/json' -d '{"message":"hi"}'   # start/token/done + [DONE]
```

本包**没有 `dev` 脚本**：t7 禁止用 dev server 冒充"已发布、已通过"；
`build` 即 `tsc -p tsconfig.json` 出 `dist/index.js`。

## 测试

`vitest` 真实 HTTP：每个用例 `createServer({token}).listen(0)` 取 ephemeral 端口，
用 `node:http` 原生客户端直连，跑完 `close()`。**不引入 supertest 等测试依赖。**

- `src/auth.test.ts`：`resolveAuthConfig`（loopback 自生成 / 非 loopback 拒绝启动）、
  `checkAuth` 三态、免认证路径。
- `src/sse.test.ts`：run 注册表（abort 幂等、终态不可降级）、SSE 线格式。
- `src/server.test.ts`：health 免认证、401、chat 非流式、chat SSE 事件顺序与 `[DONE]` 尾帧、
  abort 未知/已知 runId、404/400、sessions/messages/memory 校验分支、真实断线触发 abort、
  治理内核接线（delivery 与判定函数同源、`turn.end`/`state.transition` 审计、
  health 不写审计、账本不含正文）。
  末段 `describe("state 落地（真库真盘：写 → 查 → 删）")`（t17 / t18）15 例：会话建的 id 出现在列表
  且可同库直查、`createdAt` 取库行、`messageCount` 与 messages 列表对齐、未知 session 空数组、
  `since` 水位、消息形状（tool 消息/NULL 键不带）、记忆写后真实 id + FTS 命中、
  **"token 前缀命中而纯子串不命中"（证明走 FTS 而非 `LIKE '%…%'`）**、`limit` 生效、
  `sourceSessionId` 溯源、按 id / 按 query 删除后 FTS 查不到、会话归档 204 且库行 `archived`、
  **归档即从 `GET /api/sessions` 消失（库行仍 `archived`、消息仍可查；原始 SQL 回退被库层拦下）**、
  **带未知 `sessionId` 写记忆 → 400 `bad_request` 且不落库**、
  `STATE_DB_PATH` 注入落盘（真盘文件存在）。
- `src/audit-buffer.test.ts`：环形缓冲 cap（写 201 条只剩 200 条、丢最旧）、
  `payloadMeta` 超限抛错、时间戳 unix 秒、只读副本。
- `src/governance.test.ts`：**跨包**断言（server → state）——`archived→active` 拒绝（终态不可降级）、
  `tryClaim` 双 claim 恰一成功、`payload_meta` 上限两包同值。
- 工具/策略（t14，`src/tools/__tests__/` + `src/policy/__tests__/`，共约 145 例）：
  **真盘**（tmpdir 工作区，`cleanup()` 删净）+ **真进程**（`node -e` 回显 / `exit 3` / 超时睡眠后
  用 PID 存活探测确认进程树真死）+ **真 socket**（`node:http` 本地回环 stub，ephemeral 端口）。
  测试目录内**不使用任何 mock 框架 API**：外部网络能力的注入点是 `ToolServices.fetchImpl`
  （真 HTTP 请求，"域名 → 连哪儿"固定到回环）与 `resolveHost`（真守卫链路上的 DNS 替身）。

## 实现说明（与 spec 签名的差异，非契约偏差）

1. `checkAuth` 比 spec 的 `checkAuth(req)` 多一个显式 `expectedToken` 形参（token 由启动流程注入，
   避免模块级可变配置污染并行测试）；`watchClientDisconnect(req,res,onAbort)` 额外返回解绑函数。

（原骨架期三处偏差已收敛：`sandboxMode` 改 `workspace-only` 且过 `HealthResponseSchema` 校验；
`createdAt` 统一 unix 秒；`DELETE /api/memory` 的路由层 `id`/`query` 约束已启用。）

## 依据

`docs/decisions/t4-backend-architecture.md` §2/§3；`packages/protocol/src/api.ts`、`src/sse.ts`；
`AGENTS.md` 硬约束 1/6。
