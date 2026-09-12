/**
 * purity 测试：把 agent-core 的**纯度纪律**变成可执行断言（读源码文本，不做行为推断）。
 *
 * 依据：AGENTS.md 硬约束 2（`packages/*` 禁 import `apps/*`）+ 本包 t13 口径
 * 「agent-core 保持纯函数：禁 node:sqlite / node:http，纯逻辑可单测」。
 *
 * 与 `packages/state` 的同名测试的区别：state 允许 `node:sqlite`（它就是存储层），
 * 本包**一个 I/O 模块都不许有**——判定函数必须能在无 DB、无网络的环境里单测。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));
const PACKAGE_JSON_PATH = fileURLToPath(new URL("../package.json", import.meta.url));

function productionSources(): { readonly name: string; readonly text: string }[] {
  return readdirSync(SRC_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(SRC_DIR, name), "utf8") }));
}

/** 去注释后再扫：注释里提到 `node:sqlite` 这类词不算违规（文档会提到它们）。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function importSpecifiers(text: string): string[] {
  const specifiers = [...text.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] ?? "");
  const dynamic = [...text.matchAll(/import\s*\(\s*"([^"]+)"/g)].map((match) => match[1] ?? "");
  const requires = [...text.matchAll(/require\s*\(\s*"([^"]+)"/g)].map((match) => match[1] ?? "");
  return [...specifiers, ...dynamic, ...requires];
}

/** 任何 I/O：DB / HTTP / 文件 / 子进程 / 工作线程……纯内核一个都不许碰。 */
const FORBIDDEN_MODULES = [
  "node:sqlite",
  "node:http",
  "node:https",
  "node:net",
  "node:fs",
  "node:child_process",
  "node:worker_threads",
  "node:dgram",
];

describe("纯度（AGENTS.md 硬约束 2 + t13「保持纯函数」）", () => {
  it("生产源码不 import 任何 I/O 模块（含 node:sqlite / node:http）", () => {
    const found: string[] = [];
    for (const file of productionSources()) {
      for (const specifier of importSpecifiers(stripComments(file.text))) {
        if (FORBIDDEN_MODULES.includes(specifier)) {
          found.push(`${file.name} → ${specifier}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it("生产源码不 import apps/*（硬约束 2）也不 import state（分层：state 是存储层）", () => {
    const offenders: string[] = [];
    for (const file of productionSources()) {
      for (const specifier of importSpecifiers(stripComments(file.text))) {
        if (/(^|\/)apps\//.test(specifier) || specifier === "@agentplant/state") {
          offenders.push(`${file.name} → ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("运行时依赖恰好是 @agentplant/protocol（多一个都会破坏纯度分层）", () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(["@agentplant/protocol"]);
    expect(pkg.dependencies?.["@agentplant/protocol"]).toBe("workspace:*");
  });

  it("判定层不读时钟 / 随机数 / 环境变量（同一输入必得同一输出）", () => {
    const offenders: string[] = [];
    for (const file of productionSources()) {
      const text = stripComments(file.text);
      for (const forbidden of ["Date.now", "new Date(", "Math.random", "process.env"]) {
        if (text.includes(forbidden)) {
          offenders.push(`${file.name} → ${forbidden}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
