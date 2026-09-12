/**
 * agent/confirm：`POST /api/chat/confirm` 的服务层（M1-9 ③）。
 *
 * 一次确认要做完的四件事，顺序固定：
 *
 * ```
 * 查 run（未知 → 404） → 查挂起调用（未知 → 404 / 已解决 → 400）
 *   → run 已 abort → 400 run_finished（不执行）
 *   → 从挂起集合**先**移出（并发/重复确认只有一个能拿到它）
 *   → allow：执行 → 落 tool 消息 → 写审计 → {confirmed:true, executed:true, ok, summary}
 *     deny ：不执行 → 落"用户拒绝了本次执行" → 写审计 → {confirmed:true, executed:false}
 * ```
 *
 * **M1 简化（如实标注，别当成设计目标）**：确认结果**不同流续推**。挂起时那条 SSE 已经
 * 发完 `done` 收流了，因此这里执行出来的 `tool_result` 只落到**消息表 + 审计**，
 * 前端要看到它得重新拉 `GET /api/sessions/:id/messages`（或发起下一次 chat）。
 * 二期把"续推"做进同一条流时，本文件的"落库 + 返回"两段会各自换一条出口，
 * 但**判定逻辑（谁能不能执行、重复确认怎么判）不变**。
 *
 * 另一半 M1 口径在 `agent/loop.ts` 文件头：挂起的调用在确认之前**永不执行**，路由层
 * 不做超时兜底（没有"等太久就替他放行"这种危险默认）。
 */
import { buildAuditMeta } from "@agentplant/agent-core";
import type { StateDao } from "@agentplant/state";
import {
  getPendingCall,
  getRun,
  isConfirmationResolved,
  resolvePendingCall,
} from "../sse.js";
import { paramKeys } from "../tools/params.js";
import type { ToolRegistry, ToolServices } from "../tools/index.js";
import type { ConfirmDecision } from "./confirmation.js";
import { executeToolCall } from "./loop.js";

/** 用户拒绝时落库的 tool 消息正文（前端据此渲染"已拒绝"行；措辞写死在这里，只有一处）。 */
export const DENIED_MESSAGE = "用户拒绝了本次执行";

export interface ConfirmInput {
  readonly runId: string;
  readonly toolCallId: string;
  readonly decision: ConfirmDecision;
  readonly dao: StateDao;
  readonly registry: ToolRegistry;
  readonly services: ToolServices;
}

/** 确认结果：成功带响应体，失败带 HTTP 状态与 ApiError 码（由路由层原样发出）。 */
export type ConfirmOutcome =
  | {
      readonly ok: true;
      readonly body: {
        readonly confirmed: true;
        readonly executed: boolean;
        readonly ok?: boolean;
        readonly summary?: string;
      };
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
    };

/** 下一条消息的 `seq`（`messages` 表按会话内 `seq` 升序，确认时接着写）。 */
function nextSeqOf(dao: StateDao, sessionId: string): number {
  const history = dao.listMessages(sessionId);
  return history.reduce((max, row) => (row.seq > max ? row.seq : max), 0) + 1;
}

/** 参数**键名**清单（审计只记键名不记值）。参数不是对象时如实留空，不猜。 */
function argKeysOf(args: unknown): string[] {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return [];
  }
  return paramKeys(args);
}

/**
 * 解决一次确认。
 *
 * `runId` 不存在 → 404 `run_not_found`；`toolCallId` 不在挂起集合里 →
 * 已解决过的给 400 `already_resolved`（重复点击是客户端问题，不是"没这条"），
 * 从没存在过的给 404 `tool_call_not_found`。
 */
export async function resolveConfirmation(input: ConfirmInput): Promise<ConfirmOutcome> {
  const record = getRun(input.runId);
  if (record === undefined) {
    return { ok: false, status: 404, code: "run_not_found", message: `未知 runId：${input.runId}` };
  }
  const pending = getPendingCall(input.runId, input.toolCallId);
  if (pending === undefined) {
    if (isConfirmationResolved(input.runId, input.toolCallId)) {
      return {
        ok: false,
        status: 400,
        code: "already_resolved",
        message: `该工具调用已经处理过，不能重复确认：${input.toolCallId}`,
      };
    }
    return {
      ok: false,
      status: 404,
      code: "tool_call_not_found",
      message: `未知 toolCallId（该 run 没有挂着这个调用）：${input.toolCallId}`,
    };
  }
  // 取消是终态：被 abort 的 run 不再执行任何工具（`run_command` 内部也会因同一个 signal
  // 直接抛错，但在这里就拒掉更诚实——不产生"执行了一半"的模糊结果）。
  if (record.aborted || record.controller.signal.aborted) {
    return {
      ok: false,
      status: 400,
      code: "run_finished",
      message: `本次 run 已被取消，挂起的工具调用不再执行：${input.runId}`,
    };
  }

  const sessionId = record.sessionId;
  const seq = nextSeqOf(input.dao, sessionId);
  // 先摘牌再执行：并发/重复确认时只有一个请求能摘到，另一个立刻是 already_resolved。
  resolvePendingCall(input.runId, input.toolCallId, input.decision);

  if (input.decision === "deny") {
    input.dao.appendMessage({
      sessionId,
      seq,
      role: "tool",
      content: DENIED_MESSAGE,
      toolName: pending.name,
      toolCallId: pending.callId,
    });
    input.dao.appendAudit({
      kind: "tool.call",
      sessionId,
      runId: input.runId,
      status: "denied",
      payloadMeta: buildAuditMeta({
        toolName: pending.name,
        argKeys: argKeysOf(pending.args),
        resultBytes: Buffer.byteLength(DENIED_MESSAGE, "utf8"),
        truncated: false,
      }),
    });
    return { ok: true, body: { confirmed: true, executed: false } };
  }

  const result = await executeToolCall({
    registry: input.registry,
    // 原样用模型给的参数串（`materializeParams` 才是唯一的参数门），callId 保持不变。
    call: { id: pending.callId, name: pending.name, args: pending.rawArgs },
    runId: input.runId,
    sessionId,
    // 原 run 的 signal：run 被取消后这里已经拒过，走到这儿说明它是活的。
    signal: record.controller.signal,
    services: input.services,
    redact: (text) => input.services.redactor.redact(text),
  });
  input.dao.appendMessage({
    sessionId,
    seq,
    role: "tool",
    content: result.fullContent,
    toolName: pending.name,
    toolCallId: pending.callId,
  });
  // 两条审计：一条记"用户允许了"（治理事实），一条记"工具跑成什么样"（结果事实）。
  // `resultBytes` 用落库的完整内容长度，`truncated: false`——消息表里存的是原文，没有截断。
  input.dao.appendAudit({
    kind: "tool.call",
    sessionId,
    runId: input.runId,
    status: "allowed",
    payloadMeta: buildAuditMeta({
      toolName: pending.name,
      argKeys: argKeysOf(pending.args),
      resultBytes: Buffer.byteLength(result.fullContent, "utf8"),
      truncated: false,
    }),
  });
  input.dao.appendAudit({
    kind: "tool.result",
    sessionId,
    runId: input.runId,
    status: result.ok ? "ok" : "failed",
    payloadMeta: buildAuditMeta({
      toolName: pending.name,
      argKeys: argKeysOf(pending.args),
      resultBytes: Buffer.byteLength(result.fullContent, "utf8"),
      truncated: false,
    }),
  });
  return {
    ok: true,
    body: {
      confirmed: true,
      executed: true,
      ok: result.ok,
      summary: result.summary,
    },
  };
}
