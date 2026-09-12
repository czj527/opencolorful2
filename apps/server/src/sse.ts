/**
 * sse：SSE 推送 + 断线监听 + run 注册表（t4 §2）。
 *
 * 三个硬要求：
 * 1. 响应头与结束帧一律走 protocol 的常量（`SSE_HEADERS` / `SSE_DONE_FRAME`），不在本包重写。
 * 2. **必须** `watchClientDisconnect`：监听 socket/res 的 `close`，未正常结束即 abort 本次 run
 *    ——否则断线后模型还在跑（openclaw `http-common.ts` 教训，t4 §2 点名）。
 * 3. 每个 run 一个 `AbortController` 存在注册表里；`/api/chat/abort` 与断线复用同一条
 *    `abortRun(runId)` 路径（单一标记入口，避免两条路径语义漂移）。
 *
 * 骨架期说明：注册表是**进程内存 Map**，进程退出即丢；SQLite 落地是后续任务
 * （见 README「骨架期内存实现」）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { SSE_DONE_FRAME, SSE_HEADERS, encodeSseEvent, type SseEventName } from "@agentplant/protocol";
import type { ConfirmDecision } from "./agent/confirmation.js";

/**
 * 一次挂起等确认的工具调用（M1 就地确认协议，M1-9 ③）。
 *
 * 记两份参数是刻意的：`args` 是 `tool_call` 事件里给前端的那一份（展示用），
 * `rawArgs` 是模型原始 JSON 串——确认后执行时**原样**交给 `materializeParams`，
 * 不做"解析再序列化"的回环（多一次编解码就多一处与模型原文不一致的机会）。
 */
export interface PendingCall {
  readonly callId: string;
  readonly name: string;
  readonly args: unknown;
  readonly rawArgs: string;
}

/** 单个 run 的注册表条目。 */
export interface RunRecord {
  readonly runId: string;
  readonly sessionId: string;
  /** 供后续 agent 主循环消费；骨架期只由 abort 路径触发。 */
  readonly controller: AbortController;
  aborted: boolean;
  /** 已正常收流（done + [DONE] 已发出 / 非流式已应答）：此时 abort 应当返回 false。 */
  finished: boolean;
  /**
   * 挂起待确认的调用（`callId` → 调用）。
   *
   * M1 的挂起**跨回合存活**：主循环在确认处停下、发完 `done`，条目仍留在这里等
   * `POST /api/chat/confirm`。因此 run 记录不能在本回合收尾时删除——代价是注册表
   * 会留到确认被解决为止（清理策略跟"确认结果同流续推"的二期优化一起做）。
   */
  readonly pendingConfirmations: Map<string, PendingCall>;
  /** 已解决的确认（`callId` → 决策）：用来把重复确认的 400 `already_resolved` 与未知的 404 分开。 */
  readonly resolvedConfirmations: Map<string, ConfirmDecision>;
}

const runs = new Map<string, RunRecord>();

/** 登记一个新 run（返回条目，便于调用方读取 controller.signal）。 */
export function registerRun(runId: string, sessionId: string): RunRecord {
  const record: RunRecord = {
    runId,
    sessionId,
    controller: new AbortController(),
    aborted: false,
    finished: false,
    pendingConfirmations: new Map<string, PendingCall>(),
    resolvedConfirmations: new Map<string, ConfirmDecision>(),
  };
  runs.set(runId, record);
  return record;
}

export function getRun(runId: string): RunRecord | undefined {
  return runs.get(runId);
}

/** 标记 run 正常收尾（终态不可降级：已 aborted 的 run 不会被这里翻回 finished）。 */
export function finishRun(runId: string): void {
  const record = runs.get(runId);
  if (record !== undefined && !record.aborted) {
    record.finished = true;
  }
}

/**
 * 标记 run 为 aborted 并触发其 AbortController。
 *
 * 返回是否**本次真的**发生了状态迁移：未知 runId（或已 aborted / 已 finished）返回 false，
 * 与 protocol 的 `ChatAbortResponseSchema` 注释一致（`aborted=false` 表示已终态，不是错误）。
 */
export function abortRun(runId: string): boolean {
  const record = runs.get(runId);
  if (record === undefined || record.aborted || record.finished) {
    return false;
  }
  record.aborted = true;
  record.controller.abort();
  return true;
}

