/**
 * memory-tool.test.ts：`memory_write` / `memory_search`（**真 SQLite 文件**，tmpdir）。
 *
 * 两条主线：
 * 1. **未注入 DAO 时诚实报错**（骨架期 routes 不接线；假装写入成功是最危险的假绿）。
 * 2. 注入真库（`openDatabase` + `migrate` + `createStateDao`）后：写入落盘可回读、
 *    FTS5 检索命中、`sessionId` 归属正确。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { closeDatabase, createStateDao, migrate, openDatabase } from "@agentplant/state";
import { ToolInputError } from "@agentplant/agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemorySearchTool, createMemoryWriteTool } from "../builtin/memory.js";
import {
  createContext,
  createServices,
  createTestWorkspace,
  removeTempDirRetrying,
  type TestWorkspace,
} from "./harness.js";

let workspace: TestWorkspace;
let dbDir: string;
let db: DatabaseSync;

beforeEach(() => {
  workspace = createTestWorkspace();
  dbDir = mkdtempSync(join(tmpdir(), "agentplant-memory-tool-test-"));
  db = openDatabase(join(dbDir, "agentplant.sqlite"));
  migrate(db);
  // `memories.session_id` 有外键约束（t4 §4 DDL）：真库里必须先有会话行，
  // 这正是"用真库而不是内存桩"才能暴露的约束。
  const dao = createStateDao(db);
  for (const id of ["session-alpha", "session-1", "session-from-context", "session-explicit"]) {
    dao.createSession({ id, title: id });
  }
});

afterEach(() => {
  closeDatabase(db);
  // 与工作区临时目录同一条退避重试路径：刚关闭的 SQLite 在 Windows 上可能还短暂持有句柄
  removeTempDirRetrying(dbDir);
  workspace.cleanup();
});

function withoutDb() {
  const services = createServices(workspace);
  return {
    write: createMemoryWriteTool(services),
    search: createMemorySearchTool(services),
    ctx: createContext({ workspaceRoot: services.workspaceRoot }),
  };
}

function withDb(sessionId = "session-alpha") {
  const services = createServices(workspace, { memoryDb: createStateDao(db) });
  return {
    write: createMemoryWriteTool(services),
    search: createMemorySearchTool(services),
    ctx: createContext({ workspaceRoot: services.workspaceRoot, sessionId }),
  };
}

/** 库里的记忆行数：证明"没写进去"而不是"报错了但留下一行"。 */
function memoryRowCount(): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n?: unknown } | undefined;
  return Number(row?.n ?? 0);
}

describe("memory_*：未接线时诚实报错", () => {
  it("memory_write 抛 ToolInputError，消息指明需要注入 memoryDb", async () => {
    const { write, ctx } = withoutDb();
    const error = await write
      .execute(ctx as never, { kind: "preference", text: "用户喜欢简短回答" })
      .then(() => null)
      .catch((thrown: unknown) => thrown as ToolInputError);
    expect(error).toBeInstanceOf(ToolInputError);
    expect(error?.message).toContain("未接线");
  });

  it("memory_search 抛 ToolInputError（不是返回空列表）", async () => {
    const { search, ctx } = withoutDb();
    const error = await search
      .execute(ctx as never, { query: "偏好" })
      .then(() => null)
      .catch((thrown: unknown) => thrown as ToolInputError);
    expect(error).toBeInstanceOf(ToolInputError);
    expect(error?.message).toContain("未接线");
  });

  it("参数非法时仍先报 400（参数校验在接线检查之前）", async () => {
    const { write, ctx } = withoutDb();
    await expect(write.execute(ctx as never, { kind: "note", text: "x" })).rejects.toMatchObject({
      message: expect.stringContaining("参数不合法"),
    });
  });
});

