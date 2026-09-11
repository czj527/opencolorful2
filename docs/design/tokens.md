# agentplant 设计系统 Tokens 规划（v1.0.0）

> **文档定位**：设计系统 **tokens 层**的唯一真相来源（single source of truth）。
> 只定义取值、命名、语义与落地映射；不定义组件结构、不写业务代码、不引入二期要素。
>
> **输入（必读源材料）**
> - `docs/decisions/t1-reference-benchmark.md`（openhanako / hermes-agent / openclaw 对标蒸馏）
> - `docs/decisions/t2-positioning-mvp.md`（产品定位与 MVP 边界，用户 2026-09-11 拍板）
> - 旁证：`docs/decisions/t3-repo-ci.md`（pnpm monorepo 形态）、`docs/decisions/t7-click-paths.md`（MVP 可点击链路）
>
> **产品锚点**：单人自托管的私人 AI 助理 —— 本地可跑、有记忆、能办事；
> MVP 为**桌面宽屏优先**的单 Agent 聊天主循环 + 工具调用 + 简单记忆，SQLite 单库持久化。
> 体验差异化 = **陪伴感**（参考 openhanako 的书桌/人格侧）× **克制**（不二次元过度）。
>
> **状态**：v1.0.0 / 2026-09-11 / 规划稿。所有取值已冻结，**不含任何"待定"项**。
> 全部色彩对比度已逐项实测（见 §2.4 与附录 A），明暗双主题 109 项检查全部达标。

---

## 0. 文档约定

### 0.1 三层 token 模型

| 层 | 命名形状 | 是否可直接用于组件 | 说明 |
|---|---|---|---|
| **L1 原始层**（palette） | `--ap-{hue}-{step}`（如 `--ap-seal-500`） | ❌ 禁止 | 纯色值阶梯，无语义。组件引用 L1 = 违规 |
| **L2 语义层**（semantic） | `--ap-{role}-{variant}`（如 `--ap-surface-1`） | ✅ 唯一入口 | 明暗主题在此层切换；组件只写 L2/L3 |
| **L3 结构层**（structure） | `--ap-{space\|radius\|shadow\|fs\|lh\|fw\|z\|duration\|ease}-*` | ✅ | 与主题无关的恒定值（动效时长除外，见 §6.4） |

**硬约束**：组件 CSS 中只允许出现 `var(--ap-*)`（L2/L3）；出现任何硬编码 hex / 裸 px 字号 / 裸 ms 时长即为违规，由 CI 静态检查拦下（检查方案见 §9）。

### 0.2 命名规范（可机器解析）

- 统一前缀 `--ap-`；全小写；层级用 `-` 分隔：`--ap-{类}-{子类}-{变体}`。
- 数字档位直接写数值语义，不做抽象编号：`--ap-space-16: 16px`（值 = px），`--ap-seal-500`（档位而非亮度）。
- **保留色相名**（L1 专用，不得被语义 token 复用）：`paper` `ink` `night` `mist` `seal` `ember` `sage` `moss` `clay` `wheat` `iris`。
- **保留语义前缀**（L2 专用）：`surface` `text` `border` `accent` `success` `warning` `danger` `info` `presence` `ambient` `emotion`。
- 同一语义的"实心 / 文字 / 浅底 / 描边"四档固定后缀：`（无后缀）= 实心填充`、`-text`、`-subtle`、`-border`；反白文字固定 `-on`。
- 机器解析约定：`^--ap-(palette-hue|[a-z]+)-[a-z0-9-]+$`；禁止别名链（`--ap-a: var(--ap-b)` 只允许出现在 Tailwind `@theme` 桥接层，不允许出现在 token 定义层，以免解析脚本无法回溯原值）。

### 0.3 范围守门（scope gate）

| 类别 | 本文件收录 | 明确不收录（二期，且**不预留任何 token**） |
|---|---|---|
| presence / 任务状态 | ✅ 五态 presence + 任务终态（复用 `success`/`danger`/`text-*`） | ❌ 多 Agent 并发 presence 矩阵、委派深度 ≥2 的层级标识 |
| 环境氛围 | ✅ 房间色 / 暗角 / 光晕 / 纸纹 / 时间氛围 | ❌ cron 心跳灯、后台巡检进度色 |
| 渠道标识 | ❌ | ❌ 网关渠道徽标色（Telegram/飞书/QQ/微信）、渠道头像底色 |
| 协作 UI | ❌ | ❌ 群聊头像栈、并排消息列、成员在线色、草稿卡审批色 |
| 生态 UI | ❌ | ❌ 插件市场卡片、技能市场中庭、版本号徽标 |
| 布局尺寸 | ✅ 单侧栏 + 对话列 + 详情面板 | ❌ 三栏可拖拽工作台、多窗口分屏尺寸系统 |

> 依据 t2：网关 / 多 Agent / cron / 插件市场均为 Out of scope，**且 M2 目录只留 stub 不实现**（t3 §1）。
> 但 **presence 与任务状态属于一期范围**——它对应 t7 的 AT-201 流式断言、
> AT-301~303 工具卡片 running→success、AT-501~506 治理显式报错，都有真实承载组件。

### 0.4 可访问性契约

- 目标：**WCAG 2.2 AA**。
- 契约分四类，每类有独立阈值，并**在全部 9 个背景表面（surface-0/1/2/sunken/inset/code/bubble/row-hover/row-selected）上取最差值**判定，而不是只测主背景——这一步专门用于避免"主背景达标、卡片上不达标"的经典事故：

| 类别 | 阈值 | WCAG 条款 |
|---|---|---|
| 正文/元信息文字（≤18.66px 常规） | **≥ 4.5:1** | 1.4.3 Contrast (Minimum) |
| 非文本指示器（presence 圆点、图标、focus ring、状态描边） | **≥ 3:1** | 1.4.11 Non-text Contrast |
| 结构性描边 / 表面层差 | ≥ 1.2:1（强描边 ≥1.4:1） | 无强制条款，为"可辨识"工程下限 |
| 禁用态控件（`--ap-text-disabled`） | **AA 豁免**（明 2.22:1 / 暗 3.21:1） | 1.4.3 对 inactive 组件豁免；禁止用于任何需阅读的信息 |

- 明暗双主题**分别独立达标**，不允许"暗色降低标准"。
- 校验方式：`scripts/check-tokens.mjs` 用 WCAG 相对亮度公式解析 token 源文件并复核本表（附录 A 已给出本轮实测值，脚本化后进 CI，与 t3 §3 的 `pnpm test` 同级门禁）。

---

## 1. 设计原则（5 条）

> 判定标准：每条原则都必须能"约束到 token"，否则不写。

### P1 在场感优先于装饰感（Presence over ornament）
陪伴感来自"它一直在那儿、且在做什么"的**可感知状态**，而不是装饰元素的数量。
→ **约束**：`presence-*` 是一等公民（§3.1）；装饰性渐变、贴纸、插画不得新增 `presence`/`emotion` 之外的颜色 token。

### P2 克制的用色：一个强调色 + 低饱和纸感基调
全局只允许 **seal（印章青蓝）** 一个强调色系；成功/警告/危险/信息只用于**真实语义**，不用于装饰。
→ **约束**：L1 色相总数锁定 11 个（§2.1），其中真实彩色只有 6 个；新增色相必须在本文件登记并说明淘汰对象。

### P3 本地工具的信任感：状态可解释、后果可预期
本地自托管工具让用户交出文件与命令权限，信任来自"看得见状态、读得懂后果"。
→ **约束**：①进行时用 `presence-*`，终态用 `success`/`danger` + 文字标签，二者**禁止互相顶替**；
②治理类信息（限额拒绝、沙箱越界、终态提示）**只用 `danger`/`warning` 与中性色，禁止使用情绪色与呼吸动效**——避免把安全信息"情绪化"。

### P4 动效只承担"信息"职责
每个动画都必须回答"它在告诉我什么"；答不上来的一律不加。
→ **约束**：`duration`/`ease` 为封闭集合（§6.1/§6.2），组件不得自造时长；全部动效在 `prefers-reduced-motion: reduce` 下必须降级为**静态可读状态**而非"变快"（§6.4）。

### P5 桌面宽屏优先的清晰度
鼠标 + 键盘、≥1240px 可用宽度、长时间阅读。以**阅读列宽**而非"填满屏幕"为布局目标。
→ **约束**：对话正文列宽上限 760px、正文字号 ≥15px、中文行高 ≥1.6、文字对比度按最差表面判定（§0.4）。

---

## 2. 色彩系统

### 2.1 L1 原始色板（palette）

> 仅登记**被 L2 实际引用**的档位（无死档位，符合 P2 克制）。括号内为承载的语义角色。
> oklch 为近似换算值，用于跨主题色相一致性审查，**不作为运行时取值**（运行时一律 hex）。

#### 暖纸中性 paper（浅色主题骨架）

| 档位 | hex | oklch（近似） | 承载角色 |
|---|---|---|---|
| `--ap-paper-50` | `#FFFDF8` | `oklch(99.4% 0.006 85)` | `surface-2`、`text-on-accent` |
| `--ap-paper-100` | `#FBF7EE` | `oklch(97.6% 0.013 88)` | `surface-1`（卡片）、`text-inverse` |
| `--ap-paper-200` | `#F5EFE4` | `oklch(95.3% 0.017 87)` | `surface-0`、`ambient-room` |
| `--ap-paper-300` | `#EFE8DB` | `oklch(93.0% 0.019 87)` | `surface-sunken`（侧栏） |
| `--ap-paper-400` | `#E9E1D2` | `oklch(90.7% 0.022 86)` | `border-subtle` |
| `--ap-paper-500` | `#D8CFBE` | `oklch(85.2% 0.028 85)` | `border-default` |
| `--ap-paper-600` | `#B4A68C` | `oklch(73.2% 0.036 80)` | `border-strong` |

#### 暖墨 ink（浅色主题文字）

| 档位 | hex | oklch（近似） | 承载角色 |
|---|---|---|---|
| `--ap-ink-300` | `#A79C8C` | `oklch(70.2% 0.024 78)` | `text-disabled`（AA 豁免） |
| `--ap-ink-500` | `#6E6455` | `oklch(53.0% 0.026 76)` | `text-muted` |
| `--ap-ink-600` | `#61584C` | `oklch(48.0% 0.025 73)` | `text-tertiary` |
| `--ap-ink-700` | `#4A433C` | `oklch(38.6% 0.017 66)` | `text-secondary` |
| `--ap-ink-800` | `#2A2622` | `oklch(25.0% 0.010 55)` | `text-primary` |

#### 夜 night（深色主题骨架）

| 档位 | hex | oklch（近似） | 承载角色 |
|---|---|---|---|
| `--ap-night-400` | `#4E5F6C` | `oklch(45.5% 0.020 233)` | `border-strong`（暗） |
| `--ap-night-500` | `#2F3F4A` | `oklch(33.5% 0.022 231)` | `border-default`（暗） |
| `--ap-night-600` | `#2B3A45` | `oklch(31.5% 0.022 231)` | `surface-2`、`surface-bubble-user` |
| `--ap-night-700` | `#22303A` | `oklch(26.5% 0.021 231)` | `surface-1`（卡片） |
| `--ap-night-800` | `#1A242B` | `oklch(21.3% 0.016 232)` | `surface-0`、`ambient-room`（暗） |
| `--ap-night-900` | `#111A20` | `oklch(15.7% 0.013 232)` | `surface-sunken`（暗） |
| `--ap-night-950` | `#101B22` | `oklch(15.2% 0.017 235)` | `text-on-accent`、`text-inverse`（暗） |

#### 冷雾 mist（深色主题文字与静息色）

| 档位 | hex | oklch（近似） | 承载角色 |
|---|---|---|---|
| `--ap-mist-50` | `#E9EFF3` | `oklch(94.5% 0.006 226)` | `text-primary`（暗） |
| `--ap-mist-100` | `#C3D1DA` | `oklch(84.1% 0.016 226)` | `text-secondary`（暗） |
| `--ap-mist-200` | `#A9BAC5` | `oklch(77.0% 0.017 228)` | `text-tertiary`（暗）、`presence-idle-text`（暗） |
| `--ap-mist-300` | `#96A9B4` | `oklch(70.7% 0.018 228)` | `text-muted`（暗） |
| `--ap-mist-400` | `#8A9DA8` | `oklch(66.3% 0.018 228)` | `presence-idle`（暗） |
| `--ap-mist-500` | `#6B7E8A` | `oklch(56.5% 0.019 228)` | `text-disabled`（暗，AA 豁免） |

#### 印章青蓝 seal —— 唯一强调色（brand accent）

| 档位 | hex | oklch（近似） | 承载角色 |
|---|---|---|---|
| `--ap-seal-100` | `#E7F0F5` | `oklch(94.5% 0.013 226)` | `accent-subtle`、`info-subtle` |
| `--ap-seal-200` | `#D3E3EC` | `oklch(90.0% 0.022 224)` | `accent-active`（暗） |
| `--ap-seal-300` | `#9FC3D6` | `oklch(79.9% 0.043 226)` | `accent-hover`/`accent-text`（暗）、`info-text`（暗） |
| `--ap-seal-400` | `#6FA0BC` | `oklch(66.9% 0.061 234)` | `accent`（暗实心）、`border-focus`（暗） |
| `--ap-seal-500` | `#45708A` | `oklch(50.6% 0.056 236)` | `accent`（明实心）、`border-focus`（明） |
| `--ap-seal-600` | `#3F6179` | `oklch(45.3% 0.052 236)` | `accent-hover`、`accent-text`（明） |
| `--ap-seal-700` | `#2F4E60` | `oklch(38.3% 0.046 235)` | `accent-active`（明）、`info-text`（明） |

#### 余温 ember（陪伴暖色：thinking / awaiting）

| 档位 | hex | oklch（近似） | 承载角色 |
|---|---|---|---|
| `--ap-ember-50` | `#F7EFE8` | `oklch(95.2% 0.013 62)` | `presence-thinking-subtle`（明） |
| `--ap-ember-300` | `#E0A87F` | `oklch(76.1% 0.076 60)` | `presence-thinking`/`-thinking-text`/`-awaiting`（暗） |
| `--ap-ember-500` | `#B27049` | `oklch(55.7% 0.093 52)` | `presence-thinking`（明圆点） |
| `--ap-ember-600` | `#A9663A` | `oklch(52.0% 0.100 48)` | `presence-awaiting`（明圆点） |
| `--ap-ember-700` | `#8A5433` | `oklch(45.0% 0.081 48)` | `presence-thinking-text`（明） |
| `--ap-ember-800` | `#8A4F26` | `oklch(43.6% 0.092 45)` | `presence-awaiting-text`（明） |

#### 苔绿 sage（动手 / 工具：acting）

| 档位 | hex | oklch（近似） | 承载角色 |
|---|---|---|---|
| `--ap-sage-400` | `#96CDB8` | `oklch(80.6% 0.058 167)` | `presence-acting-text`（暗） |
| `--ap-sage-500` | `#86BFAA` | `oklch(76.1% 0.058 168)` | `presence-acting`（暗圆点） |
| `--ap-sage-600` | `#4F7F6E` | `oklch(53.9% 0.053 168)` | `presence-acting`（明圆点） |
| `--ap-sage-700` | `#3D6355` | `oklch(45.1% 0.045 167)` | `presence-acting-text`（明） |

#### 苔藓绿 moss（success）

| 档位 | hex | oklch（近似） | 承载角色 |
|---|---|---|---|
| `--ap-moss-200` | `#B9CFB4` | `oklch(81.9% 0.044 140)` | `success-border`（明） |
| `--ap-moss-300` | `#8CC790` | `oklch(78.3% 0.069 143)` | `success-text`（暗） |
| `--ap-moss-400` | `#7FBE84` | `oklch(74.8% 0.074 143)` | `success`（暗实心） |
| `--ap-moss-500` | `#3A6B45` | `oklch(46.1% 0.062 149)` | `success`（明实心） |
| `--ap-moss-600` | `#33613E` | `oklch(41.6% 0.058 149)` | `success-text`、`success-hover`（明） |

#### 陶土 clay（danger）

| 档位 | hex | oklch（近似） | 承载角色 |
|---|---|---|---|
| `--ap-clay-200` | `#E0B3A8` | `oklch(79.9% 0.055 32)` | `danger-border`（明） |
| `--ap-clay-300` | `#E59A92` | `oklch(74.5% 0.079 27)` | `danger-text`、`danger-hover`（暗） |
| `--ap-clay-400` | `#D9736A` | `oklch(63.4% 0.115 27)` | `danger`（暗实心） |
| `--ap-clay-600` | `#8B2C1F` | `oklch(41.6% 0.108 33)` | `danger`/`danger-text`（明） |
| `--ap-clay-700` | `#6E2117` | `oklch(34.4% 0.093 33)` | `danger-hover`（明） |

#### 麦黄 wheat（warning）

| 档位 | hex | oklch（近似） | 承载角色 |
|---|---|---|---|
| `--ap-wheat-200` | `#E0C89A` | `oklch(83.3% 0.057 85)` | `warning-border`（明） |
| `--ap-wheat-300` | `#E0B45C` | `oklch(79.0% 0.098 81)` | `warning-text`（暗） |
| `--ap-wheat-600` | `#7A4E0E` | `oklch(41.9% 0.088 68)` | `warning-text`（明） |

