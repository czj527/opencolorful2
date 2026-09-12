# Kimi（Moonshot AI）web 端视觉风格参照笔记

> **文档定位**：本文件是**参照笔记（reference note）**，不是设计规范。
> 唯一目的是为「品牌强调色二选一（印章青蓝 `#45708A` vs 暖棕 `#8C6845`）」提供可核查的风格证据。
>
> **本文件不修改任何现有设计文件**：`docs/design/tokens.md`、`docs/design/ia-and-interaction.md`、
> 以及全部 `docs/decisions/*` 均未改动。本文件是新增的独立研究产物。
>
> **研究日期**：2026-09-11
> **一级证据源**：`D:\agentplant\references\kimi-code`（git HEAD `9f7e68e8`，提交时间 2026-09-10 10:37 +0800）
> **二级证据源**：`https://www.kimi.com` 未登录态实测（2026-09-11）

---

## 0. 证据等级约定

按可信度从高到低四级，全文每条观察都标注等级：

| 等级 | 记号 | 含义 | 可核查性 |
|---|---|---|---|
| **A** | 源码 | 本地仓库中的样式/主题源文件，**路径:行号**可直达 | 最高：任何人可复现打开同一行 |
| **B** | 实测 | 浏览器中 `getComputedStyle` / CSSOM 读出的**运行时真实取值** | 高：可复现但依赖站点当时的部署版本 |
| **C** | 截图 | 截图目视观察（形态、有无装饰、疏密） | 中：客观但含解释成分 |
| **D** | 二手 | 搜索到的第三方描述、品牌文章 | 低：仅作背景，不作为任何 hex 的依据 |

**本文件所有 hex 均达到 A 或 B 级。没有任何 D 级来源的色值被采用。**

### 0.1 关于 `dist-web` 的特殊说明（重要）

`references/kimi-code/AGENTS.md` 明确记载：

> the browser web UI: **its source no longer lives in this repo.** It is developed in the
> code-app repo (`apps/web`) and shipped as the committed, prebuilt bundle
> `apps/kimi-code/dist-web`

因此 **`apps/kimi-code/dist-web/assets/index-C8RkgE6U.css` 就是 Kimi Code web 端线上所跑的同一份产物**，
它是本研究能拿到的最强证据——不是"类似物"，而是**发布物本体**。

该文件为生产构建压缩产物（568,857 字节 / 32 行），**行号无意义**，
故对其的引用一律采用「**token 名 + 选择器块**」定位，而非行号。这是该证据源的唯一格式妥协。

仓库中另有 `apps/vis/web/src/theme.css`（**可读源码、有行号**）与
`apps/kimi-code/src/tui/theme/colors.ts`（**可读源码、有行号**），
二者作为同期同品牌的旁证使用，用于交叉验证 token 体系的**结构**（而非线上的精确取值）。

---

## 1. 证据清单

### 1.1 一级证据（A / B 级，实际取样）

| # | 等级 | 证据 | 来源（路径:行号 / 选择器） | 关键内容 |
|---|---|---|---|---|
| E1 | **A** | Kimi Code web 线上样式产物 | `apps/kimi-code/dist-web/assets/index-C8RkgE6U.css`，`:root` 块 2（254 个变量） | 完整 design token：表面/文字/线条/强调/语义/圆角/间距/阴影/动效 |
| E2 | **A** | 同上，暗色覆盖 | 同文件 `@media(prefers-color-scheme:dark)` 块 3（66 个变量） | 暗色全部取值 |
| E3 | **A** | 同上，旧版兼容层 | 同文件 `:root` 块 1（36 个变量） | `--canvas/--panel/--bg/--blue/--ok/--warn/--err` 等别名 |
| E4 | **A** | 同上，markstream markdown 主题 | 同文件 `.dark .markstream-vue` / `.markstream-vue` 根块 | markdown/代码块专用 token（`--ms-*`、`--code-bg`） |
| E5 | **A** | 同品牌可读源码版主题 | `apps/vis/web/src/theme.css:9-53` | `@theme` 暗色基线：`--color-surface-0..3`、`--color-fg-0..3`、类别强调色 |
| E6 | **A** | 同上，亮色覆盖 | `apps/vis/web/src/theme.css:60-96` | 亮色全部取值 + 注释「Accents get darker variants for AA contrast on light backgrounds」 |
| E7 | **A** | 同品牌 TUI 语义色板 | `apps/kimi-code/src/tui/theme/colors.ts:82-107`（dark）/ `:109-134`（light） | `primary/accent/text/.../roleUser` 语义色 + 明暗双套 |
| E8 | **A** | 品牌对可访问性的自述契约 | `apps/kimi-code/src/tui/theme/colors.ts:9-11` | 「Light palette values are tuned for **≥ 4.5:1** contrast against #FFFFFF for text tokens and **≥ 3:1** for chrome, matching **WCAG AA**」 |
| E9 | **A** | 可用性/词法规范（非色彩） | `.agents/skills/write-tui/DESIGN.md:10-24, 50-56, 86-92` | 语义 token 强制、装饰约束、"不加多余分隔线"的克制纪律 |
| E10 | **A** | 仓库自我陈述 | `references/kimi-code/AGENTS.md`（web UI 产物来源段） | 证明 `dist-web` = 线上发布物 |
| E11 | **B** | kimi.com 首页运行时取值 | `getComputedStyle(document.body)`，2026-09-11 | `background-color: rgb(24,24,23)`＝`#181817`（暗色）；CSSOM 变量与 E1/E2 逐项一致 |
| E12 | **B** | kimi.com `/code` 页运行时取值 | 同上 | `.kimi-logo-box { background: rgb(26,136,255); border-radius: 7px }`；`.kfc-hero-title { font-size:48px; font-weight:600; letter-spacing:-0.96px }` |
| E13 | **B** | 页面实测字形统计 | `/code` 页全元素 `fontFamily` 计数 | `Schibsted Grotesk Variable` 派生栈 214 次；`JetBrains Mono` 41 次 |
| E14 | **B** | 页面装饰元素普查 | `/code` 页 507 个元素 | `linear-gradient` 背景 **0** 个；`box-shadow` 非 none **1** 个；`<svg>` **0** 个；`<img>` **1** 个（飞书二维码） |

### 1.2 二级/辅助证据（C / D 级，仅作旁证）

