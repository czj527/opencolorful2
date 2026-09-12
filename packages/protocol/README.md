# packages/protocol

**前后端共享契约的唯一来源**：TypeBox schema + 由 schema 推导的 TS 类型 + 运行期校验辅助。
运行期依赖只有 `@sinclair/typebox`，**不含任何状态**（不碰 SQLite / 网络 / 文件系统）。

## 职责边界

- 只回答"线上长什么样"：SSE 事件、HTTP 端点请求/响应、工具参数、状态字面量取值集合。
- 不回答"怎么实现"：路由、主循环、工具执行、持久化都在 `apps/server` / `packages/state`。
- `apps/web`（以及未来的 Electron 渲染层）只依赖本包来对齐后端面。

## 契约来源（M1 决策文档）

| 文件 | 内容 | 依据 |
|---|---|---|
| `src/sse.ts` | 8 种 SSE 事件 + `data: [DONE]` + 响应头 + `encodeSseEvent` | t4 §2；`delivery`/`evidence` 见 t5 §4.2/§5 |
| `src/api.ts` | `/api/*` 请求/响应 + 统一错误形 `ApiError` | t4 §3（端点表）、t4 §4（messages 列） |
| `src/tools.ts` | 7 个工具参数 schema + 状态字面量 + 默认值常量 | t4 §5、t4 §6；命名为 t5 §4.2 口径 |
| `src/closed-object.ts` | `additionalProperties: false` 语义 | 抄 openclaw `gateway-protocol`（t4 §1） |
| `src/index.ts` | 重导出 + `validate<T>()` 运行期校验 | — |

补充口径（实现期对齐，见 t3 §8 同仓结构落定）：

- **工具命名以 t5 §4.2 为准**：`read_file / write_file / run_command / web_search /
  browse_page / memory_write / memory_search`。t4 §5 表里的 `fs_read / fs_write /
  shell_exec / web_fetch / memory` 旧名为作废名，本包不导出。
- **默认值语义**：TypeBox 的 `default` 只是 JSON Schema 注解，`Value.Check` **不会**改写数据。
  因此默认值以 `RUN_COMMAND_DEFAULT_TIMEOUT_MS` 等常量显式导出，由运行时在调用工具前物化
  （`Value.Default` 可依据同一注解补默认）；schema 里同时保留注解以便 provider 侧看到默认语义。
- **`done.delivery` 是必填**：t5 §5 要求前端只消费后端显式给出的交付判定，缺失时渲染
  「未提供交付状态」。把"缺失"挡在协议层，后端就不可能出现漏填（t4 §4 不变量四：进度文本 ≠ 交付）。
- **`DELETE /api/memory` 的"id 与 query 至少其一"**由路由在运行时判，不写进 schema：
  JSON Schema 的 `anyOf` 会让 provider 侧工具 schema 兼容性变差（openclaw 亦踩过）。

## 使用

```ts
import { SseDoneDataSchema, validate, type SseDoneData } from "@agentplant/protocol";

const result = validate(SseDoneDataSchema, payload);
if (!result.ok) {
  // result.errors: { path, message }[] —— 失败分支不含原始数据，避免"校验失败仍继续用"
  throw new Error(JSON.stringify(result.errors));
}
const done: SseDoneData = result.value; // 已收窄
```

## 构建与测试

```bash
pnpm --filter @agentplant/protocol run build      # 先 clean，再 tsc → dist（不含 *.test.ts）
pnpm --filter @agentplant/protocol run typecheck  # 源码 + 测试双 tsconfig 全量类型检查
pnpm test                                         # vitest 拾取 src/**/*.test.ts
```

- `tsconfig.json` 只编译源码（`exclude: src/**/*.test.ts`），产物里没有测试文件。
- `tsconfig.test.json` 单独对测试做 `--noEmit` 类型检查，测试文件 import 源码
  （`./sse.js` 这类相对路径），因此**不依赖 dist 是否已构建**。
- `build` 前先 `clean`：`composite: true` 的增量编译会依赖 `tsconfig.tsbuildinfo`，
  一旦有人在保留该文件的情况下手删 `dist/`，tsc 会认为产物未变而**跳过重新生成**
  （dist 里只剩 `.js`、没有 `.d.ts`，包对外不可用）。先清干净即消除这个假绿面。
