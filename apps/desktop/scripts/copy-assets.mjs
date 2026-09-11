/**
 * 把渲染层静态资源（HTML / CSS）拷进 dist/，使 `pnpm build` 产出**可运行的构建产物**
 * （t7 反假绿 FG-01/FG-02：不得依赖 dev server 或源码目录）。
 *
 * 目标路径与主进程的加载路径契约一致：
 *   dist/renderer/index.html（主进程 loadFile 的目标）
 *   dist/renderer/styles/tokens.css
 *
 * 用法：node scripts/copy-assets.mjs（由 apps/desktop 的 build 脚本调用）
 */
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** [源路径, dist 内目标路径]，均为相对 apps/desktop 的路径。 */
const ASSETS = [
  ["src/index.html", "dist/renderer/index.html"],
  ["src/styles", "dist/renderer/styles"],
];

let copied = 0;
for (const [from, to] of ASSETS) {
  const target = path.join(APP_ROOT, to);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(APP_ROOT, from), target, { recursive: true, force: true });
  copied += 1;
}

process.stdout.write(`desktop: 已拷贝 ${copied} 项静态资源到 dist/renderer/\n`);
