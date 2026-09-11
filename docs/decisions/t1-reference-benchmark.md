# t1 参考项目蒸馏：openhanako / hermes-agent / openclaw 对标结论

> 为 t2（产品定位与 MVP 边界）提供决策输入。基于三份子 agent 实读源码报告综合。
> 关键术语澄清：**三者都没有「任务层棘轮」运行时机制**。"ratchet" 在 openhanako/openclaw
> 中仅指仓库工程侧 CI lint 基线（只减不增）；hermes 全仓无 ratchet 一词，只有循环断路器。
> 不要把工程侧 ratchet 误标为任务治理机制。

## 1. 三句话定位

| 项目 | 一句话定位 | 目标用户 | 技术底座 |
|---|---|---|---|
| openhanako (HanaAgent) | 有记忆有人格的**图形化桌面**多 Agent 私人助理 | 文员/知识工作者（非 coder） | Electron + Node Hono Server，TS |
| hermes-agent | **自我改进型**个人 Agent（记忆+技能沉淀+委派+cron+Kanban） | 个人开发者/自托管重度用户 | Python 内核（cli.py/run_agent.py 双上帝对象）+ Node 前端 |
| openclaw | 自托管**多渠道消息网关** + 个人助理（Gateway 是控制面） | 自托管极客/插件开发者 | pnpm TS monorepo，Gateway WS 控制面 |

共同点：单人自托管、跨会话记忆、技能/插件扩展、定时任务、多平台消息接入。
最大差异：hanako 重**桌面图形与办公协作**；hermes 重**学习闭环与持久编排**；
openclaw 重**网关控制面与插件生态**，且明确不做 manager-of-managers 默认层级。

## 2. 多 Agent 机制对比

| 维度 | openhanako | hermes-agent | openclaw |
|---|---|---|---|
| 主/子分工 | 父保留对话决策；子是后台任务（deny_on_prompt） | leaf（默认剥夺委派/记忆/消息）vs orchestrator（可再派生） | spawn 时刻能力最小化；leaf 失全部 session 工具；depth≥2 才出 orchestrator |
| 协作通道 | subagent 工具（非阻塞 taskId+steer 回注）/ workflow JS 编排 / 跨 session 直连 | 进程内 delegate_task（只回 summary+预算裁剪）/ 跨进程 Kanban（profile=worker 身份） | push-based announce + sessions_yield；**硬性禁止轮询**；跨 agent 消息默认关闭 |
| 任务分解 | workflow 脚本：LLM 写确定性 JS，vm 沙箱执行扇出 | kanban_decompose（LLM 输出子任务图 JSON）/ kanban_swarm 固定拓扑模板，不引入第二调度器 | sessions_spawn{collect,outputSchema,groupId}+agents_wait 首完成 race，刻意无图 DSL |
| 并发上限 | per-session 10 / global 20；workflow 256/1000 | max_concurrent_children=3；max_spawn_depth（默认扁平 1） | lane 并发 8；depth 1–5；maxChildrenPerAgent 5 |
| 断点恢复 | workflow journal（内容哈希+序号双键，resumeFromRunId） | reclaim_task 回收过期 claim（TTL 900s）；cron 会话 3 分钟硬中断 | orphan recovery + tombstone 限无限恢复；main-session 重启恢复 |

## 3. 治理方案对比