#### 鸢尾 iris（emotion-curious）

| 档位 | hex | oklch（近似） | 承载角色 |
|---|---|---|---|
| `--ap-iris-300` | `#A8B6E0` | `oklch(77.2% 0.058 271)` | `emotion-curious`（暗） |
| `--ap-iris-500` | `#5B6FA8` | `oklch(53.0% 0.076 271)` | `emotion-curious`（明） |

> **无死档位**：以上每一档都被至少一个 L2 语义 token 直接引用（`scripts/check-tokens.mjs` 强制校验）。
> 需要新档位时再登记，不预留——这与 §0.3 的 scope 守门同一条纪律。

> **色相数量审计**：11 个色相（paper / ink / night / mist / seal / ember / sage / moss / clay / wheat / iris）。
> 其中 4 个是中性（paper / ink / night / mist）→ 真实彩色只有 6 个
> （seal 强调色 + ember/sage 陪伴对 + moss/clay/wheat 语义三色 + iris 情绪点缀）。
> 对比 openhanako 的"纸本世界 + 印章青蓝"单强调色立场，我们额外引入
> **ember/sage 一对"心智 vs 动手"冷暖色对**——这是 §3.1 presence 五态能靠色温自我区分的前提，
> 属于本期差异化的必要成本，已在上文登记。

### 2.2 L2 语义色彩 tokens（明 / 暗全套）

#### 表面 surface

| Token | 明（light） | 暗（dark） | 用途（对应 MVP 组件） |
|---|---|---|---|
| `--ap-surface-0` | `#F5EFE4` | `#1A242B` | 应用底 |
| `--ap-surface-1` | `#FBF7EE` | `#22303A` | 卡片：消息卡、工具卡、记忆条目 |
| `--ap-surface-2` | `#FFFDF8` | `#2B3A45` | 浮起层：输入框外壳、下拉、模态 |
| `--ap-surface-sunken` | `#EFE8DB` | `#111A20` | 下沉层：会话列表侧栏、详情面板底 |
| `--ap-surface-inset` | `#F4EFE5` | `#1E2A33` | 内嵌块：工具参数块、引用块 |
| `--ap-surface-code` | `#F2EDE2` | `#16222A` | 代码 / 命令原文块 |
| `--ap-surface-bubble-user` | `#EAF0F4` | `#2B3A45` | 用户消息气泡 |
| `--ap-surface-row-hover` | `#F5F0E5` | `#24323C` | 列表行悬停（明色用**提亮**而非压暗，与纸感光向一致） |
| `--ap-surface-row-selected` | `#D8E5EC` | `#2A3C49` | 列表行选中（当前会话） |
| `--ap-surface-scrim` | `rgb(42 38 34 / 0.45)` | `rgb(0 0 0 / 0.58)` | 模态遮罩 |

#### 文字 text

| Token | 明 | 暗 | 最差表面对比度（明/暗） | 用途 |
|---|---|---|---|---|
| `--ap-text-primary` | `#2A2622` | `#E9EFF3` | 11.68 / 9.83 | 正文、标题 |
| `--ap-text-secondary` | `#4A433C` | `#C3D1DA` | 7.57 / 7.31 | 次级正文、列表标题 |
| `--ap-text-tertiary` | `#61584C` | `#A9BAC5` | 5.43 / 5.71 | 元信息、时间戳、工具名 |
| `--ap-text-muted` | `#6E6455` | `#96A9B4` | 4.52 / 4.69 | 占位符、脚注、次要标签 |
| `--ap-text-disabled` | `#A79C8C` | `#6B7E8A` | 2.22 / 3.21（**AA 豁免**） | 禁用态控件自身 |
| `--ap-text-inverse` | `#FBF7EE` | `#101B22` | — | 深色卡片上的浅色文字 |
| `--ap-text-on-accent` | `#FFFDF8` | `#101B22` | 5.25 / 6.18 | 实心强调色上的文字 |

> **纸感走廊的代价（设计说明）**：暖纸底色把可用文本亮度区间压缩得很窄，
> 因此 `tertiary` 与 `muted` 的差异刻意做小（ΔL* ≈ 5）。
> 强调层级靠**字重与字号**而非颜色深浅——这既是 P2 克制的具体体现，
> 也避免"灰色字层级过多导致整体可读性崩塌"这一浅色主题最常见的退化路径。

#### 边框 border

| Token | 明 | 暗 | 用途 |
|---|---|---|---|
| `--ap-border-subtle` | `#E9E1D2` | `#26343D` | 分隔线、卡片内分隔 |
| `--ap-border-default` | `#D8CFBE` | `#2F3F4A` | 控件描边、卡片描边 |
| `--ap-border-strong` | `#B4A68C` | `#4E5F6C` | 悬停描边、强调分隔 |
| `--ap-border-accent` | `#45708A` | `#6FA0BC` | 选中/激活描边 |
| `--ap-border-focus` | `#45708A` | `#6FA0BC` | focus ring 颜色（2px + 2px offset） |
| `--ap-border-success` | `#B9CFB4` | `#33513C` | 成功态卡片描边 |
| `--ap-border-warning` | `#E0C89A` | `#5C4A22` | 警告条描边 |
| `--ap-border-danger` | `#E0B3A8` | `#5C332E` | 错误条描边、超限提示 |
| `--ap-border-info` | `#AECBDA` | `#2E4A58` | 信息条描边 |

#### 强调色 accent

| Token | 明 | 暗 | 用途 |
|---|---|---|---|
| `--ap-accent` | `#45708A` | `#6FA0BC` | 主按钮底、选中指示条 |
| `--ap-accent-hover` | `#3F6179` | `#9FC3D6` | 主按钮悬停 |
| `--ap-accent-active` | `#2F4E60` | `#D3E3EC` | 主按钮按下 |
| `--ap-accent-text` | `#3F6179` | `#9FC3D6` | 可点击文字、链接 |
| `--ap-accent-subtle` | `#E7F0F5` | `#26343D` | 选中行浅底、标签浅底 |
| `--ap-accent-on` | `#FFFDF8` | `#101B22` | 实心强调色上的文字（与 `text-on-accent` 同值，语义独立保留） |

### 2.3 语义状态色 success / warning / danger / info

| Token | 明 | 暗 | 用途（对应 MVP 场景） |
|---|---|---|---|
| `--ap-success` | `#3A6B45` | `#7FBE84` | 工具调用成功徽标（实心） |
| `--ap-success-hover` | `#33613E` | `#8CC790` | 实心悬停 |
| `--ap-success-text` | `#33613E` | `#8CC790` | 成功文字（`exit_code = 0`，AT-303） |
| `--ap-success-subtle` | `#E9F1E7` | `#17251C` | 成功卡片底 |
| `--ap-success-border` | `#B9CFB4` | `#33513C` | 成功卡片描边 |
| `--ap-success-on` | `#FFFDF8` | `#101B22` | 实心上的文字 |
| `--ap-warning-text` | `#7A4E0E` | `#E0B45C` | 警告文字（限额接近上限、AT-004 网络降级提示） |
| `--ap-warning-subtle` | `#FBF0DC` | `#2A2214` | 警告条底 |
| `--ap-warning-border` | `#E0C89A` | `#5C4A22` | 警告条描边 |
| `--ap-danger` | `#8B2C1F` | `#D9736A` | 危险实心（失败徽标、破坏性操作按钮） |
| `--ap-danger-hover` | `#6E2117` | `#E59A92` | 危险实心悬停 |
| `--ap-danger-text` | `#8B2C1F` | `#E59A92` | 错误文字（工具失败、非零退出码、AT-506 限额显式拒绝） |
| `--ap-danger-subtle` | `#FBEAE6` | `#2A1A18` | 错误条底 |
| `--ap-danger-border` | `#E0B3A8` | `#5C332E` | 错误条描边 |
| `--ap-danger-on` | `#FFFDF8` | `#101B22` | 实心上的文字 |
| `--ap-info-text` | `#2F4E60` | `#9FC3D6` | 信息文字（记忆写入提示、系统说明，AT-401） |
| `--ap-info-subtle` | `#E7F0F5` | `#16242C` | 信息条底 |
| `--ap-info-border` | `#AECBDA` | `#2E4A58` | 信息条描边 |

> **刻意缺档（scope 决策）**：`warning` 与 `info` **不提供实心填充档**。
> 依据：MVP 不存在"警告主按钮"或"信息主按钮"场景（t2 In scope 无此类操作），
> 为不存在的组件造 token 违反 §0.3 守门表。二期若出现再登记，届时需补对比度实测。
>
> **终态语义（对应 t1 P0 #1「终态不可降级」）**：任务/工具的终态只用
> `success` / `danger` / `text-tertiary` 三色 + 文字标签表达，且**渲染后不得再变色或带动效**。
> "钉死"就是"终态不可降级"在视觉层面的承诺。

### 2.4 对比度实测摘要（完整 109 项见附录 A）

| 检查组 | 项数 | 目标 | 实测最差 | 结果 |
|---|---|---|---|---|
| 浅色文字 × 9 表面 | 14 | ≥4.5:1 | 4.52（`text-muted`） | ✅ |
| 浅色非文本指示器 × 9 表面 | 12 | ≥3:1 | 3.07（`emotion-warm`） | ✅ |
| 深色文字 × 9 表面 | 14 | ≥4.5:1 | 4.69（`text-muted`） | ✅ |
| 深色非文本指示器 × 9 表面 | 12 | ≥3:1 | 3.59（`danger` 实心） | ✅ |
| 填充色 / 反白文字 | 11 | ≥4.5:1 | 5.25（浅色 `accent-on`） | ✅ |
| 语义 text-on-bg | 22 | ≥4.5:1 | 5.43 | ✅ |
| 结构描边与表面层差 | 24 | 见 §0.4 | 全部达下限 | ✅ |
| **合计** | **109** | — | **0 项未达标** | ✅ |

---

## 3. 陪伴感专属语义 tokens（本项目差异化重点）

### 3.1 presence 五态

> 语义定义：presence 描述"**它现在在做什么**"（进行时），不描述任务是否完成。
> 五态与 t7 可点击链路一一对齐，保证每个 token 都有真实承载组件。

| 状态 | 指示器变量 | 明 | 暗 | 文字变量 | 明 | 暗 | 触发时机（对齐 t7） |
|---|---|---|---|---|---|---|---|
| **idle 静息** | `--ap-presence-idle` | `#6F7E88` | `#8A9DA8` | `--ap-presence-idle-text` | `#58666F` | `#A9BAC5` | 无请求在跑（AT-201 空闲态） |
| **thinking 思考** | `--ap-presence-thinking` | `#B27049` | `#E0A87F` | `--ap-presence-thinking-text` | `#8A5433` | `#E0A87F` | 请求已发、首 token 未到（AT-201 S4：首 token ≤5s，窗口内必须有可见反馈） |
| **streaming 输出** | `--ap-presence-streaming` | `#45708A` | `#6FA0BC` | `--ap-presence-streaming-text` | `#3F6179` | `#9FC3D6` | 流式追加中（AT-201 S4「逐字/逐块追加」） |
| **acting 执行** | `--ap-presence-acting` | `#4F7F6E` | `#86BFAA` | `--ap-presence-acting-text` | `#3D6355` | `#96CDB8` | 工具调用 running（AT-301~304 工具卡片 running 段） |
| **awaiting-user 待你** | `--ap-presence-awaiting` | `#A9663A` | `#F0BE93` | `--ap-presence-awaiting-text` | `#8A4F26` | `#F0BE93` | 需用户确认/输入（AT-506 限额显式拒绝后的等待、越界确认） |

附属 token：

| Token | 明 | 暗 | 用途 |
|---|---|---|---|
| `--ap-presence-thinking-subtle` | `#F7EFE8` | `rgb(224 168 127 / 0.10)` | thinking 态标签/气泡浅底 |
| `--ap-presence-dot-size` | `8px` | `8px` | 标准 presence 圆点直径 |
| `--ap-presence-dot-size-lg` | `10px` | `10px` | 标题级圆点（会话头、空状态） |
| `--ap-presence-ring-width` | `2px` | `2px` | awaiting 态外描边环宽度 |
| `--ap-presence-ring-offset` | `2px` | `2px` | 环与圆点间距 |

#### 设计依据（presence 是差异化核心，给完整推理）

**依据 1：用"温度 + 通道"而非任意颜色区分状态。** 五个状态落在一条可解释的语义轴上：

```
冷 ←─────────────────────────────────────────────────────→ 暖
idle（中性雾蓝）  streaming（品牌青）  acting（苔绿）  thinking（余温琥珀）  awaiting（深琥珀）
  "在场但不打扰"      "正在说话"        "手上有动作"      "在心里想"          "在等你"
```

- **心智侧（thinking / awaiting）= 暖色（ember 同族）**；
- **外部动作侧（acting）= 青绿（sage）**；
- **输出通道（streaming）= 品牌色（seal）**；
- **静息（idle）= 中性（mist）**。

这不是审美选择而是**通道区分**：用户能凭色温一眼判断"它是在想，还是在动手"，无需先读文字。
参照上，openhanako 已用 `--mood-*`（暖玫瑰）与 `--tool-*`（中性）做了"人格 vs 工具"的通道分离；
我们把这个思想收敛成**显式五态 + 可测试的对比度契约**（t1 §5「只抄思想，不抄实现」）。

**依据 2：thinking 与 awaiting 同族但必须可分。** 两者都是心智态，色相接近是**刻意**的
（同一个人在同一侧），区分靠**三个正交维度**而非再加一个色相（守 P2 单强调色立场）：

| 维度 | thinking | awaiting-user |
|---|---|---|
| 明度 | 中等（明 `#B27049`） | 更深（明 `#A9663A`；暗色反而更亮 `#F0BE93`） |
| 填充 | 半透明（呼吸时 opacity 0.55 ↔ 1） | 实心 100%（不透明） |
| 动效 | 2400ms 呼吸（**连续**） | 静止 + 2px 外环（**离散**） |
| 读法 | "持续进行中" | "状态稳定，等你决定" |

**依据 3：awaiting-user 必须静止，这是硬规则。** 持续动画会被读作"它还在转"。
等待用户输入时若仍有动效，用户会以为系统在忙而不去操作——
这正是 t7 G4/AT-506「超限必须显式报错并等待」场景最怕的误导。
故 awaiting 用**静止实心圆点 + 外环**表达（动效语义冲突规避）。

**依据 4：每个状态都配 `-text` 变体，禁止"小圆点当唯一信息"。**
`-text` 变体全部实测 ≥4.5:1（明最差 4.61，暗最差 5.47），
因为色盲用户与 reduced-motion 用户最终依赖文字标签。信息不得只由颜色承载（WCAG 1.4.1）。

**依据 5：presence 与终态严格分离。** presence 是进行时、允许动效；
终态是完成时、**禁止动效**。这条分离让 t1 P0 #1「终态不可降级」
在视觉层面天然成立：终态一旦渲染就"定住了"，不给用户"它还在变"的错觉。

### 3.2 环境氛围 ambient

> 定位：模拟"同一间屋子里有光"。ambient 是**氛围层，不是信息层**——
> 永远极低 alpha（≤0.12），永远不承载唯一信息。

| Token | 明 | 暗 | 用途 |
|---|---|---|---|
| `--ap-ambient-room` | `#F5EFE4` | `#1A242B` | 房间主色（叠加在 `surface-0` 之上的色相基准层，为未来色温漂移留接口） |
| `--ap-ambient-vignette` | `rgb(42 38 34 / 0.06)` | `rgb(0 0 0 / 0.45)` | 四角压暗，模拟台灯光衰减 |
| `--ap-ambient-desk-edge` | `rgb(216 207 190 / 0.55)` | `rgb(47 63 74 / 0.55)` | 面板外缘 1px 内高光，模拟纸边受光 |
| `--ap-ambient-paper-opacity` | `0.035` | `0.02` | 纸纹噪点叠加上限（超过即"脏"；暗色更低以免发灰） |
| `--ap-ambient-glow-thinking` | `rgb(178 112 73 / 0.10)` | `rgb(224 168 127 / 0.12)` | thinking 态环境光晕色 |
| `--ap-ambient-glow-streaming` | `rgb(69 112 138 / 0.08)` | `rgb(111 160 188 / 0.10)` | streaming 态环境光晕色 |
| `--ap-ambient-glow-acting` | `rgb(79 127 110 / 0.08)` | `rgb(134 191 170 / 0.10)` | acting 态环境光晕色 |
| `--ap-ambient-glow-size` | `480px` | `480px` | 光晕半径（大半径 + 低 alpha = 氛围而非光斑） |
| `--ap-ambient-glow-blur` | `80px` | `80px` | 光晕模糊半径 |

#### 时间氛围（可选增强，P1；默认关闭，不阻塞 MVP 验收）

| 时段键（`data-ambient-hour` 取值） | 时段 | 明 `--ap-ambient-hour-tint` | 暗 `--ap-ambient-hour-tint` | `--ap-ambient-hour-glow-scale` |
|---|---|---|---|---|
| `dawn` | 05:00–08:00 | `rgb(247 227 210 / 0.35)` | `rgb(28 32 40 / 0.35)` | `0.6` |
| `day` | 08:00–17:00 | `rgb(0 0 0 / 0)`（无色偏） | `rgb(0 0 0 / 0)` | `0` |
| `dusk` | 17:00–20:00 | `rgb(243 222 201 / 0.30)` | `rgb(34 30 40 / 0.30)` | `0.5` |
| `night` | 20:00–05:00 | `rgb(239 230 216 / 0.25)` | `rgb(22 32 43 / 0.35)` | `0.8` |

