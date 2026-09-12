/**
 * purity 测试：把 AGENTS.md 的硬约束变成**可执行的回归断言**（读源码文本，不做行为推断）。
 *
 * - 硬约束 1：SQLite 唯一存储 → 生产源码不得出现 redis/mongo/MQ/其它 DB 驱动，
 *   也不得为了 JSON 落盘去 import `node:fs`。
 * - 硬约束 2：`packages/*` 禁 import `apps/*`。
 * - t4 §4 事务纪律：`node:sqlite` 是同步 API → 生产源码里不出现 `await`。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));

/** 生产源码 = 非测试文件（测试脚手架可以读文件系统，产品路径不行）。 */
function productionSources(): { readonly name: string; readonly text: string }[] {
  return readdirSync(SRC_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "test-support.ts")
    .sort()
    .map((name) => ({ name, text: readFileSync(join(SRC_DIR, name), "utf8") }));
}

/** 去注释后再扫：注释里出现 `await`/`redis` 这类词不算违规（文档会提到它们）。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function importSpecifiers(text: string): string[] {
  const specifiers = [...text.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] ?? "");
  const dynamic = [...text.matchAll(/import\s*\(\s*"([^"]+)"/g)].map((match) => match[1] ?? "");
  const requires = [...text.matchAll(/require\s*\(\s*"([^"]+)"/g)].map((match) => match[1] ?? "");
  return [...specifiers, ...dynamic, ...requires];
}

const FORBIDDEN_DRIVERS = [
  "redis",
  "ioredis",
  "mongodb",
  "mongoose",
  "kafkajs",
  "amqplib",
  "better-sqlite3",
  "sqlite3",
  "pg",
  "mysql",
  "mysql2",
  "@libsql/client",
];

describe("零旁路（AGENTS.md 硬约束 1）", () => {
  it("生产源码不 import 任何非 SQLite 存储驱动（redis/mongo/MQ/其它 DB）", () => {
    const found: string[] = [];
    for (const file of productionSources()) {
      for (const specifier of importSpecifiers(file.text)) {
        const bare = specifier.replace(/^node:/, "").split("/")[0] ?? "";
        if (FORBIDDEN_DRIVERS.includes(bare)) {
          found.push(`${file.name} → ${specifier}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it("生产源码不 import node:fs（没有 JSON/文件落盘旁路；测试脚手架除外）", () => {
    const withFs = productionSources()
      .filter((file) => importSpecifiers(file.text).some((specifier) => /^node:fs/.test(specifier)))
      .map((file) => file.name);
    expect(withFs).toEqual([]);
  });

  it("唯一存储驱动是 node:sqlite，且只有 db.ts 真正 import 它的运行期值（其余为 type-only）", () => {
    const users = productionSources()
      .filter((file) => importSpecifiers(file.text).includes("node:sqlite"))
      .map((file) => file.name)
      .sort();
    expect(users).toEqual(["dao.ts", "db.ts", "governance.ts", "migrate.ts"]);

    const valueImports = productionSources()
      .filter((file) => /import\s*\{[^}]*\}\s*from\s*"node:sqlite"/.test(file.text))
      .map((file) => file.name);
    expect(valueImports).toEqual(["db.ts"]);
  });
});

describe("分层与同步纪律", () => {
  it("`packages/state` 不 import `apps/*`（硬约束 2）", () => {
    const offenders: string[] = [];
    for (const file of productionSources()) {
      for (const specifier of importSpecifiers(file.text)) {
        if (/(^|\/)apps\//.test(specifier) || specifier.startsWith("..")) {
          offenders.push(`${file.name} → ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("生产源码无 `await`（node:sqlite 同步 API，事务回调内禁 await）", () => {
    const offenders = productionSources()
      .filter((file) => /\bawait\b/.test(stripComments(file.text)))
      .map((file) => file.name);
    expect(offenders).toEqual([]);
  });
});
