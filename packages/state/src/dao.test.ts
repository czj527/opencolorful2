/**
 * dao 测试：5 张表的同步读写语义（真实文件库，每用例一个 tmpdir 库，跑完删目录）。
 *
 * 覆盖：sessions 生命周期、messages seq 幂等与 since 水位、归档终态不可回退、
 * memories 作用域默认与 FTS 写→查→删→查无、列表浏览（listMemories/countMemories 的
 * 排序与分页 clamp）、audit 元数据上限与游标 tail。
 */
import { describe, expect, it } from "vitest";
import {
  PAYLOAD_META_MAX_CHARS,
  createStateDao,
  nowSeconds,
  type StateDao,
} from "./index.js";
import { createTempStateDb, type TempStateDb } from "./test-support.js";

/** 建库 + DAO；用例内手动 cleanup（已 try/finally 包住，失败也不留文件）。 */
function withDao(run: (dao: StateDao, temp: TempStateDb) => void): void {
  const temp = createTempStateDb();
  try {
    run(createStateDao(temp.db), temp);
  } finally {
    temp.cleanup();
  }
}

describe("sessions DAO", () => {
  it("createSession 落库并可读回；时间戳是 unix 秒且 status=active", () => {
    withDao((dao) => {
      const session = dao.createSession({ title: "咖啡偏好", model: "m1", provider: "p1", cwd: "D:\\w" });
      expect(session.title).toBe("咖啡偏好");
      expect(session.status).toBe("active");
      expect(session.archivedAt).toBeNull();
      // 秒级口径：毫秒值会是 1e12 量级，这里必须小于 1e10；容差 1s 避免跨秒抖动。
      expect(Math.abs(session.createdAt - nowSeconds())).toBeLessThanOrEqual(1);
      expect(session.updatedAt).toBe(session.createdAt);
      expect(session.createdAt).toBeLessThan(10_000_000_000);

      expect(dao.getSession(session.id)).toEqual(session);
      expect(dao.getSession("nope")).toBeNull();
    });
  });

  it("listSessions 按 status 过滤，按 updated_at 倒序", () => {
    withDao((dao) => {
      const first = dao.createSession({ id: "s-1", title: "一", createdAt: 100 });
      const second = dao.createSession({ id: "s-2", title: "二", createdAt: 200 });
      expect(dao.listSessions().map((row) => row.id)).toEqual(["s-2", "s-1"]);
      expect(dao.listSessions("active").map((row) => row.id)).toEqual(["s-2", "s-1"]);
      expect(dao.listSessions("archived")).toEqual([]);

      expect(dao.archiveSession(first.id).archived).toBe(true);
      expect(dao.listSessions("archived").map((row) => row.id)).toEqual(["s-1"]);
      expect(dao.listSessions("active").map((row) => row.id)).toEqual(["s-2"]);
      expect(dao.getSession(second.id)?.status).toBe("active");
    });
  });

  it("archiveSession：active→archived 落 archived_at；再次归档幂等成功且状态不回退", () => {
    withDao((dao) => {
      const session = dao.createSession({ id: "s-1" });
      const first = dao.archiveSession(session.id);
      expect(first).toEqual({ archived: true });
      const archived = dao.getSession(session.id);
      expect(archived?.status).toBe("archived");
      expect(archived?.archivedAt).not.toBeNull();
      expect(Math.abs((archived?.archivedAt ?? 0) - nowSeconds())).toBeLessThanOrEqual(1);

      const again = dao.archiveSession(session.id);
      expect(again).toEqual({ archived: true });
      expect(dao.getSession(session.id)?.status).toBe("archived");

      expect(dao.archiveSession("missing")).toEqual({ archived: false, reason: "not_found" });
    });
  });

  it("归档是单向的：DAO 上不存在 unarchive/restore 之类入口（编译期 + 运行期双保险）", () => {
    withDao((dao) => {
      // 编译期：StateDao 一旦新增 unarchive* 方法，下面这行就会类型报错（LOC 级的回归护栏）。
      type Forbidden = Extract<keyof StateDao, "unarchive" | "unarchiveSession" | "restoreSession">;
      const noUnarchiveApi: Forbidden extends never ? true : false = true;
      expect(noUnarchiveApi).toBe(true);

      // 运行期：方法名里也不该出现 unarchive/restore。
      const methodNames = Object.keys(dao);
      expect(methodNames.filter((name) => /unarchive|restore/i.test(name))).toEqual([]);
    });
  });

  it("库层第二道防线不误伤产品路径：archiveSession 正常走通，绕过 DAO 的回退被库拦下", () => {
    withDao((dao, temp) => {
      const session = dao.createSession({ id: "s-1" });
      // 产品路径：active → archived（v2 触发器的 WHEN 已排除这一迁移，故不受影响）。
      expect(dao.archiveSession(session.id)).toEqual({ archived: true });
      expect(dao.getSession(session.id)?.status).toBe("archived");

      // 绕过 DAO 的原始 SQL 回退：库层抛错，行仍为 archived。
      // DAO 刻意不 catch 这个错误——真被拦下说明有人在回退终态，必须显式失败（静默吞掉=假绿）。
      expect(() =>
        temp.db.prepare("UPDATE sessions SET status = 'active' WHERE id = 's-1'").run(),
      ).toThrow(/terminal status immutable/);
      expect(dao.getSession(session.id)?.status).toBe("archived");
    });
  });
});

