/**
 * builtin/memory：记忆工具 `memory_write` / `memory_search`（t5 §4.2 拆成两个名字）。
 *
 * 口径（用户拍板 + t4 §5）：**记忆 = 偏好 + 事实**（`MEMORY_KINDS`），FTS5 检索，
 * 向量检索放二期。
 *
 * 存储接线：经 `ToolServices.memoryDb`（`@agentplant/state` 的 `StateDao`）读写。
 * 骨架期 `routes.ts` 还没有主循环，**不会**注入 DAO，因此这里未注入时**诚实报错**
 * （`ToolInputError`，明说"记忆存储未接线"）——绝不假装写入成功（t7 §1.2 禁假绿）。
 * t15 主循环接上 DB（`openDatabase` + `migrate` + `createStateDao`）后本文件一行不用改。
 *
 * `sessionId` 归属：参数给了用参数的，否则用 `ToolContext.sessionId`（会话级记忆），
 * 两者都没有才落到全局作用域（DAO 的默认语义）。
 */
import { ToolInputError } from "@agentplant/agent-core";
import { TOOL_PARAM_SCHEMAS, type MemoryKind } from "@agentplant/protocol";
import type { MemoryRecord, StateDao } from "@agentplant/state";
import { materializeParams } from "../params.js";
import type { Tool, ToolServices } from "../types.js";

export interface MemoryWriteDetails {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly scope: string;
  readonly contentBytes: number;
  readonly createdAt: number;
}

export interface MemoryItem {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly createdAt: number;
  readonly scope: string;
  readonly source: "memory";
}

export interface MemorySearchDetails {
  readonly query: string;
  readonly limit: number;
  readonly items: readonly MemoryItem[];
}

/** 取 DAO 或抛"未接线"错（诚实报错，不静默降级）。 */
export function requireMemoryDb(services: ToolServices, tool: string): StateDao {
  if (services.memoryDb === undefined) {
    throw new ToolInputError(
      `${tool}：记忆存储未接线（ToolServices.memoryDb 未注入）。` +
        "本工具需要由调用方经 @agentplant/state 打开数据库后注入 DAO（t15 主循环接线）",
      { tool },
    );
  }
  return services.memoryDb;
}

/** 记忆行 → 工具结果项（`text` 而不是 `content`：模型侧用词更贴它看到的东西）。 */
export function toMemoryItem(record: MemoryRecord): MemoryItem {
  return {
    id: record.id,
    kind: record.kind,
    text: record.content,
    createdAt: record.createdAt,
    scope: record.scope,
    source: "memory",
  };
}

export function createMemoryWriteTool(services: ToolServices): Tool<unknown, MemoryWriteDetails> {
  return {
    name: "memory_write",
    label: "写入记忆",
    description:
      "把一条**长期有效**的偏好或事实写进记忆（偏好 = 用户喜好/约定；事实 = 关于用户或环境的" +
      "稳定信息）。何时用：用户明确说了「以后都这样」或透露了跨会话仍然成立的信息。" +
      "何时不用：一次性的任务上下文不要写记忆（那是会话消息的事）。",
    parameters: TOOL_PARAM_SCHEMAS.memory_write,
    sideEffect: { kind: "fs_write", capability: "memory.write" },
    risk: "safe",
    execute: async (ctx, rawParams) => {
      const params = materializeParams("memory_write", rawParams);
      const dao = requireMemoryDb(services, "memory_write");
      // `sessionId` 是**调用方给的引用**，故先判存在性（空/纯空白 = 未给 → 全局作用域）：
      // `memories.session_id` 有 FK，未知 id 直接写会撞 `FOREIGN KEY` 被兜底成 500，
      // 但那是调用方的错 —— 与 `routes.ts` 的 `handleMemoryWrite` 同口径报 400。
      const raw = (params.sessionId ?? ctx.sessionId).trim();
      if (raw.length > 0 && dao.getSession(raw) === null) {
        throw new ToolInputError(
          `memory_write：会话不存在（sessionId=${raw}）。` +
            "会话级记忆要求会话行已在库中；要写全局记忆请省略 sessionId",
          { tool: "memory_write" },
        );
      }
      const record = dao.writeMemory({
        kind: params.kind,
        content: params.text,
        ...(raw.length === 0 ? {} : { sessionId: raw }),
      });
      return {
        content:
          `已记住（${record.kind}）：${record.content}\n` +
          `id=${record.id} scope=${record.scope}`,
        details: {
          id: record.id,
          kind: record.kind as MemoryKind,
          scope: record.scope,
          contentBytes: Buffer.byteLength(record.content, "utf8"),
          createdAt: record.createdAt,
        },
      };
    },
  };
}

export function createMemorySearchTool(services: ToolServices): Tool<unknown, MemorySearchDetails> {
  return {
    name: "memory_search",
    label: "检索记忆",
    description:
      "检索长期记忆（FTS5 全文，中文按字符切分检索）。何时用：需要知道用户的偏好、或此前" +
      "记下的事实。何时不用：查会话历史不要走这里（那是会话消息）。",
    parameters: TOOL_PARAM_SCHEMAS.memory_search,
    risk: "safe",
    execute: async (_ctx, rawParams) => {
      const params = materializeParams("memory_search", rawParams);
      const dao = requireMemoryDb(services, "memory_search");
      const records = dao.searchMemories(params.query, { limit: params.limit });
      const items = records.map((record) => toMemoryItem(record));
      return {
        content:
          items.length === 0
            ? `没有匹配「${params.query}」的记忆`
            : items
                .map((item) => `- [${item.kind}] ${item.text}（${item.id}）`)
                .join("\n"),
        details: { query: params.query, limit: params.limit, items },
      };
    },
  };
}
