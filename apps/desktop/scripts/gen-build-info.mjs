/**
 * 版本戳注入机制的第二环：构建期生成 `apps/desktop/dist/build-info.json`（t3 §6-6）。
 *
 * 单一版本源 = 根 `package.json` 的 `version`；本脚本在 **构建期**把它连同 gitSha 与
 * buildTime 一起注入产物，供：
 *   - 主进程（`dist/main/main.cjs`）读取并与 `app.getVersion()` 交叉校验；
 *   - 渲染层「关于」信息经 preload 桥接读取（**不得**硬编码版本号，t7 FG-05）。
 *
 * 用法：
 *   node scripts/gen-build-info.mjs                    # 构建（骨架期允许非发布版本，仅告警）
 *   node scripts/gen-build-info.mjs --require-release  # 发布：版本非 YYYY.M.PATCH 即非 0 退出
 */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(APP_ROOT, "..", "..");

const RELEASE_VERSION_RE = /^\d{4}\.\d{1,2}\.\d+$/;

function gitSha() {
  try {
    return execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

function pnpmVersion() {
  const userAgent = process.env.npm_config_user_agent ?? "";
  const match = /pnpm\/([\d.]+)/.exec(userAgent);
  return match === null ? null : match[1];
}

async function main() {
  const requireRelease = process.argv.includes("--require-release");

  const rootPkg = JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
  const version = rootPkg.version;

  if (typeof version !== "string" || version.trim() === "") {
    process.stderr.write("版本注入失败：根 package.json 缺少 version（单一版本源必须存在）\n");
    process.exitCode = 1;
    return;
  }

  const isReleaseVersion = RELEASE_VERSION_RE.test(version);
  if (!isReleaseVersion) {
    const message =
      `⚠ 版本 \`${version}\` 不是发布格式 \`YYYY.M.PATCH\`（t3 §4）：` +
      "当前为骨架/开发版本，产物**不得**作为发布（t7 FG-01 判假绿）";
    if (requireRelease) {
      process.stderr.write(`版本注入失败：${message}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`desktop: ${message}\n`);
  }

  const sha = gitSha();
  if (sha === null) {
    // 不静默降级：没有 gitSha 时显式标注 null，t7 校验会因此失败（verify-release P3）。
    process.stdout.write(
      "desktop: ⚠ 无法获取 gitSha（非 git 仓库或 git 不可用）→ build-info.gitSha = null\n",
    );
  }

  const buildInfo = {
    version,
    gitSha: sha,
    buildTime: new Date().toISOString(),
    isReleaseVersion,
    source: "package.json#version",
    node: process.version,
    pnpm: pnpmVersion(),
  };

  const outPath = path.join(APP_ROOT, "dist", "build-info.json");
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(buildInfo, null, 2)}\n`, "utf8");
  process.stdout.write(`desktop: 版本戳已注入 dist/build-info.json（version=${version}）\n`);
}

await main();
