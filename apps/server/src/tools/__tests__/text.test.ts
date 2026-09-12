/**
 * text.test.ts：截断与行窗口的纯函数（边界穷举，无 I/O）。
 *
 * 这些函数决定了"模型看到什么"，边界错一位就会静默丢内容，因此逐字节/逐行断言。
 */
import { describe, expect, it } from "vitest";
import { RollingBuffer, readLineWindow, truncateTail, truncateToBytes } from "../builtin/text.js";
import { htmlToText } from "../builtin/net.js";

describe("truncateToBytes（保头）", () => {
  it("未超限时原样返回", () => {
    expect(truncateToBytes("abc", 10)).toEqual({ text: "abc", truncated: false });
  });

  it("超限时按字节裁剪并标记", () => {
    const result = truncateToBytes("abcdef", 3);
    expect(result).toEqual({ text: "abc", truncated: true });
  });

  it("中文按真实 UTF-8 字节计（1 个汉字 3 字节）", () => {
    const result = truncateToBytes("中文字", 6);
    expect(result.text).toBe("中文");
    expect(result.truncated).toBe(true);
  });

  it("在汉字中间切断时不产生半个字符（残字节被丢弃）", () => {
    const result = truncateToBytes("中文字", 7);
    expect(result.text).toBe("中文");
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(7);
  });
});

describe("truncateTail（保尾）", () => {
  it("未超限时原样返回且 droppedBytes=0", () => {
    expect(truncateTail("abc", 10)).toEqual({ text: "abc", truncated: false, droppedBytes: 0 });
  });

  it("超限时保留尾部并报告丢弃字节数", () => {
    const result = truncateTail("0123456789", 4);
    expect(result.text).toBe("6789");
    expect(result.droppedBytes).toBe(6);
  });

  it("从 UTF-8 字符边界开始解码（不产生 U+FFFD）", () => {
    const text = "前中文";
    const result = truncateTail(text, 4);
    expect(result.text).not.toContain("\uFFFD");
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(4);
  });

  it("空串与零上限不抛错", () => {
    expect(truncateTail("", 10).text).toBe("");
    expect(truncateTail("abc", 0).truncated).toBe(true);
  });
});

describe("readLineWindow", () => {
  const raw = "l1\nl2\nl3\nl4\n";

  it("全量窗口：totalLines/totalBytes 报整文件", () => {
    const window = readLineWindow(raw, { offset: 0, limit: 100, maxBytes: 1024 });
    expect(window.text).toBe("l1\nl2\nl3\nl4");
    expect(window.totalLines).toBe(4);
    expect(window.totalBytes).toBe(Buffer.byteLength(raw, "utf8"));
    expect(window.truncated).toBe(false);
  });

  it("窗口未覆盖到末尾 -> truncatedBy=lines", () => {
    const window = readLineWindow(raw, { offset: 0, limit: 2, maxBytes: 1024 });
    expect(window.text).toBe("l1\nl2");
    expect(window.truncated).toBe(true);
    expect(window.truncatedBy).toBe("lines");
  });

  it("从末尾开始（offset=totalLines）返回空窗口且不标记截断", () => {
    const window = readLineWindow(raw, { offset: 4, limit: 2, maxBytes: 1024 });
    expect(window.text).toBe("");
    expect(window.truncated).toBe(false);
  });

  it("字节上限优先于行数上限（同时超限时报 bytes）", () => {
    const window = readLineWindow(raw, { offset: 0, limit: 100, maxBytes: 3 });
    expect(window.truncatedBy).toBe("bytes");
    expect(window.totalLines).toBe(4);
  });

  it("尾部换行不算额外一行；空文本 0 行", () => {
    expect(readLineWindow("a\n", { offset: 0, limit: 10, maxBytes: 100 }).totalLines).toBe(1);
    expect(readLineWindow("", { offset: 0, limit: 10, maxBytes: 100 }).totalLines).toBe(0);
    expect(readLineWindow("a", { offset: 0, limit: 10, maxBytes: 100 }).totalLines).toBe(1);
  });
});

describe("RollingBuffer（内存有界）", () => {
  it("块被丢弃后保留的字节数不超过上限量级", () => {
    const buffer = new RollingBuffer(100);
    for (let index = 0; index < 50; index += 1) {
      buffer.push(Buffer.from(`${index}`.padEnd(20, "x")));
    }
    expect(buffer.byteLength()).toBeLessThanOrEqual(120);
    expect(buffer.text()).toContain("49");
    expect(buffer.text()).not.toContain("0xxxxxxxxxxxxxxxxxx");
  });

  it("单块超限时整块保留（不做块内切分）", () => {
    const buffer = new RollingBuffer(10);
    buffer.push(Buffer.from("y".repeat(50)));
    expect(buffer.byteLength()).toBe(50);
    expect(buffer.text()).toHaveLength(50);
  });
});

describe("htmlToText", () => {
  it("去掉 script/style/注释，保留正文并解实体", () => {
    const html =
      "<!--comment--><style>a{}</style><script>var x=1</script><p>A&amp;B</p><p>&lt;tag&gt;</p>";
    const text = htmlToText(html);
    expect(text).toContain("A&B");
    expect(text).toContain("<tag>");
    expect(text).not.toContain("var x=1");
    expect(text).not.toContain("comment");
  });

  it("块级标签换行，行内标签不粘词", () => {
    expect(htmlToText("<p>one</p><p>two</p>")).toBe("one\ntwo");
    expect(htmlToText("<span>a</span><span>b</span>")).toBe("a b");
  });

  it("压缩空白与空行", () => {
    expect(htmlToText("<div>  a   b  </div>\n\n<div></div>")).toBe("a b");
  });
});
