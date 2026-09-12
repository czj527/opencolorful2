/**
 * tools/builtin/text：行窗口 + 截断的纯函数（无 I/O，便于穷举边界）。
 *
 * 两种截断方向对应两种真实需求（t4 §6）：
 * - `truncateHead`（读文件）：保留**开头**——用户/模型要看的是文件起始部分。
 * - `truncateTail`（命令输出）：保留**末尾**——报错和汇总在末尾，砍掉尾巴等于砍掉最有用的部分。
 *
 * 字节口径一律 UTF-8 真实字节数（`Buffer.byteLength`），与 `maxOutputBytes`/`maxBytes`
 * 这些参数名的语义一致；字符数口径会把中文文件的实际体积低估三倍。
 */

export interface LineWindow {
  /** 返回的正文（已按字节上限裁剪）。 */
  readonly text: string;
  /** 是否发生了截断（行数超限、字节超限或窗口未覆盖到末尾）。 */
  readonly truncated: boolean;
  readonly truncatedBy?: "lines" | "bytes";
  readonly totalLines: number;
  readonly totalBytes: number;
}

/** 按字节上限裁剪一段文本（不切断 UTF-8 多字节序列：残尾字节直接丢弃）。 */
export function truncateToBytes(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) {
    return { text, truncated: false };
  }
  // 从切点向前退到字符首字节：`Buffer#toString` 会把半个序列解成 U+FFFD，
  // 那会让"截断"看起来像"文件里真有乱码"（读文件工具尤其不能这样）。
  let end = Math.max(maxBytes, 0);
  while (end > 0) {
    const byte = bytes[end];
    if (byte === undefined || (byte & 0xc0) !== 0x80) {
      break;
    }
    end -= 1;
  }
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

/**
 * 行窗口：`offset` 从 0 开始计；`totalLines` 口径 = 尾部换行不额外算一行
 * （`"a\nb\n"` 是 2 行，`""` 是 0 行），`totalBytes` 是整文件字节数。
 */
export function readLineWindow(
  raw: string,
  options: { readonly offset: number; readonly limit: number; readonly maxBytes: number },
): LineWindow {
  const totalBytes = Buffer.byteLength(raw, "utf8");
  const lines = raw.length === 0 ? [] : raw.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const totalLines = lines.length;
  const start = Math.min(options.offset, totalLines);
  const end = Math.min(start + options.limit, totalLines);
  const capped = truncateToBytes(lines.slice(start, end).join("\n"), options.maxBytes);
  const truncated = capped.truncated || end < totalLines;
  return {
    text: capped.text,
    truncated,
    ...(capped.truncated
      ? { truncatedBy: "bytes" as const }
      : end < totalLines
        ? { truncatedBy: "lines" as const }
        : {}),
    totalLines,
    totalBytes,
  };
}

export interface TailResult {
  readonly text: string;
  readonly truncated: boolean;
  /** 被丢弃的字节数（`truncated` 为真时 > 0）。 */
  readonly droppedBytes: number;
}

/**
 * 保留尾部的截断（命令输出用，t4 §6 `truncateTail`）。
 *
 * 裁剪发生在**字节**层面并从尾部取：取最后 `maxBytes` 字节后，从首个完整 UTF-8 序列
 * 边界开始解码——否则半个汉字解码成 `U+FFFD` 会污染报错行。
 */
export function truncateTail(text: string, maxBytes: number): TailResult {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) {
    return { text, truncated: false, droppedBytes: 0 };
  }
  let start = bytes.length - maxBytes;
  // 跳过延续字节（0b10xxxxxx），落到字符首字节
  while (start < bytes.length) {
    const byte = bytes[start];
    if (byte === undefined || (byte & 0xc0) !== 0x80) {
      break;
    }
    start += 1;
  }
  return {
    text: bytes.subarray(start).toString("utf8"),
    truncated: true,
    droppedBytes: start,
  };
}

/**
 * 滚动缓冲：写入时只保留尾部 `maxBytes`，防止长跑命令把内存吃光
 * （t4 §6「滚动缓冲防 OOM」）。
 *
 * 与 `truncateTail` 的分工：本类型管"进程还在跑时的内存上限"（进程活着时就要生效），
 * `truncateTail` 管"最终输出的呈现上限"。单块超限时**整块保留**（块内部再切就没有边界
 * 可言了）；真正的兜底是进程结束后的 `truncateTail`，两者一起保证返回体有界。
 */
export class RollingBuffer {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  private dropped = 0;

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.maxBytes && this.chunks.length > 1) {
      const first = this.chunks.shift();
      if (first === undefined) {
        break;
      }
      this.size -= first.length;
      this.dropped += first.length;
    }
  }

  /** 当前保留的字节数（`test` 断言"内存有界"用）。 */
  byteLength(): number {
    return this.size;
  }

  /**
   * 被丢弃的字节数。
   *
   * **必须暴露出来**：滚动缓冲丢掉的字节不会出现在最终文本里，`truncateTail` 因此看不见它们
   * ——只看文本框会把"内存里就已经截断了"误报成 `truncated: false`（真实发生的丢数据却不标记，
   * 是最坏的一类谎报）。调用方用 `droppedBytes() > 0 || truncateTail(...).truncated` 判截断。
   */
  droppedBytes(): number {
    return this.dropped;
  }

  /** 当前保留内容的文本形态（不裁剪）。 */
  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}