| # | 等级 | 证据 | 来源 | 用途 |
|---|---|---|---|---|
| E15 | **C** | Kimi Code 落地页截图 | `https://www.kimi.com/code` 全页截图（2026-09-11，存 `.tmp-kimi-shot/kimi-code-dark.png`） | 目视确认：无插画、无渐变、主 CTA 为**白色实心按钮**而非品牌蓝 |
| E16 | **C** | 首页截图 | `https://www.kimi.com/`（同目录） | 目视确认构图疏密 |
| E17 | **D** | 官方品牌指引页 | `https://moonshotai.github.io/Branding-Guide` | 仅确认「KIMI=字标+图标、有明/暗/彩底三套用法」；**其正文未给出任何 hex**，故未采用任何取值 |
| E18 | **D** | Kimi Code CLI Web UI 文档 | `https://moonshotai.github.io/kimi-cli/en/reference/kimi-web.html` | 仅作布局描述旁证（桌面=侧栏+主区） |

### 1.3 明确**未能**实测到的内容（诚实边界）

- ❌ **未登录态无法进入真实会话**：`kimi.com` 未登录常驻「登录以同步历史会话」。
  因此**真实 AI 回复的 markdown 正文/代码块渲染**未能在浏览器中实测。
  → 该部分改用 **A 级证据 E4**（`dist-web` 中的 `--ms-*` / `--code-*` token）替代，**未使用猜测**。
- ❌ **未遇到验证码**：`kimi.com` 与 `kimi.com/code` 均可直接加载，无 CAPTCHA / 人机挑战。
  故本任务书预案中的"改用截图描述"分支**未被触发**。
- ⚠️ **`dist-web` 的配色是压缩产物中的 `@media(prefers-color-scheme:dark)` 媒体查询**，
  是**系统偏好驱动**而非站点 UI 开关；这一点与 `vis/web/theme.css` 的 `data-theme` 属性驱动不同。
  两个前端是不同代码库，本文件在引用时已分别标注来源，未互相污染。

---

## 2. 色板（全部为 A/B 级实测值）

### 2.1 Kimi Code web 中性底色阶

> 来源：E1（亮色，`:root` 块 2）/ E2（暗色，`@media(prefers-color-scheme:dark)` 块 3）。
> **暗色是基线**（源码注释原文：`Dark theme is the baseline; light theme overrides the same variable names below.`），
> 但下表两栏并列给出，因二者是对称的完整集合。

| Token | 亮色 | 暗色 | 承载角色 |
|---|---|---|---|
| `--color-bg` | `#ffffff` | `#121212` | 主背景 |
| `--color-surface` | `#f5f5f5` | `#1f1f1f` | 次级面 |
| `--color-surface-raised` | `#ffffff` | `#292929` | 抬升面（卡片/气泡） |
| `--color-surface-overlay` | `#ffffff` | `rgba(255,255,255,.1)` | 浮层 |
| `--color-surface-sunken` | `#f5f5f5` | `#121212` | 下沉面（**代码块底**） |
| `--color-surface-deep` | `#f5f5f5` | `#0d0d0d` | 最深面 |
| `--color-well` | `#f5f5f5` | `#1f1f1f` | 井状容器 |
| `--color-sidebar-bg` | `#f9fbfc` | `#0d0d0d` | **侧栏** |
| `--canvas` | `#f9fbfc` | `#161717` | 画布（E3 兼容层） |
| `--color-user-bubble-bg` | `#f5f5f5` | `#292929` | **用户气泡** |
| `--color-inline-code-bg` | `rgba(0,0,0,.03)` | `rgba(255,255,255,.1)` | 行内代码底 |
| `--color-hover` | `rgba(0,0,0,.03)` | `rgba(255,255,255,.05)` | 悬停 |
| `--color-selected` | `rgba(0,0,0,.05)` | `rgba(255,255,255,.1)` | 选中 |
| `--color-selected-hover` | `rgba(0,0,0,.08)` | `rgba(255,255,255,.14)` | 选中+悬停 |

**关键结构性观察（等级 A，这是本笔记最重要的一条）：**
中性色阶**无任何色相偏移**——亮色是纯灰 `#f5f5f5` + 极淡冷白 `#f9fbfc`，
暗色是纯灰 `#121212 / #1f1f1f / #292929` + 极淡冷黑 `#0d0d0d`。
**Kimi 是中性的，不是暖的。** 唯一带色相的中性面是侧栏/画布的 `#f9fbfc`、
暗色的 `#0d0d0d`，都偏向**极轻微冷调**，而非暖调。

> 旁证（等级 A）：同品牌 `vis/web/src/theme.css:63-68` 亮色面同样是冷灰系
> （`#fafbfc / #eef1f6 / #e4e8f0 / #d4d9e4`，蓝灰色相），一致指向"冷中性"立场。

### 2.2 文字色阶

| Token | 亮色 | 暗色 | 承载角色 |
|---|---|---|---|
| `--color-text-strong` | `#000000` | `#ffffff` | 最强 |
| `--color-text` | `rgba(0,0,0,.9)` | `rgba(255,255,255,.84)` | **正文默认** |
| `--color-text-muted` | `rgba(0,0,0,.6)` | `rgba(255,255,255,.56)` | 次级 |
| `--color-text-faint` | `rgba(0,0,0,.45)` | `rgba(255,255,255,.42)` | 最弱 |
| `--dim`（兼容层 E3） | `rgba(0,0,0,.6)` | `rgba(255,255,255,.56)` | 同 muted |
| `--muted` | `rgba(0,0,0,.45)` | `rgba(255,255,255,.42)` | 同 faint |
| `--faint` | `rgba(0,0,0,.3)` | `rgba(255,255,255,.26)` | 更弱 |

**可执行的工程观察**：文字色阶用 **alpha 叠加**而非实色 hex（除 `text-strong`）。
好处是同一 token 落在 `#ffffff` 或 `#f5f5f5` 上自动保持相对关系。
`--color-text` 暗色 `.84` 与实测 E11 的 `rgba(255,255,255,.84)` 完全吻合，
证明 `dist-web` 就是线上产物。

### 2.3 品牌强调色（**核裁决用的取值**）

| 场景 | 取值 | 来源 |
|---|---|---|
| **Kimi 品牌蓝（亮色）** | **`#1783ff`** | E1 `--color-accent` |
| Kimi 品牌蓝（亮色悬停） | `#167ff7` | E1 `--color-accent-hover` |
| **Kimi 品牌蓝（暗色）** | **`#1a88ff`** | E2 `--color-accent` |
| Kimi 品牌蓝（暗色悬停） | `#258eff` | E2 `--color-accent-hover` |
| 强调浅底（亮） | `#e8f3ff` | E1 `--color-accent-soft` |
| 强调浅底（暗） | `rgba(26,136,255,.1)` | E2 `--color-accent-soft` |
| 强调描边（亮） | `rgba(23,131,255,.25)` | E1 `--color-accent-bd` |
| 强调描边（暗） | `rgba(26,136,255,.28)` | E2 `--color-accent-bd` |
| 文本选中 | `rgba(23,131,255,.2)` | E1 `--p-selection` |
| 代码区选中 | `rgba(23,131,255,.346)` | E1 `--color-code-selection` |
| focus ring | `0 0 0 3px var(--color-accent-soft)`（**3px**） | E1 `--p-focus-ring` |
| 品牌蓝（旧兼容层） | `#1783ff`（亮）/ `#1a88ff`（暗） | E3 `--blue` |