describe("messages DAO", () => {
  it("appendMessage 幂等：同 (sessionId, seq) 第二次 inserted=false，且库里只有一行", () => {
    withDao((dao, temp) => {
      const session = dao.createSession({ id: "s-1" });
      const first = dao.appendMessage({ sessionId: session.id, seq: 1, role: "user", content: "你好" });
      expect(first.inserted).toBe(true);

      const second = dao.appendMessage({ sessionId: session.id, seq: 1, role: "user", content: "重放" });
      expect(second.inserted).toBe(false);
      expect(second.id).not.toBe(first.id);

      const rows = dao.listMessages(session.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.content).toBe("你好");

      const count = temp.db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number };
      expect(count.n).toBe(1);
    });
  });

  it("listMessages 按 seq 升序；since 是水位（只回 seq > since）", () => {
    withDao((dao) => {
      const session = dao.createSession({ id: "s-1" });
      for (const seq of [3, 1, 2]) {
        dao.appendMessage({ sessionId: session.id, seq, role: seq === 2 ? "assistant" : "user", content: `m${seq}` });
      }
      expect(dao.listMessages(session.id).map((row) => row.seq)).toEqual([1, 2, 3]);
      expect(dao.listMessages(session.id, 1).map((row) => row.seq)).toEqual([2, 3]);
      expect(dao.listMessages(session.id, 3)).toEqual([]);
      expect(dao.listMessages(session.id)[1]?.role).toBe("assistant");
    });
  });

  it("工具消息字段（toolName/toolCallId）与 token 计数原样存取", () => {
    withDao((dao) => {
      const session = dao.createSession({ id: "s-1" });
      dao.appendMessage({
        sessionId: session.id,
        seq: 1,
        role: "tool",
        toolName: "read_file",
        toolCallId: "call-1",
        tokenIn: 12,
        tokenOut: 34,
      });
      const row = dao.listMessages(session.id)[0];
      expect(row?.toolName).toBe("read_file");
      expect(row?.toolCallId).toBe("call-1");
      expect(row?.tokenIn).toBe(12);
      expect(row?.tokenOut).toBe(34);
      expect(row?.content).toBeNull();
    });
  });

  it("外键与级联：不存在的会话拒绝写入；删会话级联删消息", () => {
    withDao((dao, temp) => {
      expect(() => dao.appendMessage({ sessionId: "ghost", seq: 1, role: "user" })).toThrow(/FOREIGN KEY/);

      const session = dao.createSession({ id: "s-1" });
      dao.appendMessage({ sessionId: session.id, seq: 1, role: "user", content: "x" });
      temp.db.prepare("DELETE FROM sessions WHERE id = ?").run(session.id);
      expect(dao.listMessages(session.id)).toEqual([]);
    });
  });
});

