# t5 核心页面信息架构与交互视觉规划（MVP）

> 输入：`docs/decisions/t1-reference-benchmark.md`（对标蒸馏）、`docs/decisions/t2-positioning-mvp.md`（定位与 MVP 边界，已拍板）。
> 旁证约束：`docs/decisions/t7-click-paths.md`（点击链路 AT-201…AT-506 的 UI 可观测要求）、`docs/decisions/t7-acceptance-gates.md`（§2/§2.1 门禁语义）。
> **取值真相源**：`docs/design/tokens.md`（v1.0.0）。本文件所有颜色/字号/时长/圆角/z-index 均为 `var(--ap-*)` 引用，不重复定义数值（见 §1.5）。
> 定位：**只做信息架构 / 交互 / 视觉规划，不写业务代码、不定技术栈**。所有布局给数值、所有状态给定义，全文无"待定"。
> 落地路径：token 层落 `apps/desktop/src/styles/tokens.css`（tokens.md §7.2 建议路径），视图与组件落 `apps/desktop`（t3 §1），供 t4（agent-core 前端契约）与 t3 直接对照实现。

---

## 0. 范围声明与设计原则

### 0.1 设计范围（= t2 §2 In scope，一条不多）

| # | 视图/能力 | 承载页（本文件） |
|---|---|---|
| 1 | 聊天主循环（单 Agent 多轮 + 流式） | §3 聊天主界面 |
| 2 | 工具调用可见可审计 | §4 工具调用呈现 |
| 3 | 简单记忆（偏好 + 事实，跨会话） | §5 记忆视图 |
| 4 | 本地状态治理语义（终态/进度≠交付/限额/CAS） | §6 任务与状态呈现 |
| 5 | 桌面端入口优先（宽屏 Web 布局，Electron 壳二期） | §1 信息架构、§2 视觉基础 |

### 0.2 明确不做的界面（出现即为范围违规，必须删除）

- ❌ 网关/多渠道连接页（Telegram/飞书/QQ/微信扫码、Webhook 配置）——t2 Out of scope。
- ❌ 多 Agent 视图：团队/群聊/委派树/子 Agent 详情/depth 选择器——t2 Out of scope（M2）。
- ❌ Kanban 看板、泳道拖拽、swarm 拓扑图——t2 明确"不做 Kanban"。
- ❌ cron/定时任务表、心跳巡检面板、提醒日历——t2 Out of scope。
- ❌ 技能市场/插件商店/MCP 配置 UI、人格卡编辑、语音通话——t2 Out of scope。
- ❌ 移动端 PWA 专属设计（底部 Tab Bar、抽屉手势为主要交互）——仅"响应式不破版"（§1.5），不做专属导航。
- ❌ 向量记忆检索 UI（相似度滑块/向量可视化）——t2 §5-3 向量检索放二期。
- ❌ 发布/版本/门禁仪表盘、CI 状态页——t7 是文档与脚本流程，不是产品页面（唯一例外：关于页显示版本，见 §6.6）。

### 0.3 五条设计原则（每条挂 t1/t2 依据）

1. **克制不打扰（P1）**：默认没有弹窗、没有红点、没有自动切换视图。t2 核心场景把"日常陪伴问答"排第一、t1 §6 指出 hanako 的图形桌面+办公侧才是与 CLI agent 拉开差距的一侧——陪伴感靠**在场感**而非**通知感**实现。（依据：t1 §6、t2 §1）
2. **可见即可信（P2）**：一切越过边界的动作（写文件、执行命令、联网）都必须以**结构化卡片**留在消息流里，参数与结果可展开、可追溯。依据：t1 §3「审计：metadata-only 账本」，t7 AT-301…AT-304 要求工具调用在 UI 可见且能与 DB 逐字比对。
3. **状态以库为准（P3）**：UI 任何状态标签都不是本地推断，而是 `tasks.status` / `tool_calls.status` 的直接投影；终态文案一旦出现不再变化。依据：t1 §4 P0-1「终态不可降级」、t7 §2.1 AT-503。
4. **计划不是交付（P4）**：助手说"我接下来要…"与"已完成"在视觉上必须是两种东西，且完成态必须挂核验凭据。依据：t1 §4 P0-3、t7 §2.1 AT-504 与 CP-01/CP-02。
5. **失败显式（P5）**：拒绝、超限、冲突、断连一律给出可见的**显式错误**与下一步动作，禁止静默截断/静默降级/静默串行。依据：t1 §4 P0-4「显式报错不静默降级」、t7 §6 G2/G4 判定。

---

## 1. 全局信息架构

### 1.1 结论：单窗口 + 三主干视图 + 右侧检查器（不是多窗口、不是单页长滚动）

**结论：采用"单窗口、多视图、共享一条会话上下文"的结构。**

- 左侧固定导航 + 会话列表；中间是**唯一的注意力中心**（聊天流）；右侧是**上下文检查器**（记忆详情 / 任务详情 / 工具详情共用同一块面板）。
- 视图切换只发生在**左侧导航的三个一级项**：`对话` / `记忆` / `任务`。切换不销毁聊天流状态，切回即续。

| 候选方案 | 结论 | 理由 |
|---|---|---|
| 多窗口（聊天一窗、记忆一窗、任务一窗） | ❌ 否决 | 单人自托管桌面应用，多窗口会带来焦点争抢与"关哪个"的心智负担，与 P1 克制冲突；且 t2 MVP 无并行任务需要并视 |
| 单页长滚动分区（聊天/记忆/任务上下铺在一页） | ❌ 否决 | 记忆与任务是低频回看，长滚动会把聊天流的滚动锚点冲掉；且会话多起来后首屏噪声过大 |
| 单窗口多视图 + 右侧检查器（**采用**） | ✅ | 只有一个"正在发生"的地方（聊天），低频视图按需进入，检查器让"看到一条工具卡片→看它的详情"不离开上下文 |

**窗口规格**：单窗口，`minWidth` = `--ap-breakpoint-compact`（1024px）× `minHeight` 640px；默认启动尺寸 1280 × 840（Windows 上居中，`BrowserWindow` 参数，非 token）；记住上次尺寸与位置（落 SQLite `settings`，非 UI 状态）。

### 1.2 一级导航（左侧栏，展开 `--ap-size-sidebar` 248px / 折叠 `--ap-space-64` 64px）

从上到下共 5 个区，无第一级折叠：

| 序 | 区块 | 高度（token） | 内容 |
|---|---|---|---|
| 1 | 应用头 | `--ap-size-titlebar`（44px） | 产品名「助理」+ 在场状态点（§3.6）+ 折叠按钮 |
| 2 | 主操作 | `--ap-size-toolbar`（36px） | `+ 新建对话`（`Ctrl/Cmd+N`） |
| 3 | 一级导航 | 3 × `--ap-size-toolbar`（36px） | `对话`（`Ctrl/Cmd+1`）/ `记忆`（`Ctrl/Cmd+2`）/ `任务`（`Ctrl/Cmd+3`） |
| 4 | 会话列表 | flex:1，可滚动 | 仅当一级导航=对话时显示；按 `updated_at` 倒序，分组「今天 / 近 7 天 / 更早」 |
| 5 | 应用脚 | `--ap-size-titlebar`（44px） | `设置`（`Ctrl/Cmd+,`）、关于（版本号，t7 P2 版本戳 UI 侧） |

区块间间距 `--ap-space-8`；列表行高 `--ap-space-48`（48px），行间距 `--ap-space-12`。

导航项状态（每项必须有四态）：`默认`（文字 `--ap-text-primary`，背景透明）→ `悬停`（背景 `--ap-surface-row-hover`）→ `选中`（背景 `--ap-surface-row-selected`，左侧 `--ap-size-indicator-rail` 竖条 `--ap-border-accent`，文字 `--ap-text-primary` + `--ap-fw-medium`）→ `聚焦`（`--ap-focus-ring-width` 外环 `--ap-border-focus`，偏移 `--ap-focus-ring-offset`）。图标 `--ap-space-20`（20px），与文字间距 `--ap-space-12`，左右内边距 `--ap-space-12`。

### 1.3 布局网格（1440 × 900 基准）

```
┌──────────────────┬──────────────────────────────────┬────────────────────┐
│ 左侧栏            │ 聊天主列                          │ 右侧检查器          │
│ --ap-size-sidebar │ flex，内容区                      │ --ap-size-detail   │
│ 248px 固定        │ max-width --ap-size-chat-max 760 │ 320px（可收起为 0） │
│                   │ 顶栏 --ap-size-titlebar 44        │ 顶栏 44 / 内容滚动  │
└──────────────────┴──────────────────────────────────┴────────────────────┘
   ↑ --ap-border-w 分隔线 --ap-border-subtle   ↑ 同上
```

- 整体外边距 0；三栏之间各 `--ap-border-w`（1px）分隔线取 `--ap-border-subtle`，不用阴影分隔（P1 降噪）。
- 聊天主列背景 `--ap-surface-0`；消息流内边距 `--ap-space-40`（40px）；文本块可用宽度上限 = `--ap-size-chat-max` − 2 × `--ap-space-40` = **680px**。
- 右键优先：消息流滚动条宽 `--ap-space-8`（8px），悬停才显形（`--ap-border-default`），轨道透明；滚动条槽位始终占位（避免流式时内容横向跳动）。

### 1.4 断点与最小可用宽度（桌面优先）

| 断点 | 条件 | 左侧栏 | 右侧检查器 | 聊天内容区 | 说明 |
|---|---|---|---|---|---|
| `xl` | ≥ 1440px | `--ap-size-sidebar` 展开 | `--ap-size-detail` **停靠** | max-width `--ap-size-chat-max` 居中 | 默认态；三栏同屏 |
| `lg` | 1280–1439px | `--ap-size-sidebar` 展开 | `--ap-size-detail` **停靠** | max-width `--ap-size-chat-max`，左右内边距 `--ap-space-32` | 检查器打开时聊天列仍 ≥ 480px，不破版 |
| `md` | 1024–1279px（≥ `--ap-breakpoint-compact`） | `--ap-size-sidebar` 展开（可折叠至 `--ap-space-64`） | **覆盖式浮层**：`position: absolute; right: 0; width: var(--ap-size-detail)`，层级 `--ap-z-dropdown`；其遮罩 `--ap-surface-scrim`，层级 `--ap-z-sidebar`。检查器是**非模态浮层**，不进入焦点陷阱，故不使用 `modal` 层级 | flex，最小 456px | 检查器不再挤压聊天列 |
| `below-compact` | < 1024px（< `--ap-breakpoint-compact`） | 折叠为 `--ap-space-64` 图标栏（会话列表移入浮层，层级 `--ap-z-dropdown`） | **收起**（tokens.md §5.2 硬规定：低于 `--ap-breakpoint-compact` 收起详情面板）；用户从任务/记忆条目进入时以全屏覆盖呈现，层级 `--ap-z-modal` + `--ap-z-scrim` | flex | **降级可用**，非设计目标 |
| `xs` | < 768px | 折叠 `--ap-space-64` | 同上（全屏覆盖） | flex | 仅"不破版"：不横向滚动、发送按钮可点、文字不溢出 |

- **最小可用宽度 = `--ap-breakpoint-compact`（1024px）**。低于 1024px 不做专属优化，仅保证不破版（t2：不做移动端 PWA 专属设计）。
- 折叠态（`--ap-space-64` = 64px）只保留图标：应用头仅状态点、导航仅图标、`+` 仅图标；图标 `--ap-size-control-sm`（24px），点击区 `--ap-size-avatar-lg`（40px）见方（触达面积）。
- 窗口宽度降到 `--ap-breakpoint-compact` 以下时，若右侧检查器处于打开态，强制转为全屏覆盖（不弹提示，静默按 `below-compact` 规则重排）。
- 断点判定一律用 CSS 媒体查询 + `--ap-breakpoint-compact`，**不写死 1024 之外的中间档魔数**；`below-compact` / `xs` 仅为"不破版"下限，不代表产品目标形态。

### 1.5 视觉基础（引用与映射说明）

> **取值以 `docs/design/tokens.md` 为唯一真相源（single source of truth）。**
> 本节**不定义任何色值、字号、时长、圆角、z-index 的具体数值**——全部以 `var(--ap-*)` 引用 tokens.md。
> 本文件只保留两样东西：①**组件几何值**（本文件特有的布局分工）；②**语义角色的 token 映射**（哪个组件用哪个 token）。
> 主题机制：**默认 `auto` 跟随系统（`prefers-color-scheme`），字面兜底浅色**；用户可在设置中显式锁定 `light`/`dark`（依据 tokens.md §8、§7.4）。
> 品牌色相以 tokens.md 现值（seal 印章青蓝）为准；若后续调整色相，只改 tokens.md，本文件因全为引用而**零改动**。

**① 组件几何值 → token 对照（本文件独有，不属于 tokens 层）**

| 本文件几何项 | 取值 | token（tokens.md §5.2/§5.1） | 说明 |
|---|---|---|---|
| 左侧栏展开宽 | 248px | `--ap-size-sidebar` | 落阶梯 ✅ |
| 左侧栏折叠宽 | 64px | `--ap-space-64` | 落阶梯（原 64px 现由间距阶梯承载）✅ |
| 内容区（对话阅读列） | 760px | `--ap-size-chat-max` | 落阶梯 ✅；输入区同宽用 `--ap-size-composer-max` |
| 右侧检查器宽 | 320px | `--ap-size-detail` | **原 360px → 320px**（见 §12） |
| 聊天顶栏 / 应用头 / 应用脚高 | 44px | `--ap-size-titlebar` | **原 56px / 48px → 44px**；折叠态图标仅在此高度内（见 §12） |
| 主操作按钮 / 一级导航项高 | 36px | `--ap-size-toolbar` | **原 44px / 36px → 统一 36px**（见 §12） |
| 控件标准高（按钮、输入框） | 32px | `--ap-size-control` | 落阶梯 ✅ |
| 紧凑控件高（图标按钮小号） | 24px | `--ap-size-control-sm` | 落阶梯 ✅ |
| 选中/状态竖条宽 | 3px | `--ap-size-indicator-rail` | 落阶梯 ✅ |
| 消息流内容宽 | `--ap-size-chat-max` − 2 × `--ap-space-40` = 680px | 派生值 | **不引入新魔数**，由列宽与内边距推出 |
| 工具卡片宽 | 上述 680px − `--ap-space-40` = 640px | 派生值 | 同上 |
| 用户气泡最大宽 | `--ap-size-chat-max` − 3 × `--ap-space-40` = 640px | 派生值 | **原 560px → 640px**（见 §12） |
| 最小可用宽度 | 1024px | `--ap-breakpoint-compact` | 落阶梯 ✅（低于此值细节见 §1.4） |
| 窗口默认尺寸 | 1280 × 840 | 非 token（Electron 窗口参数） | 由 `BrowserWindow` 配置，不进入 tokens 层 |
| 消息流滚动条宽 | 8px | `--ap-space-8` | **原 10px → 8px**（见 §12） |
| 间距阶梯 | 14 档 | `--ap-space-{0,2,4,6,8,12,16,20,24,32,40,48,64,80}` | 以 tokens.md §5.1 为准；散值同样禁止，且含 2/6/48/64/80 |

**② 语义角色 → token 映射（组件实现按此表选 token）**

