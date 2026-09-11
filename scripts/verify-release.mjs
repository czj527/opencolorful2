#!/usr/bin/env node
/**
 * 发布产物校验（t7 §1.1）—— 一条命令判定"本地真实发布"是否成立。
 *
 * 用法：
 *   node scripts/verify-release.mjs dist/release/<version>
 *   node scripts/verify-release.mjs dist/release/<version> --repo <repoRoot>
 *   node scripts/verify-release.mjs --self-test          # 最小 fixture 自检（CI 用）
 *
 * 通过时输出：`VERIFY-OK <version> <gitSha>`；任一失败非 0 退出并逐项说明。
 *
 * 校验范围（P1–P4）：
 *   P1 桌面构建产物存在性（exe 或 win-unpacked/ 解包目录 + 启动 exe；不得指向源码目录/dev）
 *   P2 版本戳（产物文件名 / 根 package.json / git tag v<version> / 应用内显示）
 *   P3 release-manifest.json 字段完整性 + 每个产物 sha256/size 现场重算一致
 *   P4 SHA256SUMS.txt 逐行现场重算一致
 *   前置断言：manifest.gitSha == git rev-parse HEAD；buildTime 不早于最后一次提交
 *
 * 不校验：P5 冒烟原始日志（`evidence/AT-xxx.log`）由 t7 验收流程负责，本脚本只提示。
 *
 * release-manifest.json 约定形状（打包任务必须产出，勿改字段名）：
 * {
 *   "version": "YYYY.M.PATCH",
 *   "gitSha": "<40 hex>",
 *   "buildTime": "<ISO-8601>",
 *   "platform": { "os": "win32", "arch": "x64" },
 *   "toolchain": { "node": "v22.x.y", "pnpm": "11.x.y" },
 *   "command": "pnpm build && pnpm package:release",
 *   "artifacts": [ { "path": "<releaseDir 内相对路径>", "sha256": "<hex>", "size": 123 } ]
 * }
 *
 * 依据：docs/decisions/t7-acceptance-gates.md §1.1；落地任务 docs/decisions/t3-repo-ci.md §6-4。
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_VERSION_RE = /^\d{4}\.\d{1,2}\.\d+$/;
const DESKTOP_ARTIFACT_PREFIX = "agentplant-desktop-";

/** 假绿标识版本（t7 FG-01：UI 中版本显示为 `0.0.0`/`dev`）。 */
const SKELETON_VERSIONS = new Set(["0.0.0", "dev", ""]);

function git(repoRoot, args) {
  return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }).trim();
}

function tryGit(repoRoot, args) {
  try {
    return git(repoRoot, args);
  } catch {
    return null;
  }
}