**品牌蓝的色相/饱和（脚本计算，非目测）：**

| 色 | HSL |
|---|---|
| `#1783ff` | **H212 S100% L55%** |
| `#1a88ff` | **H211 S100% L55%** |
| `#45708A`（我方 seal） | H203 S33% L41% |
| `#6FA0BC`（我方 seal-400 暗色） | H202 S36% L59% |

→ **色相一致（212° vs 203°，同属青蓝轴），饱和度差一个量级（100% vs 33%）。**
这条数值关系是 §5 结论的主要依据之一。

> 交叉验证（等级 A，另一前端）：`apps/vis/web/src/theme.css:13,42`。
> 该可读源码版**没有单一品牌蓝 token**，而是把强调拆成 8 个类别色
> （`--color-cat-conversation: #22d3ee` 等）+ 5 个会话角色色。
> **这印证了 Kimi 前端"强调色是分类信号、不是品牌装饰"的用法**，
> 但该文件是 debug 工具（`apps/vis` = 会话/回放可视化调试器），
> **不代表 Kimi Code 线上取值**，故其 hex 不作为 brand accent 裁决依据。

### 2.4 语义色

| 语义 | 亮色（`dist-web`） | 暗色（`dist-web`） | 另一前端亮色（`vis`） |
|---|---|---|---|
| success | `#0e7a38` | `#3fb950` | `#15803d` |
| warning | `#a9610a` | `#d29922` | `#b45309` |
| danger / error | `#c0392b` | `#f85149` | `#b91c1c` |
| info | `#1783ff`（**复用品牌蓝**） | `#1a88ff`（**复用品牌蓝**） | `#2563eb` |
| orange（额外档） | `#bc4c00` | `#f0883e` | — |
| done（额外档，紫） | `#8250df` | `#a371f7` | — |
| `--ok`（兼容层） | `#0e7a38` | `#3fb950` | — |
| `--warn` | `#a9610a` | `#d29922` | — |
| `--err` | `#c0392b` | `#f85149` | — |

**观察（等级 A）**：`--color-info` **直接等于** `--color-accent`。
即 Kimi **没有为 info 单开色相**——信息态就是品牌色。
这与我方 `tokens.md` 的做法（`info` 复用 seal 家族 `#2F4E60`/`#9FC3D6`）**思路一致**。

### 2.5 代码块配色（来自 A 级 E4，非猜测）

`dist-web` 有两套 markdown 配色，经 `--code-bg` 覆盖链解析：

**（a）应用正文 markdown（`.md[data-v-480fdb53]` 作用域内）——这是会话里真实生效的一套：**

| Token | 取值 |
|---|---|
| `--code-bg` | `var(--color-surface-sunken)` → 亮 `#f5f5f5` / 暗 `#121212` |
| `--code-fg` | `var(--color-text)` → 亮 `rgba(0,0,0,.9)` / 暗 `rgba(255,255,255,.84)` |
| `--code-border` | `var(--color-line)` → 亮 `rgba(0,0,0,.13)` / 暗 `rgba(255,255,255,.12)` |
| `--code-header-bg` | `var(--color-surface)` → 亮 `#f5f5f5` / 暗 `#1f1f1f` |
| `--code-font-size` | `calc(var(--content-font-size) - 2px)` |

**（b）markstream 独立渲染器的兜底默认（`.markstream-vue` 根）：**

| Token | 亮 | 暗 |
|---|---|---|
| `--ms-background` | `0 0% 100%` | `0 0% 7%` |
| `--ms-foreground` | `0 0% 10%` | `0 0% 93%` |
| `--ms-border` | `0 0% 87%` | `0 0% 20%` |
| `--ms-radius` | `8px` | `8px` |
| `--code-bg`（兜底） | `#fff` | `#111827` |
| `--inline-code-bg` | `hsl(var(--ms-secondary))` = 亮 `0 0% 93.5%` | `0 0% 16%` |

**关键观察（等级 A）**：`--ms-*` **全部是无彩色的 `0 0%` HSL**。
即 **Kimi 的 markdown/代码渲染区是纯灰阶，唯一彩色来自语法高亮的第三方主题**
（`dist-web/assets/` 内含 60+ 主题：github-dark / dracula / gruvbox / tokyo-night / pierre-* 等）。
**不是一个自造彩色代码配色体系。**

### 2.6 明暗模式策略（对比）

| 维度 | Kimi Code web | 我方 tokens.md |
|---|---|---|
| 基线 | **暗色为基线**，亮色覆盖（E1 源码注释） | 暖纸亮色为基线，暗色为"体验锚点" |
| 切换机制 | `@media(prefers-color-scheme:dark)`（系统偏好） | `[data-theme]` 属性（手动可控） |
| 中性面 | 纯灰 `#ffffff/#f5f5f5` / `#121212/#1f1f1f/#292929` | 暖纸 `#FFFDF8/#FBF7EE/#F5EFE4` / 冷夜 `#22303A/#1A242B` |
| 色相温度 | **冷中性**（侧栏 `#f9fbfc`、暗底 `#0d0d0d` 微冷） | **暖纸**（85–88° oklch），暗色偏蓝 `#1A242B` |
| 文字 | alpha 叠加 | 实色 hex（暖墨 ink / 冷雾 mist） |
| 暗色正文 | `rgba(255,255,255,.84)` | `#E9EFF3`（mist-50） |

---

## 3. 「极简 / 优雅 / 实用」的具体解码

> 这一节回答"Kimi 的极简到底极简在哪"，全部尽量落到数值。

### 3.1 留白尺度

