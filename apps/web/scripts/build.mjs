/**
 * apps/web 构建（真实产物，禁 dev server 冒充 —— t7 FG-01/FG-02）。
 *
 * 顺序（每一步都为消除一类假绿面）：
 *   1. clean：删 dist 与 tsconfig.tsbuildinfo（增量编译会让"手删 dist"后的构建**跳过重生成**）
 *   2. tsc -p tsconfig.json：只编译源码（`src/**\/*.test.ts` 被 exclude，测试不进产物）
 *   3. 拷静态资产：src/index.html、src/styles/theme-init.js、src/styles/app.css、
 *      src/styles/tokens.css → dist（**tokens.css 原样落盘**，它是渲染层 token 的唯一副本）
 *   4. 守卫①：dist 内不得出现裸包名导入（`from "@agentplant/..."`）——渲染层要么相对导入，
 *      要么用 `import type`（编译期擦除）；出现裸包名即说明产物无法被浏览器直载
 *   5. 守卫②：index.html 引用的每个本地 js/css 都必须在 dist 内真实存在
 *
 * 注意：`@agentplant/protocol` 只以 `import type` 参与**类型检查**（类型来自 packages/protocol/dist，
 * 故本包 build 必须排在 protocol 之后）。运行期零 workspace 依赖 ⇒ 不需要打包器，
 * 产物就是浏览器/Electron 可直接 `loadFile` 的 ESM。
 */
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(APP_ROOT, "dist");

/** [源 → dist 内目标]，均为 apps/web 相对路径。 */
const STATIC_ASSETS = [
  ["src/index.html", "dist/index.html"],
  ["src/styles/tokens.css", "dist/styles/tokens.css"],
  ["src/styles/app.css", "dist/styles/app.css"],
  ["src/styles/theme-init.js", "dist/styles/theme-init.js"],
];

const BARE_SPECIFIER_RE = /(?:from|import)\s*\(?\s*["']([^"'.][^"']*)["']/g;

async function listJsFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listJsFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

/** 守卫①：产物内不得有裸包名导入（浏览器与 `loadFile` 都解析不了）。 */
async function assertNoBareSpecifiers() {
  const offenders = [];
  for (const file of await listJsFiles(DIST)) {
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(BARE_SPECIFIER_RE)) {
      offenders.push(`${path.relative(APP_ROOT, file)} → ${match[1]}`);
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `构建产物存在裸包名导入（浏览器无法解析，需要改成相对导入或用 \`import type\`）：\n  ${offenders.join("\n  ")}`,
    );
  }
}

/** 守卫②：index.html 引用的本地 js/css 必须真实存在（防止"HTML 指向不存在的产物"）。 */
async function assertHtmlReferences() {
  const html = await readFile(path.join(DIST, "index.html"), "utf8");
  const refs = [
    ...[...html.matchAll(/<script[^>]+src="\.\/([^"]+)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/<link[^>]+href="\.\/([^"]+)"/g)].map((m) => m[1]),
  ];
  if (refs.length === 0) {
    throw new Error("index.html 未引用任何本地 js/css：产物自检无法成立");
  }
  for (const ref of refs) {
    const target = path.join(DIST, ref);
    try {
      await readFile(target);
    } catch {
      throw new Error(`index.html 引用了不存在的产物：${ref}`);
    }
  }
  return refs;
}

/**
 * 用 TypeScript 自带的编译器 API 编译（不 spawn `pnpm exec tsc`）。
 *
 * 为什么不用子进程：Windows 下 `pnpm` 是 `.cmd`，`execFileSync("pnpm", …)` 会 ENOENT；
 * 用 shell 又引入引号/注入面。仓内 devDependencies 已有 typescript，直接 require 它的 JS API
 * 最简、跨平台且报错信息等价（诊断打印走 `ts.formatDiagnosticsWithColorAndContext`）。
 */
async function runTsc() {
  const ts = (await import("typescript")).default;
  const configPath = path.join(APP_ROOT, "tsconfig.json");
  const raw = ts.readConfigFile(configPath, ts.sys.readFile);
  if (raw.error !== undefined) {
    throw new Error(ts.formatDiagnostics([raw.error], host));
  }
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, APP_ROOT);
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const emitted = program.emit();
  const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitted.diagnostics);
  if (diagnostics.length > 0) {
    process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, host));
    const hasError = diagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
    if (hasError) {
      throw new Error(`tsc 失败：${String(diagnostics.length)} 条诊断（见上）`);
    }
  }
}

const host = {
  getCurrentDirectory: () => APP_ROOT,
  getCanonicalFileName: (fileName) => fileName,
  getNewLine: () => "\n",
};

async function main() {
  await rm(DIST, { recursive: true, force: true });
  await rm(path.join(APP_ROOT, "tsconfig.tsbuildinfo"), { force: true });

  await runTsc();

  for (const [from, to] of STATIC_ASSETS) {
    const target = path.join(APP_ROOT, to);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(APP_ROOT, from), target, { force: true });
  }

  await assertNoBareSpecifiers();
  const refs = await assertHtmlReferences();

  const jsFiles = await listJsFiles(DIST).catch(() => []);
  await writeFile(
    path.join(DIST, ".build-manifest.json"),
    `${JSON.stringify({ app: "@agentplant/web", entry: "index.html", modules: jsFiles.length, refs }, null, 2)}\n`,
    "utf8",
  );

  process.stdout.write(
    `web: dist 就绪（${jsFiles.length} 个 js 模块 + index.html + styles/）→ ${path.relative(process.cwd(), DIST)}\n`,
  );
}

await main();
