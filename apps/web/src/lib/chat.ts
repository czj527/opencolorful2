/**
 * 回合聚合与 SSE 应用（**纯逻辑**）：把后端事件序列变成"有序块序列"。
 *
 * 对应 IA §3.2（L2 块序列：`text` / `tool_call` / `error` / `plan-note`）与 §4.3（工具卡状态）。
 *
 * 硬约定：
 *   1. **块顺序 = 后端事件顺序**（不重排、不合并、不补帧）——这是"可审计"的视觉前提；
 *   2. `done.delivery` 由后端显式给出，前端只存不推断（delivery.ts 负责渲染口径）；
 *   3. 工具卡状态**只由 `tool_result` 推进**：没收到结果就是 `running`，不猜测成功。
 */
import type { SseDoneData, SseEvent, SseToolCallData, ToolStatus } from "./protocol.js";
import type { ConfirmState } from "./danger.js";

export type Block =
  | { readonly kind: "text"; text: string; streaming: boolean }
  | {
      readonly kind: "tool_call";
      readonly callId: string;
      readonly name: string;
      readonly args: unknown;
      status: ToolStatus;
      summary: string | null;
      resultOk: boolean | null;
      confirm: ConfirmState;
      durationMs: number | null;
      startedAt: number;
    }
  | { readonly kind: "error"; readonly code: string; readonly message: string }
  | { readonly kind: "plan_note"; text: string };

export interface AssistantTurn {
  readonly id: string;
  /** 回合开始时间（毫秒；用于 thinking 分级文案的时间轴，属交互时间轴而非动效 token）。 */
  readonly startedAt: number;
  /** run id（`start` 事件给出；用于 `/api/chat/abort`）。 */
  runId: string | null;
  readonly blocks: Block[];
  /** 思考增量（UI 折叠展示，不进模型上下文）。 */
  thinking: string;
  promptTokens: number;
  completionTokens: number;
  /** 交付判定（**只由后端 `done.delivery` 赋值**；`null` = 后端未提供 → 渲染「未提供交付状态」）。 */
  delivery: SseDoneData["delivery"] | null;
  evidence: SseDoneData["evidence"] | null;
  finishReason: SseDoneData["finishReason"] | null;
  /** 流是否已正常收尾（见到 `[DONE]` 或 `done` 事件）。 */
  streamDone: boolean;
  /** 是否被用户中断（IA §3.4「已中断 · 已保留上述内容」）。 */
  stopped: boolean;
}

let turnSeq = 0;

/** 新建一个空的助手回合（`id` 只用于 key，不参与业务判定）。 */
export function newAssistantTurn(): AssistantTurn {
  turnSeq += 1;
  return {
    id: `turn-${String(turnSeq)}`,
    startedAt: Date.now(),
    runId: null,
    blocks: [],
    thinking: "",
    promptTokens: 0,
    completionTokens: 0,
    delivery: null,
    evidence: null,
    finishReason: null,
    streamDone: false,
    stopped: false,
  };
}

function lastText(blocks: Block[]): Extract<Block, { kind: "text" }> | null {
  const tail = blocks[blocks.length - 1];
  return tail !== undefined && tail.kind === "text" ? tail : null;
}

/**
 * 应用一个 SSE 事件（原地更新 turn，返回是否改变了渲染结构）。
 *
 * 返回值语义：`"text"` = 只追加了正文增量（调用方可直接改 DOM 文本节点，不必重建子树）；
 * `"structure"` = 块序列/状态变了（需要重渲染该回合）。
 */