| 项 | Kimi 取值 | 来源 | 说明 |
|---|---|---|---|
| **内容阅读列宽上限** | **`760px`** | E1 `--p-content-max: 760px` | 与我方 `--ap-size-chat-max: 760px` **完全相同** |
| 宽版内容上限 | `920px` | E1 `--p-content-wide` | 表格/宽块 |
| 表格上限 | `1040px` | E1 `--p-table-max` | |
| 表格单元格上限 | `700px` | E1 `--p-table-cell-max` | |
| **侧栏宽** | **`264px`** | E1 `--p-sidebar-w: 264px` | 我方 `--ap-size-sidebar: 248px` |
| 详情面板宽 | `460px`（启动器 288px） | E1 `--p-panel-default-w` / `--p-panel-launcher-w` | 我方 `--ap-size-detail: 320px` |
| 用户气泡最大宽 | `78%` | E1 `--p-bubble-max: 78%` | |
| 段落间距（块） | `10px` | E1 `--chat-block-gap` | |
| 轮次间距 | `16px` | E1 `--chat-turn-gap` | |
| 区块间距 | `18px` | E1 `--chat-section-gap` | |
| 间距阶梯 | `2 / 4 / 6 / 8 / 12 / 16 / 20 / 24 / 32` | E1 `--space-05..--space-8` | 我方同阶梯，额外有 40/48/64/80 大留白档 |

**「极简」在留白上的具体含义（等级 A）**：
Kimi 用的是**极窄的内容列 + 中性大背景**——`760px` 列宽放在 1370px+ 的视口里，
两侧各留 ~300px 空白（E12 实测侧栏 240–264px，主区 1092–1124px）。
极简感来自**"内容集中、边缘空旷"，而不是"元素很少"**。

> 实测佐证（等级 B）：`/code` 页 `max-width` 分层为
> 展示容器 `1300px` → 内容 `920px` → 终端模拟窗 `800px` → 终端内容 `750px`。
> 每一层都在收窄，而非铺满。

### 3.2 字阶与字重层级

**（a）UI 字阶**（E1，基准 `--base-font: 14px`，`--ui-shift = base - 14px`）：

| Token | 值 | 角色 |
|---|---|---|
| `--ui-c2` | `10px` | 最小（角标） |
| `--ui-c1` | `12px` | 说明/caption |
| `--ui-b2` | `14px` | **UI 正文默认** |
| `--ui-b1` | `15px` | |
| `--ui-t2` | `16px` | 小标题 |
| `--ui-t1` | `min(18px+shift, 22px)` | 标题 |
| `--ui-t0` | `min(20px+shift, 24px)` | 大标题 |

**（b）Markdown 正文阶**（E1）：

| Token | 值 |
|---|---|
| `--md-b3` / `--md-b2` | `13px` |
| `--md-b1` | `14px`（**正文默认**） |
| `--md-h3` | `18px` |
| `--md-h2` | `20px` |
| `--md-h1` | `22px` |

**（c）会话正文实测字体规则**（E1，`.md[data-v-480fdb53]`）：

```
font: 400 var(--content-font-size)/1.6 var(--font-ui);
line-height: round(calc(var(--content-font-size) * 1.625), 1px);
```

且 `--content-font-size: calc(var(--md-b1) + 2px)` = **16px**（会话内加 2px）。
→ **会话正文 = 16px / 行高 26px = 1.625**。

> **与 `tokens.md` 的巧合级一致**：我方 `--ap-fs-body-lg: 16px` / `--ap-lh-body-lg: 26px`
> = **1.625**。**Kimi 与我们在"正文 16px / 行高 1.625"上完全同值**
> （见 §4 对照表）。这是一个非常强的"我们已经在同一条路上"的信号。

**（d）字重（E1）**：

| Token | 值 |
|---|---|
| `--weight-regular` | `400` |
| `--weight-caption` | `450` |
| `--weight-option-label` | `475` |
| `--weight-medium` | `500` |
| `--weight-ui-strong` | `525` |
| `--weight-section-label` | `600` |
| `--weight-semibold` | `700` |

**观察（等级 A，可直接搬的一条）**：Kimi 有 **450 / 475 / 525 三个"非整百"字重**。
这依赖可变字体（`Schibsted Grotesk Variable`，E1/E13）才能真实渲染。
含义：**Kimi 用字重的"微差"做层级，而不是靠颜色深浅或加粗跳档**——
这正是"优雅"的工程来源。我方 `tokens.md` 只用 400/500/600/700，
且 `§4.3` 明确"禁用 `font-synthesis`"。**这是差异点，也是我方现有字体的能力边界。**

**字号自适应**（E2/E1）：`--ui-shift: calc(var(--base-font, 14px) - 14px)`，
全部字阶随 `--base-font` 整体平移。这是一个**"用户可调字号"的架构级设计**。

### 3.3 圆角与边框

**圆角阶梯**（E1 亮色默认）：

| Token | 值 | 我方对应 | 差 |
|---|---|---|---|
| `--radius-xs` | `4px` | `--ap-radius-sm: 4px` | 同值，档名不同 |
| `--radius-sm` | `6px` | `--ap-radius-md: 6px` | 同值，档名不同 |
| `--radius-md` | `8px` | `--ap-radius-tool-card: 8px` | 同值 |
| `--radius-lg` | `12px` | `--ap-radius-lg: 10px` | **Kimi 大一档** |
| `--radius-xl` | `16px` | `--ap-radius-xl: 14px` | **Kimi 大一档** |
| `--radius-2xl` | `20px` | `--ap-radius-2xl: 20px` | 同值 |
| `--radius-window` | `14px` | — | 无对应 |
| `--radius-composer` | **`32px`** | — | 无对应（输入框胶囊化） |
| `--radius-full` | `999px` | `--ap-radius-full: 9999px` | 同义 |
| `--radius-menu-row` | `var(--radius-sm)` = 6px | — | |
| `--radius-menu-item` | `calc(12px - 3.5px - 0.5px)` = **8px** | — | 嵌套圆角公式 |

**观察（等级 A）**：
- 主力圆角**集中在 `--radius-sm`(6px，78 次) / `--radius-full`(73 次) / `--radius-md`(8px，62 次)**
  （E1 全文件 `border-radius:` 计数）。
- **Kimi 大量使用"嵌套圆角公式"**：`--radius-menu-item: calc(var(--radius-lg) - var(--menu-pad) - var(--p-hairline))`。
  即内层圆角 = 外层圆角 − 内边距 − 发丝线宽。
  这是"**同心圆角**"纪律，是"优雅"的一个可量化来源——我方 `tokens.md` **没有这套公式**。
- **`--p-hairline: .5px`**：Kimi 把 0.5px 发丝线作为一等 token 参与计算。
  我方有 `--ap-border-w-hairline: 0.5px`，但**未参与圆角计算**。

**边框**（E1）：

