/**
 * 把 **apps/web 的构建产物**（渲染层唯一真相源，t21 起）拷进 `apps/desktop/dist/renderer/`。
 *
 * 为什么不再拷 `src/`：渲染层 SoT 已统一到 `apps/web`（见 apps/web/README 与 apps/desktop/README）。
 * desktop 只保留 **Electron 特有**的两样东西：`src/index.html`（CSP + 标题，`loadFile` 的目标）
 * 与 `src/main/*.cts`（主进程 / preload）。其余 HTML/CSS/JS **一律来自 web 的 dist**，
 * 禁止在本包复制一份渲染源码（那会让"唯一 SoT"重新分裂成两份）。
 *
 * 产物契约（t7 / ci.yml 产物断言，勿改）：
 *   dist/main/main.cjs
 *   dist/main/preload.cjs
 *   dist/renderer/index.html
 *   dist/renderer/main.js
 *   dist/renderer/styles/tokens.css
 *   dist/build-info.json
 *
 * 用法：node scripts/copy-assets.mjs（由 apps/desktop 的 build 脚本调用）
 */
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(APP_ROOT, "..", "..");
const WEB_DIST = path.join(REPO_ROOT, "apps", "web", "dist");
const WEB_INDEX = path.join(WEB_DIST, "index.html");
const RENDERER_DIST = path.join(APP_ROOT, "dist", "renderer");
const SOURCE_INDEX = path.join(APP_ROOT, "src", "index.html");

/** 必须存在的 web 产物（缺一即"渲染层未构建"，显式报错而不是产出一个打不开的壳）。 */
const REQUIRED_WEB_ARTIFACTS = ["main.js", "styles/tokens.css", "styles/app.css", "styles/theme-init.js"];

/** 本包 index.html 必须与 apps/web 一致的片段（只允许改 CSP 与 <title>）。 */
const SHARED_MARKERS = [
  '<div id="app" class="ap-app" aria-busy="true"></div>',
  '<script type="module" src="./main.js"></script>',
  '<script type="module" src="./styles/theme-init.js"></script>',
  '<link rel="stylesheet" href="./styles/tokens.css" />',
  '<link rel="stylesheet" href="./styles/app.css" />',
];

async function main() {
  // ① web 产物必须齐备（apps/web 的 build 排在 desktop 之前，见根 package.json 的 build 链）。
  for (const relative of REQUIRED_WEB_ARTIFACTS) {
    try {
      await readFile(path.join(WEB_DIST, relative));
    } catch {
      throw new Error(
        `缺少 apps/web 产物 ${relative}：请先构建渲染层（根 build 链已保证顺序；` +
          "单独构建时先跑 `pnpm --filter @agentplant/web run build`）。",
      );
    }
  }

  // ② 漂移守卫：本包 index.html 的结构片段必须仍与 apps/web 的 index.html 一致。
  const desktopHtml = await readFile(SOURCE_INDEX, "utf8");
  const webHtml = await readFile(WEB_INDEX, "utf8");
  const missing = SHARED_MARKERS.filter((marker) => !webHtml.includes(marker));
  if (missing.length > 0) {
    throw new Error(
      `apps/desktop/src/index.html 与 apps/web 的 index.html 结构已漂移（共享契约片段不在 web 侧）：\n` +
        `${missing.map((marker) => `    · ${marker}`).join("\n")}\n` +
        "  → 渲染层结构以 apps/web 为准；本包只允许改 CSP 与 <title>。",
    );
  }

  await mkdir(RENDERER_DIST, { recursive: true });

  // ③ 本包 index.html（Electron CSP）→ dist/renderer/index.html
  await writeFile(path.join(RENDERER_DIST, "index.html"), `${desktopHtml.replace(/\r?\n/g, "\n").trimEnd()}\n`, "utf8");

  // ④ web 的 JS/CSS 产物原样搬入（styles/ 整目录 + 拆分出的模块），但**不覆盖**③ 的 index.html。
  await cp(WEB_DIST, RENDERER_DIST, {
    recursive: true,
    force: true,
    filter: (source) =>
      !source.endsWith(`${path.sep}index.html`) && !source.endsWith(".build-manifest.json"),
  });

  process.stdout.write(
    "desktop: 渲染层产物已复用 apps/web/dist → dist/renderer/（index.html 取自本包，其余原样搬入）\n",
  );
}

await main();