| 界面角色 | 使用的 token |
|---|---|
| 应用底 / 聊天底 | `--ap-surface-0` |
| 左侧栏底 / 检查器底 | `--ap-surface-sunken` |
| 卡片底（消息卡、工具卡、记忆条目、任务行） | `--ap-surface-1` |
| 浮起层（输入框外壳、下拉、模态） | `--ap-surface-2` |
| 内嵌块（工具参数块 L4、引用块） | `--ap-surface-inset` |
| 代码 / 命令原文块 | `--ap-surface-code` |
| 用户消息气泡底 | `--ap-surface-bubble-user` |
| 列表行悬停 / 选中 | `--ap-surface-row-hover` / `--ap-surface-row-selected` |
| 覆盖式检查器遮罩 | `--ap-surface-scrim` |
| 正文、标题 | `--ap-text-primary` |
| 次级正文、列表标题 | `--ap-text-secondary` |
| 元信息、时间戳、工具名、参数摘要 | `--ap-text-tertiary` |
| 占位符、脚注、状态附注 | `--ap-text-muted` |
| 1px 分隔线、卡片内分隔 | `--ap-border-w` + `--ap-border-subtle` |
| 控件描边、卡片描边 | `--ap-border-default` |
| 选中/激活描边（含选中竖条） | `--ap-border-accent` |
| 键盘焦点环 | `--ap-border-focus` + `--ap-focus-ring-width` + `--ap-focus-ring-offset` |
| 主按钮底 / 主按钮文字 | `--ap-accent` / `--ap-text-on-accent`（或 `--ap-accent-on`） |
| 主按钮悬停 / 按下 | `--ap-accent-hover` / `--ap-accent-active` |
| 选中行浅底、标签浅底 | `--ap-accent-subtle` |
| 可点击文字（`查看原对话`、`在系统中打开`） | `--ap-accent-text` |
| 成功（工具 success、已完成、`exit 0`） | 文字 `--ap-success-text`；实心徽标 `--ap-success`；底 `--ap-success-subtle`；描边 `--ap-border-success` |
| 警告（待确认、限额、降级、`仅计划`标签） | 文字 `--ap-warning-text`；底 `--ap-warning-subtle`；描边 `--ap-border-warning`（**无实心档**，tokens.md §2.3 刻意缺档） |
| 危险（失败、`denied`、破坏性按钮、终态锁定） | 文字 `--ap-danger-text`；实心按钮/竖条 `--ap-danger`；底 `--ap-danger-subtle`；描边 `--ap-border-danger`；反白 `--ap-danger-on` |
| 信息（记忆写入提示、系统说明） | 文字 `--ap-info-text`；底 `--ap-info-subtle`；描边 `--ap-border-info`（**无实心档**） |
| presence 五态（见 §3.6） | `--ap-presence-{idle,thinking,streaming,acting,awaiting}` 及各自 `-text` 变体 |
| 工具栏高度 | `--ap-size-toolbar` |
| 助理头像 / 空状态头像 | `--ap-size-avatar` / `--ap-size-avatar-lg` |

**③ 排版角色映射**

| 界面角色 | 字号 token（tokens.md §4.2） |
|---|---|
| 助理回答正文、markdown 渲染 | `--ap-fs-body-lg`（16px／行高 1.625） |
| 用户消息、输入框 | `--ap-fs-body`（15px／行高 1.6） |
| 页面 / 检查器标题 | `--ap-fs-h1`（20px／600）；区块标题 `--ap-fs-h2`（17px／600） |
| 空状态欢迎语 | `--ap-fs-display` + `--ap-font-display`（仅 ≥20px 展示型） |
| 控件文字、按钮、标签 | `--ap-fs-ui`（14px／500） |
| 工具卡片参数区 | `--ap-fs-tool`（13px） |
| 命令 / 代码原文 | `--ap-fs-code`（13px）+ `--ap-font-mono` |
| 时间戳、工具名、元信息、徽标 | `--ap-fs-caption`（12px） |
| 角标、键位提示、极短附注 | `--ap-fs-micro`（11px／500） |
| 全 UI 默认字体 | `--ap-font-sans`（CJK 使用 `--ap-tracking-normal`，禁止非零字距） |

**④ 圆角、阴影、层级、动效（一律引用，不取值）**

| 组件 | token |
|---|---|
| 消息气泡（用户） | `--ap-radius-bubble` |
| 卡片（错误条、任务条、记忆条目） | `--ap-radius-card` |
| 工具卡片 | `--ap-radius-tool-card` |
| 按钮、输入框、下拉、行内小块 | `--ap-radius-control` |
| 模态 | `--ap-radius-modal` |
| 状态点、头像、胶囊 | `--ap-radius-pill` / `--ap-radius-full` |
| 静止输入框 / 卡片与工具卡 / 浮起输入框 / 侧拉检查器 / 模态 | `--ap-shadow-xs` / `--ap-shadow-sm` / `--ap-shadow-md` / `--ap-shadow-lg` / `--ap-shadow-pop` |
| 焦点光晕 | `--ap-shadow-glow` |
| 覆盖式检查器浮层 / 其遮罩 / 模态 / Toast / Tooltip | `--ap-z-dropdown` / `--ap-z-sidebar` / `--ap-z-modal`+`--ap-z-scrim` / `--ap-z-toast` / `--ap-z-tooltip` |
| 粘性聊天顶栏 / 吸顶提示条 | `--ap-z-raised` / `--ap-z-sticky` |
| 微交互（悬停、退场、撤销） | `--ap-duration-instant`（80ms）+ `--ap-ease-standard` |
| 状态切换、focus、面板（默认档） | `--ap-duration-fast`（140ms） |
| 消息进入、卡片状态色、确认入场 | `--ap-duration-base`（200ms）+ `--ap-ease-enter` |
| 大块进场、侧栏折叠、检查器滑入 | `--ap-duration-slow`（320ms）+ `--ap-ease-emphasized` |
| 流式增量尾段淡入 | `--ap-duration-stream`（90ms）+ `--ap-ease-enter` |
| 流式光标闪烁周期 | `--ap-duration-caret`（1000ms，`step-end infinite`） |
| presence thinking 呼吸 / acting 节拍 | `--ap-duration-breath`（2400ms）/ `--ap-duration-pulse`（900ms）+ `--ap-ease-breathe` |
| 一次性"送达确认"（工具成功、记忆已写入） | `--ap-ease-settle` + `--ap-duration-base`（**禁止用于布局位移或持续动画**） |
| 位移幅度 | `--ap-motion-slide-sm/md` × `--ap-motion-scale`（reduced 时 scale=0） |

**⑤ 动效降级（硬要求，依 tokens.md §6.4）**：降级 = 换成**静态可读状态**，不是"变快"。
`prefers-reduced-motion: reduce` 与 `[data-motion="reduced"]` 两套取值完全相同（tokens.md §7.2 已给出），组件只引用 `animate-ap-*` token 即可。
本文件涉及的具体降级结果：打字/呼吸/节拍 → 静态圆点 + **文字标签必须存在**；流式光标 → 常亮；面板与抽屉滑入 → 瞬切；块落地位移 → 仅 `opacity`；悬停与聚焦的颜色变化 → **保留**（颜色变化不构成运动）。

**⑥ 本文档中"非动效时长"的说明**：本文件的 presence 分级时间轴（250ms / 2.5s / 8s / 30s，见 §3.6）、工具卡片结果色静态停留 3s、重连自动重试 5s、撤销窗口 `--ap-duration-dwell-toast`（6s）等属于**交互时间轴**（行为契约），不是动效 token，不受 tokens.md §6.1 约束，故以具体毫秒书写。

---

## 2. 全局状态矩阵（每个视图都必须定义，禁止"待定"）

| 状态 | 对话视图 | 记忆视图 | 任务视图 | 右侧检查器 |
|---|---|---|---|---|
| **空态** | 无会话 → 空态卡：标题「还没有对话」+ 副文案「直接说话就行，我会记住重要的部分。」+ 主按钮`新建对话`；有会话但无消息 → 极简空态（无配图，仅 §3.5 引导语） | 0 条记忆 → 「还没有记忆。聊过几轮后，偏好和事实会自动沉淀在这里。」+ 说明「MVP 不支持手动新建」 | 0 条任务 → 「当前没有进行中的任务。任务会在你让我办事时自动出现。」 | 未选中对象 → 「在左侧选一条记录查看详情」 |
| **加载** | 会话列表骨架屏：3 条 40px 高占位条，`opacity .4→1` 1.2s 循环；消息历史加载：顶部 2 条 64px 占位块 | 列表骨架：5 条 56px 占位 | 列表骨架：4 条 48px 占位 | 详情骨架：标题 24px + 3 行 16px 占位 |
| **流式中** | 见 §3.4 | 不适用（列表为静态投影，不轮询） | 有 running 任务时仅列表项状态点呼吸，不整页重排 | 若详情正在流式，只在字段级更新，不重建面板 |
| **错误** | 见 §3.8；消息流内错误是**行内错误条**（不用 toast，避免打扰） | 列表加载失败：整块错误条 + `重试`（`Ctrl/Cmd+R` 不重载窗口，见 §7） | 同上 | 详情读取失败：面板内错误条 + `重试` |
| **重连/降级** | 见 §3.9 | 只读降级：顶部 32px 提示条「本地状态可读，写入暂停」 | 只读降级：同上，且**禁用**任何状态变更按钮（MVP 无手改状态入口，故只需禁用删除/清理） | 只读时按钮禁用并附 title 说明 |

---

## 3. 聊天主界面（最高完成度）

### 3.1 结构总览与垂直尺寸