| Token | 亮 | 暗 |
|---|---|---|
| `--color-line` | `rgba(0,0,0,.13)` | `rgba(255,255,255,.12)` |
| `--color-line-strong` | `rgba(0,0,0,.15)` | `rgba(255,255,255,.18)` |
| `--color-subtle` | `rgba(0,0,0,.05)` | `rgba(255,255,255,.05)` |

**观察**：`line` 仅 **13% 黑**，`line-strong` 也才 15%——**极淡**。
分隔靠"极低对比的线 + 面差"，而非明显描边。这与"极简"直接相关。

**焦点环**：`--p-focus-ring: 0 0 0 3px var(--color-accent-soft)` → **3px 且用 10% 品牌色浅底**，
不是实色描边。我方是 2px 实色 `#45708A` + 2px offset。

### 3.4 组件克制度（计数级描述）

**装饰元素普查结果**：

| 指标 | Kimi Code 落地页实测（E14，507 元素） | Kimi Code 打包 CSS 全文（E1/E2 计数） |
|---|---|---|
| `linear-gradient` 背景元素 | **0** | 62 处（绝大多数是**功能性**遮罩/淡出/棋盘格底，非装饰） |
| `radial-gradient` | — | **0** |
| `box-shadow` 非 none 元素 | **1** | 192 处（绝大多数是 `--shadow-xs/sm` 级） |
| `<svg>` 元素 | **0** | — |
| `<img>` 元素 | **1**（飞书二维码） | — |
| 有边框元素 | 15 / 507 ≈ **3%** | — |

**插画 / 渐变 / 阴影的结论（等级 A+B+C）**：

1. **无插画**。落地页唯一的位图是二维码。
   `dist-web/assets/` 中仅 2 个动画资产：`k3_doodle1-27EZ2HSw.riv`、`kimi_avatar_default-srYjF2HV.riv`（Rive 格式）。
   → 有**一个头像动画**和一个涂鸦，**但没有插画体系**。
2. **无装饰渐变**。全页 0 个渐变背景；打包 CSS 里的 62 个 `linear-gradient` 经查是
   棋盘格透明底（`--media-alpha-canvas`）、流式 shimmer、滚动淡出遮罩等功能性用途。
3. **阴影极省**。落地页 507 个元素只有 1 个有阴影。
   打包 CSS 的阴影阶梯（E1）收敛为 `xs/sm/md/lg/xl` + `menu/input/send`，
   且暗色下**全部降为纯黑 alpha**（`rgba(0,0,0,.2)` 起），**不使用彩色阴影**。

> **这条对裁决极重要**：Kimi 的"极简"= **不用插画、不用渐变、不用彩色阴影**，
> 而不是"用很少的颜色"。它是**靠消除装饰元素**达成的，不是靠调色板收敛。

### 3.5 动效使用程度

| Token | Kimi | 我方 `tokens.md` |
|---|---|---|
| `--duration-fast` | **`.12s`** | `--ap-duration-instant: 80ms` / `fast: 140ms` |
| `--duration-base` | **`.16s`** | `--ap-duration-base: 200ms` |
| `--duration-slow` | **`.26s`** | `--ap-duration-slow: 320ms` |
| 悬停意图 | `.25s` | — |
| Tooltip | `.3s` | — |
| 旋转 | `.7s` | — |
| Flash | `1.2s` | — |
| `--ease-out` | `cubic-bezier(.16, 1, .3, 1)` | `--ap-ease-enter: cubic-bezier(0.16, 1, 0.3, 1)` — **完全相同** |
| `--ease-in-out` | `cubic-bezier(.4, 0, .2, 1)` | `--ap-ease-exit: cubic-bezier(0.4, 0, 1, 1)` — 近似但不同 |

`@keyframes` 共 **44 个**（E1），其中与"活着"相关的：
`think-breathe-854f9154`（思考呼吸）、`kimi-eye-blink` / `kimi-eye-look`（头像眨眼/视线）、
`kw-dot-pulse-ddf97fc4`（点脉冲）、`typewriter-cursor-blink`（打字光标）。

**观察（等级 A）**：
- **Kimi 的动效比我方"更快"**：base `.16s` vs 我方 `200ms`。
  "优雅"在这里体现为**快速落定**（`ease-out` 快起慢收 + 短时长），而不是"慢动作"。
- **Kimi 同样有"呼吸"与"眨眼"**——即我方的 presence thinking 呼吸（2400ms）思路
  **与 Kimi 同源**，但我方周期更慢、更"陪伴"，Kimi 更快、更"工具"。
- **`--ease-enter` 与 Kimi `--ease-out` 逐位相同**：说明我方这条曲线选对了。

### 3.6 "极简/优雅/实用"的一句话解码

> **Kimi Code web 的极简 = 冷中性灰阶 + 760px 窄内容列 + 无插画/无装饰渐变/无彩色阴影；
> 优雅 = 同心圆角公式 + 450/475/525 微差字重 + 极淡分隔线；
> 实用 = 主操作按钮用中性墨色而非品牌色 + 快速动效(.12–.16s) + 品牌色只出现在链接/徽标。**

**最后一条是本笔记最反直觉、也最关键的一条，单独用实测数据支撑：**

| 元素 | 实测取值（E12，`/code` 页 2026-09-11） |
|---|---|
| 主 CTA「注册/登录」按钮 | `background: rgba(255,255,255,.84)`（**白**）、`color: rgb(18,18,18)`（**黑字**）、`border-radius: 12px` |
| 安装命令输入壳 | `background: rgb(31,31,31)`、`border-radius: 14px` |
| 「安装 Kimi Code」选择器 | `background: rgba(255,255,255,.84)`（**白**） |
| 品牌蓝出现位置 | 仅 banner 文字 `rgb(26,136,255)`、`立即体验` 链接、`推荐` 徽标、`最高立省` 徽标 |

打包 CSS 同向印证（E1/E2）：

| Token | 亮 | 暗 |
|---|---|---|
| `--color-send-bg`（**发送按钮底**） | **`rgba(0,0,0,.9)`** ← 黑 | `rgba(255,255,255,.84)` ← 白 |
| `--color-send-icon` | `#ffffff` | `#1f1f1f` |
| `--color-send-bg-hover` | `#252525` | — |

→ **Kimi 的"发送"主按钮是纯墨色/纯白色，不是品牌蓝。**
品牌蓝**从不承担大面积填充**，只用于：链接、徽标文字、选中态、focus ring、soft 浅底。

---

## 4. 与 `docs/design/tokens.md` 的逐项对照

> 左列为我方冻结值（来源 `docs/design/tokens.md`，未修改），右列为 Kimi 实测。