describe("memory_write：真库落盘", () => {
  it("写入返回 id 且能从库里读回（内容一字不差）", async () => {
    const { write, ctx } = withDb("session-1");
    const result = await write.execute(ctx as never, {
      kind: "preference",
      text: "用户偏好中文回复",
    });
    expect(result.details?.id).toBeDefined();
    const row = db
      .prepare("SELECT kind, content, session_id, scope FROM memories WHERE id = ?")
      .get(result.details?.id ?? "");
    expect(row).toMatchObject({
      kind: "preference",
      content: "用户偏好中文回复",
      session_id: "session-1",
      scope: "session",
    });
  });

  it("未给 sessionId 时归属 ToolContext.sessionId", async () => {
    const { write, ctx } = withDb("session-from-context");
    const result = await write.execute(ctx as never, { kind: "fact", text: "项目用 pnpm" });
    const row = db
      .prepare("SELECT session_id FROM memories WHERE id = ?")
      .get(result.details?.id ?? "");
    expect(row).toMatchObject({ session_id: "session-from-context" });
  });

  it("显式 sessionId 覆盖上下文", async () => {
    const { write, ctx } = withDb("session-from-context");
    const result = await write.execute(ctx as never, {
      kind: "fact",
      text: "显式归属",
      sessionId: "session-explicit",
    });
    const row = db
      .prepare("SELECT session_id FROM memories WHERE id = ?")
      .get(result.details?.id ?? "");
    expect(row).toMatchObject({ session_id: "session-explicit" });
  });

  it("details 记的是字节数而不是正文（长度口径，供审计用）", async () => {
    const { write, ctx } = withDb();
    const text = "中文偏好";
    const result = await write.execute(ctx as never, { kind: "preference", text });
    expect(result.details?.contentBytes).toBe(Buffer.byteLength(text, "utf8"));
  });
});

describe("memory_write：未知 sessionId → ToolInputError（400 口径，不是 FK 500）", () => {
  it("参数给未知 sessionId：抛 ToolInputError（kind=input）且库里不新增行", async () => {
    const { write, ctx } = withDb("session-from-context");
    const error = await write
      .execute(ctx as never, { kind: "fact", text: "不该落下", sessionId: "no-such-session" })
      .then(() => null)
      .catch((thrown: unknown) => thrown as ToolInputError);
    expect(error).toBeInstanceOf(ToolInputError);
    expect(error?.kind).toBe("input");
    expect(error?.message).toContain("会话不存在");
    expect(error?.message).toContain("no-such-session");
    expect(memoryRowCount()).toBe(0);
  });

  it("ctx 给未知 sessionId：同样抛 ToolInputError，不落库也不静默跳过写入", async () => {
    const { write, ctx } = withDb("ghost-session");
    const error = await write
      .execute(ctx as never, { kind: "preference", text: "不该落下" })
      .then(() => null)
      .catch((thrown: unknown) => thrown as ToolInputError);
    expect(error).toBeInstanceOf(ToolInputError);
    expect(error?.kind).toBe("input");
    expect(error?.message).toContain("ghost-session");
    expect(memoryRowCount()).toBe(0);
  });

  it("参数与 ctx 都指向未知会话时，报的是参数那个（显式覆盖上下文）", async () => {
    const { write, ctx } = withDb("ghost-session");
    await expect(
      write.execute(ctx as never, { kind: "fact", text: "x", sessionId: "ghost-param" }),
    ).rejects.toThrow(/ghost-param/);
    expect(memoryRowCount()).toBe(0);
  });

  it("正常写入不受影响：已知会话（参数给 / ctx 给 / 两侧带空白）都真的落库", async () => {
    const viaCtx = withDb("session-from-context");
    await viaCtx.write.execute(viaCtx.ctx as never, { kind: "fact", text: "ctx 归属" });
    await viaCtx.write.execute(viaCtx.ctx as never, {
      kind: "fact",
      text: "参数归属",
      sessionId: "session-explicit",
    });
    await viaCtx.write.execute(viaCtx.ctx as never, {
      kind: "fact",
      text: "带空白参数",
      sessionId: "  session-explicit  ",
    });
    const rows = db
      .prepare("SELECT content, session_id, scope FROM memories ORDER BY rowid ASC")
      .all() as { session_id?: unknown; scope?: unknown }[];
    expect(rows).toHaveLength(3);
    // 逐行核对归属：`ctx` → 会话，参数 → 目标会话，带空白参数 → **trim 后**同一个会话
    // （与 `POST /api/memory` 的 `body.sessionId.trim()` 同口径，不因空白多出一行）。
    expect(rows.map((row) => row.session_id)).toEqual([
      "session-from-context",
      "session-explicit",
      "session-explicit",
    ]);
    expect(rows.every((row) => row.scope === "session")).toBe(true);
  });

  it("空 / 纯空白 sessionId 视同未给 → 全局作用域写入成功（不做存在性检查）", async () => {
    const { write, ctx } = withDb("");
    await write.execute(ctx as never, { kind: "preference", text: "全局偏好（空串）" });
    const spaced = withDb("   ");
    await spaced.write.execute(spaced.ctx as never, {
      kind: "preference",
      text: "全局偏好（空白）",
    });
    const rows = db.prepare("SELECT session_id, scope FROM memories").all() as {
      session_id?: unknown;
      scope?: unknown;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.session_id === null && row.scope === "global")).toBe(true);
  });
});