export function applySseEvent(turn: AssistantTurn, event: SseEvent, now = Date.now()): "text" | "structure" {
  switch (event.event) {
    case "start": {
      turn.runId = event.data.runId;
      return "structure";
    }
    case "token": {
      const tail = lastText(turn.blocks);
      if (tail === null) {
        turn.blocks.push({ kind: "text", text: event.data.deltaText, streaming: true });
      } else {
        tail.text += event.data.deltaText;
      }
      return "text";
    }
    case "thinking": {
      turn.thinking += event.data.deltaText;
      return "structure";
    }
    case "tool_call": {
      const data: SseToolCallData = event.data;
      // 正文块在工具调用开始处"封口"：后续增量属于新块（保持事件顺序可审计）。
      const tail = lastText(turn.blocks);
      if (tail !== null) {
        tail.streaming = false;
      }
      turn.blocks.push({
        kind: "tool_call",
        callId: data.callId,
        name: data.name,
        args: data.args,
        status: "running",
        summary: null,
        resultOk: null,
        confirm: { kind: "idle" },
        durationMs: null,
        startedAt: now,
      });
      return "structure";
    }
    case "tool_result": {
      const block = turn.blocks.find(
        (candidate): candidate is Extract<Block, { kind: "tool_call" }> =>
          candidate.kind === "tool_call" && candidate.callId === event.data.callId,
      );
      if (block === undefined) {
        // 没见过的 callId（协议层允许乱序的极端情况）：显式记为错误块，不静默丢弃。
        turn.blocks.push({
          kind: "error",
          code: "tool_result_unknown_call",
          message: `收到未知 callId 的工具结果：${event.data.callId}`,
        });
        return "structure";
      }
      block.status = event.data.ok ? "success" : "error";
      block.summary = event.data.summary;
      block.resultOk = event.data.ok;
      block.durationMs = now - block.startedAt;
      return "structure";
    }
    case "usage": {
      turn.promptTokens += event.data.promptTokens;
      turn.completionTokens += event.data.completionTokens;
      return "structure";
    }
    case "error": {
      turn.blocks.push({ kind: "error", code: event.data.code, message: event.data.message });
      return "structure";
    }
    case "done": {
      turn.delivery = event.data.delivery;
      turn.evidence = event.data.evidence ?? null;
      turn.finishReason = event.data.finishReason;
      turn.streamDone = true;
      for (const block of turn.blocks) {
        if (block.kind === "text") {
          block.streaming = false;
        }
      }
      return "structure";
    }
  }
}

/** 收尾：把仍在 `running` 的工具卡显式标成"未收到结果"（禁止猜测成功）。 */
export function sealTurn(turn: AssistantTurn): void {
  for (const block of turn.blocks) {
    if (block.kind === "text") {
      block.streaming = false;
      continue;
    }
    if (block.kind === "tool_call" && block.status === "running") {
      block.status = "error";
      block.summary = block.summary ?? "未收到该工具调用的结果（流已结束）";
      block.resultOk = false;
    }
  }
}

/** 是否存在仍在运行的工具（presence=acting 的判据）。 */
export function hasRunningTool(turn: AssistantTurn): boolean {
  return turn.blocks.some((block) => block.kind === "tool_call" && block.status === "running");
}

/** 是否存在待确认卡片（presence=awaiting 的判据；A9：阻塞该回合完成、不阻塞输入）。 */
export function hasPendingConfirm(turn: AssistantTurn): boolean {
  return turn.blocks.some((block) => block.kind === "tool_call" && block.confirm.kind === "pending");
}

/** 回合是否仍未完成（用于任务条与输入区状态）。 */
export function turnPending(turn: AssistantTurn): boolean {
  return !turn.streamDone || hasPendingConfirm(turn);
}

/** 交付依据里的工具计数（IA §6.3「依据：<工具名> ×N」）。 */
export function evidenceText(turn: AssistantTurn): string | null {
  if (turn.evidence === undefined || turn.evidence === null) {
    return null;
  }
  return `${turn.evidence.toolName} ×${String(turn.evidence.count)}`;
}

/** 纯文本外置（用于 live region / 复制：把块序列摊平成人类可读文本）。 */
export function turnText(turn: AssistantTurn): string {
  return turn.blocks
    .map((block) => {
      switch (block.kind) {
        case "text":
          return block.text;
        case "tool_call":
          return `[工具 ${block.name} · ${block.status}]${block.summary === null ? "" : ` ${block.summary}`}`;
        case "error":
          return `[错误 ${block.code}] ${block.message}`;
        case "plan_note":
          return block.text;
      }
    })
    .join("\n");
}