```
┌─ 聊天顶栏 56px ─────────────────────────────────────────────┐
│ 会话标题（可双击重命名，MVP 仅改 UI 标题）+ 会话状态点 + ⋯菜单 │
├─ 消息流 flex:1, overflow-y:auto, padding: 24px 40px 32px ────┤
│  · 日期分隔条（今天/昨天/具体日期）                           │
│  · 消息组（用户消息 / 助手回合）                               │
│  · 回合内：正文段 → 工具卡片 → 正文段 → 完成核验徽标            │
├─ 输入区（随内容自适应 96–240px）──────────────────────────────┤
│  · 附件占位行（0 或 32px）                                    │
│  · 多行输入框 + 工具条（左：附件/斜杠占位；右：字数/发送/停止） │
│  · 底部辅助行 20px：快捷键提示 / 队列提示 / 限额提示            │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 消息流的层级（三层 + 一层分隔）

**层级 L0：会话级** — 日期分隔条（`--ap-fs-caption` + `--ap-text-tertiary`，居中，上下 `--ap-space-16` 间距，两侧细线 `--ap-border-subtle`）。

**层级 L1：回合（Turn）** — 一个用户回合 + 其后的助手回合构成一个「消息组」，组间距 `--ap-space-24`，组内元素间距 `--ap-space-12`。

**层级 L2：块（Block）** — 助手回合内部是**有序块序列**：`text` / `tool_call` / `error` / `plan-note`。块的渲染顺序严格等于后端事件顺序（不重排、不合并），这是"可审计"的视觉前提。

**层级 L3：行内元素** — 徽标、时间戳、参数摘要、退出码——均为 `--ap-fs-caption`（12px）/ `--ap-fs-tool`（13px）及以下，不使用大字重。

**对齐与形态**

| 角色 | 对齐 | 最大宽 | 背景 | 圆角 | 内边距 | 头像 |
|---|---|---|---|---|---|---|
| 用户 | 右 | `--ap-size-chat-max` − 3 × `--ap-space-40` = 640px | `--ap-surface-bubble-user` | `--ap-radius-bubble`（右下角改 `--ap-radius-control`） | `--ap-space-12` / `--ap-space-16` | 无 |
| 助手 | 左 | 680px（= `--ap-size-chat-max` − 2 × `--ap-space-40`） | 无背景（直接落在 `--ap-surface-0` 上） | — | `--ap-space-0`（文字直接排） | `--ap-size-avatar` 圆形在场点（§3.6） |
| 工具卡片 | 左，与助手文字左缘对齐 | 680px − `--ap-space-40` = 640px | `--ap-surface-1` + `--ap-border-w` `--ap-border-subtle` | `--ap-radius-tool-card`（8px） | `--ap-space-12` / `--ap-space-16` | 无 |
| 行内错误 | 左，与助手文字对齐 | 680px | `--ap-danger-subtle` + `--ap-border-w` `--ap-border-danger` | `--ap-radius-card` | `--ap-space-12` / `--ap-space-16` | 无 |
| 系统/状态行（如「会话已恢复」「已中断」） | 居中 | 自动 | 无 | — | — | — |

**正文字号**：助手回答用 `--ap-fs-body-lg`（16px／行高 1.625，tokens.md §4.2 明定"对话正文（助理回答）"）；用户消息与输入框用 `--ap-fs-body`（15px／1.600）。助手侧比用户侧大一档，是"阅读材料 vs 我的便签"的层级区分。

**为什么助手消息不用气泡**：气泡=两人对话隐喻，会把工具卡片挤出视觉层级；助手侧改用"文档流 + 卡片"更接近"工作台"。用户侧保留气泡以明确"这是我说的"。该取舍直接服务于 §0.3-P2（工具卡片的可见性优先于对称美感）。

### 3.3 消息元数据行

每条消息（含工具卡片）底部有 1 行 `--ap-fs-caption` + `--ap-text-tertiary`（行高 `--ap-lh-caption`），仅在**悬停或键盘聚焦**时显形（opacity 0→1，`--ap-duration-instant`），内容：

- 用户消息：`HH:mm` + 悬停操作 `复制`（MVP 只给复制，不做编辑/重发/删除）。
- 助手消息：`HH:mm` + `模型名`（截断 16 字符）+ `复制`。
- 流式中不显示元数据行（避免跳动）。

### 3.4 流式输出呈现（硬指标对齐 t7 AT-201）

| 项 | 规则 |
|---|---|
| 首 token | 发送后必须 ≤ 5s 出现首个可见字符（t7 AT-001 S4 的 UI 侧要求）；超时按 §3.8-E3 处理 |
| 增量方式 | 按 token/块追加，**逐块可见**（禁止一次性整段替换——t7 明确"一次性整段出现且未见增量刷新"即阻塞）：文本以 16ms 帧节流批量追加（渲染帧预算，非动效 token），单帧最多追加 24 字符 |
| 增量淡入 | 只对新追加的**尾段**用 `--ap-duration-stream`（90ms）+ `--ap-ease-enter` 做 `opacity 0.35 → 1`（`animate-ap-stream-tail`）；**禁止对全文重跑动画**（会整屏闪） |
| 光标 | 流式期间在文本尾部渲染 `--ap-motion-caret-width`（2px）竖条，色取 `--ap-presence-streaming`，闪烁周期 `--ap-duration-caret`（1000ms）`step-end infinite`（`animate-ap-caret`）；reduced-motion 下**常亮**（保留可见性） |
| 滚动锚定 | 用户在底部（距底 ≤ `--ap-space-48`）时自动跟随；一旦用户上滑 > `--ap-space-48` 则**停止跟随**，右下角出现 `--ap-size-toolbar`（36px）圆形「回到最新 ↓」按钮（层级 `--ap-z-raised`，带未读计数上限显示 "99+"） |
| 段落级完成 | 每个块（block）流式结束时执行一次"块落地"：`opacity .85→1` + 位移 `--ap-motion-slide-sm` × `--ap-motion-scale`，时长 `--ap-duration-fast` + `--ap-ease-standard`；reduced-motion 下仅保留 opacity |
| 代码/路径 | 流式文本内的反引号片段在**块完成后**才做代码样式化（流式中不做 markdown 二次解析，避免抖动）；代码块 `--ap-fs-code` + `--ap-font-mono`、底 `--ap-surface-code`、右上角 `复制` 按钮 |
| 结束后 | 输入框 `--ap-duration-base`（200ms）内恢复可编辑（焦点自动回输入框）；助手消息元数据行显现 |
| 中断 | 用户点`停止`（或 `Esc`）→ 流式光标消失，块尾追加 `--ap-fs-tool` + `--ap-text-tertiary` 灰字「已中断 · 已保留上述内容」，助手消息状态=`stopped`，输入框立即可用（§3.7-E） |

### 3.5 空态与引导（首次启动对齐 t7 AT-001 S2）

- **首次启动**（`sessions` 表为空）：应用自动创建一个会话（t7 要求"默认已有一个会话"），标题「新对话」，创建时间即启动时间。聊天区显示**引导块**（不用大插画，P1 降噪；上边距 `--ap-space-80`）：

  ```
  ┌ --ap-space-80 顶部留白 ───────────────────────────┐
  │ 你好，我是你的本地助理。                        │  ← --ap-fs-h2 + --ap-fw-semibold
  │ 我能读你的文件、执行命令、上网查资料，          │  ← --ap-fs-body + --ap-text-tertiary
  │ 也能记住你的偏好。每一项操作都会留在这里可查。   │
  │                                                │
  │ [让助理看看桌面上的文件] [记住：我常去的目录是…] │  ← 2 个建议 chip，--ap-size-toolbar 高，--ap-radius-pill，点击填入输入框不发送
  └────────────────────────────────────────────────┘
  ```
  > 欢迎语若使用 `--ap-font-display`，字号须 ≥ `--ap-fs-h1`（tokens.md §4.1 限定衬线体仅用于 ≥20px 展示型文案）；MVP 默认用 `--ap-font-sans` + `--ap-fs-h2`，不启用衬线体（Windows 中文衬线回退为宋体，小字号渲染差）。
- 引导块在该会话产生第一条消息后**永久消失**（不重复出现）。
- **无会话空态**（用户删掉全部会话）：§2 表中定义的居中空态卡。

### 3.6 陪伴感微交互（presence 五态映射 + 交互时间轴）

设计意图：t1 §6 指出 hanako 的差异化在"图形桌面 + 人格"，但 t2 的"陪伴感（克制、不打扰）"要求存在感**低幅持续**而非**高幅事件**。因此全部 presence 表达集中在**不超过 24px 的视觉元素**上，且一律不弹窗、不响铃、不改变焦点。

**presence 五态映射（取值与动效全部来自 tokens.md §3.1 与 §6.3，本文件不自定义任何颜色与时长）**

| 本文件场景 | presence 态 | token | 动效（tokens.md §6.3） |
|---|---|---|---|
| P-A 用户还在输入 | `presence-idle` | 圆点 `--ap-presence-idle`；文字 `--ap-presence-idle-text` | **静态 100%，无动画**（静息态不做任何动画） |
| P-B 已发送、首 token 未到 | `presence-thinking` | 圆点 `--ap-presence-thinking`；文字 `--ap-presence-thinking-text`；浅底 `--ap-presence-thinking-subtle` | `--ap-duration-breath`（2400ms）`infinite alternate` + `--ap-ease-breathe`；`opacity 0.55 ↔ 1`、`scale 1 ↔ 1.05` |
| P-B′ 流式追加中 | `presence-streaming` | 圆点/标签 `--ap-presence-streaming`；文字 `--ap-presence-streaming-text` | **无脉冲**（静态色）；文本 + 光标已足够可见 |
| P-C 工具执行中 | `presence-acting` | 圆点/竖条 `--ap-presence-acting`；文字 `--ap-presence-acting-text` | `--ap-duration-pulse`（900ms）`infinite` + `--ap-ease-breathe`；三点 `opacity 0.35/0.65/1`，**相位差 150ms** |
| P-E 待用户确认（越界确认区、限额拒绝后等待） | `presence-awaiting` | 圆点 `--ap-presence-awaiting`；文字 `--ap-presence-awaiting-text` | 入场一次 `--ap-duration-slow`（320ms）+ `--ap-ease-settle`；**入场后完全静止**（静止实心 + 外环 `--ap-presence-ring-width` / `--ap-presence-ring-offset`） |

**硬规则（依 tokens.md §3.1 依据 3、§1-P3）**：`presence-awaiting` **禁止任何持续动效**——等待用户决定时若有动效，用户会误以为系统仍在忙而不去操作，直接破坏 t7 AT-506／G4「超限必须显式报错并等待」的可读性。
**进行时与终态严格分离**：`presence-*` 只表达进行时；任务/工具的终态一律用 `--ap-success-text` / `--ap-danger-text` / `--ap-text-tertiary` + 文字标签，且**渲染后不再变色、不带动效**（对应 t1 P0-1「终态不可降级」）。二者禁止互相顶替。
**治理类信息禁止使用情绪色与呼吸动效**：限额拒绝、沙箱越界、终态提示只用 `danger`/`warning`/中性色（tokens.md §1-P3）。
**每个状态必须同时渲染文字标签**（如「思考中」「执行中」「待你确认」）：信息不得只由颜色承载，且 reduced-motion 下文字标签是唯一信息源（tokens.md §3.1 依据 4）。

**P-A 打字中（typing）—— 用户还在输入**
- 输入框左侧 `--ap-presence-dot-size`（8px）圆点，色 `--ap-presence-idle`；仅当输入框有内容且获得焦点时以 `--ap-text-muted`→`--ap-presence-idle` 一次性颜色切换（`--ap-duration-fast`）表示"草稿中"，**不做循环动画**。
- 顶部会话状态点同步为「草稿中」（仅颜色 + 文字，不弹文案）。

**P-B 思考中（thinking）—— 已发送，未出首 token（交互时间轴）**
- 时间轴：`t=0` 发送 → 用户消息立即落位（乐观渲染，`opacity .6`，落库确认后 `.6→1` 用 `--ap-duration-fast`）。
- `t+250ms` 起：助手消息位出现打字指示——三圆点使用 `presence-thinking` 态：依次 `opacity 0.55↔1` + `scale 1↔1.05`，周期 `--ap-duration-breath`，相位差 = 周期 ÷ 3。
- `t+2.5s` 仍未出首 token：圆点右侧追加 `--ap-fs-tool` + `--ap-text-tertiary` 文案「正在思考…」。
- `t+8s`：文案改为「还在处理，可能需要一点时间…」，并在输入区辅助行提示「可随时按 Esc 停止」。
- `t+30s`：转入 §3.8-E3 超时错误。
- 首 token 到达：打字指示整体 `opacity→0`（`--ap-duration-fast`）后卸载，正文从同一位置开始（**不发生布局跳动**：打字指示与首行正文共用同一行高基线 `--ap-lh-body-lg`）。

**P-B′ 流式追加中（streaming）**
- 助手头像点与光标切换为 `presence-streaming` 态（色 `--ap-presence-streaming`），**不加脉冲动效**——避免与光标闪烁形成双重动效。
- 增量尾段淡入用 `--ap-duration-stream` + `--ap-ease-enter`（只作用于新追加的尾段）。

**P-C 任务执行中（acting）—— 工具正在跑**
- 不在消息流外另开"工作中"提示条（避免视觉噪声）；执行态**只体现在工具卡片自身**：卡片左缘 `--ap-size-indicator-rail`（3px）竖条取 `--ap-presence-acting`（tokens.md §6.3 presence acting 节拍），状态徽标「执行中」+ `--ap-presence-acting-text`，以及耗时计时器 `0.8s` 起、100ms 步进（等宽数字，避免抖动）。
- 助手头像点在此期间为 `--ap-presence-acting` 色（**不再借用 warning 色**，改为"动手通道"的苔绿，与"心智通道"的 amber 在色温上可分）。
- 长时间命令（> 10s）：卡片底部追加 `--ap-fs-tool` + `--ap-text-tertiary` 灰字「仍在运行（已 00:12）」，并出现`停止`文字按钮（`--ap-size-control` 高，`--ap-danger-text` 色）。
- 执行结束：竖条与徽标转终态色（`--ap-success` / `--ap-danger`）用 `--ap-duration-base`，**静态停留 3s**（交互时间轴），然后淡为 `--ap-border-subtle`（结果色不留永久高饱和，回到安静）；**终态落定后不再变化**。

**P-D 回合完成 → 回到静息（idle）**
- 回复完成后 presence 直接回到 `presence-idle`（**静态、无动画**）；**不设"完成脉冲"**——静息态不做任何动画是 tokens.md §6.3 的硬约定（不假装活着、不白耗电）。
- "送达感"改由**一次性确认**承担：工具调用成功、记忆已写入的场景允许使用 `--ap-ease-settle` + `--ap-duration-base` 做单次落定（tokens.md §6.2 限定：禁止用于布局位移或持续动画），且**每回合最多一次**。
- 不做：桌面通知、任务栏闪烁、提示音、红点计数（全部违反 P1）。

**P-E 待用户确认（awaiting）**
- 越界确认区出现时（§4.4）、限额拒绝后等待用户决定时，presence 切到 `presence-awaiting`：静止实心圆点 + 外环，入场一次 `--ap-ease-settle`，此后**完全静止**。
- 助手头像点与确认区标题行同步该态；文案固定为「待你确认」（`--ap-presence-awaiting-text`），不得写成"处理中/进行中"（避免与 P-C 混淆）。

### 3.7 输入区（多行 / 附件占位 / 发送与中断）

**几何**
- 容器：宽度 = `--ap-size-composer-max`（760px）− 2 × `--ap-space-40`；最小高 = `--ap-space-80` + `--ap-space-16`（96px），最大高 `--ap-space-48` × 5（240px，超出内部滚动）；背景 `--ap-surface-2`（浮起层），`--ap-border-w` `--ap-border-default`，圆角 `--ap-radius-bubble`，阴影 `--ap-shadow-xs`；聚焦时描边转 `--ap-border-focus` + `--ap-shadow-glow`。
- 内边距：上 `--ap-space-12`、左右 `--ap-space-16`、下 `--ap-space-8`。
- 输入框：`<textarea>` 自动增高，行高 `--ap-lh-body`（24px），1–8 行；`resize: none`；字号 `--ap-fs-body`、字体 `--ap-font-sans`。
- 工具条：高 `--ap-size-toolbar`（36px），左起 `附件占位`（`--ap-size-control-sm` 图标按钮）→ `斜杠占位`（同尺寸）→ 弹性空隙 → 字数计数（≥800 字才显示，`--ap-fs-caption`）→ `停止` 或 `发送`。

**按钮规格**

| 按钮 | 尺寸 | 常态 | 悬停 | 禁用 | 加载 |
|---|---|---|---|---|---|
| 发送 | `--ap-size-control`（32×32，`xs` 断点 40×40），图标 `--ap-space-16` | 底 `--ap-accent`，图标 `--ap-text-on-accent` | 底 `--ap-accent-hover` + 图标 `--ap-text-on-accent` | 输入为空或流式中：底 `--ap-surface-inset`，图标 `--ap-text-disabled`，整体 `opacity: var(--ap-opacity-disabled)`，`cursor: not-allowed` | 不适用 |
| 停止 | `--ap-size-control`（32×32），方形实心方块图标 | 底 `transparent`，描边 `--ap-border-w` `--ap-border-danger`，图标 `--ap-danger-text` | 底 `--ap-danger-subtle`，描边 `--ap-border-danger` | — | 点击后 300ms 内变为禁用 + `--ap-fs-tool`「正在停止…」 |

**交互规则（逐条定死）**
1. `Enter` 发送，`Shift+Enter` 换行；`Ctrl/Cmd+Enter` 等价发送（对习惯差异友好）。
2. **IME 保护**：`compositionstart` 到 `compositionend` 期间，`Enter` 一律不发送（中文输入法选词回车不得误发）。这是硬要求。
3. 输入为空（或仅空白）时发送按钮禁用；纯空白不发送。
4. 发送后：输入框立即清空（乐观），文本进入待发队列并渲染为乐观消息；落库失败则把文本**回填到输入框**并给出行内错误（不丢用户输入）。
5. **中断动线**：流式中发送按钮替换为停止按钮（同位置，不位移）；`Esc` 全局等效停止；停止后已产出内容保留（§3.4）。
6. **队列**：流式中允许继续输入与发送——第二条进入队列，输入区辅助行显示「已排队 1 条，将在当前回复结束后发送」（`--ap-fs-tool` + `--ap-warning-text`）+ `取消排队` 文字按钮。t7 AT-009 G4-2 要求"第二条排队"可被观测，此处即观测点。
7. **附件占位**：MVP 不做真实上传。点击附件图标 → 弹出宽 = `--ap-size-detail` 的面板（层级 `--ap-z-dropdown`）：标题「附件（二期）」+ 一行 `--ap-fs-tool` 说明「M1 支持在消息里直接写文件路径，我会去读。」+ `插入路径` 按钮（点击后往输入框插入 `""` 并把光标置于其中）+ `知道了` 按钮。**不出现"上传中"假进度**（不得制造未实现能力的假象）。
8. **斜杠占位**：MVP 不做命令面板。输入 `/` 时在输入框上方浮出 1 行 `--ap-fs-tool` 提示「斜杠命令二期开放」；不弹出选择器、不吞按键。
9. 输入历史：`ArrowUp` 在输入框为空且光标在首行时，取上一条已发送文本（最多 50 条）；`ArrowDown` 反向；到达末条后再按 `ArrowDown` 恢复草稿。
10. 输入框辅助行（高 `--ap-space-20`，默认只显示键位提示 `Enter 发送 · Shift+Enter 换行`，`--ap-fs-tool` + `--ap-text-tertiary`）：按优先级替换为 — ①错误提示（`--ap-danger-text`）②限额/拒绝提示（`--ap-warning-text`）③排队提示（`--ap-warning-text`）④默认键位提示。同一时刻只显示一条。

### 3.8 错误状态（逐类定义，禁止笼统 toast）

统一形态：**行内错误条**（宽 680px，底 `--ap-danger-subtle`，`--ap-border-w` 描边 `--ap-border-danger`，圆角 `--ap-radius-card`，内边距 `--ap-space-12` / `--ap-space-16`），结构 = `--ap-space-16` 图标 + 标题（`--ap-fs-body` + `--ap-fw-semibold`）+ 说明（`--ap-fs-tool`）+ 操作按钮（右对齐，`--ap-size-control` 高）。

| ID | 场景 | 标题 | 说明文案 | 操作 |
|---|---|---|---|---|
| E1 | LLM 请求失败（网络/服务端 5xx） | 回复失败 | 「请求没有成功：<原始错误摘要，≤120 字>。」 | `重试`（重发同一用户消息，不重复落库用户消息）· `复制错误` |
| E2 | 鉴权/密钥无效（401/403） | 未配置或密钥无效 | 「请检查设置中的 API Key。」 | `打开设置` |
| E3 | 首 token 超时（> 30s） | 响应超时 | 「30 秒内没有收到任何内容。」 | `重试` · `停止等待`（结束等待，保留已输入） |
| E4 | 流式中断（连接断/进程被杀后恢复） | 回复不完整 | 「连接中断，这条回复可能不完整。」 | `继续`（以当前内容续写）· `重试整条` |
| E5 | 落库失败 | 消息未保存 | 「这条内容没有写入本地数据库，重启后可能丢失。」 | `重试保存` · `复制内容`（并给 13px 提示"请先复制"） |
| E6 | 工具调用失败 | 见 §4.6（工具卡片内部呈现，不用本表） | — | — |
| E7 | 限额拒绝（t1 P0-5 / t7 AT-505） | 已达限额 | 「并发已达上限（2），本条已排队。」（排队=warning，不算错误）或「子任务数已达上限（5），本次请求被拒绝。」 | `知道了`（错误）/ `取消排队`（warning） |
| E8 | 会话列表读取失败 | 会话列表不可用 | 「本地状态读取失败。」 | `重试` |
| E9 | 记忆/任务视图读取失败 | 数据读取失败 | 「本地状态读取失败。」 | `重试` |

约束：错误条**不自动消失**；同一回合最多 1 条错误条（新的替换旧的并注明）；错误文案必须含**可执行下一步**；禁止使用 `出错了` 这类无信息文案。所有错误同时写 `events`（metadata-only，不记正文），保证 P5 与 t1 P1-7。

### 3.9 重连 / 降级状态

| 场景 | 表现 |
|---|---|
| 后端进程/本地服务不可达（启动中） | 全屏居中块：`--ap-presence-thinking` 点（`--ap-duration-breath` 呼吸，配文字标签）+ 「正在连接本地服务…」（`--ap-fs-body`）+ `--ap-fs-tool` 副文案「首次启动可能需要几秒」。无按钮。30s 未通则转错误块：「本地服务未能启动」+ `重试` + `查看日志`（打开 `state/` 目录）。 |
| 运行中后端断开 | 聊天区顶部固定提示条（高 `--ap-size-control`，底 `--ap-warning-subtle`，描边 `--ap-border-w` `--ap-border-warning`，圆角 0，全宽，层级 `--ap-z-sticky`）：**「本地服务已断开，消息不会发送」** + 右侧 `重连`（文字按钮，`--ap-accent-text`）。输入框禁用（placeholder 改为「等待重连…」），发送按钮禁用。每 5s 自动重连一次，成功后提示条替换为同尺寸提示条（底 `--ap-success-subtle`、描边 `--ap-border-success`、文字 `--ap-success-text`）「已重连」（3s 后自动消失）。 |
| 重连后队列 | 断开期间输入的内容保留在输入框（不丢）；若已排队消息未发送，保留在队列并标注「未发送」。 |
| 只读降级（库被占用/迁移只读） | 顶部同尺寸提示条「本地状态只读：可以查看，写入暂停」（`--ap-warning-subtle` / `--ap-warning-text`）；记忆删除、任务清理按钮禁用（`--ap-text-disabled` + `opacity: var(--ap-opacity-disabled)`，title：「当前为只读模式」）。 |
| **重启恢复**（t7 AT-403） | 启动后左栏会话列表按 `updated_at` 倒序恢复；**不自动打开上次会话**（P1：不抢焦点），但列表首项高亮为 `上次对话` 徽标（`--ap-fs-caption` + `--ap-text-tertiary`）；消息流为空态「选择左侧对话继续」。用户点击后完整加载历史。 |

---

## 4. 工具调用呈现

### 4.1 工具卡片信息层级（四层，从上到下）

```
┌ 工具卡片（640px × 自适应，圆角 --ap-radius-tool-card，--ap-border-w --ap-border-subtle，底 --ap-surface-1）┐
│ L1 头部（高 --ap-space-20）： [16px 图标] 工具名（--ap-fs-body 600）  ← 危险徽标（如「会写入磁盘」）│
│                                  右侧：状态徽标 · 耗时 · 展开箭头 ▾        │
│ L2 摘要行（高 --ap-space-20）：一行参数摘要（--ap-fs-tool，--ap-font-mono，单行省略，悬停显示全量 tooltip）│
│ L3 结果区（默认 0 行；成功且短 → 最多 3 行；失败 → 1 行错误首行）           │
│ L4 展开详情（默认收起）：参数全量（JSON，等宽，可复制）+ 结果全量 + 元数据    │
└──────────────────────────────────────────────────────────────────────┘
```

**层级职责（对齐 t7 的可比对要求）**

| 层 | 内容 | 数据来源 | 可见性 |
|---|---|---|---|
| L1 | 工具名（见 §4.2 映射表）、危险等级徽标、`status` 徽标、耗时 | `tool_calls.tool_name/status/created_at` | 始终可见 |
| L2 | **参数摘要**：按工具给出人类可读摘要（见 §4.2），示例 `C:\agentplant\sandbox\hello.md ← 3 行` | `tool_calls.args`（截断 120 字符） | 始终可见 |
| L3 | **结果摘要**：`read`→前 3 行内容；`write`→`已写入 3 行 / 128 B / mtime 10:16:20`；`shell`→`exit 0` + stdout 前 3 行（stderr 用 `--ap-danger-text` 色）；`search`→结果条数 + 首条标题；`browse`→页面标题 + URL | `tool_calls.result/exit_code` | 成功/失败后始终可见（成功且无输出时可空） |
| L4 | 参数原文（JSON 格式化 2 空格）、结果原文（> 4KB 时折叠为前 200 行 + 「在详情面板打开」）、调用 id（8 位短 id，等宽，可复制）、开始/结束时间（ISO） | 全量 | 点击头部或 `Enter` 展开 |

**展开状态**：`collapsed`（默认）/ `expanded`（手动）/ `expanded-auto`（失败时**自动展开**，因为失败必须显式；用户手动收起后不再自动展开）。

### 4.2 工具清单与呈现映射（MVP 最小工具集，t2 §2-2）

| 工具 | 中文名 | 图标 | 危险级 | L2 参数摘要规则 | L3 结果摘要规则 | 特殊呈现 |
|---|---|---|---|---|---|---|
| `read_file` | 读取文件 | 📄 | `safe` | 路径（中段省略，保留盘符+文件名） | `读取 N 行 / N B`，前 3 行折叠预览 | 无 |
| `write_file` | 写入文件 | ✎ | `caution` | `路径 ← N 行内容` | `已写入 N 行 / N B` + `mtime HH:mm:ss` + 文件存在校验点（§4.4） | 卡片左缘 `--ap-size-indicator-rail` 竖条 `--ap-warning-text` |
| `run_command` | 执行命令 | ▸_ | `danger` | 命令行原文（等宽，完整展示不省略——t7 AT-003 S2 要求"显示实际命令文本"） | `exit {code}`（等宽、`exit 0` → `--ap-success-text`；非 0 → `--ap-danger-text`）+ stdout 前 3 行 + stderr（若有，单独 `--ap-danger-text` 区，最多 5 行） | 命令用 `--ap-fs-code` + `--ap-font-mono` 独占一行、`--ap-surface-code` 底、可横向滚动；左缘 `--ap-size-indicator-rail` 竖条 `--ap-danger` |
| `web_search` | 网页搜索 | 🔍 | `safe` | 查询词（加引号） | `N 条结果` + 首条标题（`--ap-fs-tool`，单行省略） | 无 |
| `browse_page` | 打开网页 | 🌐 | `safe` | URL（域名加粗+路径次级；超 120 字符中段省略） | 页面标题（`--ap-fs-tool` + `--ap-fw-semibold`）+ URL（`--ap-fs-tool` + `--ap-text-tertiary`，可复制） | 结果区提供 `在系统中打开`（文字按钮，`--ap-size-control` 高，`--ap-accent-text`）——t7 AT-004 S3 允许"外部浏览器已打开该 URL" |
| `memory_write` | 记住 | ◆ | `safe` | `kind: 偏好/事实` + 内容首 60 字 | `已记录（#<短 id>）` | 结果区提供 `在记忆中查看`（切到记忆视图并选中该条）；允许 `--ap-ease-settle` 单次确认 |
| `memory_search` | 检索记忆 | ◇ | `safe` | 查询词 | `命中 N 条` + 第一条内容首 40 字 + `#<短 id>` | 命中 id 必须可见（t7 AT-006 S4 要求与 AT-005 的 id 一致）；`在记忆中查看` |

