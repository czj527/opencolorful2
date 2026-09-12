#!/usr/bin/env node
/**
 * 工程棘轮（t3 §5）：`config/size-baseline.json` 记录每包 LOC 上限与 lint suppression 数量，
 * **只允许减少、不允许增加**；有意上调需在 PR 中单独说明并更新基线文件。
 *
 * 用法：
 *   node scripts/check-ratchet.mjs            # 对比基线，超限即非 0 退出
 *   node scripts/check-ratchet.mjs --update   # 有意变更基线时重写基线文件
 *
 * 统计口径（写在代码里以便复核）：
 *   - 计入范围：仓库内 `packages/*`、`apps/*`、`scripts` 三组。
 *   - 计入文件：.ts .tsx .mts .cts .js .mjs .cjs .css .html
 *     （不含 .json 等配置、不含 node_modules/dist/out/coverage）。
 *   - LOC = 去空行、去纯注释行后的行数（注释行：// 与 /* 与 * 与 <!-- 开头）。
 *   - lintSuppressions = 出现 `eslint-disable` 的次数（含 next-line / 整文件）。
 *
 * 依据：docs/decisions/t3-repo-ci.md §5；t1 §4 清单 #13（工程侧 ratchet 防退化）。
 */
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = path.join(REPO_ROOT, "config", "size-baseline.json");

const COUNTED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  ".css",
  ".html",
]);
const IGNORED_DIRS = new Set(["node_modules", "dist", "out", "coverage", ".turbo", "release"]);

/** 统计分组：与 t3 §1 仓结构对应。 */
function targetGroups() {
  // 与 t3 §1 §8 落定的 packages 清单保持一致：新增包必须同步登记到本列表，
  // 否则该包不计入棘轮（"未登记"比"超限"危险：它会让 LOC 增长完全不被看见）。
  return [
    ...["protocol", "agent-core", "state", "gateway-protocol", "plugin-sdk"].map((name) => ({
      key: `packages/${name}`,
      dir: path.join(REPO_ROOT, "packages", name),
    })),
    ...["desktop", "web", "server"].map((name) => ({
      key: `apps/${name}`,
      dir: path.join(REPO_ROOT, "apps", name),
    })),
    { key: "scripts", dir: path.join(REPO_ROOT, "scripts") },
  ];
}

async function listFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return out;
    }
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      out.push(...(await listFiles(full)));
    } else if (entry.isFile() && COUNTED_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

function isCommentLine(line) {
  return (
    line.startsWith("//") ||
    line.startsWith("/*") ||
    line.startsWith("*") ||
    line.startsWith("<!--")
  );
}

async function measure(dir) {
  let exists = true;
  try {
    exists = (await stat(dir)).isDirectory();
  } catch {
    exists = false;
  }
  if (!exists) {
    return null;
  }

  const files = await listFiles(dir);
  let loc = 0;
  let lintSuppressions = 0;

  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.length === 0 || isCommentLine(line)) {
        continue;
      }
      loc += 1;
    }
    lintSuppressions += (text.match(/eslint-disable/g) ?? []).length;
  }

  return { loc, lintSuppressions, fileCount: files.length };
}

async function measureAll() {
  const measured = {};
  for (const group of targetGroups()) {
    const result = await measure(group.dir);
    if (result !== null) {
      measured[group.key] = result;
    }
  }
  return measured;
}

async function readBaseline() {
  let raw;
  try {
    raw = await readFile(BASELINE_PATH, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  return JSON.parse(raw);
}

function toBaselineShape(measured) {
  const entries = {};
  for (const key of Object.keys(measured).sort()) {
    const { loc, lintSuppressions } = measured[key];
    entries[key] = { loc, lintSuppressions };
  }
  return {
    version: 1,
    note:
      "工程棘轮基线（t3 §5）：LOC 与 lint suppression 只减不增。" +
      "有意上调需在 PR 中单独说明，并用 `node scripts/check-ratchet.mjs --update` 更新本文件。",
    metric: {
      loc: "去空行、去纯注释行后的行数",
      lintSuppressions: "`eslint-disable` 出现次数",
      extensions: [...COUNTED_EXTENSIONS].sort(),
    },
    entries,
  };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const measured = await measureAll();

  if (args.has("--update")) {
    const next = toBaselineShape(measured);
    await mkdir(path.dirname(BASELINE_PATH), { recursive: true });
    await writeFile(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    const total = Object.values(next.entries).reduce((sum, e) => sum + e.loc, 0);
    process.stdout.write(
      `棘轮基线已更新：${Object.keys(next.entries).length} 组，LOC 合计 ${total}\n` +
        `→ ${path.relative(REPO_ROOT, BASELINE_PATH)}\n`,
    );
    return;
  }

  const baseline = await readBaseline();
  if (baseline === null) {
    process.stderr.write(
      "棘轮检查失败：缺少 config/size-baseline.json\n" +
        "→ 生成初值：node scripts/check-ratchet.mjs --update\n",
    );
    process.exitCode = 1;
    return;
  }

  const findings = [];
  const baselineEntries = baseline.entries ?? {};

  for (const [key, current] of Object.entries(measured)) {
    const allowed = baselineEntries[key];
    if (allowed === undefined) {
      findings.push(
        `${key}: 未登记在基线中（新增包必须显式登记）` +
          ` 当前 LOC ${current.loc} / suppressions ${current.lintSuppressions}`,
      );
      continue;
    }
    if (current.loc > allowed.loc) {
      findings.push(`${key}: LOC ${allowed.loc} → ${current.loc}（+${current.loc - allowed.loc}，超限）`);
    }
    if (current.lintSuppressions > allowed.lintSuppressions) {
      findings.push(
        `${key}: lint suppression ${allowed.lintSuppressions} → ${current.lintSuppressions}` +
          `（+${current.lintSuppressions - allowed.lintSuppressions}，超限）`,
      );
    }
  }

  for (const key of Object.keys(baselineEntries)) {
    if (measured[key] === undefined) {
      findings.push(`${key}: 基线中登记但目录不存在（请收敛基线）`);
    }
  }

  if (findings.length > 0) {
    process.stderr.write("棘轮检查失败：以下指标只允许减少、不允许增加（t3 §5）\n");
    for (const finding of findings) {
      process.stderr.write(`  ✗ ${finding}\n`);
    }
    process.stderr.write(
      "\n如为有意上调：在 PR 中单独说明理由，然后运行\n" +
        "  node scripts/check-ratchet.mjs --update\n",
    );
    process.exitCode = 1;
    return;
  }

  const total = Object.values(measured).reduce((sum, e) => sum + e.loc, 0);
  process.stdout.write(
    `棘轮检查通过：${Object.keys(measured).length} 组均在基线内（LOC 合计 ${total}）\n`,
  );
  for (const [key, current] of Object.entries(measured).sort()) {
    const allowed = baselineEntries[key];
    process.stdout.write(
      `  ${key}: LOC ${current.loc}/${allowed.loc} · suppressions ` +
        `${current.lintSuppressions}/${allowed.lintSuppressions}\n`,
    );
  }
}

await main();
