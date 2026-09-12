/**
 * 清空 `apps/desktop/dist`（build 的第一步）。
 *
 * 为什么必须先清：`copy-assets.mjs` 是"往 dist 里搬 web 产物"，若上一次构建留下的旧文件
 * （例如 web 侧已删除的模块）继续存在，产物目录就会**同时包含新旧两份**，
 * 产物断言（ci.yml）与 `verify-release` 的 sha256 都会算在这种"脏产物"上 → 假绿。
 * 与 `packages/protocol` 的 clean-before-build 同一纪律。
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await rm(path.join(APP_ROOT, "dist"), { recursive: true, force: true });
await rm(path.join(APP_ROOT, "tsconfig.tsbuildinfo"), { force: true });
process.stdout.write("desktop: dist 已清空（防脏产物 / 增量假绿）\n");
