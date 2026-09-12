/**
 * tools/params：参数物化 + 校验（工具执行的第一道门）。
 *
 * 两件事在这里一次性做掉，避免 7 个工具各写一套不一致的入参检查：
 * 1. **校验**：`@agentplant/protocol` 的 `validate(TOOL_PARAM_SCHEMAS[name], params)`。
 *    失败 → `ToolInputError`（t4 §5：参数不合法 = 400 口径），不把非法结构用下去。
 * 2. **默认值物化**：TypeBox 的 `default` 只是 JSON Schema 注解，`Value.Check` **不会**
 *    改写数据（`protocol/src/tools.ts` 文件头已点名）。因此默认值一律在这里用
 *    `XXX_DEFAULT` 常量显式落定，模型/前端看到的"省略即默认"由本层负责。
 *
 * 为什么不用 `Value.Default`：那会给 server 引入 `@sinclair/typebox` 的**运行时**依赖；
 * 本仓口径是 server 只经 protocol 的冻结契约（`TOOL_PARAM_SCHEMAS` + `validate`）使用 schema。
 */
import {
  BROWSE_PAGE_DEFAULT_MAX_BYTES,
  MEMORY_SEARCH_DEFAULT_LIMIT,
  RUN_COMMAND_DEFAULT_MAX_OUTPUT_BYTES,
  RUN_COMMAND_DEFAULT_TIMEOUT_MS,
  TOOL_PARAM_SCHEMAS,
  WEB_SEARCH_DEFAULT_COUNT,
  validate,
  type ToolName,
} from "@agentplant/protocol";
import { ToolInputError } from "@agentplant/agent-core";

/** 工具名 → 已校验且已物化默认值的参数（键名与 protocol schema 完全一致）。 */
export interface MaterializedParams {
  readonly read_file: {
    readonly path: string;
    readonly offset: number;
    readonly limit: number;
  };
  readonly write_file: {
    readonly path: string;
    readonly content: string;
    readonly mode: "create" | "overwrite" | "append";
  };
  readonly run_command: {
    readonly cmd: string;
    readonly cwd?: string;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
  };
  readonly web_search: {
    readonly query: string;
    readonly count: number;
    readonly site?: string;
  };
  readonly browse_page: {
    readonly url: string;
    readonly timeoutMs: number;
    readonly maxBytes: number;
  };
  readonly memory_write: {
    readonly kind: "preference" | "fact";
    readonly text: string;
    readonly sessionId?: string;
  };
  readonly memory_search: {
    readonly query: string;
    readonly limit: number;
  };
}

/** 读文件的默认窗口：不传 limit 时最多返回的行数（截断口径见 read_file）。 */
export const READ_FILE_DEFAULT_LIMIT = 2000;
/** 浏览页面默认超时（t4 §5 未给默认值；与命令超时同为 10s，口径统一）。 */
export const BROWSE_PAGE_DEFAULT_TIMEOUT_MS = 10_000;
/** 搜索请求默认超时（同上）。 */
export const WEB_SEARCH_DEFAULT_TIMEOUT_MS = 10_000;

/** 校验失败时抛的错：措辞里带上工具名与首个问题，便于模型自行修正调用。 */
function paramsError(tool: ToolName, detail: string): ToolInputError {
  return new ToolInputError(`${tool} 参数不合法：${detail}`, { tool });
}

/** 通用形状检查：对象、非数组、非 null。 */
function expectRecord(tool: ToolName, params: unknown): Record<string, unknown> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw paramsError(tool, "参数必须是对象");
  }
  return params as Record<string, unknown>;
}

/** 校验 + 物化默认值；失败一律 `ToolInputError`（400 口径）。 */
export function materializeParams<Name extends ToolName>(
  tool: Name,
  params: unknown,
): MaterializedParams[Name] {
  const record = expectRecord(tool, params);
  const result = validate(TOOL_PARAM_SCHEMAS[tool], record);
  if (!result.ok) {
    const first = result.errors[0];
    throw new ToolInputError(
      `${tool} 参数不合法：${first === undefined ? "未知问题" : `${first.path} ${first.message}`}`,
      { tool, issues: result.errors.slice(0, 8) },
    );
  }
  const checked = result.value as Record<string, unknown>;
  const materialized = materializeChecked(tool, checked);
  return materialized as unknown as MaterializedParams[Name];
}

/**
 * 物化默认值（已通过 schema 校验的分支）。
 *
 * 与 `materializeParams` 拆开是为了让 `switch` 的穷举检查独立成立：
 * 泛型收窄与穷举检查混在一个函数里时，`never` 分支会被泛型掩盖。
 */
function materializeChecked(
  tool: ToolName,
  checked: Record<string, unknown>,
): MaterializedParams[ToolName] {
  switch (tool) {
    case "read_file":
      return {
        path: String(checked.path),
        offset: numberOr(checked.offset, 0),
        limit: numberOr(checked.limit, READ_FILE_DEFAULT_LIMIT),
      };
    case "write_file":
      return {
        path: String(checked.path),
        content: String(checked.content),
        mode: checked.mode as "create" | "overwrite" | "append",
      };
    case "run_command":
      return {
        cmd: String(checked.cmd),
        timeoutMs: numberOr(checked.timeoutMs, RUN_COMMAND_DEFAULT_TIMEOUT_MS),
        maxOutputBytes: numberOr(checked.maxOutputBytes, RUN_COMMAND_DEFAULT_MAX_OUTPUT_BYTES),
        ...(checked.cwd === undefined ? {} : { cwd: String(checked.cwd) }),
      };
    case "web_search":
      return {
        query: String(checked.query),
        count: numberOr(checked.count, WEB_SEARCH_DEFAULT_COUNT),
        ...(checked.site === undefined ? {} : { site: String(checked.site) }),
      };
    case "browse_page":
      return {
        url: String(checked.url),
        timeoutMs: numberOr(checked.timeoutMs, BROWSE_PAGE_DEFAULT_TIMEOUT_MS),
        maxBytes: numberOr(checked.maxBytes, BROWSE_PAGE_DEFAULT_MAX_BYTES),
      };
    case "memory_write":
      return {
        kind: checked.kind as "preference" | "fact",
        text: String(checked.text),
        ...(checked.sessionId === undefined ? {} : { sessionId: String(checked.sessionId) }),
      };
    case "memory_search":
      return {
        query: String(checked.query),
        limit: numberOr(checked.limit, MEMORY_SEARCH_DEFAULT_LIMIT),
      };
    default: {
      const exhaustive: never = tool;
      throw new ToolInputError(`未实现的工具：${String(exhaustive)}`);
    }
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * 参数**键名**清单（审计只记键名不记值，t4 §4 不变量）。
 *
 * 用物化后的参数对象：模型省略字段时账本要反映"运行时实际用了哪些键"，
 * 与 `buildAuditMeta` 的 `argKeys` 口径一致。
 */
export function paramKeys(params: object): string[] {
  return Object.keys(params).sort();
}