export async function sha256File(filePath) {
  const data = await readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

async function fileSize(filePath) {
  const info = await stat(filePath);
  return info.size;
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** 递归列出目录内所有文件（相对目录的 POSIX 路径），用于 win-unpacked 查找 exe。 */
async function listFilesRecursive(dir, prefix = "") {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(path.join(dir, entry.name), rel)));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * 校验一个发布目录。返回结构化结果（供 CLI 与 --self-test 复用）。
 * @returns {Promise<{ok: boolean, errors: Array<{id: string, detail: string}>, notes: string[], version: string|null, gitSha: string|null}>}
 */
export async function verifyRelease({ releaseDir, repoRoot }) {
  const errors = [];
  const notes = [];
  const fail = (id, detail) => errors.push({ id, detail });

  const rootPkgPath = path.join(repoRoot, "package.json");
  const desktopPkgPath = path.join(repoRoot, "apps", "desktop", "package.json");

  if (!(await exists(releaseDir))) {
    fail("P1", `发布目录不存在：${releaseDir}（dev-only 产物或未构建，t7 FG-01）`);
    return { ok: false, errors, notes, version: null, gitSha: null };
  }

  // ---------- P3：manifest 读取 ----------
  const manifestPath = path.join(releaseDir, "release-manifest.json");
  if (!(await exists(manifestPath))) {
    fail("P3", `缺少 release-manifest.json：${manifestPath}`);
    return { ok: false, errors, notes, version: null, gitSha: null };
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    fail("P3", `release-manifest.json 不是合法 JSON：${error.message}`);
    return { ok: false, errors, notes, version: null, gitSha: null };
  }

  const version = typeof manifest.version === "string" ? manifest.version : null;
  const gitSha = typeof manifest.gitSha === "string" ? manifest.gitSha : null;

  // ---------- P2：版本戳（骨架/dev 版本直接判假绿） ----------
  if (version === null) {
    fail("P2", "release-manifest.json 缺少 version");
  } else if (SKELETON_VERSIONS.has(version)) {
    fail("P2", `版本为 \`${version}\`：骨架/dev 版本不得作为发布（t7 FG-01）`);
  } else if (!RELEASE_VERSION_RE.test(version)) {
    fail("P2", `版本 \`${version}\` 不符合 \`YYYY.M.PATCH\`（t3 §4）`);
  }

  // ---------- P3：字段完整性 ----------
  const requiredStrings = [
    ["gitSha", manifest.gitSha],
    ["buildTime", manifest.buildTime],
    ["command", manifest.command],
  ];
  for (const [field, value] of requiredStrings) {
    if (typeof value !== "string" || value.trim() === "") {
      fail("P3", `release-manifest.json 缺少非空字段 \`${field}\``);
    }
  }
  if (typeof manifest.platform?.os !== "string" || typeof manifest.platform?.arch !== "string") {
    fail("P3", "release-manifest.json 缺少 `platform.os` / `platform.arch`");
  }
  if (typeof manifest.toolchain?.node !== "string" || typeof manifest.toolchain?.pnpm !== "string") {
    fail("P3", "release-manifest.json 缺少 `toolchain.node` / `toolchain.pnpm`");
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    fail("P3", "release-manifest.json 的 `artifacts` 必须是非空数组");
  }
  if (gitSha !== null && !/^[0-9a-f]{40}$/.test(gitSha)) {
    fail("P3", `gitSha \`${gitSha}\` 不是 40 位 hex`);
  }

  // 生成命令原文必须至少有一条能解析为根 package.json 的已知脚本（t7 FG-02）
  if (typeof manifest.command === "string" && manifest.command.trim() !== "") {
    let rootScripts = {};
    try {
      rootScripts = JSON.parse(await readFile(rootPkgPath, "utf8")).scripts ?? {};
    } catch (error) {
      fail("P3", `无法读取根 package.json：${error.message}`);
    }
    const segments = manifest.command.split(/&&|\|\||;/);
    const resolved = segments.some((segment) => {
      const match = /^\s*pnpm(?:\s+--\S+(?:\s+\S+)?)*\s+(?:run\s+)?([\w:@/.-]+)/.exec(segment);
      if (match === null) {
        return false;
      }
      const name = match[1].replace(/^run$/, "");
      return Object.hasOwn(rootScripts, name);
    });
    if (!resolved) {
      fail(
        "P3",
        `\`command\` 中没有任何命令可解析为根 package.json 脚本（t7 FG-02 防"文档命令不存在"）：${manifest.command}`,
      );
    }
  }

  // ---------- 前置断言：gitSha == HEAD（t7 §1.1） ----------
  const headSha = tryGit(repoRoot, ["rev-parse", "HEAD"]);
  if (headSha === null) {
    fail("PRECHECK", `无法在 ${repoRoot} 执行 git rev-parse HEAD（t7 §1.1 前置断言无法成立）`);
  } else if (gitSha !== null && headSha !== gitSha) {
    fail(
      "PRECHECK",
      `manifest.gitSha (${gitSha}) != git rev-parse HEAD (${headSha})：产物与源码不一致（陈旧产物，blocked）`,
    );
  }

  // ---------- 前置断言：buildTime 不早于最后一次提交 ----------
  if (typeof manifest.buildTime === "string" && manifest.buildTime.trim() !== "") {
    const buildTime = new Date(manifest.buildTime);
    if (Number.isNaN(buildTime.getTime())) {
      fail("PRECHECK", `buildTime \`${manifest.buildTime}\` 不是合法时间戳`);
    } else {
      const lastCommitIso = tryGit(repoRoot, ["log", "-1", "--format=%cI"]);
      if (lastCommitIso === null) {
        fail("PRECHECK", "无法读取最后一次提交时间（git log -1 --format=%cI）");
      } else if (buildTime.getTime() < new Date(lastCommitIso).getTime()) {
        fail(
          "PRECHECK",
          `buildTime (${manifest.buildTime}) 早于最后一次提交 (${lastCommitIso})：陈旧产物被拒绝（t7 §1.1）`,
        );
      }
    }
  }

  // ---------- P2：根 package.json / apps/desktop package.json 版本一致 ----------
  for (const [label, pkgPath] of [
    ["根 package.json", rootPkgPath],
    ["apps/desktop/package.json", desktopPkgPath],
  ]) {
    try {
      const pkgVersion = JSON.parse(await readFile(pkgPath, "utf8")).version;
      if (version !== null && pkgVersion !== version) {
        fail("P2", `${label} 的 version (${pkgVersion}) != 发布版本 (${version})`);
      }
    } catch (error) {
      fail("P2", `无法读取 ${label}：${error.message}`);
    }
  }

  // ---------- P2：git tag v<version> 存在且指向 gitSha（t7 FG-05） ----------
  if (version !== null && RELEASE_VERSION_RE.test(version)) {
    const tag = `v${version}`;
    const tagSha = tryGit(repoRoot, ["rev-list", "-n", "1", tag]);
    if (tagSha === null) {
      fail("P2", `缺少 git tag \`${tag}\`（版本戳四方一致要求 tag 存在）`);
    } else if (gitSha !== null && tagSha !== gitSha) {
      fail("P2", `tag \`${tag}\` 指向 ${tagSha}，与 manifest.gitSha (${gitSha}) 不一致（t7 FG-05）`);
    }
  }

  // ---------- P1：桌面构建产物存在性 ----------
  let artifactFiles = [];
  const entries = await readdir(releaseDir, { withFileTypes: true });
  const topLevelFiles = entries.filter((e) => e.isFile()).map((e) => e.name);
  const topLevelDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  if (version !== null) {
    const expectedExe = `${DESKTOP_ARTIFACT_PREFIX}${version}-win-x64.exe`;
    const hasExe = topLevelFiles.includes(expectedExe);
    const hasUnpacked = topLevelDirs.includes("win-unpacked");

    if (!hasExe && !hasUnpacked) {
      fail(
        "P1",
        `未找到桌面构建产物：既无 \`${expectedExe}\`，也无 \`win-unpacked/\` 解包目录` +
          `（当前顶层：${[...topLevelFiles, ...topLevelDirs].join(", ") || "空"}；t7 FG-01）`,
      );
    }

    if (hasExe) {
      const exeStat = await stat(path.join(releaseDir, expectedExe));
      if (exeStat.size === 0) {
        fail("P1", `产物 \`${expectedExe}\` 为空文件`);
      }
      if (!expectedExe.includes(version)) {
        fail("P2", `产物文件名 \`${expectedExe}\` 未嵌入版本 \`${version}\``);
      }
      artifactFiles.push(expectedExe);
    }

    if (hasUnpacked) {
      const unpackedDir = path.join(releaseDir, "win-unpacked");
      const unpackedFiles = await listFilesRecursive(unpackedDir);
      const exes = unpackedFiles.filter((f) => path.extname(f).toLowerCase() === ".exe");
      if (exes.length === 0) {
        fail("P1", "`win-unpacked/` 内没有可执行 exe（解包目录不构成可启动产物）");
      } else {
        notes.push(`win-unpacked exe: ${exes.join(", ")}`);
      }
      artifactFiles.push(...unpackedFiles.map((f) => `win-unpacked/${f}`));

      // P2 第四方：应用内显示的真实来源 = 打包后的 app package.json（app.getVersion() 读它）
      const packagedPkgRel = "win-unpacked/resources/app/package.json";
      if (!unpackedFiles.includes("resources/app/package.json")) {
        fail(
          "P2",
          `应用内显示待补：缺少 \`${packagedPkgRel}\`，无法从产物验证 app.getVersion() 的版本` +
            "（需打包产物或关于页证据；禁止以脚本内硬编码值充当证据，t7 FG-05）",
        );
      } else {
        try {
          const packagedVersion = JSON.parse(
            await readFile(path.join(unpackedDir, "resources", "app", "package.json"), "utf8"),
          ).version;
          if (version !== null && packagedVersion !== version) {
            fail(
              "P2",
              `应用内显示版本 (\`${packagedVersion}\`) != 发布版本 (\`${version}\`)：四方一致不成立`,
            );
          }
        } catch (error) {
          fail("P2", `无法解析 ${packagedPkgRel}：${error.message}`);
        }
      }
    }
  }

  // ---------- P3：每个产物 sha256 + size 现场重算 ----------
  const declared = new Map();
  if (Array.isArray(manifest.artifacts)) {
    for (const artifact of manifest.artifacts) {
      const rel = artifact?.path;
      if (typeof rel !== "string" || rel.trim() === "") {
        fail("P3", "artifacts 中存在缺少 `path` 的条目");
        continue;
      }
      if (path.isAbsolute(rel) || rel.includes("..")) {
        fail("P3", `产物路径必须位于发布目录内：\`${rel}\``);
        continue;
      }
      const absolute = path.join(releaseDir, rel);
      if (!(await exists(absolute))) {
        fail("P1", `manifest 声明的产物不存在：\`${rel}\``);
        continue;
      }
      const actualSize = await fileSize(absolute);
      const actualSha = await sha256File(absolute);
      if (typeof artifact.size !== "number" || artifact.size !== actualSize) {
        fail("P3", `\`${rel}\` size 不一致：manifest ${artifact.size} vs 实际 ${actualSize}`);
      }
      if (typeof artifact.sha256 !== "string" || artifact.sha256 !== actualSha) {
        fail(
          "P3",
          `\`${rel}\` sha256 不一致：manifest ${artifact.sha256} vs 现场重算 ${actualSha}`,
        );
      }
      declared.set(rel, actualSha);
    }
  }

  // ---------- P4：SHA256SUMS.txt 逐行现场重算 ----------
  const sumsPath = path.join(releaseDir, "SHA256SUMS.txt");
  if (!(await exists(sumsPath))) {
    fail("P4", `缺少 SHA256SUMS.txt：${sumsPath}`);
  } else {
    const sumsText = await readFile(sumsPath, "utf8");
    const lines = sumsText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "");
    if (lines.length === 0) {
      fail("P4", "SHA256SUMS.txt 为空（校验文件不得为空）");
    }
    const listed = new Set();
    for (const line of lines) {
      const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line);
      if (match === null) {
        fail("P4", `SHA256SUMS.txt 行格式非法（应为 \`<sha256>  <file>\`）：${line}`);
        continue;
      }
      const [, expectedSha, rel] = match;
      listed.add(rel);
      const absolute = path.join(releaseDir, rel);
      if (!(await exists(absolute))) {
        fail("P4", `SHA256SUMS.txt 列出的文件不存在：\`${rel}\``);
        continue;
      }
      const actualSha = await sha256File(absolute);
      if (actualSha !== expectedSha) {
        fail("P4", `\`${rel}\` 现场重算 sha256 (${actualSha}) != 清单值 (${expectedSha})`);
      }
    }
    for (const rel of declared.keys()) {
      if (!listed.has(rel)) {
        fail("P4", `manifest 声明的产物 \`${rel}\` 未出现在 SHA256SUMS.txt（清单未随产物更新，FG-05）`);
      }
    }
  }

  notes.push("P5 冒烟原始日志（evidence/AT-xxx.log）不在本脚本校验范围，由 t7 验收流程负责。");

  return {
    ok: errors.length === 0,
    errors,
    notes,
    version,
    gitSha,
  };
}