| 项 | agentplant `tokens.md` | Kimi Code web | 判定 |
|---|---|---|---|
| **底色策略** | **暖纸**：`surface-0 #F5EFE4` / `1 #FBF7EE` / `2 #FFFDF8`（oklch 85–88°，明显暖黄） | **冷中性**：`#f5f5f5` / `#ffffff` / `#f9fbfc`，无色相偏移 | ❌ **根本差异** |
| **暗色底色** | 冷蓝夜 `#1A242B` / `#22303A` / `#2B3A45`（231° 青蓝） | 纯中性 `#121212` / `#1f1f1f` / `#292929`（**零色相**） | ❌ 差异（我方暗色反而更"有色"） |
| **文字色** | 实色暖墨 `#2A2622`→`#A79C8C`（5 档） | alpha 叠加 `rgba(0,0,0,.9/.6/.45)`（3 档）+ strong | ⚠️ 机制不同，效果相近 |
| **强调色（亮）** | **seal `#45708A`**（H203 S33% L41%） | **`#1783ff`**（H212 **S100%** L55%） | ⚠️ **同色相轴，饱和度差 3 倍** |
| **强调色（暗）** | seal-400 `#6FA0BC`（H202 S36% L59%） | `#1a88ff`（H211 S100% L55%） | ⚠️ 同上 |
| **暖棕候选** | `#8C6845`（H30 S34% L41%） | —— | ❌ **H30° 与 Kimi H212° 正交，色温相反** |
| **主操作按钮填充** | `--ap-accent #45708A`（**品牌色实心**） | `--color-send-bg rgba(0,0,0,.9)`（**中性墨色**） | ❌ **理念差异（我方用品牌色，Kimi 用中性色）** |
| **语义色 success** | `#3A6B45`（暖苔绿） | `#0e7a38`（纯绿） | ✅ 功能等价 |
| **语义色 danger** | `#8B2C1F`（暖陶土） | `#c0392b`（纯红） | ✅ 功能等价 |
| **语义色 info** | `#2F4E60`（seal 家族） | `#1783ff`（= accent 同值） | ✅ **同思路**（info 复用强调色家族） |
| **圆角阶梯** | `2/4/6/10/14/20/9999` | `4/6/8/12/16/20/999` + **composer 32px** | ⚠️ Kimi 每档大 0–2px，且多"输入框胶囊"档 |
| **圆角公式** | 无（固定档位） | **同心圆角 `calc(outer − pad − hairline)`** | ❌ **Kimi 独有** |
| **发丝线** | `0.5px`（`≥2×DPI` 限制） | `--p-hairline: .5px`（参与圆角计算） | ⚠️ 同值，用途更广 |
| **字号阶梯** | `11/12/13/14/15/16/17/20/28` | UI `10/12/14/15/16/18/20` + md `13/14/18/20/22` | ⚠️ 结构不同，**重心同为 14–16px** |
| **正文** | `body-lg 16px / lh 26px = 1.625` | `content-font-size 16px / lh 26px = 1.625` | ✅ **逐值相同** |
| **字重** | `400/500/600/700` | `400/450/475/500/525/600/700` | ❌ **Kimi 有微差字重（依赖可变字体）** |
| **字距** | `-0.01em` / `0` / `0.02em`；CJK 强制 0 | hero `-0.96px`（48px 下 ≈ `-0.02em`）；正文无 | ✅ 近似 |
| **阅读列宽** | `--ap-size-chat-max: 760px` | `--p-content-max: 760px` | ✅ **完全相同** |
| **侧栏宽** | `248px` | `264px` | ⚠️ 差 16px |
| **详情面板** | `320px` | `460px`（默认）/ `288px`（启动器） | ⚠️ Kimi 更宽 |
| **间距阶梯** | `2/4/6/8/12/16/20/24/32/40/48/64/80` | `2/4/6/8/12/16/20/24/32` | ⚠️ Kimi **无 40+ 大留白档** |
| **对话段落间距** | `--ap-space-20: 20px` | `--chat-block-gap: 10px` / `turn 16px` / `section 18px` | ⚠️ Kimi 更紧凑 |
| **阴影色** | **暖墨** `rgb(42 38 34)` | **中性/纯黑** `rgba(16,24,40,.04)` 亮 / `rgba(0,0,0,.2)` 暗 | ❌ 色温相反 |
| **动效时长** | `80/140/200/320/480ms` | `.12/.16/.26s` = `120/160/260ms` | ⚠️ **Kimi 更快** |
| **缓动** | `ease-enter(0.16,1,0.3,1)` | `--ease-out(0.16,1,0.3,1)` | ✅ **逐位相同** |
| **focus ring** | `2px` 实色 `#45708A` + `2px` offset | `3px` 品牌色 **10% 浅底**（`--p-focus-ring`） | ⚠️ 机制不同 |
| **克制度：插画** | 禁止（P1「装饰性渐变、贴纸、插画不得新增色 token」） | 无插画（全页 0 个装饰 SVG） | ✅ **同立场** |
| **克制度：装饰渐变** | P2 单强调色，克制 | 全页 **0** 个渐变背景 | ✅ **同立场** |
| **克制度：彩色阴影** | 明确禁止（`§5.4`「禁止暗色使用大扩散彩色阴影」） | 无彩色阴影 | ✅ **同立场** |
| **presence/呼吸动效** | 五态 + `2400ms` 呼吸 | `think-breathe` / `kimi-eye-blink` / `kw-dot-pulse` | ✅ **同源思路** |
| **暗色地位** | 「体验锚点但不是默认主题」 | **暗色是基线**（源码注释） | ❌ 相反 |

### 4.1 相同点汇总

1. **阅读列宽 760px 逐值相同**——最硬的巧合，说明两方对"桌面宽屏阅读列宽"的判断一致。
2. **正文 16px / 行高 1.625 逐值相同**。
3. **缓动曲线 `cubic-bezier(0.16,1,0.3,1)` 逐位相同**。
4. **克制度立场相同**：都明确拒绝装饰性渐变、插画、彩色阴影。
5. **`info` 复用强调色家族**的思路相同。
6. **呼吸/脉冲表达"在思考"** 的做法同源。
7. **圆角主力档位落点相近**（6–8px 控件档、20px 大容器档）。

### 4.2 差异点汇总

1. **底色温度**：暖纸（85–88°）vs 冷中性（无色相）。**这是最大、最不可调和的一条。**
2. **主操作用色**：我方品牌色实心按钮 vs Kimi 中性墨色按钮。
3. **强调色饱和度**：33% vs 100%。
4. **字重粒度**：Kimi 有 450/475/525 微差档（可变字体）。
5. **圆角纪律**：Kimi 有同心圆角公式，我方是固定档位表。
6. **暗色地位相反**：Kimi 暗色基线，我方亮色基线。
7. **动效速度**：Kimi 快约 25%（160 vs 200ms）。
8. **间距紧凑度**：Kimi 对话块间距 10px，我方 20px。
9. **Kimi 无大留白档**（40px 以上），我方有 64/80px 孤岛留白。

