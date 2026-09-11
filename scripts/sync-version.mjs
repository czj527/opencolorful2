#!/usr/bin/env node
/**
 * 版本戳注入机制的第一环：单一版本源 → 各包 version 同步（t3 §6-6）。
 *
 * 单一版本源 = **根 `package.json` 的 `version`**（格式 `YYYY.M.PATCH`，t3 §4）。
 * `app.getVersion()` 读的是 `apps/desktop/package.json` 的 version，因此发布前必须同步，
 * 否则 t7 P2「四方一致」不成立（见 scripts/verify-release.mjs）。
 *
 * 用法：
 *   node scripts/sync-version.mjs            # 把根版本写入 apps/desktop/package.json（有变更才写）
 *   node scripts/sync-version.mjs --check    # 只校验一致，不写文件；不一致非 0 退出（CI 用）
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_PKG = path.join(REPO_ROOT, "package.json");

/** 需要跟随根版本的文件（app.getVersion() 的来源在此）。 */
const FOLLOWERS = ["apps/desktop/package.json"];

const RELEASE_VERSION_RE = /^\d{4}\.\d{1,2}\.\d+$/;

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  const source = await readJson(ROOT_PKG);
  const version = source.version;

  if (typeof version !== "string" || version.trim() === "") {
    process.stderr.write("版本同步失败：根 package.json 缺少 version（单一版本源必须存在）\n");
    process.exitCode = 1;
    return;
  }

  const notes = [];
  if (!RELEASE_VERSION_RE.test(version)) {
    // 骨架期为 0.0.0；发布前必须 bump 为 YYYY.M.PATCH（t3 §4）。
    notes.push(
      `⚠ 根版本 \`${version}\` 不是发布格式 \`YYYY.M.PATCH\`：骨架阶段允许，` +
        "发布前必须 bump（t7 P2 会拒绝 0.0.0/dev）",
    );
  }

  const drifted = [];
  for (const rel of FOLLOWERS) {
    const file = path.join(REPO_ROOT, rel);
    const pkg = await readJson(file);
    if (pkg.version === version) {
      continue;
    }
    drifted.push({ rel, file, pkg });
  }

  if (drifted.length === 0) {
    process.stdout.write(`版本一致：${version}（${FOLLOWERS.join(", ")}）\n`);
    for (const note of notes) {
      process.stdout.write(`${note}\n`);
    }
    return;
  }

  if (checkOnly) {
    process.stderr.write("版本不一致（单一版本源 = 根 package.json）：\n");
    for (const { rel, pkg } of drifted) {
      process.stderr.write(`  ✗ ${rel}: ${pkg.version} != ${version}\n`);
    }
    process.stderr.write("\n修复：node scripts/sync-version.mjs\n");
    process.exitCode = 1;
    return;
  }

  for (const { rel, file, pkg } of drifted) {
    pkg.version = version;
    await writeFile(file, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
    process.stdout.write(`已同步：${rel} → ${version}\n`);
  }
  for (const note of notes) {
    process.stdout.write(`${note}\n`);
  }
}

await main();
