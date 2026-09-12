/**
 * migrate 测试：账本 + 幂等 + DDL 约束生效。
 *
 * 覆盖：v1 建表/索引/FTS/触发器与记账、重跑幂等、checksum 篡改抛错、
 * 每版本一个事务（失败不留半套表）、CHECK/FK/UNIQUE 由库兜底。
 */
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  SCHEMA_VERSION,
  V1_SQL,
  V2_SQL,
  checksumOf,
  getAppliedVersions,
  migrate,
  nowSeconds,
} from "./index.js";
import type { Migration } from "./index.js";
import { createTempStateDb } from "./test-support.js";

/** 测试库的对象名清单（表 / 索引 / 触发器）。 */
function objectNames(db: DatabaseSync, type: string): string[] {
  return db
    .prepare(`SELECT name FROM sqlite_master WHERE type = '${type}' ORDER BY name`)
    .all()
    .map((row) => (row as { name: string }).name);
}

describe("migrate v1", () => {
  it("建齐 5 张表 + 索引 + FTS5 虚表 + 3 个同步触发器，并记账", () => {
    const temp = createTempStateDb();
    try {
      expect(temp.files().some((name) => name.endsWith(".sqlite"))).toBe(true);

      const tables = objectNames(temp.db, "table");
      for (const name of ["schema_migrations", "sessions", "messages", "memories", "audit_events"]) {
        expect(tables).toContain(name);
      }
      expect(tables).toContain("memories_fts");

      const indexes = objectNames(temp.db, "index");
      for (const name of [
        "idx_sessions_status_updated",
        "idx_messages_session_seq",
        "idx_memories_scope_kind",
        "idx_audit_session_ts",
        "idx_audit_run",
      ]) {
        expect(indexes).toContain(name);
      }

      const triggers = objectNames(temp.db, "trigger");
      for (const name of ["memories_fts_insert", "memories_fts_delete", "memories_fts_update"]) {
        expect(triggers).toContain(name);
      }

      const applied = getAppliedVersions(temp.db);
      expect(applied).toHaveLength(2);
      expect(applied[0]?.version).toBe(1);
      expect(applied[0]?.name).toBe("init_state_kernel");
      expect(applied[0]?.checksum).toBe(checksumOf(V1_SQL));
      expect(applied[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(applied[0]?.appliedAt).toBeLessThanOrEqual(nowSeconds());
      expect(applied[1]?.version).toBe(2);
      expect(applied[1]?.name).toBe("sessions_terminal_guard");
      expect(applied[1]?.checksum).toBe(checksumOf(V2_SQL));
    } finally {
      temp.cleanup();
    }
  });

  it("版本口径一致：SCHEMA_VERSION = 最新迁移版本 = LATEST_SCHEMA_VERSION（v2）", () => {
    expect(SCHEMA_VERSION).toBe(2);
    expect(LATEST_SCHEMA_VERSION).toBe(SCHEMA_VERSION);
    expect(MIGRATIONS.at(-1)?.version).toBe(SCHEMA_VERSION);
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2]);
    // v1 是已发布迁移：SQL 与名字都不许改（checksum 记账），v2 只能追加。
    expect(MIGRATIONS[0]?.name).toBe("init_state_kernel");
    expect(MIGRATIONS[0]?.sql).toBe(V1_SQL);
  });

  it("重跑幂等：不报错、不重复记账（applied 空 / skipped=[1,2] / 账本仍 2 行）", () => {
    const temp = createTempStateDb();
    try {
      const second = migrate(temp.db);
      expect(second.applied).toEqual([]);
      expect(second.skipped).toEqual([1, 2]);
      expect(getAppliedVersions(temp.db)).toHaveLength(2);

      const third = migrate(temp.db);
      expect(third.applied).toEqual([]);
      expect(getAppliedVersions(temp.db)).toHaveLength(2);
    } finally {
      temp.cleanup();
    }
  });

  it("已记账版本的 SQL 被改动 → 抛错（checksum 拦截，拒绝静默分叉）", () => {
    const temp = createTempStateDb();
    try {
      const tampered: Migration[] = [{ version: 1, name: "init_state_kernel", sql: `${V1_SQL}\n-- 事后改动` }];
      expect(() => migrate(temp.db, tampered)).toThrow(/checksum/);
      expect(getAppliedVersions(temp.db)).toHaveLength(2);
    } finally {
      temp.cleanup();
    }
  });

  it("每版本一个事务：后续版本失败时回滚，不留半套表", () => {
    const temp = createTempStateDb({ migrate: false });
    try {
      const list: Migration[] = [
        { version: 1, name: "init_state_kernel", sql: V1_SQL },
        { version: 2, name: "broken", sql: "CREATE TABLE half_baked (id TEXT);\nCREATE TABLE oops (" },
      ];
      expect(() => migrate(temp.db, list)).toThrow();
      expect(objectNames(temp.db, "table")).toContain("sessions");
      expect(objectNames(temp.db, "table")).not.toContain("half_baked");
      expect(getAppliedVersions(temp.db).map((record) => record.version)).toEqual([1]);
    } finally {
      temp.cleanup();
    }
  });

  it("CHECK 约束由库兜底：非法 status / role / scope / payload_meta 一律抛错", () => {
    const temp = createTempStateDb();
    const { db } = temp;
    try {
      db.prepare(
        "INSERT INTO sessions (id, status, created_at, updated_at) VALUES ('s-ok', 'active', 1, 1)",
      ).run();

      expect(() =>
        db
          .prepare("INSERT INTO sessions (id, status, created_at, updated_at) VALUES ('s-bad', 'weird', 1, 1)")
          .run(),
      ).toThrow(/CHECK/);

      expect(() =>
        db
          .prepare(
            "INSERT INTO messages (id, session_id, seq, role, created_at) VALUES ('m-bad', 's-ok', 1, 'robot', 1)",
          )
          .run(),
      ).toThrow(/CHECK/);

      expect(() =>
        db
          .prepare(
            "INSERT INTO memories (id, scope, kind, content, created_at, updated_at) VALUES ('mem-bad', 'galaxy', 'fact', 'x', 1, 1)",
          )
          .run(),
      ).toThrow(/CHECK/);

      expect(() =>
        db
          .prepare("INSERT INTO audit_events (ts, kind, payload_meta) VALUES (1, 'k', ?)")
          .run("x".repeat(2049)),
      ).toThrow(/CHECK/);

      // 库层约束兜底：外键（messages.session_id 指向不存在的会话）与 UNIQUE(session_id, seq)。
      expect(() =>
        db
          .prepare(
            "INSERT INTO messages (id, session_id, seq, role, created_at) VALUES ('m-fk', 'nope', 1, 'user', 1)",
          )
          .run(),
      ).toThrow(/FOREIGN KEY/);

      db.prepare(
        "INSERT INTO messages (id, session_id, seq, role, created_at) VALUES ('m-1', 's-ok', 1, 'user', 1)",
      ).run();
      expect(() =>
        db
          .prepare(
            "INSERT INTO messages (id, session_id, seq, role, created_at) VALUES ('m-2', 's-ok', 1, 'user', 1)",
          )
          .run(),
      ).toThrow(/UNIQUE/);
    } finally {
      temp.cleanup();
    }
  });
});