---

## 5. 结论与建议

### 5.1 ① 青蓝 vs 暖棕：哪个更贴合 Kimi 风？

**明确判断：印章青蓝 `#45708A` 明显更贴合；暖棕 `#8C6845` 与 Kimi 风相冲。**

理由（三条，均为可核查证据）：

1. **色相轴一致（决定性）**。脚本计算（§2.3）：
   `#1783ff` = **H212**，`#45708A` = **H203**，`#8C6845` = **H30**。
   青蓝与 Kimi 品牌蓝**同在青蓝轴，仅差 9°**；暖棕与之**正交 182°，色温完全相反**。
   Kimi 整个体系（底色、文字、代码区）都是冷中性，暖棕会引入 Kimi 体系里
   **根本不存在的暖色相**。

2. **"冷"是 Kimi 极简感的载体**。E1/E2 显示 Kimi 的中性面无色相偏移，
   侧栏 `#f9fbfc`、暗底 `#0d0d0d` 反而**微冷**。
   我方暗色 `#1A242B / #22303A`（231° 青蓝）本就偏冷，
   **与 Kimi 的暗色方向一致**；而暖棕 `#8C6845` 在暗色 `#1A242B` 上的对比
   只有 **3.14:1**（脚本实测，`docs` §2.4 要求非文本 ≥3:1，勉强；作正文则**远不达标**）。
   反观 seal-400 `#6FA0BC` 在 `#1A242B` 上为 **5.58:1**，宽裕。

3. **Kimi 的强调色是"冷 + 用在链接/徽标"**，与 seal 在我方体系中的角色
   （链接、选中、focus ring、presence-streaming）**角色定位一致**；
   暖棕在我方体系中并无既有角色支撑，属新增色相。

**但也必须诚实指出**：**两个候选都不等于 Kimi 风**，因为
**Kimi 风的核心是"冷中性底"，而我方基底是"暖纸本"**——这是 `tokens.md`
贯穿始终的产品立场（P2「低饱和纸感基调」、openhanako 书桌感）。
选青蓝只是"不冲突"，**不等于"变身 Kimi"**。

### 5.2 ② 是否需要第三方案？

**结论：不建议引入第三个强调色。** 但给出一个"若必须贴合 Kimi 色相"的**经过实测的**备选。

**为什么不建议**：Kimi 实测强调色 `#1783ff` **在我方体系下不可用**，脚本实测：

| 检查项 | `#1783ff` 实测 | 我方 `tokens.md` 契约 | 结果 |
|---|---|---|---|
| 作正文文字（≤18.66px）落 `#F5EFE4`（surface-0） | **3.20:1** | ≥4.5:1 | ❌ **不达标** |
| 落 `#FBF7EE`（surface-1） | **3.43:1** | ≥4.5:1 | ❌ **不达标** |
| 落 `#FFFDF8`（surface-2） | **3.61:1** | ≥4.5:1 | ❌ **不达标** |
| 落 `#EAF0F4`（bubble-user，**我方浅色最差面**） | **3.01:1** | ≥4.5:1 | ❌ **不达标（最差）** |
| 作 `<a>` 链接色（`tokens.md §2.2` 要求 `accent-text` 达标） | 同上 3.01–3.61 | ≥4.5:1 | ❌ **不达标** |
| 实心按钮底 + 反白字 `#FFFDF8` | **3.61:1** | ≥4.5:1 | ❌ **不达标** |
| 暗色下 `#1a88ff` 落 `#1A242B` | 4.51:1 | ≥4.5:1 | ⚠️ 压线通过 |
| 暗色下 `#1a88ff` 落 `#22303A` | **3.87:1** | ≥4.5:1 | ❌ **不达标** |

→ **直接采用 Kimi 的 `#1783ff` 会打破 `tokens.md` 附录 A 的 109 项全绿记录。**
（注：`#1783ff` 在 Kimi **自己的**冷白底 `#ffffff` 上也只有 **3.67:1**——
说明 Kimi 是**有意**把品牌蓝用在"非正文"位置：徽标、16px 链接、
以及 `--color-send-bg` 那个**根本不用蓝**的按钮。Kimi 的 AA 达标是靠**限定使用范围**，
不是靠颜色本身。这一点必须让主 agent 知道：**照抄色值 ≠ 照抄风格。**）

**若主 agent 确实需要"Kimi 同色相 + 我方 AA 达标"的第三方案**，脚本筛选结果：

| 候选 hex | 我方浅色面最差 | Kimi 冷白面最差 | `#FFFDF8` 反白 on 它 | HSL | 判定 |
|---|---|---|---|---|---|
| `#1783ff`（Kimi 原值） | 3.01 | 3.36 | 3.61 | H212 S100% L55% | ❌ 破契约 |
| `#1273e6` | 3.73 | 4.17 | 4.47 | H212 S86% L49% | ❌ |
| `#1668cc` | 4.44 | 4.96 | 5.32 | H212 S79% L44% | ⚠️ 差 0.06 |
| **`#0D5FBF`** | **5.06** | **5.65** | **6.06** | H212 S87% L40% | ✅ **推荐** |
| `#0b57ad` | 5.78 | 6.46 | 6.93 | H212 S88% L36% | ✅ 但偏深 |

**推荐值：`#0D5FBF`**（H212，与 Kimi 品牌蓝**同色相**，压暗 4 档后在我方暖纸底上全项达标）。
**风险分析（必须一并交给主 agent）**：
- ✅ 对比度**优于** seal-500（最差 5.06 vs 4.66；反白 6.06 vs 5.25）。
- ⚠️ **饱和度 87% 远高于 seal 的 33%**，落在暖纸 `#F5EFE4` 上会**明显"跳"**，
  与 P2「低饱和纸感基调」张力大——**这是审美代价，不是可访问性代价**。
- ⚠️ **只有浅色侧有实测值**。暗色侧需要单独压亮到在 `#1A242B` 上 ≥4.5:1 的变体，
  **本笔记未实测该暗色变体，故不给出 hex**（避免编造）。若采用，须补一次 109 项重测。
- ⚠️ 引入它等于**放弃 seal 家族**（7 个 L1 档 + 全部 L2 引用），改动量远大于"换两个 hex"。