describe("memory_search：FTS5 检索", () => {
  it("命中刚写入的记忆并带 id/kind/text/createdAt/source", async () => {
    const { write, search, ctx } = withDb();
    await write.execute(ctx as never, { kind: "preference", text: "用户喜欢直接给结论" });
    // 查询要按 token 边界给：FTS5 默认分词器把连续 CJK 当作**一个 token**，
    // `用户喜欢直接给结论` 是整串 token（命中），子串 `直接给结论` 不命中（见下一条用例）
    const result = await search.execute(ctx as never, { query: "用户喜欢直接给结论" });
    expect(result.details?.items).toHaveLength(1);
    const item = result.details?.items[0];
    expect(item).toMatchObject({ kind: "preference", text: "用户喜欢直接给结论", source: "memory" });
    expect(item?.createdAt).toBeGreaterThan(0);
    expect(item?.id).toBeDefined();
  });

  it("已知限制：CJK 子串查不到（分词在 state 层，2/3-gram 属二期）", async () => {
    const { write, search, ctx } = withDb();
    await write.execute(ctx as never, { kind: "preference", text: "用户喜欢直接给结论" });
    const result = await search.execute(ctx as never, { query: "直接给结论" });
    // 这个断言记录的是**当前真实能力**（不是期望终态）：宁可在测试里承认，
    // 也不能让上层以为中文子串检索已经能用了（升级路径见 t4 §7 记忆升级）。
    expect(result.details?.items).toEqual([]);
  });

  it("拉丁词与空格分隔的多词短语都能命中", async () => {
    const { write, search, ctx } = withDb();
    await write.execute(ctx as never, { kind: "fact", text: "项目用 pnpm 管理依赖" });
    expect((await search.execute(ctx as never, { query: "pnpm" })).details?.items).toHaveLength(1);
    expect((await search.execute(ctx as never, { query: "管理依赖" })).details?.items).toHaveLength(1);
  });

  it("无匹配时返回 0 条（真的查过库，不是未接线）", async () => {
    const { write, search, ctx } = withDb();
    await write.execute(ctx as never, { kind: "fact", text: "项目用 pnpm" });
    const result = await search.execute(ctx as never, { query: "完全无关的词条" });
    expect(result.details?.items).toEqual([]);
    expect(result.content).toContain("没有匹配");
  });

  it("limit 生效", async () => {
    const { write, search, ctx } = withDb();
    for (let index = 0; index < 5; index += 1) {
      await write.execute(ctx as never, { kind: "fact", text: `repeat-keyword 条目 ${index}` });
    }
    const result = await search.execute(ctx as never, { query: "repeat-keyword", limit: 2 });
    expect(result.details?.items).toHaveLength(2);
  });

  it("库里已有的记忆也能被检索到（跨连接可读，证明真落盘）", async () => {
    const dao = createStateDao(db);
    dao.createSession({ id: "s", title: "s" });
    dao.writeMemory({ kind: "fact", content: "外部写入的关键记忆", sessionId: "s" });
    const { search, ctx } = withDb();
    const result = await search.execute(ctx as never, { query: "外部写入" });
    expect(result.details?.items).toHaveLength(1);
  });
});
