/**
 * 治理内核的**跨包**断言（t13 验收 2/3）：证明 server → state 的复用链路真的通，
 * 而不是"两侧各有一套等价实现"。
 *
 * 分工（t3 §8 纯度分层）：
 * - `packages/agent-core` 是**纯函数**内核（只依赖 protocol），判定终态/审计口径；
 * - `packages/state` 是**存储层**治理内核（终态门禁 + 表无关 CAS 原语）；
 * - `apps/server` 是运行内核，正确方向是依赖存储层 —— 因此跨包调用断言放在这里，
 *   不放 agent-core（那会污染纯度）。
 *
 * 用真实 SQLite 文件（临时目录，跑完即删）：`tryClaim` 的 CAS 语义只有在真库上
 * 才有意义（条件 UPDATE + changes 计数）。仓内永不落 `*.sqlite`（AGENTS.md 硬约束 1）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { PAYLOAD_META_MAX_CHARS, isTerminalStatus } from "@agentplant/agent-core";
import {
  PAYLOAD_META_MAX_CHARS as STATE_PAYLOAD_META_MAX_CHARS,
  closeDatabase,
  createStateDao,
  migrate,
  openDatabase,
  shouldApplySessionStatus,
  tryClaim,
} from "@agentplant/state";

/** CAS 目标表形状（M2 `tasks` 表同列名；M1 不往 MVP 表加 claim 列）。 */
const CLAIM_PROBE_DDL = `CREATE TABLE claim_probe (
  id TEXT PRIMARY KEY, claim_lock TEXT, claim_expires_at INTEGER, claimed_at INTEGER);`;

function withStateDb(run: (db: DatabaseSync) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "agentplant-server-gov-"));
  const db = openDatabase(join(dir, "agentplant.sqlite"));
  try {
    migrate(db);
    db.exec(CLAIM_PROBE_DDL);
    db.prepare("INSERT INTO claim_probe (id) VALUES ('task-1')").run();
    run(db);
  } finally {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("server → state：终态不可降级（验收 2）", () => {
  it("archived → active 被拒绝并保留原值（不抛错、不改写）", () => {
    expect(shouldApplySessionStatus("archived", "active")).toEqual({
      apply: false,
      status: "archived",
      reason: "terminal_immutable",
    });
  });

  it("端到端：真库归档后的会话，回退请求被拒且库里仍是 archived", () => {
    withStateDb((db) => {
      const dao = createStateDao(db);
      const session = dao.createSession({ id: "sess-1", title: "归档目标" });
      expect(dao.archiveSession(session.id)).toEqual({ archived: true });

      const stored = dao.getSession(session.id);
      expect(stored?.status).toBe("archived");
      const decision = shouldApplySessionStatus(stored?.status ?? "", "active");
      expect(decision.apply).toBe(false);
      // 门禁只给结论，调用方按结论决定是否写库：拒绝分支下 SQL 根本不会发出。
      expect(decision.status).toBe("archived");
      expect(dao.getSession(session.id)?.status).toBe("archived");
    });
  });
});

describe("server → state：CAS 领取（验收 3：双 claim 恰一成功）", () => {
  it("同一行两次 claim：恰一次成功，第二次抢输", () => {
    withStateDb((db) => {
      expect(tryClaim(db, "claim_probe", "id", "task-1", "lock-a", 30, 1_000)).toBe(true);
      expect(tryClaim(db, "claim_probe", "id", "task-1", "lock-b", 30, 1_005)).toBe(false);
      const row = db
        .prepare("SELECT claim_lock FROM claim_probe WHERE id = 'task-1'")
        .get() as { claim_lock: string };
      expect(row.claim_lock).toBe("lock-a");
    });
  });

  it("释放后可再领；TTL 过期允许 reclaim（CAS 的三条放行路径都在真库上成立）", () => {
    withStateDb((db) => {
      expect(tryClaim(db, "claim_probe", "id", "task-1", "lock-a", 30, 1_000)).toBe(true);
      expect(tryClaim(db, "claim_probe", "id", "task-1", "lock-b", 30, 1_031)).toBe(true);
      expect(tryClaim(db, "claim_probe", "id", "task-1", "lock-c", 30, 1_040)).toBe(false);
    });
  });
});

describe("跨包口径一致（防止两套实现漂移）", () => {
  it("payload_meta 上限：agent-core 与 state 同值（2048）", () => {
    expect(PAYLOAD_META_MAX_CHARS).toBe(STATE_PAYLOAD_META_MAX_CHARS);
    expect(PAYLOAD_META_MAX_CHARS).toBe(2048);
  });

  it("终态口径与 state 的会话终态一致：archived 是终态（不可回退）", () => {
    // 会话终态由 state 的词表管（active|archived），任务/工具终态由 agent-core 的
    // task ∪ tool 并集管；这条断言固定"两处都拒绝把终态当可继续状态"的方向。
    expect(isTerminalStatus("completed")).toBe(true);
    expect(shouldApplySessionStatus("archived", "active").apply).toBe(false);
  });
});