未在表中的工具（后续新增）：一律降级为通用形态——图标 `⚙`、危险级 `caution`（保守默认）、L2 显示 `JSON.stringify(args)` 截断 120 字符、L3 显示结果首 3 行；**不允许**出现无参数摘要的卡片。

### 4.3 卡片的动态状态（与 §3.6 P-C 联动）

| status 值 | 状态徽标 | 徽标样式 | 左缘竖条（`--ap-size-indicator-rail`） | 折叠箭头 |
|---|---|---|---|---|
| `pending`（已请求未开始） | 待执行 | `--ap-text-tertiary` 文字 + `--ap-presence-dot-size` 灰点（`--ap-presence-idle`） | `--ap-border-subtle` | 可展开 |
| `running` | 执行中 · `0.8s` | `--ap-presence-acting-text` 文字 + `presence-acting` 节拍点 | `--ap-presence-acting`（`--ap-duration-pulse` 节拍；**不再借用 warning 色**） | 可展开（参数已可见，结果区显示骨架） |
| `success` | 成功 · `1.2s` | `--ap-success-text` 文字 + ✓ | 3s 后转 `--ap-border-subtle`（终态落定后不再变化） | 可展开 |
| `error` | 失败 · `0.6s` | `--ap-danger-text` 文字 + ！ | `--ap-danger`（静态） | **自动展开** |
| `denied`（用户拒绝/被沙箱拦截） | 已拒绝 | `--ap-danger-text` 文字 + ⊘ | `--ap-danger` | 自动展开，且显示拒绝原因原文（t1 P0-4「显式报错」） |
| `cancelled`（用户停止） | 已取消 | `--ap-text-tertiary` 文字 | `--ap-border-subtle` | 可展开 |

**卡片出现动效**：新卡片插入时 `opacity 0→1` + 位移 `--ap-motion-slide-sm` × `--ap-motion-scale`，`--ap-duration-base`（200ms）+ `--ap-ease-enter`（`animate-ap-enter`）；同时消息流自动滚动跟随（若在底部）。reduced-motion 下仅淡入（`--ap-motion-scale` 置 0）。

**并发/顺序**：同一回合内多个工具卡片按**开始时间**顺序垂直排列；并行执行的卡片各自独立状态点，不合并为"批量"卡（保证可审计的一对一映射）。

### 4.4 危险操作（写文件 / 执行命令）的视觉区分与确认动线

**危险级可视化（三级，不改功能只改呈现）**

| 级别 | 适用 | 卡片头部徽标 | 头部底色 | 左缘竖条 | 图标色 |
|---|---|---|---|---|---|
| `safe` | `read_file`/`web_search`/`browse_page`/`memory_*` | 无 | `--ap-surface-1` | `--ap-border-subtle` | `--ap-text-tertiary` |
| `caution` | `write_file`（路径在工作目录内） | `会写入磁盘`（`--ap-warning-text` 文字 + `--ap-border-w` `--ap-border-warning` 描边，圆角 `--ap-radius-xs`，内边距 `--ap-space-2` / `--ap-space-6`） | `--ap-surface-1` | `--ap-warning-text` | `--ap-warning-text` |
| `danger` | `run_command`（全部）、`write_file`（路径在工作目录外） | `会执行命令` / `会写入工作目录外`（`--ap-danger-text` 文字 + `--ap-border-w` `--ap-border-danger` 描边） | `--ap-danger-subtle` | `--ap-danger` | `--ap-danger-text` |

**确认动线（推荐方案：默认放行 + 越界确认，绝不每步弹窗）**

设计取舍：t2 拍板"允许 shell 命令，沙箱初版约束"，且 §0.3-P1 要求不打扰。因此**不做每次调用的模态确认**（那会把日常对话变成审批流），改为**边界触发的就地确认**：

```
工具即将执行
  ├─ 读类 / 记忆类（safe）
  │    → 不确认，直接执行，卡片事后可见（可审计）
  ├─ 写类（caution，路径在工作目录内）
  │    → 不确认，直接执行，卡片带「会写入磁盘」徽标；结果区强制显示落盘校验（§4.4 校验点）
  ├─ 写类越界（danger：工作目录外路径）
  │    → 就地确认：卡片进入 `pending_confirmation` 态
  └─ 命令执行（danger）
       → 就地确认：卡片进入 `pending_confirmation` 态
```

**`pending_confirmation` 卡片的形态与交互（唯一确认 UI，非模态）**

- 卡片在消息流中**就地**呈现（不弹模态、不遮罩、不抢焦点），此时工具卡片底部展开一块确认区（最小高 `--ap-space-64`）：
  - 顶行（`--ap-fs-body` + `--ap-fw-semibold`，`--ap-danger-text` 色）：`这条命令会在你的机器上执行，是否继续？`；presence 切换为 `presence-awaiting`（**静止实心 + 外环，无持续动效**）。
  - 次行（`--ap-fs-code` + `--ap-font-mono`，底 `--ap-surface-code`，圆角 `--ap-radius-control`，横向可滚）：完整命令原文 / 完整目标路径。
  - 操作行（右对齐，按钮高 `--ap-size-control`）：`拒绝`（次要按钮：透明底 + `--ap-border-w` `--ap-border-default` + `--ap-text-primary`）、`允许一次`（主按钮：`--ap-accent` 底 + `--ap-text-on-accent`）。
- **键盘**：确认区出现时按 DOM 顺序把焦点置于 `允许一次`（**不是** `拒绝`，因用户刚刚主动要求了这个动作）；`Tab` 在两者间循环；`Enter` 执行当前聚焦按钮；`Esc` 等同 `拒绝`。
- **超时**：**不设自动确认超时**（t1 P0-4：禁止静默降级）。未确认期间卡片保持 `待确认` 徽标（`--ap-warning-text`），presence 保持 `presence-awaiting`，助手回合保持"未完成"状态，消息流不阻塞（用户可继续输入，但该回合被视为进行中，见 §6.4 的"未交付"语义）。
- **拒绝后**：卡片转 `denied`，展示拒绝原因原文（`用户拒绝了本次执行`），并把结果回注给 Agent 作为一次工具结果（Agent 必须据此给出显式说明，不得静默改用其他方式执行同类危险操作——t1 P0-4）。`denied` 计入 `events`；presence 回落 `presence-idle`。
- **允许后**：卡片转 `running`，确认区收起为 1 行 `--ap-fs-tool` 记录「已由用户允许（HH:mm:ss）」，留在卡片内可审计；presence 转 `presence-acting`。
- **一次性语义**：`允许一次` 只对该次调用生效；MVP **不做**"本次会话始终允许"选项（避免把安全策略藏进会话状态，也避免扩大 MVP 面）。

**沙箱拦截（非用户确认路径）**：命令越界/被沙箱规则拦下时，卡片直接呈现 `denied` + 拦截规则原文（t7 AT-003 失败即阻塞条目要求"命令越出工作目录（沙箱未拦）"可被观测；UI 必须让拦截可见）。**不得**表现为"执行成功但无输出"。

**写文件的落盘校验点（防"声称写入"）**：`write_file` 卡片的结果区在 `success` 时必须显示三项：`已写入 N 行 / N B`、`mtime HH:mm:ss`、`路径存在 ✓`（UI 侧以工具返回的校验结果为唯一来源；工具未返回校验结果时显示 `未校验`（`--ap-warning-text` 文字）而不是伪造成功）。依据：t1 §4 P0-3、t7 CP-01。

### 4.5 可审计性（历史可追溯）

| 要求 | 落地 |
|---|---|
| 每次调用一对一留痕 | 卡片与 `tool_calls` 行一一对应；卡片 L4 显示记录 id（短 id 8 位） |
| 会话内可回看 | 消息流滚动即历史；MVP **不做**"仅看工具调用"过滤器（避免超出范围），但提供 `J`/`K` 在卡片间跳转（§7） |
| 跨会话追溯 | 任务视图（§6）与记忆视图（§5）各自提供 `查看原对话` → 定位到产生它的会话并滚动到该消息并高亮 1.2s（交互时间轴；高亮底取 `--ap-accent-subtle`） |
| 审计账本可见范围 | 任务详情内呈现 `events` 时间线（**metadata-only**：只显示事件类型、时间、对象 id、结果码），**不显示正文/参数**（t1 P1-7、t7 §2.1 审计旁证）。若需要在 UI 看到参数原文，走工具卡片（那是用户自己的会话内容，语义不同） |
| 不可编辑性 | 工具卡片与事件时间线均为**只读**；无删除、无重试按钮（重试只能在助手回复层发起，避免"改历史"） |

---

## 5. 记忆视图

### 5.1 布局

```
┌ 记忆视图（占据聊天主列位置，左栏仍在）──────────────────────────────┐
│ 顶栏 --ap-size-titlebar： 「记忆」--ap-fs-h2 600 + 计数徽标（共 N 条）  │
│                            + 右侧搜索框（--ap-size-detail × --ap-size-control）│
│ 过滤行 --ap-space-40： [全部] [偏好] [事实] 分段控件（各 --ap-size-control 高，圆角 --ap-radius-control）│
│ 列表 flex:1： 每条 --ap-space-64 + --ap-space-8 高卡片，间距 --ap-space-8，左右内边距 --ap-space-40│
│  · 左 --ap-space-24：类型图标（◆ 偏好 / ● 事实）                      │
│  · 主 --ap-fs-body：内容（最多 2 行，超出省略）                        │
│  · 次 --ap-fs-caption：来源摘要 + 时间 + 右侧悬停操作                  │
└──────────────────────────────────────────────────────────────────┘
```

- 记忆条目的字段（与 `memories` 表对齐）：`kind`（`preference`|`fact`）、`content`、`created_at`、`source_session_id`、`source_message_id`、`id`。
- **排序**：`created_at` 倒序（最新在上）；不做手工排序/置顶（MVP 无此面）。
- **分组**：不按类型分组，仅用分段控件过滤（避免双重分组带来认知负担）。
- **搜索**：`--ap-size-detail` × `--ap-size-control`（320×32）输入框，按内容子串匹配（MVP 不做向量检索，t2 §5-3），输入即时过滤（无按钮）；无命中显示「没有匹配的记忆」+ `清除搜索`。

### 5.2 来源可追溯（哪次对话沉淀的）

每条记忆的次要行固定为：

```
来自「<会话标题>」· 3 天前（2026-09-08 10:16）    [查看原对话]
```

- 有 `source_session_id`：会话标题可点击（`--ap-accent-text`）→ 切到对话视图、打开该会话、滚动到 `source_message_id` 对应消息并高亮 1.2s。
- 会话已被删除：显示 `来自已删除的对话 · 2026-09-08`，`查看原对话` 置灰（`--ap-text-disabled` + `opacity: var(--ap-opacity-disabled)`，title：「原对话已删除」）。
- 无来源（二期手动新增等）：显示 `手动添加`（MVP 不产生此类数据，但留分支避免脏数据显示空白）。
- 悬停记忆条目时，右侧出现 `--ap-size-control` 图标按钮：`查看原对话` + `删除`。

### 5.3 轻量管理（查看 / 删除；**编辑为二期**）

| 操作 | MVP | 交互 |
|---|---|---|
| 查看 | ✅ | 列表 + 点击条目在右侧检查器（`below-compact` 断点下为覆盖层）显示详情：完整内容（`--ap-fs-body-lg`，可选中复制）、类型、id、创建时间、来源会话/消息、关联的工具调用卡片摘要（`memory_write` 工具名 + 时间 + 短 id） |
| 删除 | ✅ | 条目右侧 `删除`（垃圾桶图标，`--ap-size-control`）→ **行内确认**（不弹模态）：该条目行替换为 `--ap-space-64` 高确认行，文案「删除这条记忆？删除后不会再被回忆起。」+ `取消` / `删除`（危险主按钮：`--ap-danger` 底 + `--ap-danger-on` 字）。确认后条目 `opacity→` `--ap-opacity-hidden` + 高度收起（`--ap-duration-base`）移除，列表顶部出现提示条「已删除 · 撤销」（可撤销窗口 `--ap-duration-dwell-toast` = 6s，撤销后恢复原位置）。删除写 `events`（metadata-only）。 |
| 编辑 | ❌ 二期 | 明确不提供编辑入口（无铅笔图标、无双击编辑）。理由：t2 §5-3 记忆深度限定"偏好+事实简单记忆"，编辑会引入一致性/来源污染问题，二期随向量检索一起做。 |
| 手动新增 | ❌ 二期 | 空态文案已说明"记忆从对话沉淀"；不提供 `+ 新建记忆` 按钮（避免与"来源可追溯"冲突）。 |
| 批量清理 | ❌ | 不提供"清空全部记忆"（危险批量操作超出 MVP，且属于破坏性入口）。 |

