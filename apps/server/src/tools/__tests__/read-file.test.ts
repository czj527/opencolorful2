/**
 * read-file.test.ts：`read_file`（真盘 tmpdir 工作区）。
 *
 * 覆盖：守卫先行（越权 403）、行号文本、`truncateHead` 三项（truncated/totalLines/totalBytes）、
 * offset/limit 窗口、不存在文件、`.env` 拒读。
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ToolAuthorizationError, ToolInputError } from "@agentplant/agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadFileTool } from "../builtin/read-file.js";
import { createContext, createServices, createTestWorkspace, type TestWorkspace } from "./harness.js";

let workspace: TestWorkspace;

beforeEach(() => {
  workspace = createTestWorkspace();
});

afterEach(() => {
  workspace.cleanup();
});

function tool() {
  const services = createServices(workspace);
  return { tool: createReadFileTool(services), ctx: createContext({ workspaceRoot: services.workspaceRoot }) };
}

describe("read_file：正常读取", () => {
  it("返回带行号的文本，行号从 1 开始且连续", async () => {
    workspace.writeFile("a.txt", "第一行\n第二行\n第三行\n");
    const { tool: readFile, ctx } = tool();
    const result = await readFile.execute(ctx as never, { path: "a.txt" });
    expect(result.content).toContain("1\t第一行");
    expect(result.content).toContain("3\t第三行");
    expect(result.details).toMatchObject({ totalLines: 3, truncated: false, returnedLines: 3 });
  });

  it("totalBytes 是磁盘上的真实 UTF-8 字节数", async () => {
    const content = "中文 abc\n";
    workspace.writeFile("b.txt", content);
    const { tool: readFile, ctx } = tool();
    const result = await readFile.execute(ctx as never, { path: "b.txt" });
    expect(result.details).toMatchObject({
      totalBytes: Buffer.byteLength(content, "utf8"),
      returnedLines: 1,
    });
  });

  it("空文件返回 0 行且不报错", async () => {
    workspace.writeFile("empty.txt", "");
    const { tool: readFile, ctx } = tool();
    const result = await readFile.execute(ctx as never, { path: "empty.txt" });
    expect(result.details).toMatchObject({ totalLines: 0, totalBytes: 0, truncated: false });
  });

  it("offset/limit 只返回窗口，且行号是绝对行号", async () => {
    workspace.writeFile("n.txt", "l1\nl2\nl3\nl4\nl5\n");
    const { tool: readFile, ctx } = tool();
    const result = await readFile.execute(ctx as never, { path: "n.txt", offset: 2, limit: 2 });
    expect(result.content).toContain("3\tl3");
    expect(result.content).toContain("4\tl4");
    expect(result.content).not.toContain("l1");
    expect(result.details).toMatchObject({ truncated: true, truncatedBy: "lines", returnedLines: 2 });
  });

  it("offset 超过总行数时返回空窗口而不是报错", async () => {
    workspace.writeFile("s.txt", "a\nb\n");
    const { tool: readFile, ctx } = tool();
    const result = await readFile.execute(ctx as never, { path: "s.txt", offset: 99 });
    expect(result.details).toMatchObject({ returnedLines: 0, truncated: false });
  });
});

describe("read_file：截断", () => {
  it("超过 limit 行时 truncated=true + truncatedBy=lines，totalLines 仍是文件总行数", async () => {
    const lines = Array.from({ length: 50 }, (_value, index) => `line-${index + 1}`);
    workspace.writeFile("big.txt", `${lines.join("\n")}\n`);
    const { tool: readFile, ctx } = tool();
    const result = await readFile.execute(ctx as never, { path: "big.txt", limit: 10 });
    expect(result.details).toMatchObject({
      truncated: true,
      truncatedBy: "lines",
      totalLines: 50,
      returnedLines: 10,
    });
    expect(result.content).toContain("10\tline-10");
    expect(result.content).not.toContain("line-11");
  });

  it("单行超长时按字节截断（truncatedBy=bytes）", async () => {
    // 100KB 单行：行数窗口只有 1 行，截断必然来自字节上限
    workspace.writeFile("wide.txt", "x".repeat(100 * 1024));
    const { tool: readFile, ctx } = tool();
    const result = await readFile.execute(ctx as never, { path: "wide.txt" });
    expect(result.details?.truncated).toBe(true);
    expect(result.details?.truncatedBy).toBe("bytes");
    expect(result.details?.totalBytes).toBe(100 * 1024);
  });
});

describe("read_file：越权与错误", () => {
  it("工作区外的文件抛 ToolAuthorizationError（403 口径）", async () => {
    const outside = join(workspace.outsideDir, "secret.txt");
    writeFileSync(outside, "OUTSIDE", "utf8");
    const { tool: readFile, ctx } = tool();
    await expect(readFile.execute(ctx as never, { path: outside })).rejects.toBeInstanceOf(
      ToolAuthorizationError,
    );
  });

  it(".env 拒读（强制禁区）", async () => {
    workspace.writeFile(".env", "SEARCH_API_KEY=sk-test\n");
    const { tool: readFile, ctx } = tool();
    await expect(readFile.execute(ctx as never, { path: ".env" })).rejects.toBeInstanceOf(
      ToolAuthorizationError,
    );
  });

  it(".git 目录内拒读", async () => {
    workspace.mkdir(".git");
    workspace.writeFile(".git/config", "[core]\n");
    const { tool: readFile, ctx } = tool();
    await expect(readFile.execute(ctx as never, { path: ".git/config" })).rejects.toBeInstanceOf(
      ToolAuthorizationError,
    );
  });

  it("文件不存在抛 ToolInputError（不是 500）", async () => {
    const { tool: readFile, ctx } = tool();
    await expect(readFile.execute(ctx as never, { path: "nope.txt" })).rejects.toBeInstanceOf(
      ToolInputError,
    );
  });

  it("参数非法抛 ToolInputError", async () => {
    const { tool: readFile, ctx } = tool();
    await expect(readFile.execute(ctx as never, {})).rejects.toBeInstanceOf(ToolInputError);
  });
});