### 5.3 ③ 若用户最终选择"贴合 Kimi 风"，`tokens.md` 需要改动的最小集合

**重要前提**：下面的改动**只动 L1/L2 取值与 L3 数值行，不动 `tokens.md` 的结构**
（三层模型、命名规范、§0.3 守门表、5 条原则、presence 五态均保持原样）。
且**本笔记不代为修改**，仅列出"最小集合"供主 agent 裁决。

**方案 A：只换强调色为 Kimi 同色相并保 AA（最小改动，约 6 行）**

| 位置 | 现取值 | 建议 | 说明 |
|---|---|---|---|
| `§2.1` seal 块 | `--ap-seal-500: #45708A` | `#0D5FBF` | 亮色实心/focus |
| `§2.1` seal 块 | `--ap-seal-600: #3F6179` | 需重算（hover/text） | 必须同色相重排 |
| `§2.1` seal 块 | `--ap-seal-700: #2F4E60` | 需重算（active） | 同上 |
| `§2.1` seal 块 | `--ap-seal-100/200/300/400` | 需重算 | 浅底/暗色档 |
| `§2.2` accent 表 | 6 行 | 随 L1 联动 | 值变、结构不变 |
| `§2.4` + 附录 A | 109 项 | **必须整表重测** | 硬门禁 |

> 注：因 `tokens.md §0.2` 要求「无别名链」「每档位被 L2 直接引用」，
> 换色**不是改 1 个 hex，而是重排 seal 全家族 7 档 + 重跑 109 项**。

**方案 B：不动色板，只借 Kimi 的"用法纪律"（零 hex 改动，最贴合 Kimi 精神）**

| 位置 | 现取值 | 建议 | 依据 |
|---|---|---|---|
| `§2.2` accent 表 `--ap-accent`（主按钮底） | `#45708A` / `#6FA0BC` | 改为中性墨色（亮 `#2A2622`、暗 `#E9EFF3`），保留 accent 用于链接/选中/focus | E1 `--color-send-bg: rgba(0,0,0,.9)` / 暗 `rgba(255,255,255,.84)` |
| `§2.2` accent 表 `--ap-accent-subtle` | 保留 | 保留（Kimi 亦保留 `--color-accent-soft`） | E1 |
| `§5.3` 圆角表 | 固定档位 | **新增一行**同心圆角公式（如 `--ap-radius-inset: calc(外层 − 内边距 − 发丝线)`） | E1 `--radius-menu-item` |
| `§5.5` focus ring | `2px` 实色 + `2px` offset | 改 `3px` 品牌色 10% 浅底 | E1 `--p-focus-ring` |
| `§6.1` 时长 | `fast 140 / base 200ms` | 可选下调至 `120 / 160ms` | E1 `--duration-fast/.16s` |

**我的建议**：**方案 B**。它用**零 hex 风险**拿到 Kimi 风最本质的三件事
（中性主按钮、同心圆角、浅底 focus ring），且**完全不需要重跑 109 项**。
方案 A 只在"用户明确要求强调色本身看起来像 Kimi"时才需要。

**最后**：无论 A 还是 B，**暖棕 `#8C6845` 都应被淘汰**（§5.1）。

---

## 附录：可复现的取样脚本与命令

**A 级证据（本地源码）**：直接用 read 工具打开 §1.1 所列路径:行号。
`dist-web` 压缩 CSS 的取值抽取用 PowerShell 正则（如
`[regex]::Matches($t,'--[a-zA-Z0-9_-]+\s*:\s*[^;]+')`）。

**B 级证据（浏览器实测）**：`browser_execute` + `getComputedStyle` / CSSOM 遍历，
已存截图 `D:\agentplant\.tmp-kimi-shot\kimi-code-dark.png`。

**对比度计算脚本**：`D:\agentplant\.tmp-kimi-shot\contrast.mjs`、`c2.mjs`
（WCAG 2.x 相对亮度公式，与 `tokens.md §0.4` 同法）。

**取证一致性校验**：E11 实测 `rgba(255,255,255,.84)` 与 E2 的 `--color-text` 逐位相同，
证明 `dist-web` 与线上同源。

---

## 给主 agent 的裁决输入（≤10 行）

1. **判断**：青蓝 `#45708A`（H203）远胜暖棕 `#8C6845`（H30）。Kimi 品牌蓝 `#1783ff` = H212，与青蓝同轴仅差 9°；暖棕正交 182°，且暖棕在暗底 `#1A242B` 上仅 3.14:1（原文/非文本均危险）。**淘汰暖棕。**
2. **但别误读**：选青蓝只是"不与 Kimi 冲突"，**不等于变成 Kimi**——Kimi 风的内核是**冷中性底**，我方基底是**暖纸**（这是产品立场，不是 bug）。
3. **不可照抄 Kimi 色值**：`#1783ff` 落我方暖纸仅 **3.61:1**、反白仅 3.61:1，**直接用会打破 tokens.md 附录 A 的 109 项全绿**。Kimi 自己靠"限定使用范围"达标，不是靠色值。
4. **Kimi 最值得抄的是"用法"不是"颜色"**：主按钮用**中性墨色**（`--color-send-bg: rgba(0,0,0,.9)`），品牌蓝只出现在链接/徽标/选中/focus。
5. **巧合级一致（说明我们已在同一条路上）**：阅读列宽 **760px 逐值相同**；正文 **16px/1.625 逐值相同**；缓动 `cubic-bezier(0.16,1,0.3,1)` **逐位相同**；都拒绝插画/装饰渐变/彩色阴影。
6. **建议采用最小改动方案 B（零 hex 改动）**：主按钮改中性墨色 + 新增同心圆角公式 + focus ring 改 3px 浅底。**不需要重跑 109 项。**
7. **若坚持要"像 Kimi 的强调色"**：唯一经实测达标的同色相值是 **`#0D5FBF`**（最差 5.06:1、反白 6.06:1），代价是饱和度 87% vs seal 33%，与 P2 低饱和纸感张力大；且需重排 seal 全家族 7 档并重测 109 项。**暗色侧变体本笔记未实测，不提供 hex。**
8. **证据强度**：色值/字阶/圆角/间距/动效全部为 **A 级**（`dist-web` 是线上发布物本体，非类似物）；装饰计数有 **B 级**页面普查支撑。
9. **未能实测**：未登录态进不去真实会话，**AI 回复的 markdown/代码块渲染未在浏览器实测**，已用 A 级 `--ms-*`/`--code-*` token 替代，未猜测。站点**无验证码**，预案未触发。
10. **本笔记未改动** `tokens.md` / `ia-and-interaction.md` / 任何 `decisions` 文档。