| 治理项 | openhanako | hermes-agent | openclaw |
|---|---|---|---|
| ratchet | 仅工程侧（import 边界 lint + style 基线） | 无；等价物是循环断路器（失败 2 连 auto-block 等） | 仅仓库级（max-lines/env-var-count/config 基线文件） |
| 任务状态机 | 分散多 store，无统一机（pending/running/blocked…+open/closed+pending/resolved…） | 统一 9 态 + 全 CAS 转换 + recompute_ready 依赖门 | Task 终态不可降级 + TaskFlow revision 乐观并发 + sticky cancel |
| 验收门禁 | 弱：structured_output 不做深度校验；互审只给意见不阻断 | 强：幻卡校验 / 产物实体校验（≤25MB 须存在）/ LLM-as-judge / review 列强制 skill | 部分：进度文本判 blocked + 完成回传要求父核验；实质靠父自评 |
| 失败处理 | 信号量 backstop + 30min 超时 + abort | crashed/stale/max-runtime 三探针 + respawn guard + 退避 | lost 感知 + maintenance/audit + model-fallback |
| 审计 | security-audit.jsonl 固定字段 + secret 掩码 | task_events + task_runs 完整审计流；observer 只读 hook | metadata-only 版本化账本（绝不存正文/参数） |
| 权限/沙箱 | **最强**：PathGuard 四级 ACL + 三 OS 原生沙箱 + 工具调用 capability 绑定 | 分层但启发式：approval 正则 + 6 终端后端；自认非安全边界 | tool-policy 流水线 + workspaceOnly + 沙箱默认关（靠 operator） |

## 4. 可借鉴治理清单（按优先级）

P0（MVP 治理内核）：
1. **任务终态不可降级**：completed/failed 一旦落定不允许回退（抄 openclaw 状态机语义）。
2. **SQLite 本地状态 + CAS 领取**：无 Redis/MQ 实现可靠认领（抄 hermes kanban_db 模式）。
3. **进度文本≠交付**：纯"我接下来要…"文本不得标记完成→blocked（抄 openclaw completion-contract）。
4. **子权限不超父 + 显式报错不静默降级**（抄 hanako subagent-tool-policy）。
5. **三层硬限额防失控**：生成深度 / 子任务数 / 并发 lane（抄 openclaw 8/5/depth）。

P1（验收与审计）：
6. **结构化交付校验**：outputSchema + 产物实体存在性检查（hermes ArtifactPreservation + openclaw outputSchema 合流；MVP 可先做存在性，后做 schema 深度校验）。
7. **metadata-only 审计账本**：只记事件元数据不记正文（抄 openclaw audit-event-types）。
8. **块因分类分流**：dependency vs needs_input/capability/transient 分开，前者自动提升（抄 hermes），消灭人工反复 unblock。
9. **push 完成 + 显式等待原语，禁止轮询**（抄 openclaw announce+yield；与 AgentTeams mailbox 语义天然契合）。

P2（体验与工程）：
10. **LLM-as-judge 完成门 + 探活 fail-open**（抄 hermes goals；注意是软门禁，不能当硬约束）。
11. **journal 断点恢复**：长跑扇出内容哈希续跑（抄 hanako journal；MVP 后期）。
12. **两阶段草稿卡审批**：跨 agent 写操作先落草稿人确认（抄 hanako draft-store；有人审环节时）。
13. **工程侧棘轮**：只减不增的 lint/规模基线文件化（抄 openclaw/hanako scripts；t3 落地）。
14. **窄腰纪律**：新能力优先 skill/插件/MCP，最后才加核心 tool（抄 hermes Footprint Ladder；t4/t6 落字）。

## 5. 不建议吸收

- openclaw announce best-effort 可靠性、"父 agent 自评验收"——AgentTeams 的 attempt_id/verdict 机制更严，不要降级。
- hermes 单 dispatcher 绑定 gateway 生命周期、approval 正则当安全边界——多租户即失效。
- hanako workflow vm 沙箱（自述非对抗级）、分散无统一状态机、无硬验收——只抄思想（journal/草稿卡），不抄实现。
- 三者的重型编排（Kanban/swarm/depth≥2）MVP 均不引入：t2 已定单 Agent 先行。

## 6. 给 t2 的定位输入

- TS 同仓方向 → 对标体是 **openclaw 的 monorepo 形态**（packages + extensions + 单一包管理），而非 hermes 的 Python 内核。
- 最小本地 → hermes/openclaw 一致结论：**SQLite 本地状态是充分且必要的持久化内核**，MVP 不需要外部 MQ/Redis。
- 私人助理体验差异化 → hanako 证明了图形桌面+办公场景是与 CLI agent 拉开差距的一侧（书桌/群聊/人格），t5 可重点参考；但 hanako 的弱验收正是我们要用 verdict 门禁补齐的缺口。