/** 已登记且未收尾的 run 数（测试与后续观测用；也让注册表不是"只写不读"）。 */
export function activeRunCount(): number {
  let count = 0;
  for (const record of runs.values()) {
    if (!record.finished && !record.aborted) {
      count += 1;
    }
  }
  return count;
}

/**
 * 登记一次挂起的确认调用（主循环在确认处调用）。
 *
 * run 记录缺省由 `routes.ts` 在回合开始前登记；这里对"没登记过就直接跑主循环"的调用方
 * （直调 `runTurn` 的测试 / 未来的嵌入式用法）**补登记**而不是抛错：挂起是主循环的
 * 正常产物，缺一条注册表记录不该让整个回合失败。
 */
export function registerPendingCall(
  runId: string,
  sessionId: string,
  call: PendingCall,
): RunRecord {
  const record = runs.get(runId) ?? registerRun(runId, sessionId);
  record.pendingConfirmations.set(call.callId, call);
  return record;
}

/** 取一条挂起的调用；没有（或已解决）返回 undefined。 */
export function getPendingCall(runId: string, callId: string): PendingCall | undefined {
  return runs.get(runId)?.pendingConfirmations.get(callId);
}

/** 该 `callId` 是否已被解决过（用于把重复确认与未知 callId 区分开）。 */
export function isConfirmationResolved(runId: string, callId: string): boolean {
  return runs.get(runId)?.resolvedConfirmations.has(callId) === true;
}

/**
 * 解决一条挂起的调用：从 pending 移入 resolved。
 *
 * 返回是否**本次真的**解决了（false = 该调用不在挂起集合里，调用方据此回
 * 404/400，而不是静默当成成功）。先移除再执行是刻意的：并发/重复确认时只有一个
 * 请求能拿到 `true`，另一个立刻得到 `already_resolved`，不会两个都去执行同一个工具。
 */
export function resolvePendingCall(
  runId: string,
  callId: string,
  decision: ConfirmDecision,
): boolean {
  const record = runs.get(runId);
  if (record === undefined || !record.pendingConfirmations.delete(callId)) {
    return false;
  }
  record.resolvedConfirmations.set(callId, decision);
  return true;
}

/** 全部 run 的挂起调用数（观测用：确认协议真的在用，不是"写了没人读"）。 */
export function pendingCallCount(): number {
  let count = 0;
  for (const record of runs.values()) {
    count += record.pendingConfirmations.size;
  }
  return count;
}

/** 仅测试用：清空注册表，避免跨用例串味。 */
export function resetRunsForTest(): void {
  runs.clear();
}

/** 写 SSE 响应头并 flush（t4 §2：不 flush 则前端拿到流要等首帧）。 */
export function sendSseHeaders(res: ServerResponse): void {
  res.writeHead(200, { ...SSE_HEADERS });
  res.flushHeaders();
}

/** 推一条事件（线格式由 protocol 的 `encodeSseEvent` 决定）。 */
export function pushEvent(res: ServerResponse, event: SseEventName, data: unknown): void {
  res.write(encodeSseEvent(event, data));
}

/** 写结束帧并收流（`data: [DONE]\n`）。 */
export function endStream(res: ServerResponse): void {
  res.end(`${SSE_DONE_FRAME}\n`);
}

/**
 * 断线监听：客户端断开且本次响应**没有正常写完**时调用 `onAbort`。
 *
 * `close` 在正常收流后也会触发，因此用 `res.writableFinished` 区分：
 * 已正常 end 完 → 不算断线（否则每次成功的 SSE 都会把 run 标成 aborted）。
 * 返回解绑函数：正常收流后调用可避免 keep-alive 连接上残留监听器。
 */
export function watchClientDisconnect(
  req: IncomingMessage,
  res: ServerResponse,
  onAbort: () => void,
): () => void {
  const detach = (): void => {
    res.off("close", handleClose);
    req.socket?.off("close", handleClose);
  };
  function handleClose(): void {
    detach();
    if (!res.writableFinished) {
      onAbort();
    }
  }
  res.on("close", handleClose);
  req.socket?.once("close", handleClose);
  return detach;
}