function report(result, releaseDir) {
  if (!result.ok) {
    process.stderr.write(`发布校验失败：${releaseDir}\n`);
    for (const { id, detail } of result.errors) {
      process.stderr.write(`  ✗ [${id}] ${detail}\n`);
    }
    process.stderr.write(
      `\n共 ${result.errors.length} 项不成立；未输出 VERIFY-OK。依据 t7 §1.1（缺一即不是发布）。\n`,
    );
    return;
  }
  for (const note of result.notes) {
    process.stdout.write(`  · ${note}\n`);
  }
  process.stdout.write(`VERIFY-OK ${result.version} ${result.gitSha}\n`);
}

async function writeFixtureRelease({ releaseDir, version, gitSha, buildTime, withAppPackage }) {
  await rm(releaseDir, { recursive: true, force: true });
  await mkdir(releaseDir, { recursive: true });

  const exeRel = `${DESKTOP_ARTIFACT_PREFIX}${version}-win-x64.exe`;
  const unpackedExeRel = "win-unpacked/AgentPlant.exe";
  await writeFile(path.join(releaseDir, exeRel), `fake-exe-${version}-${Date.now()}`);
  await mkdir(path.join(releaseDir, "win-unpacked", "resources", "app"), { recursive: true });
  await writeFile(path.join(releaseDir, unpackedExeRel), "fake-unpacked-exe");
  if (withAppPackage) {
    await writeFile(
      path.join(releaseDir, "win-unpacked", "resources", "app", "package.json"),
      JSON.stringify({ name: "agentplant-desktop", version }, null, 2),
    );
  }

  const artifacts = [exeRel, unpackedExeRel];
  if (withAppPackage) {
    artifacts.push("win-unpacked/resources/app/package.json");
  }
  const manifestArtifacts = [];
  for (const rel of artifacts) {
    const absolute = path.join(releaseDir, rel);
    manifestArtifacts.push({
      path: rel,
      sha256: await sha256File(absolute),
      size: await fileSize(absolute),
    });
  }

  const manifest = {
    version,
    gitSha,
    buildTime,
    platform: { os: "win32", arch: "x64" },
    toolchain: { node: process.version, pnpm: "11.8.0" },
    command: "pnpm build && pnpm package:release",
    artifacts: manifestArtifacts,
  };
  await writeFile(
    path.join(releaseDir, "release-manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  await writeFile(
    path.join(releaseDir, "SHA256SUMS.txt"),
    manifestArtifacts.map((a) => `${a.sha256}  ${a.path}`).join("\n") + "\n",
  );

  return manifest;
}

/** 造一个最小临时 git 仓库（含根/desktop package.json + tag），供 fixture 断言前置条件。 */
async function makeFixtureRepo({ tmpRoot, version }) {
  const repoRoot = path.join(tmpRoot, "repo");
  await mkdir(path.join(repoRoot, "apps", "desktop"), { recursive: true });
  await writeFile(
    path.join(repoRoot, "package.json"),
    JSON.stringify({ name: "fixture", version, private: true, scripts: { build: "echo build" } }, null, 2),
  );
  await writeFile(
    path.join(repoRoot, "apps", "desktop", "package.json"),
    JSON.stringify({ name: "fixture-desktop", version }, null, 2),
  );
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_DATE: "2026-09-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-09-01T00:00:00Z",
  };
  const runGit = (args) =>
    execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", env: gitEnv });
  runGit(["init", "-q"]);
  runGit(["config", "user.name", "fixture"]);
  runGit(["config", "user.email", "fixture@example.invalid"]);
  runGit(["add", "-A"]);
  runGit(["commit", "-q", "-m", "fixture: initial"]);
  runGit(["tag", `v${version}`]);
  const gitSha = runGit(["rev-parse", "HEAD"]).trim();
  return { repoRoot, gitSha };
}

