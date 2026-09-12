/**
 * governance 测试：终态门禁 + CAS 领取原语。
 *
 * CAS 用**独立测试表**验证（`claim_probe`）：M1 不往 MVP 表加 claim 列，
 * M2 `tasks` 表按同形状复用这两个原语。
 */
import { describe, expect, it } from "vitest";
import {
  createStateDao,
  releaseClaim,
  shouldApplySessionStatus,
  tryClaim,
} from "./index.js";
import { createTempStateDb, type TempStateDb } from "./test-support.js";

/** CAS 目标表的形状（M2 `tasks` 表同列名）。 */
const PROBE_DDL = `CREATE TABLE claim_probe (
  id TEXT PRIMARY KEY, claim_lock TEXT, claim_expires_at INTEGER, claimed_at INTEGER);`;

function withProbe(run: (temp: TempStateDb) => void): void {
  const temp = createTempStateDb();
  try {
    temp.db.exec(PROBE_DDL);
    temp.db.prepare("INSERT INTO claim_probe (id) VALUES ('task-1'), ('task-2')").run();
    run(temp);
  } finally {
    temp.cleanup();
  }
}

describe("shouldApplySessionStatus（终态不可降级）", () => {
  it("active → archived 放行；archived → active 拒绝并保留原值（不抛错）", () => {
    expect(shouldApplySessionStatus("active", "archived")).toEqual({ apply: true, status: "archived" });
    expect(shouldApplySessionStatus("archived", "active")).toEqual({
      apply: false,
      status: "archived",
      reason: "terminal_immutable",
    });
  });

  it("相同值幂等放行（active→active / archived→archived）", () => {
    expect(shouldApplySessionStatus("active", "active")).toEqual({ apply: true, status: "active" });
    expect(shouldApplySessionStatus("archived", "archived")).toEqual({ apply: true, status: "archived" });
  });

  it("未知值 fail-closed：current 或 next 不在词表内一律拒绝且保留原值", () => {
    expect(shouldApplySessionStatus("sleeping", "archived")).toEqual({
      apply: false,
      status: "sleeping",
      reason: "unknown_status",
    });
    expect(shouldApplySessionStatus("active", "sleeping")).toEqual({
      apply: false,
      status: "active",
      reason: "unknown_status",
    });
    expect(shouldApplySessionStatus("", "")).toEqual({
      apply: false,
      status: "",
      reason: "unknown_status",
    });
  });
});

describe("tryClaim / releaseClaim（CAS 领取）", () => {
  it("claim 成功 → 重复 claim 失败 → 过期后新 lock 抢到 → release 后可再领", () => {
    withProbe((temp) => {
      const { db } = temp;
      // 1) 首次领取成功。
      expect(tryClaim(db, "claim_probe", "id", "task-1", "lock-a", 30, 1_000)).toBe(true);
      // 2) 未过期时第二个执行者抢输（不重复执行）。
      expect(tryClaim(db, "claim_probe", "id", "task-1", "lock-b", 30, 1_010)).toBe(false);
      // 3) TTL 到期后允许 reclaim（过期锁不阻塞）。
      expect(tryClaim(db, "claim_probe", "id", "task-1", "lock-b", 30, 1_031)).toBe(true);
      // 4) 释放后回到可领取状态。
      expect(releaseClaim(db, "claim_probe", "id", "task-1", "lock-b")).toBe(true);
      expect(tryClaim(db, "claim_probe", "id", "task-1", "lock-c", 30, 1_040)).toBe(true);
    });
  });

  it("claim 在库里有痕迹（claimed_at/claim_expires_at/claim_lock 三件套落值）", () => {
    withProbe((temp) => {
      const { db } = temp;
      expect(tryClaim(db, "claim_probe", "id", "task-1", "lock-a", 60, 5_000)).toBe(true);
      const row = db
        .prepare("SELECT claim_lock, claimed_at, claim_expires_at FROM claim_probe WHERE id = 'task-1'")
        .get() as { claim_lock: string; claimed_at: number; claim_expires_at: number };
      expect(row.claim_lock).toBe("lock-a");
      expect(row.claimed_at).toBe(5_000);
      expect(row.claim_expires_at).toBe(5_060);
    });
  });

  it("releaseClaim 只认自己的 lock；不存在的行 / 别人的 lock 都不算释放成功", () => {
    withProbe((temp) => {
      const { db } = temp;
      expect(tryClaim(db, "claim_probe", "id", "task-1", "lock-a", 30, 1_000)).toBe(true);
      expect(releaseClaim(db, "claim_probe", "id", "task-1", "lock-other")).toBe(false);
      expect(tryClaim(db, "claim_probe", "id", "task-1", "lock-b", 30, 1_005)).toBe(false);
      expect(releaseClaim(db, "claim_probe", "id", "task-1", "lock-a")).toBe(true);
      expect(releaseClaim(db, "claim_probe", "id", "task-1", "lock-a")).toBe(false);
      expect(releaseClaim(db, "claim_probe", "id", "ghost", "lock-a")).toBe(false);
    });
  });

  it("领取是行级隔离：一个 row 被抢不影响另一个 row", () => {
    withProbe((temp) => {
      const { db } = temp;
      expect(tryClaim(db, "claim_probe", "id", "task-1", "lock-a", 30, 1_000)).toBe(true);
      expect(tryClaim(db, "claim_probe", "id", "task-2", "lock-b", 30, 1_000)).toBe(true);
      expect(tryClaim(db, "claim_probe", "id", "task-2", "lock-c", 30, 1_000)).toBe(false);
    });
  });

  it("表名/列名必须是有界标识符（拼 SQL 前拦注入）", () => {
    withProbe((temp) => {
      const { db } = temp;
      expect(() => tryClaim(db, "claim_probe; DROP TABLE sessions", "id", "x", "l", 1)).toThrow(/标识符/);
      expect(() => tryClaim(db, "claim_probe", "id --", "x", "l", 1)).toThrow(/标识符/);
      expect(() => releaseClaim(db, "claim_probe", "1bad", "x", "l")).toThrow(/标识符/);
    });
  });

  it("CAS 不污染 MVP 表：sessions 上没有 claim_* 列（M2 tasks 才用）", () => {
    withProbe((temp) => {
      const columns = temp.db
        .prepare("PRAGMA table_info(sessions)")
        .all()
        .map((row) => (row as { name: string }).name);
      expect(columns.filter((name) => name.startsWith("claim"))).toEqual([]);
      expect(columns).toContain("archived_at");
      expect(createStateDao(temp.db).listSessions()).toEqual([]);
    });
  });
});
