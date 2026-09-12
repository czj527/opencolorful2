# apps/web —— 聊天渲染层（**唯一真相源**，M1-8 / t21 起）

> **口径统一（本文件替换此前的"待定占位"声明）**：自 t21 起 **`apps/web` 是渲染层的唯一真相源**
> （SoT），`apps/desktop` 只保留 Electron 壳（主进程 + preload + CSP 入口），
> **复用 `apps/web/dist` 的构建产物**。这统一了 t3 §1（`apps/desktop` 单入口）与
> t4 §1（本地 Web 聊天 UI 落 `apps/web`）的分歧：入口是 desktop，**渲染层代码只存在于 web**。
> 原 `apps/web/README.md` 的"占位、不得实质分叉"声明**作废**。

## 职责

按 `docs/design/ia-and-interaction.md`（IA / 交互 SoT）与 `docs/design/tokens.md`（token SoT）
实现 M1 的聊天渲染层：单窗口三视图（对话 / 记忆 / 任务）+ 会话列表 + 320px 检查器 + 设置模态。

**不做**（IA §0.2 守门清单，出现即范围违规）：网关/多渠道连接页、多 Agent 视图（群聊/委派树/
子 agent）、Kanban/泳道/swarm 拓扑、cron 定时任务表、技能市场/插件商店/MCP 配置、移动端 PWA
专属导航、向量记忆检索 UI、发布/门禁仪表盘。

## 目录

| 路径 | 内容 |
|---|---|
| `src/index.html` | HTML 契约（CSP、`#app` 挂载点、样式与脚本引用；`data-theme` 字面兜底浅色） |
| `src/styles/tokens.css` | **token 全文落盘**：tokens.md 附录 A 的全量定义（明暗双主题 + reduced-motion + 关键帧）。**不得手改**——改值先改 tokens.md，`check-tokens` 会拦 |
| `src/styles/app.css` | 组件样式：**只消费 `var(--ap-*)`，零裸 hex / 零裸 ms / 零裸 px 字号** |
| `src/styles/theme-init.js` | 首帧主题解析（防 FOUC；外部文件而非内联，CSP 无需 `'unsafe-inline'`） |
| `src/lib/*.ts` | 纯逻辑与数据层：协议类型入口、HTTP 客户端、SSE 解析、回合聚合、交付标签、presence 状态机、危险分级/确认动线、记忆过滤、交互时间轴、store、controller |
| `src/views/*.ts` | 视图层：外壳、侧栏、聊天（含工具卡四层）、记忆、任务、设置、动作面 |
| `src/main.ts` | 入口：启动 controller、首帧渲染、订阅变更、全局快捷键 |
| `scripts/build.mjs` | 构建：clean → tsc → 拷静态 → **两道产物守卫**（禁裸包名 / HTML 引用必须存在） |
| `dist/` | 产物（不进仓）：`index.html`、`main.js` + 模块、`styles/{tokens,app}.css`、`styles/theme-init.js` |

## 命令

```bash
pnpm --filter @agentplant/web run build      # 真实产物（自定义 clean + 守卫，非 dev server）
pnpm --filter @agentplant/web run typecheck  # 源码 + 测试双 tsconfig --noEmit
pnpm test                                    # vitest 覆盖 src/**/*.test.ts
node scripts/check-tokens.mjs                # token 门禁（CI 同款）
```

`pnpm build`（根）会先构建 `@agentplant/protocol`（本包的类型来源）与 `@agentplant/web`，
再构建 `@agentplant/desktop`（壳把 web 产物拷进 `dist/renderer/`）。

## 依赖与产物纪律

- **零新增外部依赖**：`dependencies` 只有 `@agentplant/protocol`（`workspace:*`），
  devDependencies 用仓内已有的 `typescript`。`pnpm-lock.yaml` 不引入新外部包。
- **产物必须能被浏览器/Electron 直接加载**（无打包器）：
  - 生产代码对 protocol **只用 `import type`**（编译期擦除）；
  - 运行期需要的事件名白名单在前端以 `satisfies readonly SseEventName[]` 声明，
    并由 `src/lib/contract.test.ts` 用协议层 `SSE_EVENT_NAMES` 逐项比对（漂移必红）；
  - `scripts/build.mjs` 的守卫①扫描 dist，发现任何裸包名说明符即构建失败；
  - 守卫②校验 `index.html` 引用的 js/css 都真实存在。
- 构建先 clean（删 `dist` 与 `tsconfig.tsbuildinfo`），防"增量编译认为产物未变"的假绿。

## M1 能力边界（诚实分支，不静默降级）

以下三处是**后端/协议尚未提供**的能力，UI 一律显式说明，不伪装成"没有数据"：

| 缺口 | UI 行为 |
|---|---|
| 无「列出全部记忆」读端点（只有 `GET /api/memory/search?q=`，`q` 必填且空串返回 `[]`） | 记忆视图空查询时显示「无法列出全部记忆」并说明能力边界；输入关键词即检索 |
| 无任务读端点（`tasks` 表与治理内核在 `packages/state`，`apps/server` 未暴露 `/api/tasks`） | 任务视图显示「无法读取任务列表」并说明为什么为空 |
| 服务端未实现「就地确认」协议（t15 主循环收到 `tool_call` 后即执行） | 危险工具卡片仍按 IA §4.4 渲染确认区（A7/A8 的形态），但**明示**该授权当前不改变执行结果 |

另外两处**按设计如此**（不是缺口）：`/api/chat` 的 CORS 预检（浏览器直开需 server 侧放行，
Electron `file://` 场景不受影响）、记忆删除为服务端硬删（撤销窗口只恢复本地视图）。

## 依据

`docs/design/ia-and-interaction.md`（IA/交互 SoT）、`docs/design/tokens.md`（token SoT）、
`docs/decisions/t5-frontend-visual-design.md` §5–§8（治理语义视觉编码 + A1–A11 裁决 + 接口）、
`packages/protocol/README.md`（后端面契约）、`apps/server/README.md`（端点与认证语义）、
`AGENTS.md`（硬约束：禁假绿、产物契约）。