### 5.4 记忆写入的即时可见性（对齐 t7 AT-005 / AT-006）

1. Agent 调用 `memory_write` → 聊天流中出现 `记住` 卡片（§4.2）；卡片结果区含 `#<短 id>` 与 `在记忆中查看`；允许 `--ap-ease-settle` 单次确认。
2. 左栏一级导航 `记忆` 项右上角**不显示红点**（P1），但计数徽标从 N 变为 N+1（数字滚动 `--ap-duration-fast`）。
3. 命中检索（`memory_search`）时，卡片结果区显示命中的 `#<短 id>`，与写入卡片 id 一致（t7 AT-006 S4 的可视化对照点）。
4. 若 Agent **仅在文本里说"已记住"却没有 `memory_write` 卡片**：该消息下方追加行内提示条（底 `--ap-warning-subtle`、描边 `--ap-border-warning`、文字 `--ap-warning-text`）「本回合没有记忆写入记录」+ `查看任务详情`。这是 t7 CP-02 在 UI 侧的呈现（P4：计划不是交付）。

---

## 6. 任务与状态呈现（轻量，不做 Kanban）

### 6.1 定位与形态

- **不做**看板、不做列拖拽、不做甘特、不做依赖图。
- 任务视图 = **一条纵向列表 + 一个右侧详情**，只回答三个问题：现在在做什么？做完了没有？凭什么说做完了？

```
┌ 任务视图 ────────────────────────────────────────────────────┐
│ 顶栏 --ap-size-titlebar：「任务」--ap-fs-h1 + 计数徽标 + 右侧筛选分段 [进行中][已完成][全部] │
│ 列表 flex:1：任务行 --ap-space-64 高，间距 --ap-space-6，左右内边距 --ap-space-40 │
│  · 左 --ap-presence-dot-size 状态点 · 主 --ap-fs-body 任务标题        │
│  · 次 --ap-fs-caption 最近事件 + 时间                                │
│  · 右 状态徽标（终态附 --ap-fs-caption 级锁定图标）                    │
└─────────────────────────────────────────────────────────────┘
```

- 筛选默认 `进行中`；计数徽标显示 `进行中 N · 共 M`。
- 列表项排序：`进行中` 按 `updated_at` 倒序 → 终态按 `updated_at` 倒序。

### 6.2 状态机在 UI 上的投影（与 `tasks.status` 一一对应）

| 库中 status | UI 文案 | 徽标 | 色 | 是否可再变 |
|---|---|---|---|---|
| `pending` | 待开始 | 空心圈 | `--ap-text-tertiary` | 可变 |
| `running` | 进行中 | `presence-acting` 节拍点 + 计时 | `--ap-presence-acting-text` | 可变 |
| `blocked` | 阻塞 | 竖线暂停符号 | `--ap-warning-text` | 可变 |
| `needs_input` | 需要你确认 | 问号（`presence-awaiting`） | `--ap-warning-text` | 可变 |
| `completed` | 已完成 | ✓ + **锁定图标** | `--ap-success-text` | **不可变（终态）** |
| `failed` | 失败 | ！ + **锁定图标** | `--ap-danger-text` | **不可变（终态）** |
| `cancelled` | 已取消 | ⊘ | `--ap-text-tertiary` | 终态，不可变 |

**终态不可降级的 UI 语义（t1 P0-1 / t7 AT-503）**
1. 终态行显示 `已完成` 徽标 + 锁定图标（`--ap-fs-caption` 尺寸），图标 `aria-label="终态，状态不可再变更"`。
2. 终态行**不出现**任何可变更状态的控件（MVP 本就无手改状态入口，此处以"无入口"作为语义强化）。
3. 若某种异常写入使 UI 收到与终态冲突的状态（如已完成任务收到 `running` 推送），**UI 必须保持终态显示**并在详情页顶部显示错误条（底 `--ap-danger-subtle`、描边 `--ap-border-danger`、文字 `--ap-danger-text`）：「收到与终态冲突的更新，已忽略（已完成 → 进行中）」——这条是本地状态机拒绝行为的可视化，直接支撑 AT-503 "显式报错（非静默忽略）"。
4. 终态**不显示计时器**（计时器停走并把最终耗时作为静态文本，如 `耗时 12.4s`）；终态色与文字**渲染后不再变化、不带动效**（tokens.md §2.3 终态语义）。

**CAS 领取冲突的 UI 语义（t1 P0-2 / t7 AT-009 G2）**
- 当第二个执行者尝试领取已被领取的任务：UI 在任务行与详情顶部显示提示条（底 `--ap-warning-subtle`、描边 `--ap-border-warning`、文字 `--ap-warning-text`）：「该任务已被领取（领取于 10:16:02），本次未重复执行。」
- 任务行右侧出现 `--ap-fs-caption` 的 `已被领取` 文字（`--ap-text-tertiary`）；**不出现第二个 running 指示**、不出现第二份进度文本——"不重复执行"必须在界面上可见。

### 6.3 "进度文本≠交付"（t1 P0-3 / t7 AT-504 / CP-01、CP-02）

两种消息在聊天流中的**视觉差异**（这是本设计最关键的一处语义编码）：

| | 待验证声明（plan-note） | 已交付（delivered） |
|---|---|---|
| 触发 | 助手输出"我接下来要…/我将要…/正在准备…"等未来时表述，**且**本回合尚无成功的工具调用/产物 | 本回合存在成功的工具调用 + 交付物校验通过 |
| 形态 | 正文块 + **左缘 `--ap-size-indicator-rail` 虚线** + 底部标签行：`◷ 仅计划，尚未执行`（`--ap-fs-tool` + `--ap-warning-text`，底 `--ap-warning-subtle`、圆角 `--ap-radius-xs`、内边距 `--ap-space-2` / `--ap-space-6`） | 正文块 + 底部标签行：`✓ 已核验交付`（`--ap-fs-tool` + `--ap-success-text`）+ `依据：<工具名> ×N`（`--ap-accent-text`，可点击 → 展开对应卡片） |
| 任务影响 | 若该回合结束时仍无成功工具调用 → 任务转 `blocked` 或 `needs_input`，UI 徽标同步；**绝不显示 `已完成`** | 任务可转 `completed`，且详情页展示交付凭据 |
| 反例防护 | 若只有文本、无 `tool_calls` 行 → 聊天流出现行内提示条（底 `--ap-warning-subtle`、描边 `--ap-border-warning`、文字 `--ap-warning-text`）「本轮没有对应的工具调用记录」+ `查看任务详情` | — |

**判定依据来源**：UI 不做语义推断（不解析中文时态），而是消费后端给出的 `turn.delivery` 字段（`claimed` / `verified`）。前端**只负责呈现**；后端未给该字段时，标签行显示为 `未提供交付状态`（`--ap-warning-text` 文字）而非默认显示"已核验"（**禁止把"未知"渲染为"成功"**）。

### 6.4 任务详情（右侧检查器，`--ap-size-detail` = 320px 宽）

分段结构（自上而下，间距 `--ap-space-16`）：

1. **标题区**：任务标题（`--ap-fs-h2` + `--ap-fw-semibold`，2 行内）+ 状态徽标 + （终态）锁定图标。
2. **元信息表**（`--ap-fs-tool`，标签 `--ap-text-tertiary`，值 `--ap-text-primary` / `--ap-font-mono`）：任务 id（短 id，可复制）、创建时间、更新时间、耗时、所属会话（可点击 → 跳转原对话）、领取信息（`claim_token` 短 id + 领取时间 + 领取者）。
3. **进度文本区**：最近一条来自 Agent 的进度文本（最多 3 行，超出「展开」）；标题行左侧标 `进度陈述（非交付）`（`--ap-fs-tool` + `--ap-warning-text`）。**该区块永远不与"已完成"徽标并列出现**；任务完成时此区显示 `—`。
4. **交付凭据区**（仅 `completed` 时显示，或 `failed` 时显示失败原因）：交付物清单（路径 + 大小 + sha256 前 12 位，`--ap-font-mono`，复制按钮）、核验方式（`依据工具调用` / `交付物存在性`）、关联工具卡片列表（工具名 + 短 id + 时间，点击 → 跳回聊天流并展开该卡片）。
5. **事件时间线**（metadata-only，只读）：最多展示 20 条，每条 1 行 `--ap-fs-tool`：`HH:mm:ss · <事件类型> · <对象短 id> · <结果码>`；无正文、无参数（t1 P1-7）。底部 `加载更多`（文字按钮）。
6. **拒绝/超限记录**：若发生过 `denied` 或限额拒绝，单独一块（底 `--ap-danger-subtle` / `--ap-warning-subtle`，描边 `--ap-border-danger` / `--ap-border-warning`）显示原文（如 `并发 lane 已达上限 2，本次请求被拒绝`，t7 AT-505 要求"三次拒绝报错"可见）。

**MVP 任务详情不提供的操作**：无"重跑"、无"取消任务"按钮（避免与 CAS/终态语义冲突产生绕过路径），无状态手改下拉。任务只能由 Agent 主循环推进——这既是范围控制，也是 P3（状态以库为准）的体现。

### 6.5 聊天流内的轻量任务呈现

- 当某回合产生了任务：该助手回合底部追加 1 行**任务条**（高 `--ap-size-control`，底 `--ap-surface-inset`，圆角 `--ap-radius-card`，内边距 `--ap-space-6` / `--ap-space-12`，层级 `--ap-z-raised`）：
  `[状态点] <任务标题> · <状态文案>  [查看详情 →]`
- 任务条只出现在**产生或终结该任务**的回合，不重复出现在每个回合（避免噪声）。
- 状态更新采用**就地更新**（同一 DOM 节点改文案与色），不新增消息、不插入新行（保持历史顺序稳定）。

### 6.6 关于页（唯一的"设置"面，且极简）

底部导航 `设置` 打开的是宽 `--ap-size-detail`（320px）、高自适应（最大 420px）的居中模态（层级 `--ap-z-modal` + 遮罩 `--ap-z-scrim`，圆角 `--ap-radius-modal`，阴影 `--ap-shadow-pop`），仅含 MVP 必需的 4 项，**不做设置中心**：

| 行 | 内容 |
|---|---|
| 1 | API Provider / 模型名（只读展示当前生效值，`--ap-fs-tool` + `--ap-font-mono`）；`API Key` 显示为 `已配置` / `未配置`（**不显示明文**） |
| 2 | 工作目录（`--ap-font-mono` 路径 + `在资源管理器中打开`，`--ap-accent-text`） |
| 3 | 数据位置（`state/assistant.sqlite` 的绝对路径 + `打开目录`），副文案 `--ap-fs-tool` + `--ap-text-tertiary`「所有会话、记忆与任务都在这一个文件里」 |
| 4 | 版本：`<version>`（`--ap-font-mono`）+ `构建 <gitSha 前 8 位>` + `构建于 <buildTime>` —— 支撑 t7 P2「版本戳四方一致」的 UI 侧；数据来源必须是构建期注入的常量，**禁止硬编码**（t7 FG-05） |
| 5 | 外观：`跟随系统 / 浅色 / 深色` 三选一（默认 `auto`，写 `localStorage.ap.colorScheme`，依 tokens.md §7.4/§8） |

---

## 7. 键盘与可达性

### 7.1 全局快捷键（应用级，任何视图有效）

| 快捷键 | 动作 | 备注 |
|---|---|---|
| `Ctrl/Cmd + N` | 新建对话 | 新建后焦点落输入框 |
| `Ctrl/Cmd + 1 / 2 / 3` | 切到 对话 / 记忆 / 任务 | 记忆/任务视图下 `1` 回对话并聚焦输入框 |
| `Ctrl/Cmd + K` | 打开记忆快速查找 | 切到记忆视图 + 聚焦搜索框 |
| `Ctrl/Cmd + ,` | 打开设置弹窗 | `Esc` 关闭 |
| `Ctrl/Cmd + B` | 折叠/展开左侧栏 | 折叠态 `--ap-space-64` |
| `Esc` | 上下文相关：流式中→停止生成；弹窗/浮层中→关闭；确认区中→拒绝 | 单一键位、按 `--ap-z-*` 层级自上而下消费 |
| `Ctrl/Cmd + Shift + .` | **在 `auto` / `light` / `dark` 三态间循环切换**（默认 `auto` 跟随系统） | 便于对比度与双主题自测 |
| `?`（`Shift + /`，输入框未聚焦时） | 显示快捷键帮助浮层（层级 `--ap-z-modal`，`Esc` 关闭） | 帮助浮层列出本表全部键位 |

### 7.2 输入区 / 会话快捷键

| 快捷键 | 动作 |
|---|---|
| `Enter` | 发送（IME 组合期间不生效） |
| `Shift + Enter` | 换行 |
| `Ctrl/Cmd + Enter` | 发送（等价） |
| `Esc` | 停止生成（流式中） |
| `ArrowUp` / `ArrowDown` | 输入框为空且光标在首/末行时，取历史输入 |
| `Tab` | 焦点离开输入框进入工具条（附件 → 斜杠占位 → 发送/停止） |
| `Ctrl/Cmd + F` | 当前会话内查找（浮层，输入即高亮匹配，`Enter`/`Shift+Enter` 上下跳转，`Esc` 关闭） |

### 7.3 消息流 / 检查器快捷键

| 快捷键 | 动作 |
|---|---|
| `J` / `K` | 在工具卡片之间向下/向上移动焦点（不滚动正文，只跳卡片） |
| `Alt + ArrowDown` / `Alt + ArrowUp` | 跳到下一条 / 上一条消息 |
| `Enter` / `Space` | 焦点在工具卡片头部时：展开/收起 L4 |
| `Ctrl/Cmd + C` | 焦点在卡片时复制卡片参数摘要（设计上"可复制"而非"可编辑"） |
| `Tab` / `Shift + Tab` | 在当前卡片内循环（头部 → 各按钮 → 下一个卡片头部） |
| `Ctrl/Cmd + Shift + D` | 打开/关闭右侧检查器（记忆详情 / 任务详情） |
| `Ctrl/Cmd + R` | 重试当前错误（**不**刷新窗口；窗口刷新快捷键在 Electron 中禁用，避免误丢失流式上下文） |

### 7.4 焦点管理规则

1. **焦点陷阱仅限模态弹窗**（设置、快捷键帮助）：`Tab` 循环在弹窗内，`Esc` 关闭并把焦点**归还到打开它的元素**。
2. **右侧检查器不是焦点陷阱**（它是非模态面板）：`Ctrl/Cmd + Shift + D` 打开后焦点进入面板标题；`Esc` 关闭并归还焦点。
3. **确认区（§4.4）**：出现时焦点移到 `允许一次`；`Esc` 拒绝并归还焦点给输入框。
4. **视图切换后**：`Ctrl/Cmd + 1` 后焦点落输入框（用户来对话就是要说话）；`2` 落搜索框；`3` 落列表第一项。
5. **发送后**：焦点**保持在输入框**（可以立刻继续打字），不做任何焦点跳转。
6. **可见焦点**：所有可聚焦元素 `:focus-visible` 显示 `--ap-focus-ring-width`（2px）外环，色 `--ap-border-focus`，偏移 `--ap-focus-ring-offset`（2px）；禁止 `outline: none`（tokens.md §5.5）。
7. **Tab 顺序**：左侧栏 → 顶栏 → 消息流 → 输入区 → 检查器，与视觉顺序一致（禁止 `tabindex` 正值）。

### 7.5 ARIA 角色要点（TS 实现逐条对照）

