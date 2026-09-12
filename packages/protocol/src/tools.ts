/**
 * protocol/tools：工具参数 schema + 治理状态字面量。
 *
 * 工具命名以 `docs/decisions/t5-frontend-visual-design.md` §4.2 为准（7 个）：
 * `read_file / write_file / run_command / web_search / browse_page / memory_write /
 * memory_search`；t4 §5 表里的 `fs_read / fs_write / shell_exec / web_fetch / memory`
 * 旧名**作废**（实现期统一差异 c），本包不再导出旧名。
 *
 * 参数形状对齐 t4 §5 表 + t4 §6（命令默认 10s 超时 / 50KiB 输出截断）；
 * 状态字面量对齐 t5 §4.3（tool 6 态）与 t5 §6.2（task 7 态）。
 *
 * 默认值口径：TypeBox 的 `default` 只是 JSON Schema 注解，`Value.Check` **不会**改写数据。
 * 因此默认值以 `XXX_DEFAULT` 常量显式导出，由运行时在调用工具前物化；
 * schema 里同时标注 `default` 以便 provider 侧看到默认语义。
 */
import { Type, type Static, type TObject } from "@sinclair/typebox";
import { closedObject } from "./closed-object.js";

/** 工具名清单（运行时注册表据此校验，禁止注册清单外的名字）。 */
export const TOOL_NAMES = [
  "read_file",
  "write_file",
  "run_command",
  "web_search",
  "browse_page",
  "memory_write",
  "memory_search",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/** 工具调用状态（t5 §4.3，6 态；UI 直接投影，不得自造取值）。 */
export const TOOL_STATUSES = [
  "pending",
  "running",
  "success",
  "error",
  "denied",
  "cancelled",
] as const;

export type ToolStatus = (typeof TOOL_STATUSES)[number];

/** 任务状态（t5 §6.2，7 态；`needs_input` 是"等用户"而非失败）。 */
export const TASK_STATUSES = [
  "pending",
  "running",
  "blocked",
  "needs_input",
  "completed",
  "failed",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/** 记忆种类（用户拍板：记忆 = 偏好 + 事实，t4 §0）。 */
export const MEMORY_KINDS = ["preference", "fact"] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** 文件写入模式（t4 §5 `fs_write`；`create` 遇已存在必须失败而非覆盖）。 */
export const WRITE_MODES = ["create", "overwrite", "append"] as const;

export type WriteMode = (typeof WRITE_MODES)[number];

export const RUN_COMMAND_DEFAULT_TIMEOUT_MS = 10_000;
export const RUN_COMMAND_DEFAULT_MAX_OUTPUT_BYTES = 51_200;
export const WEB_SEARCH_DEFAULT_COUNT = 5;
export const BROWSE_PAGE_DEFAULT_MAX_BYTES = 51_200;
export const MEMORY_SEARCH_DEFAULT_LIMIT = 10;

export const ReadFileParamsSchema = closedObject({
  path: Type.String({ minLength: 1 }),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
});

export const WriteFileParamsSchema = closedObject({
  path: Type.String({ minLength: 1 }),
  content: Type.String(),
  mode: Type.Union(WRITE_MODES.map((mode) => Type.Literal(mode))),
});

export const RunCommandParamsSchema = closedObject({
  cmd: Type.String({ minLength: 1 }),
  cwd: Type.Optional(Type.String({ minLength: 1 })),
  timeoutMs: Type.Optional(
    Type.Integer({ minimum: 1, default: RUN_COMMAND_DEFAULT_TIMEOUT_MS }),
  ),
  maxOutputBytes: Type.Optional(
    Type.Integer({ minimum: 1, default: RUN_COMMAND_DEFAULT_MAX_OUTPUT_BYTES }),
  ),
});

export const WebSearchParamsSchema = closedObject({
  query: Type.String({ minLength: 1 }),
  count: Type.Optional(Type.Integer({ minimum: 1, default: WEB_SEARCH_DEFAULT_COUNT })),
  site: Type.Optional(Type.String({ minLength: 1 })),
});

export const BrowsePageParamsSchema = closedObject({
  url: Type.String({ minLength: 1 }),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  maxBytes: Type.Optional(
    Type.Integer({ minimum: 1, default: BROWSE_PAGE_DEFAULT_MAX_BYTES }),
  ),
});

export const MemoryWriteParamsSchema = closedObject({
  kind: Type.Union(MEMORY_KINDS.map((kind) => Type.Literal(kind))),
  text: Type.String({ minLength: 1 }),
  sessionId: Type.Optional(Type.String({ minLength: 1 })),
});

export const MemorySearchParamsSchema = closedObject({
  query: Type.String({ minLength: 1 }),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, default: MEMORY_SEARCH_DEFAULT_LIMIT }),
  ),
});

export type ReadFileParams = Static<typeof ReadFileParamsSchema>;
export type WriteFileParams = Static<typeof WriteFileParamsSchema>;
export type RunCommandParams = Static<typeof RunCommandParamsSchema>;
export type WebSearchParams = Static<typeof WebSearchParamsSchema>;
export type BrowsePageParams = Static<typeof BrowsePageParamsSchema>;
export type MemoryWriteParams = Static<typeof MemoryWriteParamsSchema>;
export type MemorySearchParams = Static<typeof MemorySearchParamsSchema>;

/**
 * 工具名 → 参数 schema 注册表。
 *
 * `satisfies` 而非类型标注：既强制"7 个工具一个不少"（漏写即编译失败），
 * 又保留每条分支的具体 schema 类型，参数类型因此可从本表反推（见下方 ToolParams）。
 */
export const TOOL_PARAM_SCHEMAS = {
  read_file: ReadFileParamsSchema,
  write_file: WriteFileParamsSchema,
  run_command: RunCommandParamsSchema,
  web_search: WebSearchParamsSchema,
  browse_page: BrowsePageParamsSchema,
  memory_write: MemoryWriteParamsSchema,
  memory_search: MemorySearchParamsSchema,
} satisfies Record<ToolName, TObject>;

/** 工具名 → 参数对象类型（运行时注册表与主循环共用）。 */
export type ToolParams<Name extends ToolName> = Static<(typeof TOOL_PARAM_SCHEMAS)[Name]>;
export type AnyToolParams = { [Name in ToolName]: ToolParams<Name> }[ToolName];