> **不新增 token**：只有 `--ap-ambient-hour-tint` 与 `--ap-ambient-hour-glow-scale` 两个 token；
> 上表左列是 `data-ambient-hour` 属性的**取值**（`dawn` / `day` / `dusk` / `night`），不是 CSS 变量名。
> 时段取值已具体化：落地只需一个按本地时间写入该属性、并把左列数值写入上表两个 token 的纯前端映射。
> 标注为**可选**：MVP 用默认值（`rgb(0 0 0 / 0)` + `0`）即可，不进入 t7 验收链路。

#### 设计依据

1. **"陪伴感"的物理隐喻是光，不是动。** 晃动图标消耗注意力；环境光变化在余光里即可感知，
   属于"低认知成本在场感"——这正是 P1 要的东西。
2. **alpha 上限 0.12 是硬约束**：超过后会与语义色（尤其 `danger`/`warning`）混淆，
   并在暗色下污染已实测的对比度余量（§2.4 最差项余量本就很小，容错空间低）。
3. **光晕禁止承载唯一信息**：必须与 presence 圆点/文字标签并存。
   reduced-motion 下降级为**静态光晕**（保留颜色，去掉过渡）——氛围可保留，运动要去掉。
4. **暗色是氛围表达力更强的一侧**（低亮度背景上光晕更明显），
   因此 ambient 的完整光晕档在暗色下默认开启，浅色下默认只启用 `vignette` 与 `paper`。
   这也是 §8 "暗色是体验锚点但不是默认主题"的技术理由之一。

### 3.3 情绪点缀色 emotion

> 定位：表达"这句话/这个瞬间的语气"，**只用于非功能性、可选、可关闭**的微小元素
> （presence 光晕的色相偏移、空状态点缀、记忆写入的轻提示、助理头像环）。

| Token | 语气 | 明 | 暗 | 建议用法（形态上限） |
|---|---|---|---|---|
| `--ap-emotion-warm` | 亲近 / 认可 | `#B4703F` | `#E8B589` | 记忆写入成功时的头像环（2px 描边） |
| `--ap-emotion-curious` | 好奇 / 提问 | `#5B6FA8` | `#A8B6E0` | 助理提出澄清问题时的圆点 |
| `--ap-emotion-caution` | 温和提醒 | `#96702A` | `#DCBE7A` | 非危险类提示（如"这条记忆会长期保存"） |
| `--ap-emotion-serious` | 郑重 / 严肃 | `#6B5B7A` | `#BFAFD0` | 数据删除前的说明文案点缀 |

#### 设计依据

**依据**：openhanako 证明"有人格"是与 CLI agent 拉开差距的一侧（t1 §6），
但其人格表达依赖角色卡 / 立绘 / 群聊 —— 恰是我们要"克制"的部分。
所以我们把人格表达**收敛为 4 个可命名语气**，并严格限制出现场景：
**人格在语气里，不在画面里。**

#### 五条硬约束（写入本文件即生效，代码评审据此拒绝）

1. **禁止用于安全与治理信息**：错误、失败、限额拒绝、沙箱越界、终态提示
   一律只用 `danger` / `warning` / 中性色。把安全信息"情绪化"直接损害 P3 的信任感
   （用户会误以为系统在卖萌而不是在报警）。
2. **单屏同时出现的情绪色 ≤ 1 种**，不得两处 `emotion-*` 竞争注意力。
3. **禁止大面积填充**：允许形态只有 ≤2px 描边、≤8px 圆点、≤12% alpha 光晕。
   禁止用作按钮底色、卡片底、消息气泡底。
4. **与 presence 同屏时 presence 优先**：情绪元素不透明度降至 `--ap-opacity-emotion`（0.60）。
   presence 是状态信息，emotion 是语气修饰，**信息优先于修饰**。
5. **情绪色不承担对比度契约的承载角色**（它们从不是唯一的可访问信号来源），
   但仍逐项实测 ≥3:1（作为非文本指示器，见附录 A），避免"看不见的装饰"。

---

## 4. 字体系统

### 4.1 字体栈

| Token | 字体栈 | 说明 |
|---|---|---|
| `--ap-font-sans` | `'Inter var', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', 'Segoe UI', 'PingFang SC', 'HarmonyOS Sans SC', 'Microsoft YaHei UI', 'Microsoft YaHei', 'Noto Sans SC', sans-serif` | UI 与对话正文（默认） |
| `--ap-font-display` | `'Source Serif 4', 'Iowan Old Style', 'Georgia', 'Songti SC', 'STSong', 'Source Han Serif SC', 'Noto Serif SC', serif` | **仅 ≥20px 展示型文案**（空状态欢迎语、日期标题） |
| `--ap-font-mono` | `'JetBrains Mono', 'Cascadia Code', 'Cascadia Mono', 'SF Mono', 'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', 'Noto Sans Mono CJK SC', monospace` | 代码块、命令原文、工具参数、会话 ID |
| `--ap-font-emoji` | `'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji'` | 追加在 `sans` / `mono` 栈末尾 |

**西文前置、中文兜底的理由**：浏览器按字体栈顺序**逐字符**回退。
把 Inter / Segoe 放在前面，拉丁字母与数字用西文字形渲染（字形更紧凑、数字对齐更整齐），
中文字符自动落到 PingFang SC / 微软雅黑。若把中文字体放前面，
会出现"中文用雅黑、拉丁也用雅黑"的字形不统一问题（数字尤其明显）。

**为什么对话正文不用衬线体**：openhanako 默认开启衬线体以营造书桌感，
但 Windows 上中文衬线的回退是**宋体（SimSun）**，小字号屏幕渲染质量差且年代感过重。
因此本项目把衬线体限制在 ≥20px 的展示场景（此时思源宋体/宋体尚可接受），
对话正文一律 `--ap-font-sans`。这是"参考其精神、不照抄其实现"（对齐 t1 §5 取舍立场）。

### 4.2 字号阶梯

| Token | 字号 | 行高 token | 行高 | 字重 | 用途 |
|---|---|---|---|---|---|
| `--ap-fs-display` | `28px` | `--ap-lh-display` | `36px` | 600 | 空状态欢迎语（配 `font-display`） |
| `--ap-fs-h1` | `20px` | `--ap-lh-h1` | `28px` | 600 | 页面 / 面板标题 |
| `--ap-fs-h2` | `17px` | `--ap-lh-h2` | `26px` | 600 | 区块标题、会话标题 |
| `--ap-fs-body-lg` | `16px` | `--ap-lh-body-lg` | `26px` | 400 | **对话正文（助理回答）**、markdown 渲染 |
| `--ap-fs-body` | `15px` | `--ap-lh-body` | `24px` | 400 | 默认正文、用户输入框 |
| `--ap-fs-ui` | `14px` | `--ap-lh-ui` | `20px` | 500 | 控件文字、按钮、标签 |
| `--ap-fs-caption` | `12px` | `--ap-lh-caption` | `18px` | 400 | 时间戳、工具名、元信息 |
| `--ap-fs-micro` | `11px` | `--ap-lh-micro` | `16px` | 500 | 角标、计数、键位提示 |
| `--ap-fs-code` | `13px` | `--ap-lh-code` | `22px` | 400 | 代码块 / 命令原文（配 `font-mono`） |
| `--ap-fs-tool` | `13px` | `--ap-lh-tool` | `20px` | 400 | 工具卡片参数区 |

**行高理由**：CJK 正文行高 ≥1.6 是中文阅读舒适度的经验下限
（`body-lg` = 26/16 = 1.625，`body` = 24/15 = 1.600）；
UI 元素 20/14 ≈ 1.43 便于垂直居中；代码 22/13 ≈ 1.69 便于 CJK 注释与拉丁代码混排。

### 4.3 字重与字距

| Token | 值 | 用途 |
|---|---|---|
| `--ap-fw-regular` | `400` | 正文 |
| `--ap-fw-medium` | `500` | UI 标签、按钮、强调元信息 |
| `--ap-fw-semibold` | `600` | 标题、会话标题 |
| `--ap-fw-bold` | `700` | 预留（仅"未读"等强提示） |
| `--ap-tracking-tight` | `-0.01em` | 西文大标题（≥20px） |
| `--ap-tracking-normal` | `0` | 默认（**CJK 一律使用此值**） |
| `--ap-tracking-wide` | `0.02em` | 全大写拉丁小标签（如 `IDLE` / `ACTING`） |

**硬规则**：① CJK **禁止**设置非零 `letter-spacing`（破坏方块字韵律，且中文标点会错位）；
② 全局启用 `font-synthesis: none` —— 禁止浏览器对 CJK 合成伪粗体/伪斜体（糊字主因），
缺少字重时降级到相邻字重而非合成。

---

## 5. 空间与结构 tokens

### 5.1 间距阶梯（4px 基准）

| Token | 值 | 典型用途 |
|---|---|---|
| `--ap-space-0` | `0px` | 重置 |
| `--ap-space-2` | `2px` | hairline 级微调、presence 环偏移 |
| `--ap-space-4` | `4px` | 图标内边距、徽标内缩 |
| `--ap-space-6` | `6px` | 图标与文字间隙（唯一非 4 倍数的间隙值） |
| `--ap-space-8` | `8px` | 紧凑内边距、行内元素间隔 |
| `--ap-space-12` | `12px` | 控件内边距、列表行间距 |
| `--ap-space-16` | `16px` | 卡片内边距、标准间隔 |
| `--ap-space-20` | `20px` | 消息段落间距 |
| `--ap-space-24` | `24px` | 面板内边距、区块间距 |
| `--ap-space-32` | `32px` | 大区块间距 |
| `--ap-space-40` | `40px` | 页面级纵向留白 |
| `--ap-space-48` | `48px` | 空状态纵向留白 |
| `--ap-space-64` | `64px` | 孤岛式留白（空状态顶部） |
| `--ap-space-80` | `80px` | 极限留白（欢迎语上边距） |

### 5.2 尺寸（桌面宽屏优先）

| Token | 值 | 说明 |
|---|---|---|
| `--ap-size-sidebar` | `248px` | 会话列表侧栏 |
| `--ap-size-detail` | `320px` | 详情面板（记忆 / 任务） |
| `--ap-size-titlebar` | `44px` | 顶部栏（Electron 自绘标题栏预留高度） |
| `--ap-size-chat-max` | `760px` | **对话阅读列宽上限**（P5 核心约束） |
| `--ap-size-composer-max` | `760px` | 输入区列宽上限 |
| `--ap-size-toolbar` | `36px` | 工具条 / 按钮组高度 |
| `--ap-size-control` | `32px` | 标准控件高度 |
| `--ap-size-control-sm` | `24px` | 紧凑控件高度 |
| `--ap-size-avatar` | `28px` | 助理 / 用户头像直径 |
| `--ap-size-avatar-lg` | `40px` | 空状态头像直径 |
| `--ap-size-indicator-rail` | `3px` | 选中行左侧指示条宽度 |
| `--ap-breakpoint-compact` | `1024px` | 低于此宽度收起详情面板（桌面宽屏优先的最小降级） |

### 5.3 圆角

| Token | 值 | 用途 |
|---|---|---|
| `--ap-radius-none` | `0px` | 表格单元、紧贴边缘 |
| `--ap-radius-xs` | `2px` | 徽标、tag、内嵌小块 |
| `--ap-radius-sm` | `4px` | 小控件、内联代码 |
| `--ap-radius-md` | `6px` | **控件默认**（按钮、输入框、下拉） |
| `--ap-radius-lg` | `10px` | 卡片、面板、工具卡之外的大卡 |
| `--ap-radius-xl` | `14px` | 模态、对话气泡 |
| `--ap-radius-2xl` | `20px` | 空状态大容器 |
| `--ap-radius-full` | `9999px` | 圆形（圆点、头像、胶囊开关） |
| `--ap-radius-control` | `var(--ap-radius-md)` | 语义别名：控件 |
| `--ap-radius-card` | `var(--ap-radius-lg)` | 语义别名：卡片 |
| `--ap-radius-bubble` | `var(--ap-radius-xl)` | 语义别名：消息气泡 |
| `--ap-radius-tool-card` | `8px` | 语义别名：工具卡（比普通卡更紧凑） |
| `--ap-radius-modal` | `var(--ap-radius-xl)` | 语义别名：模态 |
| `--ap-radius-pill` | `var(--ap-radius-full)` | 语义别名：胶囊 |

**设计依据 ——「方中带柔」**：控件 6px（像桌面工具：克制、精确），
对话气泡 14px（像人在说话：柔和），面板 10px（居中）。
openhanako 的立场是"controls are seals, 方"（控件 2~3px），
我们保留其精确感但整体上调一档，因为陪伴感需要一点柔度；
**但绝不使用 24px+ 的"圆滚滚"圆角**——那是二次元化的第一信号。

### 5.4 阴影

| Token | 明 | 暗 | 用途 |
|---|---|---|---|
| `--ap-shadow-none` | `none` | `none` | 扁平元素 |
| `--ap-shadow-xs` | `0 1px 2px rgb(42 38 34 / 0.05)` | `0 1px 2px rgb(0 0 0 / 0.30)` | 紧贴元素（静止输入框） |
| `--ap-shadow-sm` | `0 1px 3px rgb(42 38 34 / 0.06), 0 1px 2px rgb(42 38 34 / 0.04)` | `0 1px 3px rgb(0 0 0 / 0.42), 0 1px 2px rgb(0 0 0 / 0.30)` | 卡片、工具卡 |
| `--ap-shadow-md` | `0 4px 12px rgb(42 38 34 / 0.07), 0 1px 3px rgb(42 38 34 / 0.05)` | `0 4px 12px rgb(0 0 0 / 0.48), 0 1px 3px rgb(0 0 0 / 0.32)` | 下拉、气泡、浮起输入框 |
| `--ap-shadow-lg` | `0 12px 32px rgb(42 38 34 / 0.10), 0 2px 8px rgb(42 38 34 / 0.06)` | `0 12px 32px rgb(0 0 0 / 0.55), 0 2px 8px rgb(0 0 0 / 0.38)` | 侧拉面板 |
| `--ap-shadow-pop` | `0 20px 48px rgb(42 38 34 / 0.16), 0 4px 12px rgb(42 38 34 / 0.08)` | `0 20px 48px rgb(0 0 0 / 0.62), 0 4px 12px rgb(0 0 0 / 0.40)` | 模态 |
| `--ap-shadow-inset-hairline` | `inset 0 1px 0 rgb(255 255 255 / 0.60)` | `inset 0 1px 0 rgb(233 239 243 / 0.06)` | 浮起面板顶部内高光 |
| `--ap-shadow-glow` | `0 0 0 4px rgb(69 112 138 / 0.12)` | `0 0 0 4px rgb(111 160 188 / 0.20)` | focus 光晕 |
| `--ap-shadow-ambient` | `0 0 60px 20px rgb(42 38 34 / 0.04)` | `0 0 80px 24px rgb(0 0 0 / 0.28)` | 环境光晕（配 `--ap-ambient-*`） |

**设计依据**：阴影一律使用**暖墨色**（`rgb(42 38 34)`）而非纯黑——
纯黑阴影投在暖纸底色上会显脏（偏灰紫）。暗色主题下阴影几乎不可见，
**深度主要靠表面层差表达**（`surface-0 < 1 < 2` 实测层差 1.12 ~ 1.17，见附录 A G 组），
阴影仅作边缘分离，且**禁止暗色使用大扩散彩色阴影**（会与 ambient 光晕抢语义）。

### 5.5 边框与 z-index

| Token | 值 | 用途 |
|---|---|---|
| `--ap-border-w-hairline` | `0.5px` | 仅 ≥2× DPI 屏使用（低分屏渲染不出） |
| `--ap-border-w` | `1px` | 默认描边 |
| `--ap-border-w-strong` | `2px` | 激活描边 |
| `--ap-border-w-rail` | `3px` | 选中行左侧指示条 |
| `--ap-focus-ring-width` | `2px` | focus ring 宽度 |
| `--ap-focus-ring-offset` | `2px` | focus ring 偏移 |

| z-index Token | 值 | 层 |
|---|---|---|
| `--ap-z-base` | `0` | 常规文档流 |
| `--ap-z-raised` | `10` | 卡片抬升、粘性消息头 |
| `--ap-z-sticky` | `20` | 吸顶工具栏 |
| `--ap-z-sidebar` | `30` | 侧栏（含浮起态） |
| `--ap-z-dropdown` | `40` | 下拉菜单、自动补全 |
| `--ap-z-scrim` | `50` | 模态遮罩 |
| `--ap-z-modal` | `60` | 模态主体 |
| `--ap-z-popover` | `65` | 二级浮层（模态内的下拉） |
| `--ap-z-toast` | `70` | Toast 通知 |
| `--ap-z-tooltip` | `80` | Tooltip（永远最上层可读） |
| `--ap-z-dev-overlay` | `90` | 调试覆盖层（仅 dev） |

