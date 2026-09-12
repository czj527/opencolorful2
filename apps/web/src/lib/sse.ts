/**
 * SSE 帧解析器（**纯逻辑，可单测**）。
 *
 * 契约来源：`packages/protocol/src/sse.ts` —— 8 种事件名（`start / token / thinking / tool_call /
 * tool_result / usage / error / done`）+ 结束帧 `data: [DONE]`，线格式 `event: <name>\ndata: <json>\n\n`。
 *
 * 三条不可动摇的行为（t7 AT-201 / t5 §5）：
 *   1. **块顺序 = 后端事件顺序**：解析器只做"字节 → 帧"的搬运，不重排、不合并、不补帧。
 *   2. **[DONE] 是唯一收流信号**：见到它才 `done=true`；流自然结束但没见到 [DONE] 视为**截断**
 *      （由调用方按"回复不完整"处理，不得当成正常完成）。
 *   3. **未知事件名不静默丢弃**：记进 `unknown` 列表交给上层（协议演进可观测），但不猜其形状。
 */
import type { SseEventName } from "./protocol.js";

/** 结束帧原文（协议层常量同值；此处为字面量以避免运行期依赖，见 protocol.ts 头注）。 */
export const DONE_FRAME = "data: [DONE]";

/** 解析出的一帧：事件名 + 原始 data 字符串（JSON 解析与校验由上层做，便于单测与错误定位）。 */
export interface SseFrame {
  readonly event: SseEventName;
  readonly data: string;
}

export interface SseParseResult {
  readonly frames: readonly SseFrame[];
  /** 见到 `data: [DONE]` 即为 true（此后的一切输入忽略）。 */
  readonly done: boolean;
  /** 不认识的 `event:` 名（按出现顺序；保留以便上报，不猜测其形状）。 */
  readonly unknownEvents: readonly string[];
  /** 剩余未完整接收的缓冲（含跨 chunk 的半帧），需与后续 chunk 一起再喂进来。 */
  readonly rest: string;
  /** 被跳过的不完整行数（如 "event: token" 后紧跟 chunk 边界；属正常现象，仅计数）。 */
  readonly pendingLines: number;
}

const EMPTY: SseParseResult = {
  frames: [],
  done: false,
  unknownEvents: [],
  rest: "",
  pendingLines: 0,
};

/**
 * 增量解析：把 `buffer + chunk` 切成完整帧，返回新帧与剩余缓冲。
 *
 * @param buffer 上次调用返回的 `rest`
 * @param chunk  本次从 `ReadableStream` 读到的文本
 * @param knownEvents 合法事件名集合（调用方传协议层常量，避免前端另抄一份）
 */
export function parseSseChunk(
  buffer: string,
  chunk: string,
  knownEvents: readonly SseEventName[],
): SseParseResult {
  const text = buffer + chunk;
  const frames: SseFrame[] = [];
  const unknownEvents: string[] = [];
  let done = false;
  let pendingLines = 0;

  // 事件之间以空行分隔；把 \r\n 归一化后按 \n\n 切分，最后一段留作缓冲（可能是半帧）。
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = normalized.split("\n\n");
  const rest = blocks.pop() ?? "";

  for (const block of blocks) {
    const parsed = parseBlock(block, knownEvents);
    if (parsed.kind === "skip") {
      if (block.trim() !== "") {
        pendingLines += 1;
      }
      continue;
    }
    if (parsed.kind === "done") {
      done = true;
      break;
    }
    if (parsed.kind === "unknown") {
      unknownEvents.push(parsed.event);
      continue;
    }
    frames.push({ event: parsed.event, data: parsed.data });
  }
  if (frames.length === 0 && unknownEvents.length === 0 && !done) {
    return { ...EMPTY, rest, pendingLines };
  }
  return { frames, done, unknownEvents, rest, pendingLines };
}

type ParsedBlock =
  | { readonly kind: "frame"; readonly event: SseEventName; readonly data: string }
  | { readonly kind: "unknown"; readonly event: string }
  | { readonly kind: "done" }
  | { readonly kind: "skip" };

function parseBlock(block: string, knownEvents: readonly SseEventName[]): ParsedBlock {
  let event = "";
  let data: string | null = null;

  for (const rawLine of block.split("\n")) {
    const line = rawLine.trimEnd();
    if (line === "" || line.startsWith(":")) {
      continue; // 注释 / keep-alive
    }
    const separator = line.indexOf(":");
    if (separator < 0) {
      continue;
    }
    const field = line.slice(0, separator);
    const value = line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") {
      event = value;
    } else if (field === "data") {
      data = data === null ? value : `${data}\n${value}`;
    }
  }

  // `data: [DONE]` 可能不带 event 字段（协议层的结束帧就是一行 data）。
  if (data !== null && event === "" && `data: ${data}` === DONE_FRAME) {
    return { kind: "done" };
  }
  if (data === null || event === "") {
    return { kind: "skip" };
  }
  if (!(knownEvents as readonly string[]).includes(event)) {
    return { kind: "unknown", event };
  }
  return { kind: "frame", event: event as SseEventName, data };
}

/** 判断一帧 data 是否结束帧（上层也可直接看 `SseParseResult.done`）。 */
export function isDoneFrame(line: string): boolean {
  return line.trim() === DONE_FRAME;
}
