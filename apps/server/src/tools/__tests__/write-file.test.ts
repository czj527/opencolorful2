/**
 * write-file.test.ts：`write_file`（真盘 tmpdir 工作区）。
 *
 * **验收点 2 的核心断言在 "落盘三项" 段**：写完后 `stat` 回读的 `lines / bytes / mtimeMs`
 * 必须与工具返回的 details 逐项一致——把"我以为写进去的"与"磁盘上真实存在的"对起来。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ToolAuthorizationError, ToolInputError } from "@agentplant/agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWriteFileTool } from "../builtin/write-file.js";
import { createRedactor } from "../../policy/redactor.js";
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
  return {
    tool: createWriteFileTool(services),
    ctx: createContext({ workspaceRoot: services.workspaceRoot }),
  };
}

describe("write_file：落盘三项（lines / bytes / mtimeMs）", () => {
  it("返回的三项与磁盘 stat 完全一致", async () => {
    const content = "第一行\nsecond line\nthird\n";
    const { tool: writeFile, ctx } = tool();
    const result = await writeFile.execute(ctx as never, {
      path: "out/a.txt",
      content,
      mode: "create",
    });

    const absolute = join(workspace.root, "out", "a.txt");
    const stat = statSync(absolute);
    const onDisk = readFileSync(absolute, "utf8");

    expect(onDisk).toBe(content);
    expect(result.details?.bytes).toBe(Buffer.byteLength(onDisk, "utf8"));
    expect(result.details?.bytes).toBe(stat.size);
    expect(result.details?.lines).toBe(3);
    expect(result.details?.mtimeMs).toBe(stat.mtimeMs);
    expect(result.details?.created).toBe(true);
    expect(result.details?.guardDecision).toBe("allow");
  });

  it("mtimeMs 来自磁盘（真实时间戳量级）且二次写入后变化", async () => {
    const { tool: writeFile, ctx } = tool();
    await writeFile.execute(ctx as never, { path: "t.txt", content: "a", mode: "create" });
    const first = statSync(join(workspace.root, "t.txt")).mtimeMs;
    expect(first).toBeGreaterThan(1_600_000_000_000);
    await new Promise((resolve) => setTimeout(resolve, 15));
    await writeFile.execute(ctx as never, { path: "t.txt", content: "ab", mode: "overwrite" });
    const second = statSync(join(workspace.root, "t.txt")).mtimeMs;
    expect(second).toBeGreaterThanOrEqual(first);
  });

  it("空内容写入 -> 0 行 / 0 字节（与 read_file 行数口径一致）", async () => {
    const { tool: writeFile, ctx } = tool();
    const result = await writeFile.execute(ctx as never, {
      path: "empty.txt",
      content: "",
      mode: "create",
    });
    expect(result.details).toMatchObject({ lines: 0, bytes: 0 });
    expect(statSync(join(workspace.root, "empty.txt")).size).toBe(0);
  });
});

describe("write_file：三种模式", () => {
  it("mode=create 遇已存在文件抛 ToolInputError，且磁盘内容不变", async () => {
    workspace.writeFile("exists.txt", "ORIGINAL");
    const { tool: writeFile, ctx } = tool();
    await expect(
      writeFile.execute(ctx as never, { path: "exists.txt", content: "NEW", mode: "create" }),
    ).rejects.toBeInstanceOf(ToolInputError);
    expect(readFileSync(join(workspace.root, "exists.txt"), "utf8")).toBe("ORIGINAL");
  });

  it("mode=create 自动建父目录", async () => {
    const { tool: writeFile, ctx } = tool();
    await writeFile.execute(ctx as never, {
      path: "deep/nested/dir/f.txt",
      content: "x",
      mode: "create",
    });
    expect(existsSync(join(workspace.root, "deep", "nested", "dir", "f.txt"))).toBe(true);
  });

  it("mode=overwrite 替换内容且 created=false", async () => {
    workspace.writeFile("o.txt", "OLD-LONGER-CONTENT");
    const { tool: writeFile, ctx } = tool();
    const result = await writeFile.execute(ctx as never, {
      path: "o.txt",
      content: "new",
      mode: "overwrite",
    });
    expect(readFileSync(join(workspace.root, "o.txt"), "utf8")).toBe("new");
    expect(result.details?.created).toBe(false);
    expect(result.details?.bytes).toBe(3);
  });

  it("mode=append 追加而不覆盖", async () => {
    workspace.writeFile("a.txt", "one\n");
    const { tool: writeFile, ctx } = tool();
    const result = await writeFile.execute(ctx as never, {
      path: "a.txt",
      content: "two\n",
      mode: "append",
    });
    expect(readFileSync(join(workspace.root, "a.txt"), "utf8")).toBe("one\ntwo\n");
    expect(result.details?.lines).toBe(2);
  });
});

describe("write_file：越权与错误", () => {
  it("工作区外写入抛 ToolAuthorizationError（403 口径），磁盘无残留", async () => {
    const target = join(workspace.outsideDir, "evil.txt");
    const { tool: writeFile, ctx } = tool();
    await expect(
      writeFile.execute(ctx as never, { path: target, content: "x", mode: "create" }),
    ).rejects.toBeInstanceOf(ToolAuthorizationError);
    expect(existsSync(target)).toBe(false);
  });

  it(".env 写入被拒（readonly → 403），原文件不被改动", async () => {
    workspace.writeFile(".env", "SEARCH_API_KEY=keep-me\n");
    const { tool: writeFile, ctx } = tool();
    await expect(
      writeFile.execute(ctx as never, { path: ".env", content: "EVIL=1", mode: "overwrite" }),
    ).rejects.toBeInstanceOf(ToolAuthorizationError);
    expect(readFileSync(join(workspace.root, ".env"), "utf8")).toBe("SEARCH_API_KEY=keep-me\n");
  });

  it("参数非法抛 ToolInputError", async () => {
    const { tool: writeFile, ctx } = tool();
    await expect(
      writeFile.execute(ctx as never, { path: "x.txt", content: "y", mode: "replace" }),
    ).rejects.toBeInstanceOf(ToolInputError);
  });

  it("越权错误消息经过 redactor 后不含凭据（日志/SSE 转译前先脱敏）", async () => {
    workspace.writeFile(".env", "SEARCH_API_KEY=sk-live-0123456789abcdef\n");
    const services = createServices(workspace);
    const redactor = createRedactor();
    const writeFile = createWriteFileTool(services);
    const ctx = createContext({ workspaceRoot: services.workspaceRoot });
    const error = await writeFile
      .execute(ctx as never, { path: ".env", content: "x", mode: "overwrite" })
      .then(() => null)
      .catch((thrown: unknown) => thrown as ToolAuthorizationError);
    expect(error).toBeInstanceOf(ToolAuthorizationError);
    // 错误消息里没有文件正文；即便路径/原因含可疑串，出网前也过一遍脱敏器
    expect(redactor.redact(error?.message ?? "")).not.toContain("sk-live-0123456789abcdef");
  });
});