**硬规则**：新增层级必须落进本阶梯并在此表登记；**禁止 `z-index: 999 / 9999`**
（这是 CSS 里最常见的不可维护点）。

### 5.6 不透明度

| Token | 值 | 用途 |
|---|---|---|
| `--ap-opacity-disabled` | `0.45` | 禁用控件整体 |
| `--ap-opacity-muted` | `0.72` | 次要内容整体降权 |
| `--ap-opacity-emotion` | `0.60` | 与 presence 同屏时的情绪元素（§3.3 约束 4） |
| `--ap-opacity-scrim` | `0.45` | 遮罩（明）；暗色由 `surface-scrim` 承担 |
| `--ap-opacity-hidden` | `0` | 完全隐藏（保留布局） |

---

## 6. 动效 tokens

### 6.1 时长阶梯

| Token | 值 | 用途 |
|---|---|---|
| `--ap-duration-0` | `0ms` | 无过渡 |
| `--ap-duration-instant` | `80ms` | 悬停、退场、撤销（"瞬"） |
| `--ap-duration-fast` | `140ms` | 默认（按钮、面板、focus、状态切换） |
| `--ap-duration-base` | `200ms` | 消息进入、模态进入、卡片状态色 |
| `--ap-duration-slow` | `320ms` | 大块进场、侧栏折叠、强调动作 |
| `--ap-duration-slower` | `480ms` | 仅空状态首屏（一次性） |
| `--ap-duration-stream` | `90ms` | **流式增量片段淡入**（比 instant 更快，避免文本追赶感） |
| `--ap-duration-caret` | `1000ms` | 流式光标闪烁周期 |
| `--ap-duration-breath` | `2400ms` | **presence thinking 呼吸周期**（成人静息呼吸 12–20 次/分 ≈ 3–5s；取 2.4s 略快以表达"在动脑"） |
| `--ap-duration-pulse` | `900ms` | **presence acting 节拍**（比呼吸快，制造机械节拍感） |
| `--ap-duration-dwell-toast` | `6000ms` | Toast 停留时长（错误类改为手动关闭） |

> 前 6 档是 openhanako 三档时长（0.10 / 0.15 / 0.25s）的细化；
> **后 5 档是本项目为 presence 新增的语义时长** —— 呼吸与节拍必须走 token，
> 否则会出现"五个组件五种呼吸速度"的廉价感。

### 6.2 缓动曲线（cubic-bezier 具体值）

| Token | 值 | 语义 |
|---|---|---|
| `--ap-ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | 默认（颜色、尺寸、位置变化） |
| `--ap-ease-enter` | `cubic-bezier(0.16, 1, 0.3, 1)` | 进场（快出慢收，元素"落定"） |
| `--ap-ease-exit` | `cubic-bezier(0.4, 0, 1, 1)` | 退场（慢起快走，元素"撤走"） |
| `--ap-ease-emphasized` | `cubic-bezier(0.2, 0, 0, 1)` | 大幅位移（侧栏折叠） |
| `--ap-ease-breathe` | `cubic-bezier(0.37, 0, 0.63, 1)` | **呼吸 / 脉冲**（正弦近似：两端自然停顿，无机械感） |
| `--ap-ease-settle` | `cubic-bezier(0.34, 1.36, 0.64, 1)` | **送达确认**（终点轻微过冲 1.36；仅用于"完成/送达"一次性确认） |

> `--ap-ease-settle` 是本项目唯一带过冲的曲线，**禁止用于布局位移或持续动画**，
> 只允许出现在"工具调用成功""记忆已写入"这类一次性确认上——
> 过冲传递的是"有了"的物理感，用多了就变成弹跳玩具（违反 P2）。

### 6.3 状态过渡约定

| 场景 | 触发 | 时长 | 缓动 | 变化属性 | 说明 |
|---|---|---|---|---|---|
| 消息进入（用户） | 发送 | `fast` 140ms | `enter` | `opacity` + `translateY(slide-sm)` | 位移为 `--ap-motion-slide-sm × --ap-motion-scale` |
| 消息进入（助理首块） | 首 token 到达 | `base` 200ms | `enter` | `opacity` | 不加位移（AI 输出不该"跳"） |
| **流式增量片段** | 每次追加 | `stream` 90ms | `enter` | `opacity 0.35 → 1` | **只对新追加的尾段**；禁止对全文重跑动画（会整屏闪） |
| 流式光标 | streaming 态 | `caret` 1000ms `step-end infinite` | `steps` | `opacity 1 ↔ 0` | 2px 竖条，色取 `presence-streaming` |
| presence idle | 无请求 | 无 | — | 静态 100% | **静息态不做任何动画**（不假装活着、不白耗电） |
| presence thinking | 首 token 未到 | `breath` 2400ms `infinite alternate` | `breathe` | `opacity 0.55 ↔ 1`、`scale 1 ↔ 1.05` | 必须同时渲染文字标签（如"思考中"） |
| presence streaming | 流式追加中 | 无脉冲 | — | 静态 `presence-streaming` 色 | 文本 + 光标已足够可见，避免双重动效 |
| presence acting | 工具 running | `pulse` 900ms `infinite` | `breathe` | 三点 `opacity 0.35 / 0.65 / 1`，相位差 150ms | 机械节拍 ≠ 呼吸，通道可辨 |
| presence awaiting-user | 需用户确认 | `settle` 320ms **仅入场一次** | `settle` | `opacity` + `scale(1 → 1.02 → 1)` | 入场后**完全静止**（§3.1 依据 3） |
| 工具卡状态色 | running → success/failed | `base` 200ms | `standard` | `background` + `border-color` + `color` | 终态落定后不再变化（P3 / 终态不可降级） |
| 行悬停 | hover | `instant` 80ms | `standard` | `background` | 颜色变化不构成"运动"，reduced-motion 下保留 |
| 行选中 | click | `fast` 140ms | `standard` | `background` + 指示条 `transform` | 指示条位移在 reduced-motion 下取消 |
| 下拉 / 气泡弹出 | 点击 | `fast` 140ms | `enter` | `opacity` + `scale(0.96 → 1)` | 配合 `transform-origin` 从触发点生长 |
| 模态进入 | 打开 | `base` 200ms | `enter` | `opacity` + `scale(0.96 → 1)` | 遮罩同步 `fast` 140ms |
| 模态退出 | 关闭 / Esc | `instant` 80ms | `exit` | `opacity` | **退场必须比进场快**（用户已决定离开） |
| Toast 出现 | 事件 | `base` 200ms | `enter` | `opacity` + `translateY(slide-md)` | 右上角堆叠 |
| Toast 消失 | 6s / 手动 | `fast` 140ms | `exit` | `opacity` | 错误类不自动消失 |
| 会话切换 | 点击列表项 | `base` 200ms | `standard` | 内容 `opacity` 交叉淡入 | **禁止整页横向滑动**（桌面端滑动 = 眩晕） |
| 侧栏折叠 | 点击 | `slow` 320ms | `emphasized` | `width` + `transform` | reduced-motion 下直接切换 |

运动幅度辅助 token：

| Token | 值 | 用途 |
|---|---|---|
| `--ap-motion-scale` | `1` | **全局运动缩放因子**；所有位移/缩放都乘以它（reduced 时置 0） |
| `--ap-motion-slide-sm` | `4px` | 微位移（消息、列表行） |
| `--ap-motion-slide-md` | `8px` | 中位移（Toast、卡片） |
| `--ap-motion-slide-lg` | `24px` | 大位移（底部确认栏上浮） |
| `--ap-motion-enter-scale` | `0.96` | 进入缩放起点（reduced 时置 1） |
| `--ap-motion-caret-width` | `2px` | 流式光标宽度 |

用法示例（"位移随 scale 归零"的唯一正确写法）：

```css
.ap-message-enter {
  animation: ap-enter var(--ap-duration-fast) var(--ap-ease-enter) both;
}
@keyframes ap-enter {
  from {
    opacity: 0;
    transform: translateY(calc(var(--ap-motion-slide-sm) * var(--ap-motion-scale)));
  }
  to { opacity: 1; transform: translateY(0); }
}
```

### 6.4 `prefers-reduced-motion` 降级策略

**策略立场：降级 ≠ 变快，而是"换成静态可读状态"。**
加快动画对前庭失调用户依然是伤害；正确做法是把"运动"换成"状态"。

| 原效果 | reduced 降级后 | 谁承担信息 |
|---|---|---|
| 消息 / Toast 位移进入 | 仅 `opacity` | 位置本身 |
| 流式增量淡入 | 直接 `opacity: 1`（无过渡） | 文本本身的逐字追加 |
| 流式光标闪烁 | **常亮**（`animation: none`，保持可见） | 光标位置 |
| thinking 呼吸（opacity + scale） | **静态 100% 不透明 + 圆点** | `presence-thinking` 色 + 「思考中」文字标签 |
| acting 三点节拍 | **三点常亮** | `presence-acting` 色 + 「执行中」文字标签 |
| awaiting 入场过冲 | 无入场动画，直接显示 | 实心圆点 + 外环（本就静止） |
| 模态 / 下拉 scale 进入 | 仅 `opacity` | 遮罩 + 位置 |
| 侧栏折叠 width 过渡 | 直接切换（无过渡） | 布局结果 |
| 行选中指示条位移 | 无过渡，直接到位 | 背景色变化 |
| ambient 光晕过渡 | **保留静态光晕，去掉过渡** | presence 圆点 / 文字标签 |
| 悬停 / 聚焦颜色变化 | **保留**（颜色变化不构成运动，且是可用性必需） | — |

实现分两层：`[data-motion="reduced"]` 供用户手动开启，媒体查询自动生效，
两者**选择器并列且取值完全相同**，保证"手动选择"与"系统偏好"走同一套值（代码见 §7.2 尾部）。

> 注意：覆写 `--ap-duration-*` 只解决"时长"；`animation: none` 类规则需在组件层
> 按本表逐条实现（呼吸 / 节拍 / 光标）。tokens 层已提供 `.animate-ap-presence-breathe`
> 等类名对应的 `animation: none` 规则作为兜底（见 §7.2），组件只引用 token 类即可。

---

## 7. 落地映射

### 7.1 token → CSS 变量 → Tailwind 主题键

> Tailwind 桥接层**不新增取值**，只把 `--ap-*` 挂到 Tailwind 命名空间上；
> 因此 Tailwind 类与 `var(--ap-*)` 永远等价，不存在"两套真相"。

#### 颜色（命名空间 `--color-*`）

| CSS 变量 | Tailwind 主题变量（v4） | 生成的类（示例） |
|---|---|---|
| `--ap-surface-0` | `--color-ap-surface-0` | `bg-ap-surface-0` |
| `--ap-surface-1` | `--color-ap-surface-1` | `bg-ap-surface-1` |
| `--ap-surface-2` | `--color-ap-surface-2` | `bg-ap-surface-2` |
| `--ap-surface-sunken` | `--color-ap-surface-sunken` | `bg-ap-surface-sunken` |
| `--ap-surface-inset` | `--color-ap-surface-inset` | `bg-ap-surface-inset` |
| `--ap-surface-code` | `--color-ap-surface-code` | `bg-ap-surface-code` |
| `--ap-surface-bubble-user` | `--color-ap-surface-bubble-user` | `bg-ap-surface-bubble-user` |
| `--ap-surface-row-hover` | `--color-ap-surface-row-hover` | `bg-ap-surface-row-hover` |
| `--ap-surface-row-selected` | `--color-ap-surface-row-selected` | `bg-ap-surface-row-selected` |
| `--ap-surface-scrim` | `--color-ap-surface-scrim` | `bg-ap-surface-scrim` |
| `--ap-text-primary` | `--color-ap-text-primary` | `text-ap-text-primary` |
| `--ap-text-secondary` | `--color-ap-text-secondary` | `text-ap-text-secondary` |
| `--ap-text-tertiary` | `--color-ap-text-tertiary` | `text-ap-text-tertiary` |
| `--ap-text-muted` | `--color-ap-text-muted` | `text-ap-text-muted` |
| `--ap-text-disabled` | `--color-ap-text-disabled` | `text-ap-text-disabled` |
| `--ap-text-inverse` | `--color-ap-text-inverse` | `text-ap-text-inverse` |
| `--ap-text-on-accent` | `--color-ap-text-on-accent` | `text-ap-text-on-accent` |
| `--ap-border-subtle` | `--color-ap-border-subtle` | `border-ap-border-subtle` |
| `--ap-border-default` | `--color-ap-border-default` | `border-ap-border-default` |
| `--ap-border-strong` | `--color-ap-border-strong` | `border-ap-border-strong` |
| `--ap-border-accent` | `--color-ap-border-accent` | `border-ap-border-accent` |
| `--ap-border-focus` | `--color-ap-border-focus` | `ring-ap-border-focus` |
| `--ap-border-success` | `--color-ap-border-success` | `border-ap-border-success` |
| `--ap-border-warning` | `--color-ap-border-warning` | `border-ap-border-warning` |
| `--ap-border-danger` | `--color-ap-border-danger` | `border-ap-border-danger` |
| `--ap-border-info` | `--color-ap-border-info` | `border-ap-border-info` |
| `--ap-accent` | `--color-ap-accent` | `bg-ap-accent` |
| `--ap-accent-hover` | `--color-ap-accent-hover` | `bg-ap-accent-hover` |
| `--ap-accent-active` | `--color-ap-accent-active` | `bg-ap-accent-active` |
| `--ap-accent-text` | `--color-ap-accent-text` | `text-ap-accent-text` |
| `--ap-accent-subtle` | `--color-ap-accent-subtle` | `bg-ap-accent-subtle` |
| `--ap-accent-on` | `--color-ap-accent-on` | `text-ap-accent-on` |
| `--ap-success` / `-hover` / `-text` / `-subtle` / `-border` / `-on` | `--color-ap-success*` | `bg-ap-success`、`text-ap-success-text` … |
| `--ap-warning-text` / `-subtle` / `-border` | `--color-ap-warning*` | `text-ap-warning-text` … |
| `--ap-danger` / `-hover` / `-text` / `-subtle` / `-border` / `-on` | `--color-ap-danger*` | `bg-ap-danger`、`text-ap-danger-text` … |
| `--ap-info-text` / `-subtle` / `-border` | `--color-ap-info*` | `text-ap-info-text` … |
| `--ap-presence-idle` | `--color-ap-presence-idle` | `bg-ap-presence-idle` |
| `--ap-presence-idle-text` | `--color-ap-presence-idle-text` | `text-ap-presence-idle-text` |
| `--ap-presence-thinking` / `-thinking-text` / `-thinking-subtle` | `--color-ap-presence-thinking*` | `bg-ap-presence-thinking` … |
| `--ap-presence-streaming` / `-streaming-text` | `--color-ap-presence-streaming*` | `bg-ap-presence-streaming` … |
| `--ap-presence-acting` / `-acting-text` | `--color-ap-presence-acting*` | `bg-ap-presence-acting` … |
| `--ap-presence-awaiting` / `-awaiting-text` | `--color-ap-presence-awaiting*` | `bg-ap-presence-awaiting` … |
| `--ap-emotion-warm` / `-curious` / `-caution` / `-serious` | `--color-ap-emotion-*` | `text-ap-emotion-warm` … |
| `--ap-ambient-room` / `-vignette` / `-desk-edge` / `-glow-*` | `--color-ap-ambient-*` | `bg-ap-ambient-vignette` … |

#### 字体、字号、行高、字重、字距

| CSS 变量 | Tailwind 主题变量（v4） | 生成的类 |
|---|---|---|
| `--ap-font-sans` | `--font-ap-sans` | `font-ap-sans` |
| `--ap-font-display` | `--font-ap-display` | `font-ap-display` |
| `--ap-font-mono` | `--font-ap-mono` | `font-ap-mono` |
| `--ap-fs-display` + `--ap-lh-display` | `--text-ap-display` + `--text-ap-display--line-height` | `text-ap-display` |
| `--ap-fs-h1` + `--ap-lh-h1` | `--text-ap-h1` + `--text-ap-h1--line-height` | `text-ap-h1` |
| `--ap-fs-h2` + `--ap-lh-h2` | `--text-ap-h2` + `--text-ap-h2--line-height` | `text-ap-h2` |
| `--ap-fs-body-lg` + `--ap-lh-body-lg` | `--text-ap-body-lg` + `--text-ap-body-lg--line-height` | `text-ap-body-lg` |
| `--ap-fs-body` + `--ap-lh-body` | `--text-ap-body` + `--text-ap-body--line-height` | `text-ap-body` |
| `--ap-fs-ui` + `--ap-lh-ui` | `--text-ap-ui` + `--text-ap-ui--line-height` | `text-ap-ui` |
| `--ap-fs-caption` + `--ap-lh-caption` | `--text-ap-caption` + `--text-ap-caption--line-height` | `text-ap-caption` |
| `--ap-fs-micro` + `--ap-lh-micro` | `--text-ap-micro` + `--text-ap-micro--line-height` | `text-ap-micro` |
| `--ap-fs-code` + `--ap-lh-code` | `--text-ap-code` + `--text-ap-code--line-height` | `text-ap-code` |
| `--ap-fs-tool` + `--ap-lh-tool` | `--text-ap-tool` + `--text-ap-tool--line-height` | `text-ap-tool` |
| `--ap-lh-*`（单独使用） | `--leading-ap-*` | `leading-ap-body-lg` |
| `--ap-fw-regular` / `-medium` / `-semibold` / `-bold` | `--font-weight-ap-regular` 等 | `font-ap-medium` |
| `--ap-tracking-tight` / `-normal` / `-wide` | `--tracking-ap-tight` 等 | `tracking-ap-tight` |

#### 间距、圆角、阴影、动效、层级

| CSS 变量 | Tailwind 主题变量（v4） | 生成的类 / 用法 |
|---|---|---|
| `--ap-space-{0,2,4,6,8,12,16,20,24,32,40,48,64,80}` | `--spacing-ap-{n}` | `p-ap-16` / `m-ap-8` / `gap-ap-12` |
| `--ap-radius-{none,xs,sm,md,lg,xl,2xl,full}` | `--radius-ap-{k}` | `rounded-ap-md` |
| `--ap-radius-{control,card,bubble,tool-card,modal,pill}` | `--radius-ap-{k}` | `rounded-ap-card` / `rounded-ap-bubble` |
| `--ap-shadow-{none,xs,sm,md,lg,pop}` | `--shadow-ap-{k}` | `shadow-ap-md` |
| `--ap-shadow-{glow,ambient,inset-hairline}` | `--shadow-ap-{k}` | `shadow-ap-glow` |
| `--ap-ease-{standard,enter,exit,emphasized,breathe,settle}` | `--ease-ap-{k}` | `ease-ap-enter` |
| `--animate-ap-*`（Tailwind 侧键，取值见下表） | `--animate-ap-*` | `animate-ap-presence-breathe` |
| `--ap-duration-*` | **无对应命名空间** | 任意值：`duration-[var(--ap-duration-base)]` |
| `--ap-z-*` | **无对应命名空间** | 任意值：`z-[var(--ap-z-modal)]` |
| `--ap-size-*` | **无对应命名空间** | 任意值：`max-w-[var(--ap-size-chat-max)]` |
| `--ap-opacity-*` | `--opacity-*` 可桥接，但建议直接用变量 | `opacity-[var(--ap-opacity-disabled)]` |

Tailwind `--animate-ap-*` 需要的 5 个关键帧（名字即契约，全部定义在 tokens 层，见 §7.2）：

| `--animate-*` 键 | 值 | 关键帧 |
|---|---|---|
| `--animate-ap-presence-breathe` | `ap-presence-breathe var(--ap-duration-breath) var(--ap-ease-breathe) infinite alternate` | `@keyframes ap-presence-breathe`（opacity 0.55↔1、scale 1↔1.05） |
| `--animate-ap-presence-pulse` | `ap-presence-pulse var(--ap-duration-pulse) var(--ap-ease-breathe) infinite` | `@keyframes ap-presence-pulse`（三点错位 opacity） |
| `--animate-ap-caret` | `ap-caret var(--ap-duration-caret) step-end infinite` | `@keyframes ap-caret`（opacity 1↔0） |
| `--animate-ap-enter` | `ap-enter var(--ap-duration-fast) var(--ap-ease-enter) both` | `@keyframes ap-enter`（见 §6.3 示例） |
| `--animate-ap-stream-tail` | `ap-stream-tail var(--ap-duration-stream) var(--ap-ease-enter)` | `@keyframes ap-stream-tail`（opacity 0.35→1） |

> **落地校验提示**：上表 Tailwind 命名空间名（`--color-*` / `--spacing-*` / `--radius-*` / `--shadow-*` /
> `--ease-*` / `--animate-*` / `--font-*` / `--font-weight-*` / `--text-*`（含 `--text-*--line-height`）/
> `--tracking-*` / `--leading-*`）按 Tailwind v4 的 CSS-first `@theme` 约定给出。
> **本次规划会话无外网访问，未能核对官方文档**，实施时（t5/t6）请以仓库**锁定的 Tailwind 版本**复核一次。
> 若某个命名空间不存在，退路是"直接写 `var(--ap-*)` 或任意值语法"——
> **token 命名与取值本身不受影响**，只有工具类写法需要调整。

### 7.2 `:root` / `[data-theme="dark"]` 完整 CSS variables 代码块

> 建议位置：`apps/desktop/src/styles/tokens.css`，在应用入口第一条 `@import`。
> 可直接复制使用：已保证无未定义引用、无组件层硬编码语义色、明暗两套完整。

```css
/* ══════════════════════════════════════════════════════════════════════════
   agentplant design tokens v1.0.0
   - L1 原始层：--ap-{hue}-{step}        （组件禁止直接引用）
   - L2 语义层：--ap-{role}-{variant}    （主题切换发生在这一层）
   - L3 结构层：--ap-{space|radius|...}  （与主题无关）
   修改本文件后必须重跑 scripts/check-tokens.mjs（对比度 + 引用完整性）
   ══════════════════════════════════════════════════════════════════════════ */