describe("memories DAO（含 FTS5）", () => {
  it("writeMemory 的 scope 默认：有 sessionId → session，否则 global", () => {
    withDao((dao) => {
      const session = dao.createSession({ id: "s-1" });
      const scoped = dao.writeMemory({ kind: "fact", content: "dark roast", sessionId: session.id });
      const global = dao.writeMemory({ kind: "preference", content: "prefers tea" });
      expect(scoped.scope).toBe("session");
      expect(scoped.sessionId).toBe("s-1");
      expect(global.scope).toBe("global");
      expect(global.sessionId).toBeNull();
      expect(global.createdAt).toBeLessThan(10_000_000_000);
    });
  });

  it("FTS5 写 → 查 → 删 → 查无（触发器同步，DAO 不手写 FTS 维护）", () => {
    withDao((dao, temp) => {
      const written = dao.writeMemory({ kind: "fact", content: "user prefers dark roast coffee" });
      expect(dao.searchMemories("roast").map((row) => row.id)).toEqual([written.id]);
      // 前缀命中（末位 token 前缀），且引号/星号等 FTS 语法字符不会把查询打成语法错误。
      expect(dao.searchMemories("roas").map((row) => row.id)).toEqual([written.id]);
      expect(dao.searchMemories('dark "roast"').map((row) => row.id)).toEqual([written.id]);

      const ftsRows = temp.db.prepare("SELECT COUNT(*) AS n FROM memories_fts").get() as { n: number };
      expect(ftsRows.n).toBe(1);

      expect(dao.forgetMemory(written.id)).toBe(true);
      expect(dao.searchMemories("roast")).toEqual([]);
      const afterDelete = temp.db.prepare("SELECT COUNT(*) AS n FROM memories_fts").get() as { n: number };
      expect(afterDelete.n).toBe(0);
    });
  });

  it("searchMemories：空/纯空白 query 回 []（不抛错）；scope/kind/limit 过滤生效", () => {
    withDao((dao) => {
      const session = dao.createSession({ id: "s-1" });
      expect(dao.searchMemories("")).toEqual([]);
      expect(dao.searchMemories("   ")).toEqual([]);

      dao.writeMemory({ kind: "fact", content: "alpha roast", sessionId: session.id });
      dao.writeMemory({ kind: "preference", content: "alpha tea" });
      dao.writeMemory({ kind: "fact", content: "alpha cake" });

      expect(dao.searchMemories("alpha")).toHaveLength(3);
      expect(dao.searchMemories("alpha", { kind: "preference" }).map((row) => row.content)).toEqual(["alpha tea"]);
      expect(dao.searchMemories("alpha", { scope: "session" }).map((row) => row.content)).toEqual(["alpha roast"]);
      expect(dao.searchMemories("alpha", { limit: 1 })).toHaveLength(1);
      expect(dao.searchMemories("alpha", { limit: 2 })).toHaveLength(2);
    });
  });

  it("forgetMemory 未知 id 不报错、返回 false（幂等删）", () => {
    withDao((dao) => {
      expect(dao.forgetMemory("missing")).toBe(false);
      const written = dao.writeMemory({ kind: "fact", content: "beta" });
      expect(dao.forgetMemory(written.id)).toBe(true);
      expect(dao.forgetMemory(written.id)).toBe(false);
    });
  });

  it("listMemories：created_at 倒序、limit 缺省 50 / 上限 200、offset 负数归 0", () => {
    withDao((dao, temp) => {
      // 显式时间戳（unix 秒）需要绕过 `writeMemory`：它固定用 nowSeconds()，
      // 因此这里直接写库（同一张表、同一个触发器面），只为把排序口径钉死。
      const insert = temp.db.prepare(
        `INSERT INTO memories (id, session_id, scope, kind, content, source_msg_id, confidence,
                               created_at, updated_at, expires_at)
         VALUES (?, NULL, 'global', ?, ?, NULL, NULL, ?, ?, NULL)`,
      );
      for (let index = 1; index <= 210; index += 1) {
        insert.run(`m-${String(index).padStart(3, "0")}`, "fact", `记忆 ${index}`, index, index);
      }

      const defaulted = dao.listMemories();
      expect(defaulted).toHaveLength(50);
      // 倒序：最新的（created_at 最大）在最前。
      expect(defaulted[0]?.id).toBe("m-210");
      expect(defaulted.at(-1)?.id).toBe("m-161");

      // 上限 clamp：要 500 条也只给 200 条（不把整库拉进内存）。
      expect(dao.listMemories({ limit: 500 })).toHaveLength(200);
      expect(dao.listMemories({ limit: 200 })).toHaveLength(200);
      // 非法 limit（0/负数/NaN）回落到默认 50，而不是"返回空"或"返回全部"。
      expect(dao.listMemories({ limit: 0 })).toHaveLength(50);
      expect(dao.listMemories({ limit: Number.NaN })).toHaveLength(50);

      // offset 分页：第二页从第 51 条起（offset 负数按 0 处理，不透传给 SQLite）。
      const secondPage = dao.listMemories({ offset: 50 });
      expect(secondPage[0]?.id).toBe("m-160");
      expect(dao.listMemories({ offset: -5 })[0]?.id).toBe("m-210");

      // countMemories 是**全量**条数：limit/offset 不影响它。
      expect(dao.countMemories()).toBe(210);
    });
  });

  it("listMemories / countMemories 的 scope/kind 过滤口径一致（total 与 items 同源）", () => {
    withDao((dao) => {
      const session = dao.createSession({ id: "s-1" });
      dao.writeMemory({ kind: "fact", content: "alpha", sessionId: session.id });
      dao.writeMemory({ kind: "preference", content: "beta" });
      dao.writeMemory({ kind: "fact", content: "gamma" });

      expect(dao.listMemories()).toHaveLength(3);
      expect(dao.countMemories()).toBe(3);
      expect(dao.listMemories({ kind: "fact" }).map((row) => row.content).sort()).toEqual([
        "alpha",
        "gamma",
      ]);
      expect(dao.countMemories({ kind: "fact" })).toBe(2);
      expect(dao.listMemories({ scope: "session" }).map((row) => row.content)).toEqual(["alpha"]);
      expect(dao.countMemories({ scope: "session" })).toBe(1);
      expect(dao.countMemories({ scope: "session", kind: "preference" })).toBe(0);
      // 过滤后 limit 仍生效，total 仍是过滤后的全量（不是当页条数）。
      expect(dao.listMemories({ kind: "fact", limit: 1 })).toHaveLength(1);
      expect(dao.countMemories({ kind: "fact" })).toBe(2);

      expect(dao.forgetMemory(dao.listMemories({ kind: "fact" })[0]?.id ?? "")).toBe(true);
      expect(dao.countMemories()).toBe(2);
    });
  });
});