| 元素 | 角色/属性 | 说明 |
|---|---|---|
| 左侧导航 | `<nav aria-label="主导航">`；每项 `<a role="tab" aria-selected>` 或 `role="link" aria-current="page"` | 采用 `aria-current="page"`（视图切换语义，不引入 tablist 的箭头键行为） |
| 会话列表 | `<ul role="list">` + 每项 `<button aria-current="true">` 表示当前会话 | 列表项名称包含标题与相对时间 |
| 消息流容器 | `role="log" aria-live="polite" aria-relevant="additions text" aria-busy={streaming}` | **关键**：流式中 `aria-busy="true"`，仅在**回合结束时**把 `aria-busy` 置 false，避免读屏逐字播报 |
| 用户消息 | `<article aria-label="你说">` | 不进入 live region（自己的话无需播报两次） |
| 助手消息 | `<article aria-label="助理">` | 正文完成后整体进入 live region（见上） |
| 打字指示 | `role="status" aria-label="助理正在思考"` | 文本形态（"正在思考…"）本身即可读 |
| 工具卡片 | `<section role="group" aria-label="工具调用：执行命令">`；头部为 `<button aria-expanded aria-controls>` | 明确"这是一个可展开的工具调用组" |
| 工具状态徽标 | `<span role="status">` 包裹状态文案；色不作为唯一信息载体 | 必须带文字（"成功/失败/执行中"），不能只有颜色与图标 |
| 危险徽标 | 文本 + `aria-describedby` 指向确认区说明 | 「会执行命令」必须可被读屏读出 |
| 确认区 | `role="alertdialog"` 不合适（非模态）→ 用 `role="group" aria-labelledby="<标题 id>" aria-describedby="<说明 id>"`；标题区加 `aria-live="assertive"` 一次播报 | 不抢焦点之外的模态语义；一次性 assertive 播报告知"需要你的确认" |
| 错误条 | `role="alert"` | 错误必须立即播报 |
| 状态提示条（重连/只读） | `role="status"` | 非错误，礼貌播报 |
| 进度文本标签（§6.3） | 文本「仅计划，尚未执行」直接可读；不用 `aria-label` 覆盖 | 语义必须能被读屏完整获得 |
| 记忆条目 | `<li>` + 内容 + `<button aria-label="删除记忆：<内容前 20 字>">` | 按钮名必须唯一可辨 |
| 任务行 | `<li>` + `<button aria-expanded>` 语义（打开详情）；状态徽标含文字 | 终态行附加 `aria-description="终态，状态不可再变更"` |
| 骨架屏 | `aria-hidden="true"` + 容器 `aria-busy="true"` | 骨架不进入可访问树 |
| 图标按钮 | 必须有 `aria-label`；装饰性图标 `aria-hidden="true"` | 全站无"仅图标无名称"的控件 |
| 数字计时器 | `aria-hidden="true"`，状态徽标文字里给静态耗时（如 `成功 · 1.2s`） | 避免 100ms 级播报骚扰 |

### 7.6 对比度与可达性要求（WCAG 2.2 AA 为底线）

> **色彩对比度不在本文件定义，也不在本文件自测。**
> 唯一依据：`docs/design/tokens.md` §0.4（四类契约阈值）+ **附录 A（109 项逐项实测，0 项未达标）**。
> tokens.md 已按**全部 9 个背景表面**（surface-0/1/2/sunken/inset/code/bubble/row-hover/row-selected）取**最差值**判定，并保证明暗双主题**分别独立达标**——因此本文件不再重复任何色值或比值。
> 校验方式：`scripts/check-tokens.mjs`（解析 token 源文件复核附录 A），接入 CI 后与 `pnpm test` 同级门禁（t3 §3）。
> 本文件只补充 tokens.md 未覆盖的**组件级**可达性要求：

| 组件级要求 | 具体标准 | 落地 |
|---|---|---|
| 目标尺寸（键盘/鼠标场景） | 所有可点击元素 ≥ `--ap-size-control`（32×32px） | 图标按钮、徽标按钮、标签行内按钮一律不小于该值 |
| 目标尺寸（触屏断点） | `below-compact` / `xs` 下 ≥ 44×44px（`--ap-size-avatar-lg` 40px 为下限并补足外边距至 44px 触达区） | 发送/停止按钮在 `xs` 下放大到 40×40 并加 `--ap-space-2` 间隔 |
| 颜色非唯一编码（WCAG 1.4.1） | 每个状态**同时**有文字与形状/图标：成功/失败/执行中/待执行/待确认/已拒绝 | 见 §4.3 状态徽标表、§6.2 任务状态表；色盲可用 |
| 目标尺寸与文字重排 | 200% 缩放（或 320px 等效宽度）下 `md` 及以上不出现横向滚动 | 字体尺寸全部以 `--ap-fs-*`（px 基准）经 `rem` 换算，行高用无单位倍数 |
| 文字间距 | 支持用户样式覆盖 `letter-spacing` / `word-spacing` / `line-height` 而不破版 | 不把行高写死进容器高度；容器高一律用 `--ap-lh-*` 或 `--ap-space-*` 推导 |
| CJK 排版硬规则 | CJK `letter-spacing` 必须为 `--ap-tracking-normal`（0），全局 `font-synthesis: none` | tokens.md §4.3 硬规则 + §7.2 全局基线 |
| 焦点可见性 | `:focus-visible` 恒有 `--ap-focus-ring-width` 外环（tokens.md §5.5 已保证 ≥3:1 对比） | 见 §7.4 第 6 条 |
| 动效可达性 | `prefers-reduced-motion` 下所有状态**静态可读**（呼吸/节拍/光标/滑入），文字标签必须存在 | tokens.md §6.4 降级表；见 §1.5-⑤、§3.6 |
| 禁用态 | 仅用于**不可用控件自身**，不得用于任何需阅读的信息（`--ap-text-disabled` 为 AA 豁免档） | 只读模式下的禁用按钮必须另配可见说明文字（§3.9） |

---

## 8. 组件清单（供 TS 实现直接对照）

命名约定：`PascalCase` 组件；props 列出**关键项**（非穷尽），状态用字面量联合类型。所有组件必须实现 `§2 全局状态矩阵` 中属于它的四态（空/加载/错误/正常）。

### 8.1 外壳与导航

| 组件 | 职责 | 关键 props | 关键状态 |
|---|---|---|---|
| `AppShell` | 三栏布局、断点计算、主题注入 | `view: 'chat'\|'memory'\|'tasks'`、`sidebarCollapsed: boolean`、`inspector: InspectorTarget \| null`、`breakpoint: 'below-compact'\|'md'\|'lg'\|'xl'`、`colorScheme: 'auto'\|'light'\|'dark'` | — |
| `SidebarNav` | 一级导航（对话/记忆/任务） | `view`、`onSelect(view)`、`counts: { memory: number; tasksRunning: number }` | 选中/悬停/聚焦；折叠态仅图标 |
| `SessionList` | 会话列表 + 分组 + 新建 | `sessions: SessionItem[]`、`activeId`、`loading`、`error`、`onSelect`、`onCreate` | 空/骨架/正常/错误 |
| `SessionListItem` | 单条会话 | `id`、`title`、`updatedAt`、`isActive`、`isLastActive` | hover 显形操作（`⋯` 菜单：重命名/删除） |
| `AppFooter` | 设置入口 + 版本 | `version`、`onOpenSettings` | — |
| `ConnectionBanner` | 顶部状态条（断开/只读/已重连/冲突），高 `--ap-size-control` | `tone: 'warning'\|'danger'\|'success'\|'info'`、`message`、`action?: {label, onClick}` | 出现/消失（`--ap-duration-slow`） |

### 8.2 聊天

| 组件 | 职责 | 关键 props | 关键状态 |
|---|---|---|---|
| `ChatHeader` | 会话标题、状态点、`⋯` 菜单 | `sessionId`、`title`、`presence: PresenceState`、`onRename`、`onDelete` | — |
| `MessageStream` | 滚动容器、自动跟随、live region | `blocks: Block[]`、`streaming: boolean`、`onReachTop`（加载更早消息） | `following` / `userScrolledUp` |
| `DateDivider` | 日期分隔 | `date: string` | — |
| `UserMessageBubble` | 用户消息（右对齐气泡） | `content`、`createdAt`、`pending: boolean`（乐观态） | normal / pending(0.6 opacity) / failed |
| `AssistantTurn` | 助手回合容器（块序列 + 元数据行 + 任务条 + 交付标签） | `blocks`、`delivery: 'claimed'\|'verified'\|'unknown'`、`model`、`createdAt`、`taskRef?` | `thinking` / `streaming` / `stopped` / `complete` / `error` |
| `StreamingText` | 流式正文（含光标、块落地动效） | `text`、`isStreaming`、`onStop` | streaming / complete |
| `ThinkingIndicator` | 打字点 + 分级文案（250ms / 2.5s / 8s / 30s，交互时间轴） | `elapsedMs: number`、`hasFirstToken: boolean` | dots（`presence-thinking` 呼吸）/ dots+text / dots+text+stopHint |
| `PlanNoteBadge` | 「仅计划，尚未执行」标签 | `visible: boolean` | — |
| `DeliveryBadge` | 「已核验交付 / 未提供交付状态」+ 依据链接 | `delivery`、`evidence: {toolName, count, toolCallIds}`、`onOpenEvidence` | verified / unknown |
| `MessageMeta` | 时间/模型/复制（悬停显形） | `createdAt`、`model?`、`onCopy` | hidden / visible |
| `InlineNotice` | 行内提示条（警告/错误/成功） | `tone`、`title`、`description`、`actions: NoticeAction[]` | 同一回合最多 1 条 |
| `ChatComposer` | 输入区容器（textarea + 工具条 + 辅助行） | `value`、`disabled`、`streaming`、`queueLength`、`hint`、`onSend`、`onStop`、`onCancelQueued` | idle / typing / streaming / queued / disabled(重连/只读) |
| `ComposerToolbar` | 附件占位、斜杠占位、计数、发送/停止 | `charCount`、`canSend`、`streaming`、`onAttach`、`onSend`、`onStop` | 发送/停止互换 |
| `AttachmentPlaceholderPanel` | 附件占位浮层（MVP 无真实上传） | `open`、`onInsertPath`、`onClose` | — |
| `JumpToLatestButton` | 回到底部（含未读计数） | `unreadCount`、`onClick` | 出现/隐藏 |
| `ScrollToMessageHighlight` | 定位并高亮（来自记忆/任务跳转） | `messageId`、`durationMs: 1200` | — |
| `ChatEmptyState` | 首启引导块 / 无会话空态 | `variant: 'firstRun'\|'noSession'`、`suggestions: string[]`、`onPickSuggestion` | — |
| `ComposerQueueHint` | 排队提示 | `count`、`onCancel` | — |

### 8.3 工具调用

| 组件 | 职责 | 关键 props | 关键状态 |
|---|---|---|---|
| `ToolCallCard` | 工具卡片容器（L1–L4 编排） | `toolCall: ToolCallVM`、`expanded`、`onToggle`、`onOpenDetail`（跳检查器） | collapsed / expanded / expanded-auto（失败时） |
| `ToolCardHeader` | 图标、工具名、危险徽标、状态徽标、耗时、展开箭头 | `toolName`、`danger: 'safe'\|'caution'\|'danger'`、`status`、`durationMs` | 各 status |
| `DangerBadge` | 「会写入磁盘 / 会执行命令 / 会写入工作目录外」 | `level`、`label` | — |
| `ToolStatusBadge` | 待执行/执行中/成功/失败/已拒绝/已取消 + 文字 | `status`、`durationMs?`、`exitCode?` | 6 态 |
| `ToolArgSummary` | L2 参数摘要（按工具规则生成） | `toolName`、`args`、`summaryText` | 单行省略 + tooltip 全量 |
| `ToolResultSummary` | L3 结果摘要（按工具规则） | `toolName`、`result`、`exitCode?`、`stderr?` | empty / short / failed / verifying |
| `CommandBlock` | 命令原文独占行（等宽、横向滚动） | `command: string` | — |
| `ExitCodeChip` | `exit 0` / `exit 1` 芯片 | `code: number` | success(0) / error(非 0) |
| `ToolDetailPanel` | L4 展开区（参数 JSON、结果原文、id、时间戳、复制） | `args`、`result`、`callId`、`startedAt`、`finishedAt`、`truncated: boolean` | normal / truncated(>200 行) |
| `DangerConfirmBlock` | 就地确认区（非模态，键盘焦点入 `允许一次`） | `toolName`、`commandOrPath`、`onAllowOnce`、`onDeny` | idle / deciding / allowed(HH:mm:ss 记录行) / denied |
| `FileWriteVerify` | 写文件落盘校验三项（行数/字节、mtime、路径存在✓/未校验） | `lines`、`bytes`、`mtime`、`verified: boolean` | verified / unverified(--ap-warning-text) |
| `ToolCardSkeleton` | running 时结果区骨架（3 行，每行 `--ap-space-16` 高） | — | — |
| `ToolJumpNavigator` | `J`/`K` 卡片间跳转的焦点管理（非可视组件） | `toolCallIds`、`direction` | — |

### 8.4 记忆

| 组件 | 职责 | 关键 props | 关键状态 |
|---|---|---|---|
| `MemoryView` | 记忆视图容器（顶栏 + 过滤 + 列表） | `items`、`filter: 'all'\|'preference'\|'fact'`、`query`、`loading`、`error` | 空/加载/正常/错误 |
| `MemoryFilterTabs` | 全部/偏好/事实 分段控件 | `value`、`onChange`、`counts` | — |
| `MemorySearchInput` | 内容子串搜索（即时过滤） | `value`、`onChange`、`onClear` | normal / noResult |
| `MemoryListItem` | 单条记忆（内容 + 来源行 + 悬停操作） | `id`、`kind`、`content`、`createdAt`、`source: {sessionId, sessionTitle, messageId} \| null`、`onOpenSource`、`onDelete` | normal / deleting(确认行) / removed |
| `MemorySourceLine` | 「来自「标题」· 相对时间」+ 查看原对话 | `sessionTitle?`、`createdAt`、`onOpenSource`、`sourceAvailable: boolean` | available / deleted / manual |
| `MemoryDeleteConfirm` | 行内确认（替换该行） | `onConfirm`、`onCancel` | idle / confirming |
| `MemoryUndoToast` | 「已删除 · 撤销」（5s） | `onUndo`、`timeoutMs: 5000` | visible / expired |
| `MemoryDetailPanel` | 检查器详情（完整内容、类型、id、来源、关联工具卡片） | `memory`、`relatedToolCalls`、`onOpenSource` | normal / loading |

### 8.5 任务

| 组件 | 职责 | 关键 props | 关键状态 |
|---|---|---|---|
| `TaskView` | 任务视图容器（顶栏 + 筛选 + 列表） | `tasks`、`filter: 'running'\|'completed'\|'all'`、`loading`、`error` | 空/加载/正常/错误 |
| `TaskFilterTabs` | 进行中/已完成/全部 | `value`、`onChange`、`counts: {running, total}` | — |
| `TaskRow` | 任务行（状态点 + 标题 + 最近事件 + 状态徽标） | `task`、`isSelected`、`onSelect` | 各 status；终态含锁定图标 |
| `TaskStatusBadge` | 7 态状态徽标（文字 + 图标 + 色） | `status`、`isTerminal`、`durationMs?` | 7 态 |
| `TerminalLockIcon` | 终态锁定图标（`--ap-fs-caption` 尺寸，`aria-label`） | — | — |
| `TaskProgressNote` | 「进度陈述（非交付）」区块 | `text`、`updatedAt` | present / empty(→ "—") |
| `TaskDeliveryEvidence` | 交付凭据区（产物清单 + 核验方式 + 关联卡片） | `artifacts: {path,size,sha256}[]`、`verifyMethod`、`relatedToolCalls`、`onOpenToolCall` | completed / failed(失败原因) |
| `TaskEventListener` | metadata-only 事件时间线（只读，20 条 + 加载更多） | `events: {at,type,objectId,resultCode}[]`、`hasMore`、`onLoadMore` | normal / loadingMore / empty |
| `TaskClaimNotice` | CAS 冲突提示条（「该任务已被领取…」） | `claimedAt`、`claimTokenShort` | — |
| `TaskLimitNotice` | 限额/拒绝记录块 | `kind: 'lane'\|'subtask'\|'depth'`、`limit`、`message` | — |
| `TurnTaskBar` | 聊天流内的任务条（就地更新） | `taskId`、`title`、`status`、`onOpenDetail` | 各 status（就地改文案） |
| `ConflictStateNotice` | 终态冲突提示条（「已忽略 已完成 → 进行中」） | `from`、`to` | — |

### 8.6 通用原子