:root {
  color-scheme: light;

  /* ─── L1 原始色板 ─────────────────────────────────────────────────── */
  /* 暖纸 paper */
  --ap-paper-50:  #FFFDF8;
  --ap-paper-100: #FBF7EE;
  --ap-paper-200: #F5EFE4;
  --ap-paper-300: #EFE8DB;
  --ap-paper-400: #E9E1D2;
  --ap-paper-500: #D8CFBE;
  --ap-paper-600: #B4A68C;
  /* 暖墨 ink */
  --ap-ink-300: #A79C8C;
  --ap-ink-500: #6E6455;
  --ap-ink-600: #61584C;
  --ap-ink-700: #4A433C;
  --ap-ink-800: #2A2622;
  /* 夜 night */
  --ap-night-400: #4E5F6C;
  --ap-night-500: #2F3F4A;
  --ap-night-600: #2B3A45;
  --ap-night-700: #22303A;
  --ap-night-800: #1A242B;
  --ap-night-900: #111A20;
  --ap-night-950: #101B22;
  /* 冷雾 mist */
  --ap-mist-50:  #E9EFF3;
  --ap-mist-100: #C3D1DA;
  --ap-mist-200: #A9BAC5;
  --ap-mist-300: #96A9B4;
  --ap-mist-400: #8A9DA8;
  --ap-mist-500: #6B7E8A;
  /* 印章青蓝 seal（唯一强调色） */
  --ap-seal-100: #E7F0F5;
  --ap-seal-200: #D3E3EC;
  --ap-seal-300: #9FC3D6;
  --ap-seal-400: #6FA0BC;
  --ap-seal-500: #45708A;
  --ap-seal-600: #3F6179;
  --ap-seal-700: #2F4E60;
  /* 余温 ember（陪伴暖色） */
  --ap-ember-50:  #F7EFE8;
  --ap-ember-300: #E0A87F;
  --ap-ember-500: #B27049;
  --ap-ember-600: #A9663A;
  --ap-ember-700: #8A5433;
  --ap-ember-800: #8A4F26;
  /* 苔绿 sage（动手 / 工具） */
  --ap-sage-400: #96CDB8;
  --ap-sage-500: #86BFAA;
  --ap-sage-600: #4F7F6E;
  --ap-sage-700: #3D6355;
  /* 苔藓绿 moss（success） */
  --ap-moss-200: #B9CFB4;
  --ap-moss-300: #8CC790;
  --ap-moss-400: #7FBE84;
  --ap-moss-500: #3A6B45;
  --ap-moss-600: #33613E;
  /* 陶土 clay（danger） */
  --ap-clay-200: #E0B3A8;
  --ap-clay-300: #E59A92;
  --ap-clay-400: #D9736A;
  --ap-clay-600: #8B2C1F;
  --ap-clay-700: #6E2117;
  /* 麦黄 wheat（warning） */
  --ap-wheat-200: #E0C89A;
  --ap-wheat-300: #E0B45C;
  --ap-wheat-600: #7A4E0E;
  /* 鸢尾 iris（emotion-curious） */
  --ap-iris-300: #A8B6E0;
  --ap-iris-500: #5B6FA8;

  /* ─── L2 表面 surface ─────────────────────────────────────────────── */
  --ap-surface-0: var(--ap-paper-200);
  --ap-surface-1: var(--ap-paper-100);
  --ap-surface-2: var(--ap-paper-50);
  --ap-surface-sunken: var(--ap-paper-300);
  --ap-surface-inset: #F4EFE5;
  --ap-surface-code: #F2EDE2;
  --ap-surface-bubble-user: #EAF0F4;
  --ap-surface-row-hover: #F5F0E5;
  --ap-surface-row-selected: #D8E5EC;
  --ap-surface-scrim: rgb(42 38 34 / 0.45);

  /* ─── L2 文字 text ───────────────────────────────────────────────── */
  --ap-text-primary: var(--ap-ink-800);
  --ap-text-secondary: var(--ap-ink-700);
  --ap-text-tertiary: var(--ap-ink-600);
  --ap-text-muted: var(--ap-ink-500);
  --ap-text-disabled: var(--ap-ink-300);
  --ap-text-inverse: var(--ap-paper-100);
  --ap-text-on-accent: var(--ap-paper-50);

  /* ─── L2 边框 border ─────────────────────────────────────────────── */
  --ap-border-subtle: var(--ap-paper-400);
  --ap-border-default: var(--ap-paper-500);
  --ap-border-strong: var(--ap-paper-600);
  --ap-border-accent: var(--ap-seal-500);
  --ap-border-focus: var(--ap-seal-500);
  --ap-border-success: var(--ap-moss-200);
  --ap-border-warning: var(--ap-wheat-200);
  --ap-border-danger: var(--ap-clay-200);
  --ap-border-info: #AECBDA;

  /* ─── L2 强调 accent ─────────────────────────────────────────────── */
  --ap-accent: var(--ap-seal-500);
  --ap-accent-hover: var(--ap-seal-600);
  --ap-accent-active: var(--ap-seal-700);
  --ap-accent-text: var(--ap-seal-600);
  --ap-accent-subtle: var(--ap-seal-100);
  --ap-accent-on: var(--ap-paper-50);

  /* ─── L2 语义状态 ────────────────────────────────────────────────── */
  --ap-success: var(--ap-moss-500);
  --ap-success-hover: var(--ap-moss-600);
  --ap-success-text: var(--ap-moss-600);
  --ap-success-subtle: #E9F1E7;
  --ap-success-border: var(--ap-moss-200);
  --ap-success-on: var(--ap-paper-50);

  --ap-warning-text: var(--ap-wheat-600);
  --ap-warning-subtle: #FBF0DC;
  --ap-warning-border: var(--ap-wheat-200);

  --ap-danger: var(--ap-clay-600);
  --ap-danger-hover: var(--ap-clay-700);
  --ap-danger-text: var(--ap-clay-600);
  --ap-danger-subtle: #FBEAE6;
  --ap-danger-border: var(--ap-clay-200);
  --ap-danger-on: var(--ap-paper-50);

  --ap-info-text: var(--ap-seal-700);
  --ap-info-subtle: var(--ap-seal-100);
  --ap-info-border: #AECBDA;

  /* ─── L2 presence（陪伴感五态） ──────────────────────────────────── */
  --ap-presence-idle: #6F7E88;
  --ap-presence-idle-text: #58666F;
  --ap-presence-thinking: var(--ap-ember-500);
  --ap-presence-thinking-text: var(--ap-ember-700);
  --ap-presence-thinking-subtle: var(--ap-ember-50);
  --ap-presence-streaming: var(--ap-seal-500);
  --ap-presence-streaming-text: var(--ap-seal-600);
  --ap-presence-acting: var(--ap-sage-600);
  --ap-presence-acting-text: var(--ap-sage-700);
  --ap-presence-awaiting: var(--ap-ember-600);
  --ap-presence-awaiting-text: var(--ap-ember-800);
  --ap-presence-dot-size: 8px;
  --ap-presence-dot-size-lg: 10px;
  --ap-presence-ring-width: 2px;
  --ap-presence-ring-offset: 2px;

  /* ─── L2 ambient（环境氛围） ─────────────────────────────────────── */
  --ap-ambient-room: var(--ap-paper-200);
  --ap-ambient-vignette: rgb(42 38 34 / 0.06);
  --ap-ambient-desk-edge: rgb(216 207 190 / 0.55);
  --ap-ambient-paper-opacity: 0.035;
  --ap-ambient-glow-thinking: rgb(178 112 73 / 0.10);
  --ap-ambient-glow-streaming: rgb(69 112 138 / 0.08);
  --ap-ambient-glow-acting: rgb(79 127 110 / 0.08);
  --ap-ambient-glow-size: 480px;
  --ap-ambient-glow-blur: 80px;
  /* 时间氛围（可选）：默认关闭，运行时按 data-ambient-hour 覆写 */
  --ap-ambient-hour-tint: rgb(0 0 0 / 0);
  --ap-ambient-hour-glow-scale: 0;

  /* ─── L2 emotion（情绪点缀） ─────────────────────────────────────── */
  --ap-emotion-warm: #B4703F;
  --ap-emotion-curious: var(--ap-iris-500);
  --ap-emotion-caution: #96702A;
  --ap-emotion-serious: #6B5B7A;

  /* ─── L3 字体 ────────────────────────────────────────────────────── */
  --ap-font-sans: 'Inter var', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', 'Segoe UI', 'PingFang SC', 'HarmonyOS Sans SC', 'Microsoft YaHei UI', 'Microsoft YaHei', 'Noto Sans SC', sans-serif;
  --ap-font-display: 'Source Serif 4', 'Iowan Old Style', 'Georgia', 'Songti SC', 'STSong', 'Source Han Serif SC', 'Noto Serif SC', serif;
  --ap-font-mono: 'JetBrains Mono', 'Cascadia Code', 'Cascadia Mono', 'SF Mono', 'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', 'Noto Sans Mono CJK SC', monospace;
  --ap-font-emoji: 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji';

  /* ─── L3 字号 / 行高 / 字重 / 字距 ───────────────────────────────── */
  --ap-fs-display: 28px;   --ap-lh-display: 36px;
  --ap-fs-h1: 20px;        --ap-lh-h1: 28px;
  --ap-fs-h2: 17px;        --ap-lh-h2: 26px;
  --ap-fs-body-lg: 16px;   --ap-lh-body-lg: 26px;
  --ap-fs-body: 15px;      --ap-lh-body: 24px;
  --ap-fs-ui: 14px;        --ap-lh-ui: 20px;
  --ap-fs-caption: 12px;   --ap-lh-caption: 18px;
  --ap-fs-micro: 11px;     --ap-lh-micro: 16px;
  --ap-fs-code: 13px;      --ap-lh-code: 22px;
  --ap-fs-tool: 13px;      --ap-lh-tool: 20px;
  --ap-fw-regular: 400;
  --ap-fw-medium: 500;
  --ap-fw-semibold: 600;
  --ap-fw-bold: 700;
  --ap-tracking-tight: -0.01em;
  --ap-tracking-normal: 0;
  --ap-tracking-wide: 0.02em;

  /* ─── L3 间距 ────────────────────────────────────────────────────── */
  --ap-space-0: 0px;
  --ap-space-2: 2px;
  --ap-space-4: 4px;
  --ap-space-6: 6px;
  --ap-space-8: 8px;
  --ap-space-12: 12px;
  --ap-space-16: 16px;
  --ap-space-20: 20px;
  --ap-space-24: 24px;
  --ap-space-32: 32px;
  --ap-space-40: 40px;
  --ap-space-48: 48px;
  --ap-space-64: 64px;
  --ap-space-80: 80px;

  /* ─── L3 尺寸 ────────────────────────────────────────────────────── */
  --ap-size-sidebar: 248px;
  --ap-size-detail: 320px;
  --ap-size-titlebar: 44px;
  --ap-size-chat-max: 760px;
  --ap-size-composer-max: 760px;
  --ap-size-toolbar: 36px;
  --ap-size-control: 32px;
  --ap-size-control-sm: 24px;
  --ap-size-avatar: 28px;
  --ap-size-avatar-lg: 40px;
  --ap-size-indicator-rail: 3px;
  --ap-breakpoint-compact: 1024px;

  /* ─── L3 圆角 ────────────────────────────────────────────────────── */
  --ap-radius-none: 0px;
  --ap-radius-xs: 2px;
  --ap-radius-sm: 4px;
  --ap-radius-md: 6px;
  --ap-radius-lg: 10px;
  --ap-radius-xl: 14px;
  --ap-radius-2xl: 20px;
  --ap-radius-full: 9999px;
  --ap-radius-control: var(--ap-radius-md);
  --ap-radius-card: var(--ap-radius-lg);
  --ap-radius-bubble: var(--ap-radius-xl);
  --ap-radius-tool-card: 8px;
  --ap-radius-modal: var(--ap-radius-xl);
  --ap-radius-pill: var(--ap-radius-full);

  /* ─── L3 阴影 ────────────────────────────────────────────────────── */
  --ap-shadow-none: none;
  --ap-shadow-xs: 0 1px 2px rgb(42 38 34 / 0.05);
  --ap-shadow-sm: 0 1px 3px rgb(42 38 34 / 0.06), 0 1px 2px rgb(42 38 34 / 0.04);
  --ap-shadow-md: 0 4px 12px rgb(42 38 34 / 0.07), 0 1px 3px rgb(42 38 34 / 0.05);
  --ap-shadow-lg: 0 12px 32px rgb(42 38 34 / 0.10), 0 2px 8px rgb(42 38 34 / 0.06);
  --ap-shadow-pop: 0 20px 48px rgb(42 38 34 / 0.16), 0 4px 12px rgb(42 38 34 / 0.08);
  --ap-shadow-inset-hairline: inset 0 1px 0 rgb(255 255 255 / 0.60);
  --ap-shadow-glow: 0 0 0 4px rgb(69 112 138 / 0.12);
  --ap-shadow-ambient: 0 0 60px 20px rgb(42 38 34 / 0.04);

  /* ─── L3 边框宽度 / 聚焦环 ───────────────────────────────────────── */
  --ap-border-w-hairline: 0.5px;
  --ap-border-w: 1px;
  --ap-border-w-strong: 2px;
  --ap-border-w-rail: 3px;
  --ap-focus-ring-width: 2px;
  --ap-focus-ring-offset: 2px;

  /* ─── L3 z-index ─────────────────────────────────────────────────── */
  --ap-z-base: 0;
  --ap-z-raised: 10;
  --ap-z-sticky: 20;
  --ap-z-sidebar: 30;
  --ap-z-dropdown: 40;
  --ap-z-scrim: 50;
  --ap-z-modal: 60;
  --ap-z-popover: 65;
  --ap-z-toast: 70;
  --ap-z-tooltip: 80;
  --ap-z-dev-overlay: 90;

  /* ─── L3 不透明度 ────────────────────────────────────────────────── */
  --ap-opacity-disabled: 0.45;
  --ap-opacity-muted: 0.72;
  --ap-opacity-emotion: 0.60;
  --ap-opacity-scrim: 0.45;
  --ap-opacity-hidden: 0;

  /* ─── L3 动效 ────────────────────────────────────────────────────── */
  --ap-duration-0: 0ms;
  --ap-duration-instant: 80ms;
  --ap-duration-fast: 140ms;
  --ap-duration-base: 200ms;
  --ap-duration-slow: 320ms;
  --ap-duration-slower: 480ms;
  --ap-duration-stream: 90ms;
  --ap-duration-caret: 1000ms;
  --ap-duration-breath: 2400ms;
  --ap-duration-pulse: 900ms;
  --ap-duration-dwell-toast: 6000ms;
  --ap-ease-standard: cubic-bezier(0.2, 0, 0, 1);
  --ap-ease-enter: cubic-bezier(0.16, 1, 0.3, 1);
  --ap-ease-exit: cubic-bezier(0.4, 0, 1, 1);
  --ap-ease-emphasized: cubic-bezier(0.2, 0, 0, 1);
  --ap-ease-breathe: cubic-bezier(0.37, 0, 0.63, 1);
  --ap-ease-settle: cubic-bezier(0.34, 1.36, 0.64, 1);
  --ap-motion-scale: 1;
  --ap-motion-slide-sm: 4px;
  --ap-motion-slide-md: 8px;
  --ap-motion-slide-lg: 24px;
  --ap-motion-enter-scale: 0.96;
  --ap-motion-caret-width: 2px;
}