describe("audit DAO（只记元数据）", () => {
  it("appendAudit 落库并回读；payloadMeta 超 2048 字符直接抛错（不截断、不留半条）", () => {
    withDao((dao, temp) => {
      const session = dao.createSession({ id: "s-1" });
      const event = dao.appendAudit({
        sessionId: session.id,
        runId: "run-1",
        kind: "tool_call",
        actor: "agent",
        subjectId: "read_file",
        status: "ok",
        durationMs: 12,
        bytesIn: 10,
        bytesOut: 20,
        payloadMeta: JSON.stringify({ tool: "read_file", path: "sandbox/a.md" }),
      });
      expect(event.id).toBeGreaterThan(0);
      expect(event.kind).toBe("tool_call");
      expect(event.ts).toBeLessThan(10_000_000_000);

      expect(() =>
        dao.appendAudit({ kind: "tool_call", payloadMeta: "x".repeat(PAYLOAD_META_MAX_CHARS + 1) }),
      ).toThrow(/payloadMeta/);

      const count = temp.db.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number };
      expect(count.n).toBe(1); // 抛错的那次没有留下记录
    });
  });

  it("tailAudit 按 id 升序游标：afterId 不含本身，可按 sessionId 过滤与 limit 截断", () => {
    withDao((dao) => {
      const session = dao.createSession({ id: "s-1" });
      const ids = [
        dao.appendAudit({ kind: "run_start", sessionId: session.id, ts: 10 }).id,
        dao.appendAudit({ kind: "tool_call", sessionId: session.id, ts: 11 }).id,
        dao.appendAudit({ kind: "run_end", ts: 12 }).id,
      ];
      expect(dao.tailAudit().map((row) => row.id)).toEqual(ids);
      expect(dao.tailAudit({ afterId: ids[0] }).map((row) => row.id)).toEqual([ids[1], ids[2]]);
      expect(dao.tailAudit({ sessionId: session.id }).map((row) => row.id)).toEqual([ids[0], ids[1]]);
      expect(dao.tailAudit({ limit: 1 }).map((row) => row.id)).toEqual([ids[0]]);
      expect(dao.tailAudit({ afterId: ids[2] })).toEqual([]);
    });
  });
});