| 组件 | 职责 | 关键 props |
|---|---|---|
| `StatusDot` | 6/8px 状态点（idle/typing/working/error/terminal） | `tone`、`size: 6\|8`、`pulsing: boolean` |
| `TypingDots` | 三点打字动画（reduced-motion 降级为静态） | `count: 3` |
| `Skeleton` | 骨架块 | `width`、`height`、`radius` |
| `IconButton` | 32/36/44px 图标按钮（必须 `aria-label`） | `size`、`label`、`icon`、`disabled`、`tone` |
| `TextButton` | 文字按钮（32px 高） | `label`、`onClick`、`tone` |
| `PrimaryButton` | 主按钮（`--ap-accent` 底 + 白字） | `label`、`disabled`、`loading` |
| `DangerButton` | 危险按钮（`--ap-danger-text` 底 + 白字） | `label`、`disabled` |
| `Banner` | 32px 顶部提示条（重连/只读/冲突/排队） | `tone`、`message`、`action?` |
| `InspectorPanel` | 右侧检查器容器（360px，`md` 以下转覆盖式） | `open`、`title`、`width: 360`、`variant: 'docked'\|'overlay'`、`onClose` |
| `Modal` | 模态弹窗（设置/快捷键帮助），焦点陷阱 | `open`、`title`、`onClose`、`initialFocusRef` |
| `Toast` | 底部 400px 居中 toast（仅两处使用：删除可撤销、复制成功） | `message`、`action?`、`timeoutMs` |
| `KeyHint` | 键位提示（`Enter 发送`） | `keys: string[]`、`label` |
| `ShortcutHelpOverlay` | 快捷键帮助浮层 | `open`、`onClose` |
| `SettingsDialog` | 设置弹窗（4 行只读信息） | `provider`、`model`、`keyConfigured`、`workDir`、`dbPath`、`version`、`gitSha`、`buildTime` |
| `CopyButton` | 复制按钮（成功态 1s 反馈） | `value`、`label` |
| `RelativeTime` | 相对时间（今天/昨天/N 天前 + tooltip 绝对时间） | `at: string` |

---

## 9. 视图间流转（文字版流程）

### 9.1 首次启动 → 日常聊天

```
启动进程
  → 连接本地服务（全屏居中小块「正在连接本地服务…」，30s 超时转错误块）
  → 读 sessions：
      ├ 为空 → 自动创建会话「新对话」(t7 AT-001 S2 要求默认有会话)
      │         → 焦点落输入框 → 显示首启引导块（含 2 个建议 chip）
      └ 非空 → 会话列表按 updated_at 倒序渲染，首项标「上次对话」
                → 消息流空态「选择左侧对话继续」，焦点落输入框
  → 用户输入（P-A：`presence-idle` 静态点 + 「草稿中」）→ Enter 发送
      → 用户消息乐观落位(0.6) → t+250ms 打字指示（P-B `presence-thinking` 呼吸）→ 首 token ≤5s
      → 流式追加（P-B′ `presence-streaming` 静态色 + 光标 `--ap-duration-caret` + 跟随锚定）
      → 回合结束：光标消失、输入框恢复、元数据悬停显形
      → presence 回到 `presence-idle`（静态，无完成脉冲）
  → 多轮继续（同 session，上下文不串行）
```

### 9.2 办事执行（工具确认动线，含危险操作分支）

```
用户：「在 D:\work\a.md 写入三行，并执行 dir 看看」
  → 助手回合开始（thinking → streaming）
  → 块1 文本「我先写入文件，再执行命令。」
  → 块2 ToolCallCard: write_file  [caution]
        L2: D:\work\a.md ← 3 行
        ├ 路径在工作目录内 → 直接执行
        └ 路径在工作目录外 → DangerConfirmBlock 就地确认（presence → `presence-awaiting`，静止）
              ├ 允许一次 → 记录行「已由用户允许 10:16:20」→ running（`presence-acting`）→ success
              │     → FileWriteVerify: 已写入 3 行 / 128 B / mtime 10:16:20 / 路径存在 ✓
              └ 拒绝（Esc 或按钮）→ denied（原因原文可见）→ 结果回注 Agent
                    → Agent 必须显式说明，不得静默改道（P5）；presence 回落 `presence-idle`
  → 块3 ToolCallCard: run_command  [danger]
        L2: dir（命令原文独占行，完整不省略）
        → DangerConfirmBlock（焦点落「允许一次」；presence-awaiting 静止）
              ├ 允许 → running（`presence-acting` 节拍竖条 + 计时 + >10s 出现「停止」）
              │     → success → ExitCodeChip exit 0 + stdout 前 3 行
              └ 沙箱拦截 → denied + 拦截规则原文（绝不显示"成功但无输出"）
  → 块4 文本收尾 + DeliveryBadge
        ├ 有成功工具调用 → 「✓ 已核验交付 · 依据：写入文件 ×1 / 执行命令 ×1」（可点击展开卡片）
        └ 只有"我接下来要…" → PlanNoteBadge「仅计划，尚未执行」+ 任务转 blocked/needs_input
  → TurnTaskBar 就地出现/更新：「写入并查看 a.md · 已完成 [查看详情 →]」
```

### 9.3 记忆沉淀 → 回看

```
用户：「记住我的偏好：咖啡不加糖」
  → ToolCallCard: memory_write  L2: 偏好 · 咖啡不加糖
      → success → L3: 已记录（#k7p2q9）+ [在记忆中查看]
  → 左栏「记忆」计数徽标 N → N+1（无红点，P1）
  → 行内提示：若本回合无 memory_write 卡片却声称"已记住"
      → InlineNotice「本回合没有记忆写入记录」+ [查看任务详情]（CP-02 的 UI 呈现在此）

回看动线（三条入口，终点同一处）
  ├ 入口A：ToolCallCard [在记忆中查看] → 记忆视图 + 选中该条 + 检查器详情
  ├ 入口B：Ctrl/Cmd+2 → 记忆视图 → 搜索/过滤 → 点条目 → 检查器详情
  └ 入口C：Ctrl/Cmd+K → 记忆视图 + 聚焦搜索框
        → 详情内 [查看原对话] → 切对话视图 → 打开源会话 → 滚动定位 + 高亮 1.2s

跨会话召回（t7 AT-006）
  新建对话（Ctrl/Cmd+N）→ 会话列表新增一项
  → 提问「我的咖啡偏好是什么？」
  → ToolCallCard: memory_search → L3「命中 1 条 · #k7p2q9」（与写入卡片 id 一致，可视化对照）
  → 回答含「不加糖」

重启不丢（t7 AT-403）
  关闭窗口（应用自行退出，非 kill）→ 重启同一产物
  → 会话列表恢复，首项标「上次对话」（不自动打开，P1）
  → 点击原会话 → 3 轮问答完整可见 → 记忆条目与任务行仍在
```

---

## 10. 验收清单（逐条自检）

### 10.1 范围自检（有无越界）

| # | 检查项 | 结论 |
|---|---|---|
| S1 | 是否出现网关/多渠道连接 UI？ | ✅ 无（§0.2 明确禁止） |
| S2 | 是否出现多 Agent 群聊/委派树/depth 选择器？ | ✅ 无（单 Agent 单会话；任务详情只呈现单任务） |
| S3 | 是否出现 Kanban/泳道拖拽/swarm 拓扑？ | ✅ 无（§6.1 明确"纵向列表 + 详情"） |
| S4 | 是否出现 cron/定时任务界面？ | ✅ 无 |
| S5 | 是否出现技能市场/插件商店/MCP 配置？ | ✅ 无（斜杠命令仅给"二期开放"提示，不弹面板） |
| S6 | 是否做了移动端 PWA 专属设计？ | ✅ 无（仅 `below-compact`/`xs` 断点"不破版"，无底部 Tab Bar） |
| S7 | 是否引入向量检索/记忆编辑/记忆手动新增？ | ✅ 无（§5.3 明确编辑二期、搜索为子串匹配） |
| S8 | 是否超出 t2 最小工具集？ | ✅ 7 条工具映射 + 未列表工具的保守降级形态，未新增能力 |
| S9 | **是否重复定义了 tokens 层取值？** | ✅ 无：§1.5 已改写为引用与映射说明，全文色/字/时长/圆角/z 一律 `var(--ap-*)`（**裸 hex 仅剩 2 处示例记忆 id，非颜色**） |

### 10.2 硬指标自检（有无"待定"、有无数值缺失）

| # | 检查项 | 结论 |
|---|---|---|
| H1 | 是否所有布局都有具体尺寸？ | ✅ §1.2/1.3/1.4/2/3.1/3.7/5.1/6.1/6.4 全部给值；尺寸一律落在 tokens.md §5.1/§5.2 阶梯或由其 `calc()` 派生（§1.5-①②） |
| H2 | 断点与最小可用宽度是否给定？ | ✅ 4 档（`below-compact` / `md` / `lg` / `xl`）+ `xs` 不破版档；最小可用宽 = `--ap-breakpoint-compact`（1024px）（§1.4） |
| H3 | 是否存在"待定/TBD/视情况"？ | ✅ 无；连"未知交付状态"都定义成了显式呈现（§6.3） |
| H4 | 每个视图的空/加载/错误/重连是否定义？ | ✅ §2 全局状态矩阵逐格填写 + §3.8 九类错误逐条 |
| H5 | 对比度是否有权威依据？ | ✅ §7.6 改为**引用 tokens.md §0.4 + 附录 A（109 项全达标）**，仅保留组件级要求（目标尺寸、缩放、颜色非唯一编码、CJK 字距） |
| H6 | 组件是否都有命名 + props + 状态？ | ✅ §8 共 60+ 组件，六大类分表 |
| H7 | presence 是否与 tokens.md 五态一一对应？ | ✅ §3.6 五态映射表；`awaiting` 静止硬规则、idle 无动画、acting 不再借用 warning 色 |

### 10.3 依 t1/t2 的溯源自检

| # | 设计决定 | 溯源 |
|---|---|---|
| T1 | 单窗口多视图 + 右侧检查器 | t1 §6（hanako 图形桌面/办公侧的差异化）、t2 §1（桌面优先，体验差异化看 hanako） |
| T2 | 助手侧不用气泡、改"文档流 + 卡片" | t1 §3（审计与工具可见）、§0.3-P2 |
| T3 | 终态徽标 + 锁定图标 + 冲突提示条 | t1 §4 P0-1、t7 §2.1 AT-503 |
| T4 | 「仅计划，尚未执行」/「已核验交付」双形态 | t1 §4 P0-3、t7 §2.1 AT-504、CP-01/CP-02 |
| T5 | 限额/拒绝/领取冲突一律显式可见 | t1 §4 P0-4、P0-5、t7 §6 G2/G4 |
| T6 | 事件时间线 metadata-only、不显示正文/参数 | t1 §4 P1-7、t7 §2.1 审计旁证 |
| T7 | 记忆 = 偏好 + 事实两类，来源可追溯，编辑二期 | t2 §5-3、t1 §6（不做超出 MVP 的记忆深度） |
| T8 | 不引入 Kanban/swarm/多 Agent 视图 | t2 Out of scope、t1 §5「三者重型编排 MVP 均不引入」 |
| T9 | 陪伴感 = 不超过 24px 的 presence 元素、无通知/无红点 | t2 体验关键词（克制、不打扰）、§0.3-P1、tokens.md §1-P1（在场感优先于装饰感） |
| T10 | 版本号在关于页由构建期常量注入 | t7 §1.1 P2、FG-05（禁止硬编码版本） |
| T11 | token 取值全部引用 tokens.md，本文件不定义色值 | 主 agent 裁决（tokens.md 为 token 层唯一真相源）；品牌色相调整时本文件零改动 |

### 10.4 与 t7 点击链路的 UI 可观测性自检（本设计的硬约束）

| t7 链路 | UI 侧必须可观测 | 本文件落点 |
|---|---|---|
| AT-201/AT-202 | 首 token ≤5s、增量可见、多轮不串、3 轮历史可滚到、输入框恢复可用 | §3.4、§3.2 |
| AT-301/AT-302 | 工具卡片含工具名、status running→success、写文件落盘校验可见 | §4.1/§4.3/§4.4 |
| AT-303 | 命令原文完整可见 + `exit_code` 可见 | §4.2 `ExitCodeChip`、§4.4 `CommandBlock` |
| AT-304 | 页面标题与 URL 可见、可 `在系统中打开`、与返回体可逐字比对 | §4.2 `browse_page` 行 |
| AT-401/AT-402 | `memory_write` 卡片含 `#id`；`memory_search` 命中同 `#id`；记忆视图可查 | §4.2、§5.4 |
| AT-403 | 重启后会话列表恢复（不自动打开）、原会话 3 轮完整、记忆仍在 | §3.9 重启恢复行、§5.1 |
| AT-501/AT-502 | 单库信息在关于页可见；CAS 冲突显式提示 | §6.6 第 3 行、§6.2 CAS 段 |
| AT-503 | 终态锁定可见 + 冲突更新被忽略且显式提示 | §6.2 第 3、4 条 |
| AT-504 | 进度文本与交付在视觉上不可混同 | §6.3 对照表 |
| AT-505/AT-506 | 限额拒绝文案可见（含上限数值）；越权拒绝原文可见 | §3.8-E7、§4.3 `denied`、§6.4 第 6 块 |
| AT-101/AT-102 | 首次启动自动建会话、默认路径可见、窗口出现即可输入 | §3.5、§3.9 |
| AT-103 | 版本四方一致中的 UI 侧由构建期常量提供 | §6.6 第 4 行 |

### 10.5 仍需主 Agent 裁决的分歧点（本文件已给推荐方案，未自行拍板）

| # | 分歧点 | 本文件默认 | 备选 | 影响 |
|---|---|---|---|---|
| D1 | 危险工具（`write_file` 越界 / `run_command`）是否每次执行前都需用户确认？ | **边界触发确认**（§4.4：写类在工作目录内直接执行；越界写入与命令执行走就地确认） | ①全部命令类每次都确认（最安全，但把日常对话变成审批流，违背 t2「不打扰」）②全部不确认、仅事后审计（最流畅，但 t2 §5-4「沙箱初版约束」的安全承诺失去人工兜底） | 若选①，`pending_confirmation` 将成为高频路径，需补一条"会话内临时放行"折中；若选②，则 §4.4 的确认区需整体删除，AT-503/505 的可观测点减少一处 |
| D2 | 危险确认是否提供"本次会话始终允许" | **不提供**（一次性，§4.4） | 提供会话级白名单开关 | 提供后会引入"安全策略藏在会话状态里"的问题，且需新增 UI 与状态位 |
| D3 | 助手回复是否需要打断后续自动动作（即确认期间是否阻塞整个回合） | **不阻塞输入、阻塞该回合完成**（用户可继续打字，但该回合不判完成，卡片停 `待确认`） | 阻塞输入直到决定 | 若阻塞输入，与 P1「不打扰」冲突，且 t7 G4-2 的"第二条排队"观测会与此混淆 |
| D4 | 任务详情是否提供"取消任务/重跑"按钮 | **不提供**（§6.4 末段，避免绕过 CAS 与终态语义） | 提供取消（需后端 sticky cancel 支持） | t2 M1 无 sticky cancel 承诺，提供按钮会造出无法兑现的入口 |

---

## 11. 落地顺序建议（给 t4 / t3 的实现排期参考，非新增范围）

1. **P0（无它则链路不通）**：`AppShell` + `SidebarNav` + `SessionList` + `MessageStream` + `UserMessageBubble` + `AssistantTurn` + `StreamingText` + `ThinkingIndicator` + `ChatComposer` + `InlineNotice` + `ConnectionBanner` + `SettingsDialog`（版本戳）。
2. **P1（治理与审计可观测）**：`ToolCallCard` 全族（含 `DangerConfirmBlock`、`FileWriteVerify`、`ExitCodeChip`）+ `PlanNoteBadge` + `DeliveryBadge` + `TaskView` 全族 + `TaskEventListener`。
3. **P2（记忆闭环）**：`MemoryView` 全族 + `MemoryDetailPanel` + 跨视图跳转高亮（`ScrollToMessageHighlight`）。
4. **P3（体验打磨，不阻塞验收）**：陪伴感微交互（§3.6 全部）、动效、快捷键帮助浮层、双主题（`auto`/`light`/`dark`）、reduced-motion 降级。

---

## 12. 对齐变更日志（v1.1）

> **本次对齐依据**：主 agent 裁决——`docs/design/tokens.md` 为 **token 层唯一真相源**；本文件保留信息架构 / 交互行为 / 组件清单的所有权，**全部 token 取值改为引用**。
> 版本：本文件 v1.0 → **v1.1**。变更性质：**契约对齐**（不改行为语义，只改取值来源与少数派生尺寸）。