/* ══════════════════════════════════════════════════════════════════════════
   深色主题：只覆盖 L2 语义层与主题相关的 L3（阴影 / 光晕）
   ══════════════════════════════════════════════════════════════════════════ */
[data-theme='dark'] {
  color-scheme: dark;

  /* 表面 */
  --ap-surface-0: var(--ap-night-800);
  --ap-surface-1: var(--ap-night-700);
  --ap-surface-2: var(--ap-night-600);
  --ap-surface-sunken: var(--ap-night-900);
  --ap-surface-inset: #1E2A33;
  --ap-surface-code: #16222A;
  --ap-surface-bubble-user: var(--ap-night-600);
  --ap-surface-row-hover: #24323C;
  --ap-surface-row-selected: #2A3C49;
  --ap-surface-scrim: rgb(0 0 0 / 0.58);

  /* 文字 */
  --ap-text-primary: var(--ap-mist-50);
  --ap-text-secondary: var(--ap-mist-100);
  --ap-text-tertiary: var(--ap-mist-200);
  --ap-text-muted: var(--ap-mist-300);
  --ap-text-disabled: var(--ap-mist-500);
  --ap-text-inverse: var(--ap-night-950);
  --ap-text-on-accent: var(--ap-night-950);

  /* 边框 */
  --ap-border-subtle: #26343D;
  --ap-border-default: var(--ap-night-500);
  --ap-border-strong: var(--ap-night-400);
  --ap-border-accent: var(--ap-seal-400);
  --ap-border-focus: var(--ap-seal-400);
  --ap-border-success: #33513C;
  --ap-border-warning: #5C4A22;
  --ap-border-danger: #5C332E;
  --ap-border-info: #2E4A58;

  /* 强调 */
  --ap-accent: var(--ap-seal-400);
  --ap-accent-hover: var(--ap-seal-300);
  --ap-accent-active: var(--ap-seal-200);
  --ap-accent-text: var(--ap-seal-300);
  --ap-accent-subtle: #26343D;
  --ap-accent-on: var(--ap-night-950);

  /* 语义状态 */
  --ap-success: var(--ap-moss-400);
  --ap-success-hover: var(--ap-moss-300);
  --ap-success-text: var(--ap-moss-300);
  --ap-success-subtle: #17251C;
  --ap-success-border: #33513C;
  --ap-success-on: var(--ap-night-950);

  --ap-warning-text: var(--ap-wheat-300);
  --ap-warning-subtle: #2A2214;
  --ap-warning-border: #5C4A22;

  --ap-danger: var(--ap-clay-400);
  --ap-danger-hover: var(--ap-clay-300);
  --ap-danger-text: var(--ap-clay-300);
  --ap-danger-subtle: #2A1A18;
  --ap-danger-border: #5C332E;
  --ap-danger-on: var(--ap-night-950);

  --ap-info-text: var(--ap-seal-300);
  --ap-info-subtle: #16242C;
  --ap-info-border: #2E4A58;

  /* presence */
  --ap-presence-idle: var(--ap-mist-400);
  --ap-presence-idle-text: var(--ap-mist-200);
  --ap-presence-thinking: var(--ap-ember-300);
  --ap-presence-thinking-text: var(--ap-ember-300);
  --ap-presence-thinking-subtle: rgb(224 168 127 / 0.10);
  --ap-presence-streaming: var(--ap-seal-400);
  --ap-presence-streaming-text: var(--ap-seal-300);
  --ap-presence-acting: var(--ap-sage-500);
  --ap-presence-acting-text: var(--ap-sage-400);
  --ap-presence-awaiting: #F0BE93;
  --ap-presence-awaiting-text: #F0BE93;

  /* ambient */
  --ap-ambient-room: var(--ap-night-800);
  --ap-ambient-vignette: rgb(0 0 0 / 0.45);
  --ap-ambient-desk-edge: rgb(47 63 74 / 0.55);
  --ap-ambient-paper-opacity: 0.02;
  --ap-ambient-glow-thinking: rgb(224 168 127 / 0.12);
  --ap-ambient-glow-streaming: rgb(111 160 188 / 0.10);
  --ap-ambient-glow-acting: rgb(134 191 170 / 0.10);

  /* emotion */
  --ap-emotion-warm: #E8B589;
  --ap-emotion-curious: var(--ap-iris-300);
  --ap-emotion-caution: #DCBE7A;
  --ap-emotion-serious: #BFAFD0;

  /* 阴影与 focus 光晕（暗色下阴影仅作边缘分离，深度靠表面层差） */
  --ap-shadow-xs: 0 1px 2px rgb(0 0 0 / 0.30);
  --ap-shadow-sm: 0 1px 3px rgb(0 0 0 / 0.42), 0 1px 2px rgb(0 0 0 / 0.30);
  --ap-shadow-md: 0 4px 12px rgb(0 0 0 / 0.48), 0 1px 3px rgb(0 0 0 / 0.32);
  --ap-shadow-lg: 0 12px 32px rgb(0 0 0 / 0.55), 0 2px 8px rgb(0 0 0 / 0.38);
  --ap-shadow-pop: 0 20px 48px rgb(0 0 0 / 0.62), 0 4px 12px rgb(0 0 0 / 0.40);
  --ap-shadow-inset-hairline: inset 0 1px 0 rgb(233 239 243 / 0.06);
  --ap-shadow-glow: 0 0 0 4px rgb(111 160 188 / 0.20);
  --ap-shadow-ambient: 0 0 80px 24px rgb(0 0 0 / 0.28);
}

/* ══════════════════════════════════════════════════════════════════════════
   全局基线（tokens 的强制副作用；写在同一文件以免遗漏）
   ══════════════════════════════════════════════════════════════════════════ */
:root {
  font-synthesis: none;            /* 禁止 CJK 伪粗体 / 伪斜体 */
  accent-color: var(--ap-accent);
}

/* 动效降级：系统偏好与用户手动开关走同一套值 */
@media (prefers-reduced-motion: reduce) {
  :root {
    --ap-motion-scale: 0;
    --ap-motion-enter-scale: 1;
    --ap-duration-instant: 1ms;
    --ap-duration-fast: 1ms;
    --ap-duration-base: 1ms;
    --ap-duration-slow: 1ms;
    --ap-duration-slower: 1ms;
    --ap-duration-stream: 1ms;
    --ap-duration-breath: 0ms;
    --ap-duration-pulse: 0ms;
    --ap-duration-caret: 0ms;
    --ap-duration-dwell-toast: 8000ms;
  }
}
[data-motion='reduced'] {
  --ap-motion-scale: 0;
  --ap-motion-enter-scale: 1;
  --ap-duration-instant: 1ms;
  --ap-duration-fast: 1ms;
  --ap-duration-base: 1ms;
  --ap-duration-slow: 1ms;
  --ap-duration-slower: 1ms;
  --ap-duration-stream: 1ms;
  --ap-duration-breath: 0ms;
  --ap-duration-pulse: 0ms;
  --ap-duration-caret: 0ms;
  --ap-duration-dwell-toast: 8000ms;
}