/**
 * v2（`sessions` 终态禁回退触发器）：t4 §4「终态不可降级」的 **DB 层**闭环。
 *
 * 判定口径（AT-503 数据层）：绕过 DAO 的原始 SQL 回退必须**抛错且行不变**；
 * 正常归档（active→archived）/ 同值重放（archived→archived）/ 非 status 列的更新不受影响；
 * v1 老库直接 `migrate()` 自动补 v2，**不需要重建库**、数据不丢、v1 记账 checksum 不变。
 */
describe("migrate v2（sessions 终态禁回退）", () => {
  /** 库里会话行的最终状态（行不变断言用）。 */
  function statusOf(db: DatabaseSync, id: string): string {
    const row = db.prepare("SELECT status FROM sessions WHERE id = ?").get(id) as
      | { status?: string }
      | undefined;
    return row?.status ?? "<missing>";
  }

  it("向后兼容：v1 老库（只跑 v1）→ migrate() 只补 v2，v1 记账不变、数据不丢", () => {
    const temp = createTempStateDb({ migrate: false });
    const { db } = temp;
    try {
      // ① 老库形状：只有 v1 的账本。
      expect(migrate(db, [{ version: 1, name: "init_state_kernel", sql: V1_SQL }]).applied).toEqual([1]);
      // ② v1 时期写下的数据（产品库存量就是这个形状）。
      db.prepare(
        "INSERT INTO sessions (id, title, status, created_at, updated_at) VALUES ('s-old','老会话','active',10,10)",
      ).run();
      db.prepare(
        "INSERT INTO messages (id, session_id, seq, role, content, created_at) VALUES ('m-old','s-old',1,'user','历史消息',10)",
      ).run();
      db.prepare(
        "INSERT INTO memories (id, scope, kind, content, created_at, updated_at) VALUES ('mem-old','global','fact','历史记忆',10,10)",
      ).run();
      db.prepare("INSERT INTO audit_events (ts, kind) VALUES (10,'run_start')").run();
      const v1Checksum = getAppliedVersions(db)[0]?.checksum;

      // ③ 升版：只补 v2（v1 已记账 → skipped），不需要重建库、不需要手工 SQL。
      const upgraded = migrate(db);
      expect(upgraded.applied).toEqual([2]);
      expect(upgraded.skipped).toEqual([1]);
      const ledger = getAppliedVersions(db);
      expect(ledger.map((record) => record.version)).toEqual([1, 2]);
      expect(ledger[0]?.checksum).toBe(v1Checksum);
      expect(ledger[0]?.checksum).toBe(checksumOf(V1_SQL));
      expect(ledger[1]?.checksum).toBe(checksumOf(V2_SQL));
      expect(objectNames(db, "trigger")).toContain("sessions_no_status_regression");

      // ④ 数据不丢：v1 时期的行全在，且读得到。
      expect((db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n).toBe(1);
      expect((db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n).toBe(1);
      expect((db.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number }).n).toBe(1);
      expect((db.prepare("SELECT content FROM messages WHERE id = 'm-old'").get() as { content: string }).content).toBe("历史消息");
      expect(statusOf(db, "s-old")).toBe("active");

      // ⑤ 补完 v2 后重跑仍幂等（不重复记账）。
      expect(migrate(db)).toEqual({ applied: [], skipped: [1, 2] });
    } finally {
      temp.cleanup();
    }
  });

  it("v2 迁移可应用且幂等：触发器在库中存在，重跑不重复建、不重复记账", () => {
    const temp = createTempStateDb();
    try {
      expect(objectNames(temp.db, "trigger")).toContain("sessions_no_status_regression");
      const again = migrate(temp.db);
      expect(again).toEqual({ applied: [], skipped: [1, 2] });
      // 触发器唯一（IF NOT EXISTS + 不重复执行），不会出现同名两条。
      const rows = temp.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?")
        .all("sessions_no_status_regression");
      expect(rows).toHaveLength(1);
    } finally {
      temp.cleanup();
    }
  });

  it("原始 SQL 回退注入：archived → active 抛错，且该行仍是 archived（行不变）", () => {
    const temp = createTempStateDb();
    const { db } = temp;
    try {
      db.prepare(
        "INSERT INTO sessions (id, title, status, created_at, updated_at, archived_at) VALUES ('s-a','已归档','archived',10,10,10)",
      ).run();
      db.prepare(
        "INSERT INTO sessions (id, status, created_at, updated_at) VALUES ('s-b','active',11,11)",
      ).run();

      expect(() => db.prepare("UPDATE sessions SET status = 'active' WHERE status = 'archived'").run()).toThrow(
        /terminal status immutable/,
      );
      // 行不变：状态、archived_at 都没被动过（不是"改了一半"）。
      expect(statusOf(db, "s-a")).toBe("archived");
      const row = db.prepare("SELECT archived_at FROM sessions WHERE id = 's-a'").get() as {
        archived_at: number;
      };
      expect(row.archived_at).toBe(10);
      expect((db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(2);

      // 逐行 id 定向回退同样被拦（不是只拦整表 UPDATE）。
      expect(() =>
        db.prepare("UPDATE sessions SET status = 'active' WHERE id = 's-a'").run(),
      ).toThrow(/terminal status immutable/);
      expect(statusOf(db, "s-a")).toBe("archived");
    } finally {
      temp.cleanup();
    }
  });

  it("正常路径不受影响：active→archived 成功；归档行的非 status 列照常可更新", () => {
    const temp = createTempStateDb();
    const { db } = temp;
    try {
      db.prepare(
        "INSERT INTO sessions (id, title, status, created_at, updated_at) VALUES ('s-b','待归档','active',11,11)",
      ).run();
      // 正常归档（原始 SQL 路径）：触发器 WHEN 不成立。
      db.prepare(
        "UPDATE sessions SET status = 'archived', archived_at = 12, updated_at = 12 WHERE id = 's-b' AND status = 'active'",
      ).run();
      expect(statusOf(db, "s-b")).toBe("archived");

      // 归档行改标题（不涉及 status 列）：`UPDATE OF status` 不拦。
      db.prepare("UPDATE sessions SET title = '改名' WHERE id = 's-b'").run();
      expect((db.prepare("SELECT title FROM sessions WHERE id = 's-b'").get() as { title: string }).title).toBe("改名");
      expect(statusOf(db, "s-b")).toBe("archived");
    } finally {
      temp.cleanup();
    }
  });

  it("同值重放不是回退：archived → archived 的 UPDATE 成功（幂等归档不被触发器误伤）", () => {
    const temp = createTempStateDb();
    const { db } = temp;
    try {
      db.prepare(
        "INSERT INTO sessions (id, status, created_at, updated_at, archived_at) VALUES ('s-a','archived',10,10,10)",
      ).run();
      db.prepare("UPDATE sessions SET status = 'archived', updated_at = 20 WHERE id = 's-a'").run();
      expect(statusOf(db, "s-a")).toBe("archived");
      expect((db.prepare("SELECT updated_at FROM sessions WHERE id = 's-a'").get() as { updated_at: number }).updated_at).toBe(20);
    } finally {
      temp.cleanup();
    }
  });
});