async function selfTest() {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "verify-release-selftest-"));
  const version = "2026.9.1";
  const cases = [];

  try {
    const { repoRoot, gitSha } = await makeFixtureRepo({ tmpRoot, version });
    const releaseDir = path.join(repoRoot, "dist", "release", version);
    await mkdir(path.dirname(releaseDir), { recursive: true });

    // 用例 1：完整自洽的 fixture 必须通过并给出 VERIFY-OK
    await writeFixtureRelease({
      releaseDir,
      version,
      gitSha,
      buildTime: new Date().toISOString(),
      withAppPackage: true,
    });
    const good = await verifyRelease({ releaseDir, repoRoot });
    cases.push({
      name: "完整 fixture 通过",
      pass: good.ok && good.version === version && good.gitSha === gitSha,
      detail: good.ok ? `VERIFY-OK ${good.version} ${good.gitSha}` : JSON.stringify(good.errors),
    });

    // 用例 2：篡改产物字节 → sha256 现场重算不一致，必须失败
    await writeFile(path.join(releaseDir, "win-unpacked", "AgentPlant.exe"), "tampered-bytes");
    const tampered = await verifyRelease({ releaseDir, repoRoot });
    cases.push({
      name: "篡改产物被拒绝",
      pass: !tampered.ok && tampered.errors.some((e) => e.id === "P3" || e.id === "P4"),
      detail: tampered.errors.map((e) => e.id).join(","),
    });

    // 用例 3：骨架/dev 版本 → 立即判假绿失败
    const devDir = path.join(repoRoot, "dist", "release", "0.0.0");
    await writeFixtureRelease({
      releaseDir: devDir,
      version: "0.0.0",
      gitSha,
      buildTime: new Date().toISOString(),
      withAppPackage: true,
    });
    const dev = await verifyRelease({ releaseDir: devDir, repoRoot });
    cases.push({
      name: "0.0.0 版本被判假绿",
      pass: !dev.ok && dev.errors.some((e) => e.id === "P2"),
      detail: dev.errors.map((e) => e.id).join(","),
    });

    // 用例 4：缺少应用内显示来源（打包 app package.json）→ 明确报错，不硬编码通过
    const noAppDir = path.join(repoRoot, "dist", "release", `${version}-noapp`);
    await writeFixtureRelease({
      releaseDir: noAppDir,
      version,
      gitSha,
      buildTime: new Date().toISOString(),
      withAppPackage: false,
    });
    const noApp = await verifyRelease({ releaseDir: noAppDir, repoRoot });
    cases.push({
      name: "缺少应用内显示来源时明确报错",
      pass: !noApp.ok && noApp.errors.some((e) => e.id === "P2" && /应用内显示待补/.test(e.detail)),
      detail: noApp.errors.map((e) => `${e.id}:${e.detail.slice(0, 40)}`).join(" | "),
    });

    // 用例 5：gitSha 与 HEAD 不一致（陈旧产物）→ 前置断言失败
    await writeFixtureRelease({
      releaseDir,
      version,
      gitSha: "0".repeat(40),
      buildTime: new Date().toISOString(),
      withAppPackage: true,
    });
    const stale = await verifyRelease({ releaseDir, repoRoot });
    cases.push({
      name: "陈旧产物（gitSha != HEAD）被拒绝",
      pass: !stale.ok && stale.errors.some((e) => e.id === "PRECHECK"),
      detail: stale.errors.map((e) => e.id).join(","),
    });

    // 用例 6：buildTime 早于最后一次提交 → 前置断言失败
    await writeFixtureRelease({
      releaseDir,
      version,
      gitSha,
      buildTime: "2020-01-01T00:00:00Z",
      withAppPackage: true,
    });
    const old = await verifyRelease({ releaseDir, repoRoot });
    cases.push({
      name: "buildTime 早于提交被拒绝",
      pass: !old.ok && old.errors.some((e) => e.id === "PRECHECK"),
      detail: old.errors.map((e) => e.id).join(","),
    });
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }

  const failed = cases.filter((c) => !c.pass);
  for (const c of cases) {
    process.stdout.write(`  ${c.pass ? "✓" : "✗"} ${c.name}${c.pass ? "" : ` — ${c.detail}`}\n`);
  }
  if (failed.length > 0) {
    process.stderr.write(`\nverify-release 自检失败：${failed.length}/${cases.length} 用例不成立\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`\nverify-release 自检通过：${cases.length}/${cases.length} 用例\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    await selfTest();
    return;
  }

  const repoFlagIndex = argv.indexOf("--repo");
  const repoRoot =
    repoFlagIndex >= 0 && argv[repoFlagIndex + 1] !== undefined
      ? path.resolve(argv[repoFlagIndex + 1])
      : (tryGit(process.cwd(), ["rev-parse", "--show-toplevel"]) ?? REPO_ROOT);

  const positional = argv.filter((arg, index) => {
    if (arg.startsWith("--")) {
      return false;
    }
    return !(repoFlagIndex >= 0 && index === repoFlagIndex + 1);
  });

  if (positional.length !== 1) {
    process.stderr.write(
      "用法：node scripts/verify-release.mjs dist/release/<version> [--repo <dir>]\n" +
        "     node scripts/verify-release.mjs --self-test\n",
    );
    process.exitCode = 1;
    return;
  }

  const releaseDir = path.resolve(positional[0]);
  const result = await verifyRelease({ releaseDir, repoRoot });
  report(result, releaseDir);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  await main();
}

// 供 --self-test / 后续测试复用
export { makeFixtureRepo, writeFixtureRelease };