/* presence 关键帧（tokens 层持有；组件只引用 animate-* token） */
@keyframes ap-presence-breathe {
  0%, 100% { opacity: 0.55; transform: scale(1); }
  50%      { opacity: 1;    transform: scale(calc(1 + 0.05 * var(--ap-motion-scale))); }
}
@keyframes ap-presence-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.35; }
}
@keyframes ap-caret {
  0%, 49%   { opacity: 1; }
  50%, 100% { opacity: 0; }
}
@keyframes ap-enter {
  from {
    opacity: 0;
    transform: translateY(calc(var(--ap-motion-slide-sm) * var(--ap-motion-scale)))
               scale(calc(1 - (1 - var(--ap-motion-enter-scale)) * var(--ap-motion-scale)));
  }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes ap-stream-tail {
  from { opacity: 0.35; }
  to   { opacity: 1; }
}

/* reduced-motion 下关闭持续型动画（静态状态由 presence 文字标签承担） */
@media (prefers-reduced-motion: reduce) {
  .animate-ap-presence-breathe,
  .animate-ap-presence-pulse,
  .animate-ap-caret { animation: none; }
}
[data-motion='reduced'] .animate-ap-presence-breathe,
[data-motion='reduced'] .animate-ap-presence-pulse,
[data-motion='reduced'] .animate-ap-caret { animation: none; }
```

### 7.3 Tailwind 接入

**v4（CSS-first，推荐；与 pnpm + TS 同仓形态一致）**

```css
/* apps/desktop/src/styles/tailwind.css */
@import 'tailwindcss';
@import './tokens.css';

/* 用 @theme inline：让工具类直接内联 var(--ap-*)，
   这样 [data-theme="dark"] 的覆盖运行时即可生效，无需重建 CSS。 */
@theme inline {
  /* 颜色 */
  --color-ap-surface-0: var(--ap-surface-0);
  --color-ap-surface-1: var(--ap-surface-1);
  --color-ap-surface-2: var(--ap-surface-2);
  --color-ap-surface-sunken: var(--ap-surface-sunken);
  --color-ap-surface-inset: var(--ap-surface-inset);
  --color-ap-surface-code: var(--ap-surface-code);
  --color-ap-surface-bubble-user: var(--ap-surface-bubble-user);
  --color-ap-surface-row-hover: var(--ap-surface-row-hover);
  --color-ap-surface-row-selected: var(--ap-surface-row-selected);
  --color-ap-surface-scrim: var(--ap-surface-scrim);

  --color-ap-text-primary: var(--ap-text-primary);
  --color-ap-text-secondary: var(--ap-text-secondary);
  --color-ap-text-tertiary: var(--ap-text-tertiary);
  --color-ap-text-muted: var(--ap-text-muted);
  --color-ap-text-disabled: var(--ap-text-disabled);
  --color-ap-text-inverse: var(--ap-text-inverse);
  --color-ap-text-on-accent: var(--ap-text-on-accent);

  --color-ap-border-subtle: var(--ap-border-subtle);
  --color-ap-border-default: var(--ap-border-default);
  --color-ap-border-strong: var(--ap-border-strong);
  --color-ap-border-focus: var(--ap-border-focus);
  --color-ap-border-danger: var(--ap-border-danger);

  --color-ap-accent: var(--ap-accent);
  --color-ap-accent-hover: var(--ap-accent-hover);
  --color-ap-accent-active: var(--ap-accent-active);
  --color-ap-accent-text: var(--ap-accent-text);
  --color-ap-accent-subtle: var(--ap-accent-subtle);
  --color-ap-accent-on: var(--ap-accent-on);

  --color-ap-success: var(--ap-success);
  --color-ap-success-text: var(--ap-success-text);
  --color-ap-success-subtle: var(--ap-success-subtle);
  --color-ap-warning-text: var(--ap-warning-text);
  --color-ap-warning-subtle: var(--ap-warning-subtle);
  --color-ap-danger: var(--ap-danger);
  --color-ap-danger-text: var(--ap-danger-text);
  --color-ap-danger-subtle: var(--ap-danger-subtle);
  --color-ap-info-text: var(--ap-info-text);
  --color-ap-info-subtle: var(--ap-info-subtle);

  /* presence（陪伴感五态，一期范围） */
  --color-ap-presence-idle: var(--ap-presence-idle);
  --color-ap-presence-idle-text: var(--ap-presence-idle-text);
  --color-ap-presence-thinking: var(--ap-presence-thinking);
  --color-ap-presence-thinking-text: var(--ap-presence-thinking-text);
  --color-ap-presence-thinking-subtle: var(--ap-presence-thinking-subtle);
  --color-ap-presence-streaming: var(--ap-presence-streaming);
  --color-ap-presence-streaming-text: var(--ap-presence-streaming-text);
  --color-ap-presence-acting: var(--ap-presence-acting);
  --color-ap-presence-acting-text: var(--ap-presence-acting-text);
  --color-ap-presence-awaiting: var(--ap-presence-awaiting);
  --color-ap-presence-awaiting-text: var(--ap-presence-awaiting-text);
  --color-ap-emotion-warm: var(--ap-emotion-warm);
  --color-ap-emotion-curious: var(--ap-emotion-curious);
  --color-ap-emotion-caution: var(--ap-emotion-caution);
  --color-ap-emotion-serious: var(--ap-emotion-serious);

  /* 字体 */
  --font-ap-sans: var(--ap-font-sans);
  --font-ap-display: var(--ap-font-display);
  --font-ap-mono: var(--ap-font-mono);

  /* 字号 + 行高（成对出现，避免写下字号忘了行高） */
  --text-ap-display: var(--ap-fs-display);
  --text-ap-display--line-height: var(--ap-lh-display);
  --text-ap-h1: var(--ap-fs-h1);
  --text-ap-h1--line-height: var(--ap-lh-h1);
  --text-ap-h2: var(--ap-fs-h2);
  --text-ap-h2--line-height: var(--ap-lh-h2);
  --text-ap-body-lg: var(--ap-fs-body-lg);
  --text-ap-body-lg--line-height: var(--ap-lh-body-lg);
  --text-ap-body: var(--ap-fs-body);
  --text-ap-body--line-height: var(--ap-lh-body);
  --text-ap-ui: var(--ap-fs-ui);
  --text-ap-ui--line-height: var(--ap-lh-ui);
  --text-ap-caption: var(--ap-fs-caption);
  --text-ap-caption--line-height: var(--ap-lh-caption);
  --text-ap-micro: var(--ap-fs-micro);
  --text-ap-micro--line-height: var(--ap-lh-micro);
  --text-ap-code: var(--ap-fs-code);
  --text-ap-code--line-height: var(--ap-lh-code);

  /* 字重 / 字距 */
  --font-weight-ap-regular: var(--ap-fw-regular);
  --font-weight-ap-medium: var(--ap-fw-medium);
  --font-weight-ap-semibold: var(--ap-fw-semibold);
  --font-weight-ap-bold: var(--ap-fw-bold);
  --tracking-ap-tight: var(--ap-tracking-tight);
  --tracking-ap-normal: var(--ap-tracking-normal);
  --tracking-ap-wide: var(--ap-tracking-wide);

  /* 间距 */
  --spacing-ap-0: var(--ap-space-0);
  --spacing-ap-2: var(--ap-space-2);
  --spacing-ap-4: var(--ap-space-4);
  --spacing-ap-6: var(--ap-space-6);
  --spacing-ap-8: var(--ap-space-8);
  --spacing-ap-12: var(--ap-space-12);
  --spacing-ap-16: var(--ap-space-16);
  --spacing-ap-20: var(--ap-space-20);
  --spacing-ap-24: var(--ap-space-24);
  --spacing-ap-32: var(--ap-space-32);
  --spacing-ap-40: var(--ap-space-40);
  --spacing-ap-48: var(--ap-space-48);
  --spacing-ap-64: var(--ap-space-64);
  --spacing-ap-80: var(--ap-space-80);

  /* 圆角 */
  --radius-ap-none: var(--ap-radius-none);
  --radius-ap-xs: var(--ap-radius-xs);
  --radius-ap-sm: var(--ap-radius-sm);
  --radius-ap-md: var(--ap-radius-md);
  --radius-ap-lg: var(--ap-radius-lg);
  --radius-ap-xl: var(--ap-radius-xl);
  --radius-ap-2xl: var(--ap-radius-2xl);
  --radius-ap-full: var(--ap-radius-full);
  --radius-ap-control: var(--ap-radius-control);
  --radius-ap-card: var(--ap-radius-card);
  --radius-ap-bubble: var(--ap-radius-bubble);
  --radius-ap-tool-card: var(--ap-radius-tool-card);
  --radius-ap-modal: var(--ap-radius-modal);

  /* 阴影 */
  --shadow-ap-none: var(--ap-shadow-none);
  --shadow-ap-xs: var(--ap-shadow-xs);
  --shadow-ap-sm: var(--ap-shadow-sm);
  --shadow-ap-md: var(--ap-shadow-md);
  --shadow-ap-lg: var(--ap-shadow-lg);
  --shadow-ap-pop: var(--ap-shadow-pop);
  --shadow-ap-glow: var(--ap-shadow-glow);
  --shadow-ap-ambient: var(--ap-shadow-ambient);

  /* 缓动 */
  --ease-ap-standard: var(--ap-ease-standard);
  --ease-ap-enter: var(--ap-ease-enter);
  --ease-ap-exit: var(--ap-ease-exit);
  --ease-ap-emphasized: var(--ap-ease-emphasized);
  --ease-ap-breathe: var(--ap-ease-breathe);
  --ease-ap-settle: var(--ap-ease-settle);

  /* 动画（关键帧定义在 tokens.css，见 §7.2 尾部） */
  --animate-ap-presence-breathe: ap-presence-breathe var(--ap-duration-breath) var(--ap-ease-breathe) infinite alternate;
  --animate-ap-presence-pulse: ap-presence-pulse var(--ap-duration-pulse) var(--ap-ease-breathe) infinite;
  --animate-ap-caret: ap-caret var(--ap-duration-caret) step-end infinite;
  --animate-ap-enter: ap-enter var(--ap-duration-fast) var(--ap-ease-enter) both;
  --animate-ap-stream-tail: ap-stream-tail var(--ap-duration-stream) var(--ap-ease-enter);
}
```

**Tailwind 暗色变体**（默认 `dark:` 走 `prefers-color-scheme`，本项目由 `data-theme` 驱动，必须改写）：

```css
@custom-variant dark (&:where([data-theme='dark'], [data-theme='dark'] *));
```

**v3 兜底**（若因构建链约束停留在 v3；键名与上表一致）：

```ts
// tailwind.config.ts
export default {
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        'ap-surface-1': 'var(--ap-surface-1)',
        'ap-surface-sunken': 'var(--ap-surface-sunken)',
        'ap-text-primary': 'var(--ap-text-primary)',
        'ap-text-tertiary': 'var(--ap-text-tertiary)',
        'ap-accent': 'var(--ap-accent)',
        'ap-accent-text': 'var(--ap-accent-text)',
        'ap-danger-text': 'var(--ap-danger-text)',
        'ap-presence-thinking': 'var(--ap-presence-thinking)',
        // …其余按 §7.1 表格逐项照抄，键名与 v4 的 --color-* 同名
      },
      borderRadius: { 'ap-card': 'var(--ap-radius-card)' },
      boxShadow: { 'ap-md': 'var(--ap-shadow-md)' },
      transitionTimingFunction: { 'ap-enter': 'var(--ap-ease-enter)' },
      fontSize: { 'ap-body-lg': ['var(--ap-fs-body-lg)', 'var(--ap-lh-body-lg)'] },
      spacing: { 'ap-16': 'var(--ap-space-16)' },
    },
  },
};
```

### 7.4 明暗切换与首屏防闪（FOUC）

**HTML 契约**（`apps/desktop/src/index.html`）：

```html
<!doctype html>
<html lang="zh-CN" data-theme="light"> <!-- 静态兜底值；下一行的内联脚本会立即改写 -->
  <head>
    <meta charset="utf-8" />
    <meta name="color-scheme" content="light dark" />
    <script>
      // 内联、同步、位于任何样式表之前 —— 保证首帧就是正确主题（无白闪/黑闪）
      (function () {
        try {
          var pref = localStorage.getItem('ap.colorScheme') || 'auto'; // 'auto' | 'light' | 'dark'
          var resolved =
            pref === 'auto'
              ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
              : pref;
          document.documentElement.setAttribute('data-theme', resolved);
          document.documentElement.setAttribute(
            'data-motion',
            localStorage.getItem('ap.motion') === 'reduced' ? 'reduced' : 'full',
          );
        } catch (e) {
          /* localStorage 不可用（隐私模式等）：保留 HTML 上的静态兜底值 */
        }
      })();
    </script>
    <link rel="stylesheet" href="./styles/app.css" />
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
```

**主题偏好变化时的运行时同步**（`auto` 模式必须监听系统切换）：

```ts
export function mountColorScheme(): () => void {
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = () => {
    const pref = localStorage.getItem('ap.colorScheme') ?? 'auto';
    const resolved = pref === 'auto' ? (mql.matches ? 'dark' : 'light') : pref;
    document.documentElement.setAttribute('data-theme', resolved);
  };
  const onSystemChange = () => {
    if ((localStorage.getItem('ap.colorScheme') ?? 'auto') === 'auto') apply();
  };
  mql.addEventListener('change', onSystemChange);
  apply();
  return () => mql.removeEventListener('change', onSystemChange);
}
```

**存储键契约**（单一真相，禁止散落多处）：

| 键 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `ap.colorScheme` | `'auto' \| 'light' \| 'dark'` | `'auto'` | 用户偏好；`auto` 时由系统偏好解析 |
| `ap.motion` | `'full' \| 'reduced'` | `'full'` | 手动动效开关，与系统 `prefers-reduced-motion` 取**并集**（任一要求减少即减少） |
| `data-theme`（DOM） | `'light' \| 'dark'` | 由脚本写入 | **只存解析后的具体值**，不出现 `data-theme="auto"` |
| `data-motion`（DOM） | `'full' \| 'reduced'` | 由脚本写入 | 与媒体查询并列生效（CSS 见 §7.2） |

**可选优化（无 JS、零重复）**：`light-dark()` 已进入 Chromium 123+，
而 MVP 入口是 Electron（Chromium 版本可控）。把明暗值写成
`:root { color-scheme: light dark; --ap-surface-0: light-dark(#F5EFE4, #1A242B); }`
即可由浏览器直接解析系统偏好，彻底去掉内联脚本。
**但本文件以 §7.2 的 `:root` / `[data-theme="dark"]` 双块为正典**——
因为它对内核版本零假设，且与本文件其余章节的表格一一对应，便于机器校验。
`light-dark()` 作为二期可选重构，重构前必须先确认 Electron 打包的 Chromium 版本 ≥123。

---

## 8. 暗色为默认主题、还是跟随系统？

### 结论

**采用"跟随系统（`auto`）"作为默认行为；不把暗色设为无条件默认。
但暗色是完整体验的一等公民，且"JS 未执行 / 偏好读取失败"的字面兜底值取浅色（非暗色）。**

### 具体决策表

| 场景 | `data-theme` | 依据 |
|---|---|---|
| 首次启动、用户未表态 | 由 `prefers-color-scheme` 解析 | 系统偏好已是用户的全局表达，零配置正确率最高 |
| 用户在设置中显式锁定 | `light` / `dark` | 显式偏好永远优先于系统 |
| 设置为 `auto` 且系统偏好变化 | 实时跟随（`matchMedia` 监听） | 避免"白天锁定浅色、晚上被亮屏"的不适 |
| JS 未执行 / `localStorage` 抛错 | HTML 上的静态字面值 = 浅色 | 兜底必须可读；且内联同步脚本已使真实运行中不会出现该路径 |
| 支持 `light-dark()` 的内核（二期可选） | 由 `color-scheme` 驱动 | 去掉内联脚本，零重复 |

### 理由

1. **目标用户的使用场景是双侧的，不是单侧的。** t2 定的目标用户是
   "个人重度用户（开发者与知识工作者）"——白天在明亮办公环境（外接显示器、环境光强），
   夜里在书房。把暗色设为无条件默认，等于强制所有白天用户进入不适合的亮度环境，
   这是体验倒退；反之亦然。**"跟随系统"是唯一不需要我们替用户猜的选择。**
2. **系统偏好是唯一可信的全局信号。** macOS / Windows 的深浅色设置是用户对所有应用的一次性表态；
   应用私有默认值与它冲突时，用户每次都要改一遍（典型的"每个 App 都要关一次深色"疲劳）。
3. **暗色在本产品中表达力更强，这是选择"锚点"而非"默认"的理由。**
   §3.2 已说明：环境光晕在低亮度背景上更明显，presence 呼吸在暗色下更"像在夜里有人陪"。
   因此暗色是**体验设计的锚点**（我们先在暗色下把 presence/ambient 调对，再推导浅色），
   但"设计锚点"与"默认值"是两件事——混同二者是本类产品最常见的设计错误。
4. **兜底值取浅色的技术理由**：`:root` 保留浅色字面值，使 CSS 在完全没有 JS 时仍是一套
   完整可读的浅色主题（不存在"半套变量"的中间态）；配合 §7.4 的**内联同步脚本**，
   真实运行中用户永远看不到这个兜底态。若把兜底设为暗色，则 §7.2 的正典块
   必须变成"`:root` = 暗色 + `[data-theme="light"]` = 浅色"，与主 agent 要求的
   ":root / [data-theme='dark']" 结构相反，且会让机器校验脚本的默认分支难以表达。
5. **对 Electron 的额外要求**：两个主题都必须设置 `color-scheme`
   （浅色 `color-scheme: light`、暗色 `color-scheme: dark`，已写入 §7.2）。
   否则系统滚动条、原生表单控件、右键菜单与自绘内容会主题错配——
   这在桌面端比在浏览器里更刺眼。

### 实施提醒

- 切换主题时**不得**对 `background-color` 施加过渡动画（会产生整屏"渐变晃动"）；
  正确做法是在 `data-theme` 变更前后用一帧禁用过渡（或直接允许瞬时切换，人眼能接受）。
- 明暗两套的 `--ap-*` 覆盖必须**逐项对齐**（§7.2 已保证）；缺失项会静默继承浅色值，
  表现为暗色主题上的亮块——这是该架构唯一的失败模式，故 §9 验收清单第 12 条专门检查它。

---

## 9. 验收清单

> 以下逐条为本交付物自认为已满足的标准，供主 agent 复核。
> 每条都给出**可执行的判定方式**（而非"已完成"这类自述）。

### A. 内容完备性

| # | 标准 | 判定方式 | 自评 |
|---|---|---|---|
| 1 | 含设计原则且 ≤5 条，围绕"陪伴感 + 克制 + 本地工具信任感" | §1 共 5 条（P1~P5），每条含"→ 约束"落点 | ✅ |
| 2 | 含原始色板（palette）+ 语义 tokens（surface/text/border/accent/success/warning/danger/info） | §2.1 11 个色相阶梯；§2.2/§2.3 全量语义表 | ✅ |
| 3 | 明暗双主题全套值 | §2.2/§2.3 每行两列；§7.2 两个代码块 | ✅ |
| 4 | 标注对比度目标（WCAG AA） | §0.4 四类契约阈值 + 附录 A 逐项实测值 | ✅ |
| 5 | 含 presence 五态（idle/thinking/streaming/acting/awaiting-user）的命名与取值 | §3.1 表（含指示器 + 文字各 5 组，明暗共 20 个值） | ✅ |
| 6 | 含环境氛围（ambient）tokens | §3.2（9 个核心 + 时间氛围 4 段具体值） | ✅ |
| 7 | 含情绪点缀色 + 设计依据 | §3.3（4 个语气 + 5 条硬约束 + 依据段） | ✅ |
| 8 | presence/ambient/emotion 三者均给出设计依据（差异化重点） | §3.1「设计依据」5 条、§3.2「设计依据」4 条、§3.3「设计依据」+ 约束 | ✅ |
| 9 | 字体系统含中西文栈、等宽栈、字号阶梯、行高、字重 | §4.1/§4.2/§4.3 | ✅ |
| 10 | 含间距 / 圆角 / 阴影 / 边框 / z-index 阶梯 | §5.1~§5.5（z-index 11 档，含"禁止 999"硬规则） | ✅ |
| 11 | 含 duration 阶梯、cubic-bezier 具体值、各状态过渡约定、reduced-motion 降级 | §6.1（11 档）/§6.2（6 条曲线）/§6.3（19 行约定表）/§6.4（11 行降级表 + 代码） | ✅ |
| 12 | 每个 token 给出 CSS variable 命名与 Tailwind theme 键对应表 | §7.1 四张表（颜色 / 字体字号 / 间距圆角阴影动效层级） | ✅ |
| 13 | 附可直接使用的 `:root` / `[data-theme="dark"]` 完整 CSS 代码块 | §7.2（含 L1+L2+L3 全量、动效降级、关键帧） | ✅ |
| 14 | 给出"暗色默认 vs 跟随系统"的建议与理由 | §8（结论 + 5 行决策表 + 5 条理由 + 2 条实施提醒） | ✅ |
| 15 | 文末含验收清单 | 本节 | ✅ |

### B. 质量硬约束

| # | 标准 | 判定方式 | 自评 |
|---|---|---|---|
| 16 | **无"待定"取值** | 全文对 `--ap-*` 的定义均为具体 hex / px / ms / cubic-bezier；可选增强项也已给出具体值并标注为可选 | ✅ |
| 17 | **命名一致、可机器解析** | §0.2 给出正则与保留词表；无同名冲突（`--ap-text-*` 只用于颜色，字号用 `--ap-fs-*`） | ✅ |
| 18 | **组件只用 L2/L3** | §0.1 三层模型 + 硬约束；L1 标注"组件禁止直接引用" | ✅ |
| 19 | **对比度已实测且全部达标** | 附录 A：109 项检查，0 项未达标 | ✅ |
| 20 | **对比度按最差表面判定**（非只测主背景） | §0.4 + 附录 A A/B/C/D 四组的"全表面最差"列 | ✅ |
| 21 | **CSS 变量引用完整性**（无未定义引用） | 附录 A 组 H：从 §7.2 代码块提取 100% 变量名比对 | ✅ |

### C. Scope 守门

| # | 标准 | 判定方式 | 自评 |
|---|---|---|---|
| 22 | 不为二期功能预留 UI token | §0.3 守门表逐类"+ ❌ 不收录"；全文无渠道/群聊/cron/插件市场相关命名 | ✅ |
| 23 | presence / 任务状态 tokens 属于一期范围且已收录 | §3.1 映射到 t7 AT-201 / AT-301~304 / AT-506 | ✅ |
| 24 | 不写业务代码 | 全文无组件实现；代码块仅为 token 定义、Tailwind 桥接、主题切换与关键帧 | ✅ |
| 25 | 明确不引入二期要素的**理由**也已写明 | §2.3「刻意缺档」、§0.3 引 t2/t3 依据 | ✅ |

### D. 与上游文档的一致性

| # | 标准 | 判定方式 | 自评 |
|---|---|---|---|
| 26 | 引用 t1/t2 作为输入并落字依据 | 文首输入清单；§1 P2、§3.1 依据 1、§3.3 依据、§4.1 衬线取舍均显式引用 t1 结论 | ✅ |
| 27 | 与 t2 的 MVP 边界一致（单人单机单 Agent / 桌面宽屏优先 / SQLite / 不引二期） | §0.3、§5.2（单侧栏 + 对话列 + 详情面板，无三栏工作台） | ✅ |
| 28 | 与 t7 可点击链路的承载关系可追溯 | §3.1 触发时机列引用 AT-201/301~304/506；§2.3 引用 AT-303/401 | ✅ |
| 29 | 与 t3 仓结构兼容（落地路径可指认） | §7.2 建议路径 `apps/desktop/src/styles/tokens.css`（t3 §1 的 `apps/desktop`） | ✅ |
| 30 | 不新增未拍板的决策（除已明确标注的建议项） | §8 明标为"建议"；§3.2 时间氛围明标为"可选增强、不进验收" | ✅ |

### E. 已知缺口（需主 agent 裁决或后续补做，不计入"已满足"）

| # | 缺口 | 影响 | 建议处置 |
|---|---|---|---|
| E1 | Tailwind v4 命名空间与 `@theme inline` 行为未与官方文档核对（本次会话无外网） | 仅影响 §7.3 的**工具类写法**，不影响 token 命名与取值 | 实施时以锁定版本复核；§7.1 已给"任意值语法"退路 |
| E2 | 对比度校验脚本 `scripts/check-tokens.mjs` 尚未落地 | 目前证据是本次会话的一次性实测（附录 A） | 进 t5/t6 落地，接入 t3 §3 的 `pnpm test` 门禁 |
| E3 | 浅色主题最低文字档 `text-muted` 余量仅 0.02（4.52:1） | 未来微调纸底色会立刻破线 | 校验脚本必须进 CI，禁止手改 §7.2 的 hex |
| E4 | 高对比度变体（WCAG AAA，如 openhanako 的 `midnight-contrast`）未纳入 | 不影响 AA 达标 | 二期再评估是否需要 `[data-contrast="high"]` |
| E5 | t2 与本次任务书对"Electron 是否在 MVP 内"表述不一致（见交付回报的分歧点） | 不影响 tokens 层（两种表述下都是桌面宽屏优先的 Web 渲染层） | 由主 agent 统一口径，tokens 层无需改动 |

---

## 附录 A：对比度实测记录（109 项，0 项未达标）

> 方法：WCAG 2.x 相对亮度公式（sRGB 线性化 → `0.2126R + 0.7152G + 0.0722B`），
> 对比度 `(L_lighter + 0.05) / (L_darker + 0.05)`。
> **判定口径**：文字类取 9 个背景表面的**最差值**（不是主背景值），
> 表面集合 = `surface-0, surface-1, surface-2, surface-sunken, surface-inset, surface-code,
> surface-bubble-user, surface-row-hover, surface-row-selected`。

### 组 A：浅色文字 × 9 表面（目标 ≥4.5:1）

| Token | 最差值 | 判定 |
|---|---|---|
| `--ap-text-primary` | 11.68 | ✅ |
| `--ap-text-secondary` | 7.57 | ✅ |
| `--ap-text-tertiary` | 5.43 | ✅ |
| `--ap-text-muted` | **4.52**（余量最小项） | ✅ |
| `--ap-accent-text` | 5.11 | ✅ |
| `--ap-success-text` | 5.60 | ✅ |
| `--ap-warning-text` | 5.59 | ✅ |
| `--ap-danger-text` | 6.59 | ✅ |
| `--ap-info-text` | 6.87 | ✅ |
| `--ap-presence-idle-text` | 4.61 | ✅ |
| `--ap-presence-thinking-text` | 4.81 | ✅ |
| `--ap-presence-streaming-text` | 5.11 | ✅ |
| `--ap-presence-acting-text` | 5.25 | ✅ |
| `--ap-presence-awaiting-text` | 5.06 | ✅ |
| `--ap-text-disabled` | 2.22（**AA 豁免**） | ➖ |

### 组 B：浅色非文本指示器 × 9 表面（目标 ≥3:1）

| Token | 最差值 | 判定 |
|---|---|---|
| `--ap-presence-idle` | 3.26 | ✅ |
| `--ap-presence-thinking` | 3.08 | ✅ |
| `--ap-presence-streaming` | 4.15 | ✅ |
| `--ap-presence-acting` | 3.56 | ✅ |
| `--ap-presence-awaiting` | 3.51 | ✅ |
| `--ap-emotion-warm` | **3.07**（余量最小项） | ✅ |
| `--ap-emotion-curious` | 3.81 | ✅ |
| `--ap-emotion-caution` | 3.52 | ✅ |
| `--ap-emotion-serious` | 4.80 | ✅ |
| `--ap-accent`（实心） | 4.15 | ✅ |
| `--ap-danger`（实心） | 6.59 | ✅ |
| `--ap-success`（实心） | 4.85 | ✅ |

### 组 C：深色文字 × 9 表面（目标 ≥4.5:1）

| Token | 最差值 | 判定 |
|---|---|---|
| `--ap-text-primary` | 9.83 | ✅ |
| `--ap-text-secondary` | 7.31 | ✅ |
| `--ap-text-tertiary` | 5.71 | ✅ |
| `--ap-text-muted` | 4.69 | ✅ |
| `--ap-accent-text` | 6.11 | ✅ |
| `--ap-success-text` | 5.81 | ✅ |
| `--ap-warning-text` | 5.89 | ✅ |
| `--ap-danger-text` | **5.09** | ✅ |
| `--ap-info-text` | 6.11 | ✅ |
| `--ap-presence-idle-text` | 5.71 | ✅ |
| `--ap-presence-thinking-text` | 5.47 | ✅ |
| `--ap-presence-streaming-text` | 6.11 | ✅ |
| `--ap-presence-acting-text` | 6.37 | ✅ |
| `--ap-presence-awaiting-text` | 6.79 | ✅ |
| `--ap-text-disabled` | 3.21（**AA 豁免**） | ➖ |

### 组 D：深色非文本指示器 × 9 表面（目标 ≥3:1）

| Token | 最差值 | 判定 |
|---|---|---|
| `--ap-presence-idle` | 4.06 | ✅ |
| `--ap-presence-thinking` | 5.47 | ✅ |
| `--ap-presence-streaming` | 4.04 | ✅ |
| `--ap-presence-acting` | 5.46 | ✅ |
| `--ap-presence-awaiting` | 6.79 | ✅ |
| `--ap-emotion-warm` | 6.19 | ✅ |
| `--ap-emotion-curious` | 5.67 | ✅ |
| `--ap-emotion-caution` | 6.35 | ✅ |
| `--ap-emotion-serious` | 5.57 | ✅ |
| `--ap-accent`（实心） | 4.04 | ✅ |
| `--ap-danger`（实心） | **3.59**（余量最小项） | ✅ |
| `--ap-success`（实心） | 5.22 | ✅ |

### 组 E：填充色 / 反白文字（目标 ≥4.5:1）

| 组合 | 实测 | 判定 |
|---|---|---|
| 浅色 `text-on-accent` `#FFFDF8` / `accent` `#45708A` | **5.25** | ✅ |
| 浅色 / `accent-hover` `#3F6179` | 6.46 | ✅ |
| 浅色 / `accent-active` `#2F4E60` | 8.68 | ✅ |
| 浅色 / `danger` `#8B2C1F` | 8.34 | ✅ |
| 浅色 / `danger-hover` `#6E2117` | 10.91 | ✅ |
| 浅色 / `success` `#3A6B45` | 6.13 | ✅ |
| 深色 `text-on-accent` `#101B22` / `accent` `#6FA0BC` | 6.18 | ✅ |
| 深色 / `accent-hover` `#9FC3D6` | 9.36 | ✅ |
| 深色 / `accent-active` `#D3E3EC` | 13.29 | ✅ |
| 深色 / `danger` `#D9736A` | 5.50 | ✅ |
| 深色 / `success` `#7FBE84` | 7.99 | ✅ |

### 组 F：语义 text-on-bg 与状态底色（目标 ≥4.5:1，22 项）

| 组合 | 实测 | 判定 |
|---|---|---|
| 明 `success-text`/`success-subtle` | 6.23 | ✅ |
| 暗 `success-text`/`success-subtle` | 8.11 | ✅ |
| 明 `warning-text`/`warning-subtle` | 6.36 | ✅ |
| 暗 `warning-text`/`warning-subtle` | 8.11 | ✅ |
| 明 `danger-text`/`danger-subtle` | 7.27 | ✅ |
| 暗 `danger-text`/`danger-subtle` | 7.44 | ✅ |
| 明 `info-text`/`info-subtle` | 7.64 | ✅ |
| 暗 `info-text`/`info-subtle` | 8.51 | ✅ |
| 明 `accent-text`/`accent-subtle` | 5.69 | ✅ |
| 暗 `accent-text`/`accent-subtle` | 6.86 | ✅ |
| 明 `text-primary`/`presence-thinking-subtle` | 13.20 | ✅ |
| 明 `presence-thinking-text`/`presence-thinking-subtle` | 5.44 | ✅ |
| 明 `text-primary`/`success-subtle` | 13.01 | ✅ |
| 暗 `text-primary`/`success-subtle` | 13.74 | ✅ |
| 明 `text-primary`/`warning-subtle` | 13.30 | ✅ |
| 暗 `text-primary`/`warning-subtle` | 13.54 | ✅ |
| 明 `text-primary`/`danger-subtle` | 12.88 | ✅ |
| 暗 `text-primary`/`danger-subtle` | 14.38 | ✅ |
| 明 `text-primary`/`row-selected` | 11.68 | ✅ |
| 暗 `text-primary`/`row-selected` | 9.83 | ✅ |
| 明 `text-tertiary`/`row-selected` | 5.43 | ✅ |
| 暗 `text-tertiary`/`row-selected` | 5.71 | ✅ |

### 组 G：结构描边与表面层差（24 项，下限见 §0.4）

| 组合 | 实测 | 下限 | 判定 |
|---|---|---|---|
| 明 `border-subtle`/`surface-1` | 1.21 | 1.2 | ✅ |
| 明 `border-default`/`surface-1` | 1.45 | 1.2 | ✅ |
| 明 `border-strong`/`surface-1` | 2.24 | 1.4 | ✅ |
| 明 `border-success`/`surface-1` | 1.55 | 1.3 | ✅ |
| 明 `border-danger`/`surface-1` | 1.76 | 1.1 | ✅ |
| 明 `border-warning`/`surface-1` | 1.52 | 1.15 | ✅ |
| 明 `border-info`/`surface-1` | 1.59 | 1.4 | ✅ |
| 暗 `border-subtle`/`surface-1` | 1.06 | 1.05 | ✅ |
| 暗 `border-default`/`surface-1` | 1.24 | 1.15 | ✅ |
| 暗 `border-strong`/`surface-1` | 2.05 | 1.4 | ✅ |
| 暗 `border-success`/`surface-1` | 1.54 | 1.18 | ✅ |
| 暗 `border-danger`/`surface-1` | 1.27 | 1.05 | ✅ |
| 暗 `border-warning`/`surface-1` | 1.58 | 1.15 | ✅ |
| 暗 `border-info`/`surface-1` | 1.44 | 1.25 | ✅ |
| 明 `surface-1` vs `surface-0` | 1.07 | 1.03 | ✅ |
| 明 `surface-2` vs `surface-1` | 1.05 | 1.02 | ✅ |
| 明 `surface-sunken` vs `surface-0` | 1.06 | 1.02 | ✅ |
| 明 `row-hover` vs `surface-sunken` | 1.07 | 1.03 | ✅ |
| 明 `row-selected` vs `surface-sunken` | 1.05 | 1.05 | ✅ |
| 暗 `surface-1` vs `surface-0` | 1.17 | 1.12 | ✅ |
| 暗 `surface-2` vs `surface-1` | 1.16 | 1.15 | ✅ |
| 暗 `surface-sunken` vs `surface-0` | 1.12 | 1.12 | ✅ |
| 暗 `row-hover` vs `surface-sunken` | 1.34 | 1.2 | ✅ |
| 暗 `row-selected` vs `surface-sunken` | 1.54 | 1.54 | ✅ |

### 组 H：CSS 变量引用完整性（已实测）

方法：从 §7.2 的 `tokens.css` 代码块（505 行）提取全部 `--ap-*` 定义名与 `var(--ap-*)` 引用名，
分别做集合比对；再与全文（含所有表格与内联码）出现的 token 名交叉比对。

| 检查项 | 实测结果 |
|---|---|
| 悬空引用（被 `var()` 引用但无定义） | **0 个** ✅ |
| 死色板档（L1 定义了但无任何 L2 引用） | **0 个** ✅ |
| 暗色块引入的浅色未定义 token（暗色专有 token） | **0 个** ✅ |
| 文档中出现的具体 token 名未在 CSS 块中定义 | **0 个** ✅ |
| §2~§6 表格首列 token 名未在 CSS 块中定义 | **0 个** ✅ |
| 通过 `-*` 简写出现的命名族（非具体 token） | 10 个：`--ap-*`、`--ap-ambient-*`、`--ap-duration-*`、`--ap-fs-*`、`--ap-lh-*`、`--ap-opacity-*`、`--ap-presence-*`、`--ap-size-*`、`--ap-text-*`、`--ap-z-*`（均为命名族说明，已在文中标注"（见下表）"等） |

> 校验脚本落地后（缺口 E2）应作为 CI 门禁：任一项 >0 即红。

### 组 I：token 数量统计（已实测）

| 类别 | 数量 | 判定规则 |
|---|---|---|
| L1 原始色板 token | **57** | `^--ap-{hue}-{step}$`，hue ∈ 11 个保留色相名 |
| L2 语义 token | **81** | 非 L1/L3；前缀 ∈ `surface/text/border/accent/success/warning/danger/info/presence/ambient/emotion` |
| L3 结构 token | **124** | 前缀 ∈ `fs/lh/fw/tracking/space/size/breakpoint/radius/shadow/border-w/focus-ring/z/opacity/duration/ease/motion/font` |
| **定义总数（去重）** | **262** | 出现在 §7.2 代码块中的全部 `--ap-*` 定义 |
| 其中暗色块覆盖项 | **92** | `[data-theme='dark']` 内的定义数（0 个为暗色专有） |
| 主题无关项（仅定义在 `:root`） | **170** | 结构性 token 与 L1 色板，不应随主题变化 |

> **为何 262 个不算多**：L1（57）+ L3（124）合计 181 个是"结构资产"，
> 与具体功能无关；真正表达产品语义的 L2 只有 **81** 个，构成如下（实测）：
>
> | L2 子类 | 数量 | 说明 |
> |---|---|---|
> | `surface-*` | 10 | 表面层级，主题切换的主体 |
> | `text-*` | 7 | 文字五档 + inverse + on-accent |
> | `border-*`（不含 `border-w-*`） | 8 | 结构描边 + 4 个语义描边 |
> | `accent-*` | 6 | 实心三档 + 文字 + 浅底 + 反白 |
> | `success-* / warning-* / danger-* / info-*` | 16 | 语义状态（warning/info 刻意无实心档） |
> | **`presence-*`** | **15** | **本项目差异化核心（五态 × 指示器/文字 + subtle + 4 个环形尺寸）** |
> | **`ambient-*`** | **11** | **环境氛围（房间/暗角/纸纹/三态光晕 + 尺寸 + 时间氛围 2）** |
> | **`emotion-*`** | **4** | **情绪点缀（4 个语气）** |
>
> 即 **30 个（37%）专属 token 服务于"陪伴感"**，其余 51 个是通用语义底座。
> 这个比例说明差异化投入确实落在 token 层，而不是停留在口号。

---

## 附录 B：与参考项目的取舍记录

> 对应 t1 §5「只抄思想，不抄实现」的落地说明。

| 议题 | openhanako 做法 | 本项目取舍 | 理由 |
|---|---|---|---|
| Token 前缀 | `--hana-*` + `--space-*` / `--radius-*` 等无前缀混用 | 统一 `--ap-` 前缀，三层模型 | 无前缀在 monorepo 多包场景下易与其他库冲突；三层模型让 L1 误用可被静态检查 |
| 主题机制 | `data-theme` + 多主题 CSS 文件 + localStorage `'auto'` + `matchMedia` | 同机制，但只保留 light/dark 两套 | 多主题（10+ 套）适合"可换皮"的消费级产品；私人助理需要的是**稳定识别度**，多主题会稀释 presence 语义 |
| 数值对 | `--space-{px}` 直接以 px 命名 | 沿用同一约定（`--space-16: 16px`） | 该约定可读性与机器解析性都好，无理由改 |
| 时长档位 | 3 档（0.1 / 0.15 / 0.25s） | 6 档常规 + 5 档 presence 语义时长 | 3 档不足以表达"呼吸 2400ms"与"流式片段 90ms"；但常规档仍保持精简 |
| 缓动 | 4 条（out/in/standard/smooth） | 6 条，新增 `breathe`（正弦近似）与 `settle`（一次性过冲） | presence 呼吸必须有专属曲线，否则会与 UI 过渡曲线混用而失去"生理感" |
| 圆角立场 | "controls are seals, 方"（2~3px） | 保留精确感但整体上调一档（控件 6px） | 陪伴感需要一点柔度；但拒绝 24px+ 的"圆滚滚" |
| 正文衬线体 | 默认开启（书桌/纸感） | 仅 ≥20px 展示文案启用 | Windows 中文衬线回退为宋体，小字号屏显质量差（本项目主平台含 Windows） |
| 情绪/mood 色 | `--mood-*` 单一暖玫瑰 + 角色卡/立绘/群聊表达人格 | 4 个命名语气 + 5 条硬约束，禁止大面积使用 | 人格表达"在语气里不在画面里"（克制要求）；且禁止情绪色承担安全信息 |
| 呼吸/脉冲动画 | `hana-pulse`（`--pulse-lo/hi` 可调） | `--ap-presence-*` 按状态区分周期与波形（呼吸 vs 节拍） | 单一 pulse 无法表达"在想"与"在做"的区别，而这是本项目的通道区分核心 |
| 高对比度主题 | 有 `midnight-contrast`（AAA） | 一期不做，记为缺口 E4 | MVP 只承诺 AA；先保证 AA 全项达标，避免摊薄质量 |
| reduced-motion | 逐组件 `@media` 覆盖（10 处散落） | tokens 层集中覆写时长 + 统一 `animation: none` 类 + 提供 `[data-motion]` 手动开关 | 散落覆盖容易漏；集中覆写可被"是否有遗漏"的检查覆盖 |

---

**文档结束。**