### 12.1 文档级变更

| # | 项目 | 原值 | 新值 | 依据 |
|---|---|---|---|---|
| 1 | 取值来源 | 本文件 §1.5 自定义全部 Design Tokens | **引用 `docs/design/tokens.md` v1.0.0**；§1.5 改写为"引用与映射说明"（组件几何 + 语义角色映射 + 排版映射 + 圆角/阴影/层级/动效映射 + 降级说明 + 非动效时长声明） | 主 agent 裁决 1 |
| 2 | 落地路径（文首） | `apps/desktop/renderer` | **`apps/desktop/src/styles/tokens.css`**（token 层）+ **`apps/desktop`**（视图与组件） | 裁决 10；tokens.md §7.2、t3 §1 |
| 3 | 主题机制 | "浅色为默认主题；深色为主题变体" | **默认 `auto` 跟随系统（`prefers-color-scheme`），字面兜底浅色**；设置内可锁定 `light`/`dark` | 裁决 7；tokens.md §8、§7.4 |
| 4 | 对比度依据 | 本文件自测的 12 行比值表（含"已修正"叙述） | **整表删除**；改为引用 tokens.md §0.4 + **附录 A（109 项，0 项未达标）**；仅保留 8 项组件级可达性要求 | 裁决 8 |
| 5 | 自测修正叙述（`#8A5D15` / `#8C6845`） | 曾以"对比度实测修正"写入 | **整体作废**（tokens.md 从未采用这些值） | 裁决 8 |
| 6 | 色相 | 暖棕 `#B08968` 系列 | **seal 印章青蓝**（tokens.md 现值，待用户最终拍板）；本文件因全为引用而**零改动** | 裁决附注 |

### 12.2 token 名重映射（全文穷尽，旧名 **0 残留**）

| 旧 token | 新 token | 处理方式 |
|---|---|---|
| `--bg-app` | `--ap-surface-0` | 机械替换 |
| `--bg-sidebar` | `--ap-surface-sunken` | 机械替换 |
| `--bg-surface` | `--ap-surface-1` | 机械替换 |
| `--bg-surface-sunken` | `--ap-surface-inset` | 机械替换（代码块 / 参数块 / 只读区） |
| （新增语义） | `--ap-surface-2` / `--ap-surface-code` / `--ap-surface-bubble-user` / `--ap-surface-row-hover` / `--ap-surface-row-selected` / `--ap-surface-scrim` | 按角色细分：输入框外壳、命令块、用户气泡、列表行悬停/选中、覆盖遮罩 |
| `--text-primary` | `--ap-text-primary` | 机械替换 |
| `--text-secondary` | `--ap-text-tertiary`（元信息/时间戳/参数摘要，16 处）<br>`--ap-text-secondary`（次级正文、列表标题）<br>`--ap-text-muted`（占位符、附注）<br>`--ap-text-disabled`（禁用态） | 按语义逐处判定 |
| `--border-subtle` | `--ap-border-subtle` | 机械替换 |
| `--border-strong` | `--ap-border-default` | 机械替换（输入框/按钮描边） |
| （新增语义） | `--ap-border-accent` / `--ap-border-danger` / `--ap-border-warning` / `--ap-border-success` / `--ap-border-info` / `--ap-border-focus` | 选中竖条、错误条、警告条描边等 |
| `--accent`（主按钮底，原 `--accent-strong`） | `--ap-accent`（文字 `--ap-text-on-accent`） | 语义改名 |
| `--accent`（装饰：选中竖条） | `--ap-border-accent` | 按用途 |
| `--accent`（高亮底） | `--ap-accent-subtle` | 按用途 |
| `--accent`（流式光标） | `--ap-presence-streaming` | 按用途（光标属 streaming 通道） |
| （新增） | `--ap-accent-hover` / `--ap-accent-text` | 按钮悬停、可点击文字 |
| `--danger`（文字） | `--ap-danger-text` | 机械替换 |
| `--danger`（实心按钮/竖条） | `--ap-danger` | 逐处修正（停止图标、危险竖条、删除按钮、DangerButton） |
| `--danger-bg` | `--ap-danger-subtle` | 机械替换 |
| `--warning` | `--ap-warning-text` | 机械替换（**tokens.md 无 warning 实心档**，故全部为 text 变体） |
| `--warning-bg` | `--ap-warning-subtle` | 机械替换 |
| `--success`（文字） | `--ap-success-text` | 机械替换 |
| `--success`（竖条/实心） | `--ap-success` | 逐处修正 |
| `--focus-ring` | `--ap-border-focus` + `--ap-focus-ring-width` / `--ap-focus-ring-offset` | 机械替换 + 补宽度/偏移 |
| `--presence`（单一绿点） | **五态**：`--ap-presence-{idle,thinking,streaming,acting,awaiting}` + 各自 `-text` + `-thinking-subtle` + `--ap-presence-dot-size{,-lg}` / `-ring-width` / `-ring-offset` | 见 §12.3 |
| `--font-ui` / `--font-mono` | `--ap-font-sans` / `--ap-font-mono`（另有 `--ap-font-display` 限 ≥20px 展示型） | 机械替换 |
| `--fs-body` 15px | `--ap-fs-body`（用户消息/输入框）+ **`--ap-fs-body-lg`**（助理回答，16px） | 语义细分：tokens.md §4.2 明定 `body-lg` 为"对话正文（助理回答）" |
| `--fs-sm` 13px | `--ap-fs-tool`（参数区/命令）/ `--ap-fs-code`（代码） | 按用途 |
| `--fs-xs` 12px | `--ap-fs-caption` | 语义改名 |
| `--fs-title` 17px | `--ap-fs-h2`（区块标题）/ `--ap-fs-h1`（页面标题 20px） | 按用途升档 |
| （新增） | `--ap-fs-micro`（11px，角标/键位提示）/ `--ap-fs-display`（28px，空态） | 补齐阶梯 |
| `--space-1…8`（4/8/12/16/20/24/32/40） | `--ap-space-{0,2,4,6,8,12,16,20,24,32,40,48,64,80}`（**14 档**） | 阶梯扩容至 tokens.md §5.1；保留"禁止散值"精神 |

### 12.3 presence 五态重写（§3.6）

| 场景 | 原表述 | 新表述 | 依据 |
|---|---|---|---|
| P-A 用户输入中 | `--presence` 圆点 `opacity .4→1` **2s 循环呼吸** | **`presence-idle`，静态 100% 无动画**（仅一次性颜色切换到"草稿中"） | tokens.md §6.3「presence idle：无 / 静态 100%，静息态不做任何动画」 |
| P-B 思考中 | 三点 `translateY` 900ms、相位 300ms | **`presence-thinking`**：`--ap-duration-breath`（**2400ms**，非 2s）`infinite alternate` + `--ap-ease-breathe`，`opacity 0.55↔1`、`scale 1↔1.05`；**必须同时渲染文字标签** | 裁决 3；tokens.md §3.1、§6.3 |
| （新增）P-B′ 流式追加 | 未单列 | **`presence-streaming`**（seal 青），**无脉冲**；尾段淡入 `--ap-duration-stream` | tokens.md §6.3 |
| P-C 工具执行中 | 左缘竖条借用 `--warning` 色 + 1.6s 呼吸；头像点用 warning 色 | **`presence-acting`**（sage 苔绿）：`--ap-duration-pulse`（**900ms**）节拍，三点 `opacity 0.35/0.65/1`、**相位差 150ms**；不再借用 warning 色 | 裁决 3；tokens.md §3.1、§6.3 |
| （新增）P-E 待确认 | 原仅写在 §4.4，无 presence 归属 | **`presence-awaiting`**：静止实心 + `--ap-presence-ring-width`（2px）外环，入场一次 `--ap-duration-slow` + `--ap-ease-settle`，**入场后完全静止（硬规则，禁止持续动效）** | 裁决 3；tokens.md §3.1 依据 3 |
| P-D 回合完成脉冲 | 头像点单次脉冲 `scale 1→1.15→1`，240ms | **删除**；presence 直接回 `presence-idle` 静态。"送达感"改由 `--ap-ease-settle` 一次性确认承担（工具成功 / 记忆已写入，每回合最多一次） | tokens.md §6.3 + §6.2（settle 仅用于一次性确认） |
| 分级时间轴 250ms/2.5s/8s/30s | 保留 | **保留不变**（属交互时间轴，非动效 token） | 裁决 3 附注 |

### 12.4 动效时长对齐（逐处）

| 原值 | 新值 | 出现处 |
|---|---|---|
| "微交互统一 120ms" | `--ap-duration-fast`（140ms，默认档） | §1.5 改写 |
| 悬停显形 120ms | `--ap-duration-instant`（80ms） | §3.3 元数据行 |
| 乐观落位 `.6→1` 120ms | `--ap-duration-fast`（140ms） | §3.6 P-B |
| 打字指示卸载 120ms | `--ap-duration-fast`（140ms） | §3.6 P-B |
| 块落地 120ms | `--ap-duration-fast`（140ms）+ `--ap-ease-standard` | §3.4 |
| 计数滚动 120ms | `--ap-duration-fast`（140ms） | §5.4 |
| 卡片插入 180ms `ease-out` | `--ap-duration-base`（200ms）+ `--ap-ease-enter` + `--ap-motion-slide-sm` × `--ap-motion-scale` | §4.3 |
| 记忆删除收起 180ms | `--ap-duration-base`（200ms） | §5.3 |
| 面板滑入 240ms | `--ap-duration-slow`（320ms）+ `--ap-ease-emphasized` | §1.5 |
| P-D 完成脉冲 240ms | **删除**（改为 idle 静态） | §3.6 |
| ConnectionBanner 出现/消失 240ms | `--ap-duration-slow`（320ms） | §8.1 |
| 流式光标 600ms 循环 | **`--ap-duration-caret`（1000ms）** `step-end infinite` | §3.4 |
| 流式增量（原未定义） | **`--ap-duration-stream`（90ms）** + `--ap-ease-enter`，仅尾段 | §3.4 |
| 工具卡状态色（原未定义） | `--ap-duration-base`（200ms） | §4.3、§6.2 |
| 撤销窗口 5s | `--ap-duration-dwell-toast`（**6000ms**） | §5.3 |
| 未变（交互时间轴） | 保留：250ms / 2.5s / 8s / 30s / 3s 静态停留 / 5s 重连 / 300ms 禁用切换 / 100ms 计时步进 / 16ms 帧预算 / 1200ms 高亮 | §3.4、§3.6、§3.9、§6.2 等 |

### 12.5 圆角对齐

| 组件 | 原值 | 新值 |
|---|---|---|
| 用户消息气泡 | 16px | **`--ap-radius-bubble`（14px）** |
| 卡片（错误条、任务条、记忆条目、面板） | 10px | **`--ap-radius-card`（10px）**（数值一致，改为 token 引用） |
| 工具卡片 | 10px | **`--ap-radius-tool-card`（8px）** ← **变小 2px** |
| 按钮、输入框、下拉、行内小块 | 6px | `--ap-radius-control`（6px） |
| 模态 | 16px | `--ap-radius-modal`（14px，经由 `xl`） |
| 状态点、头像、胶囊、建议 chip | 9999px | `--ap-radius-pill` / `--ap-radius-full` |
| 徽标、tag | 4px | `--ap-radius-xs`（2px） |

### 12.6 层级（z-index）对齐

| 用途 | 原值 | 新值 |
|---|---|---|
| 卡片抬升 / 任务条 | （未定义） | `--ap-z-raised`(10) |
| 粘性聊天顶栏、顶置提示条 | 100 | **`--ap-z-sticky`(20) / `--ap-z-raised`(10)** |
| 覆盖式检查器浮层（`md` 断点） | 100 | **`--ap-z-dropdown`(40)**（其遮罩 `--ap-z-sidebar`(30)） |
| 模态遮罩 | 200 | `--ap-z-scrim`(50) |
| 模态（设置、快捷键帮助） | 300 | `--ap-z-modal`(60) |
| Toast | 400 | `--ap-z-toast`(70) |
| Tooltip | （未定义） | `--ap-z-tooltip`(80) |

### 12.7 组件尺寸对齐（不落阶梯者已改值）

| 项目 | 原值 | 新值 | 依据 |
|---|---|---|---|
| 右侧检查器宽 | **360px** | **`--ap-size-detail`（320px）** | 落 tokens.md §5.2 阶梯 |
| 聊天顶栏 / 应用头 / 应用脚高 | **56px / 56px / 48px** | **`--ap-size-titlebar`（44px）统一** | 落 tokens.md §5.2 阶梯 |
| 主操作按钮 / 一级导航项高 | 44px / 36px | **`--ap-size-toolbar`（36px）统一** | 落 tokens.md §5.2 阶梯 |
| 用户气泡最大宽 | **560px** | **640px** = `--ap-size-chat-max` − 3 × `--ap-space-40` | 派生自 token，不引入魔数 |
| 消息流内容宽 / 工具卡片宽 | 680px / 640px | 680px（= `--ap-size-chat-max` − 2 × `--ap-space-40`）/ 640px（再 − `--ap-space-40`） | 同为派生值 |
| 最小可用宽度 | 1024px | `--ap-breakpoint-compact` | 落阶梯 |
| 断点档位 | `xs/sm/md/lg/xl`（5 档，含 768px 中间档） | `below-compact / md / lg / xl` + `xs` 不破版档；`below-compact` 依 tokens.md "低于 `--ap-breakpoint-compact` 收起详情面板" | 对齐 tokens.md §5.2 |
| 消息流滚动条宽 | 10px | `--ap-space-8`（8px） | 落间距阶梯 |
| 输入区内边距 | 12 / 14 / 10px | `--ap-space-12` / `--ap-space-16` / `--ap-space-8` | 落间距阶梯（14/10 为散值） |
| 图标尺寸 | 20px / 24px | `--ap-space-20`（20px）/ `--ap-size-control-sm`（24px） | 落阶梯 |
| 点击区 | 44×44px | `--ap-size-avatar-lg`（40px）见方 + 外边距补足至 44px 触达区 | 落阶梯 + 可达性补足 |
| 工具卡徽标内边距 | 2px 6px | `--ap-space-2` / `--ap-space-6` | 落阶梯 |
| 记忆条目高 / 间距 | 72px / 8px | `--ap-space-64` + `--ap-space-8`（72px）/ `--ap-space-8` | 落阶梯 |
| 任务行高 / 间距 | 64px / 6px | `--ap-space-64` / `--ap-space-6` | 落阶梯 |
| 设置弹窗 | 360×420 | 宽 `--ap-size-detail`（320px），高自适应（≤420px 由内容决定） | 落阶梯 |
| 间距阶梯 | 8 档（4…40） | **14 档** `--ap-space-{0,2,4,6,8,12,16,20,24,32,40,48,64,80}` | tokens.md §5.1（补 2/6/48/64/80） |

### 12.8 其他

| 项目 | 原值 | 新值 | 依据 |
|---|---|---|---|
| 主题快捷键 `Ctrl/Cmd+Shift+.` | "切换主题（浅/深）" | **"在 `auto` / `light` / `dark` 三态间循环切换"** | 裁决 7 |
| 设置弹窗内容 | 4 项只读信息 | **5 项**（新增"外观：跟随系统/浅色/深色"） | 裁决 7；tokens.md §7.4 偏好键 `ap.colorScheme` |
| 阴影 | 裸 `rgba()` 阴影 3 处 | `--ap-shadow-xs` / `--ap-shadow-lg` / `--ap-shadow-pop` / `--ap-shadow-glow` / `--ap-shadow-sm` | tokens.md §5.4（暖墨色阴影，非纯黑） |
| 示例记忆 id | `#a1b2c3`（形如 hex，易与色值混淆） | `#k7p2q9`（非 hex 形态） | 使"全文无裸 hex"可机器校验 |
| 可达性合同版本 | "WCAG 2.1 AA 为底线" | **"WCAG 2.2 AA 为底线"**（对齐 tokens.md §0.4 目标） | tokens.md §0.4 |

**保持不变（未动）**：§0 范围声明与 §0.2 禁止清单、§2 状态矩阵、§3–§6 的行为与结构（消息层级 / 确认动线 / 记忆管理 / 任务治理语义）、§7.1–7.5 快捷键与 ARIA、§8 组件命名与 props、§9 视图流转、§10.1–10.4 自检、§11 落地顺序、以及 D1–D4 四项分歧点的推荐结论（主 agent 已采纳）。
