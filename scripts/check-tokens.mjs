#!/usr/bin/env node
/**
 * token 门禁（确定性静态校验，零依赖，node 22 直跑）。
 *
 * 调用位：`.github/workflows/ci.yml`（build 之后、typecheck 之前），**脚本存在即硬门禁**。
 * 依据：tokens.md §0.1（组件只用 L2/L3 + 命名规范）、§0.4（四类对比度契约 + 最差表面口径）、
 *       §9-E2/E3（本脚本是缺口 E2 的落地）、t5 §9、ia-and-interaction.md §7.6、t7（反假绿）。
 *
 * 四类检查（全部确定性的静态解析，不联网、不跑浏览器）：
 *   ① 引用完整性：`apps/web/src/styles/tokens.css` 的每个 `--ap-*` 定义都必须在 tokens.md 附录 A
 *      有同名定义，且**取值一致**（明暗两块分别逐项比对）；
 *   ② 禁裸 hex：`apps/web` / `apps/desktop` 的源码与产物 CSS/HTML/TS 中不得出现
 *      tokens.md 未登记的 hex 颜色（tokens.css 的 L1 定义行由"已登记集合"覆盖）；
 *   ③ 对比度复核：用 WCAG 相对亮度公式重算附录 A 组 A–D（文字/指示器 × 9 表面取最差）
 *      与组 E（可解析的色对），不得低于声明值（容差 0.05），且必须满足其档位阈值；
 *   ④ 明暗双主题完整：每个 L2 语义色在明暗两块均有定义（缺失会静默继承浅色值 → 暗色亮块）。
 *
 * 通过时打印 `VERIFY-OK` 摘要；任一失败 exit 1 并逐条打印失败原因与位置。
 */
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKENS_DOC = path.join(REPO_ROOT, "docs", "design", "tokens.md");
const WEB_TOKENS_CSS = path.join(REPO_ROOT, "apps", "web", "src", "styles", "tokens.css");
const SCANNED_TREES = [
  path.join(REPO_ROOT, "apps", "web", "src"),
  path.join(REPO_ROOT, "apps", "web", "dist"),
  path.join(REPO_ROOT, "apps", "desktop", "src"),
  path.join(REPO_ROOT, "apps", "desktop", "dist"),
];
const SCANNED_EXTENSIONS = new Set([".css", ".html", ".ts", ".js", ".mjs", ".cjs"]);
const SKIPPED_DIRS = new Set(["node_modules", ".git"]);

/** 容差（tokens.md §0.4 的实测值保留两位小数，故 0.05 足够宽松又拦得住真回退）。 */
const CONTRAST_TOLERANCE = 0.05;

/** 9 个背景表面（tokens.md 附录 A 的判定口径；从 L1/L2 定义解析，不在此硬编码 hex）。 */
const SURFACE_TOKENS = [
  "surface-0",
  "surface-1",
  "surface-2",
  "surface-sunken",
  "surface-inset",
  "surface-code",
  "surface-bubble-user",
  "surface-row-hover",
  "surface-row-selected",
];

/** L2 语义色前缀（tokens.md §0.2 的保留语义前缀）。 */
const L2_PREFIXES = [
  "surface",
  "text",
  "border",
  "accent",
  "success",
  "warning",
  "danger",
  "info",
  "presence",
  "ambient",
  "emotion",
];

/** 判定阈值（tokens.md §0.4 表）。 */
const THRESHOLDS = {
  text: 4.5,
  indicator: 3,
};

const failures = [];

function fail(message) {
  failures.push(message);
}

// ── 颜色与对比度 ──────────────────────────────────────────────────────────

/** `#RGB` / `#RRGGBB` → [r,g,b]（0–255）；非 hex 返回 null。 */
function parseHex(value) {
  const text = value.trim();
  const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(text);
  if (match === null) {
    return null;
  }
  const body = match[1];
  const full = body.length === 3 ? body.split("").map((c) => c + c).join("") : body;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

function relativeLuminance(rgb) {
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(hexA, hexB) {
  const a = parseHex(hexA);
  const b = parseHex(hexB);
  if (a === null || b === null) {
    return null;
  }
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// ── 解析 tokens.md ────────────────────────────────────────────────────────

const doc = await readFile(TOKENS_DOC, "utf8");
const docLines = doc.split(/\r?\n/);

/**
 * 提取 tokens.md 的**正典 token 定义块**（§7.2/附录 A）。
 *
 * 注意：文档里不止一个 ```css 块（还有 Tailwind `@theme inline` 桥接块与暗色变体片段），
 * 且 `@theme` 段出现得更晚。判据取"内容而非位置"：包含 `--ap-` 定义 **且** 含 `:root` 选择器
 * 的那个块即正典块（@theme 块里全是 `--color-ap-*: var(--ap-*)` 桥接行，不含 `:root`）。
 */
function extractCssBlock(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === "```css") {
      start = index + 1;
      continue;
    }
    if (lines[index].trim() === "```" && start >= 0) {
      blocks.push(lines.slice(start, index).join("\n"));
      start = -1;
    }
  }
  const canonical = blocks.filter(
    (block) => block.includes(":root") && /^\s*--ap-[a-z0-9-]+\s*:/m.test(block),
  );
  if (canonical.length === 0) {
    return null;
  }
  if (canonical.length > 1) {
    process.stderr.write(
      `check-tokens 失败：tokens.md 中有 ${String(canonical.length)} 个"含 :root 与 --ap- 定义"的 css 块，` +
        "正典块必须唯一（tokens.md §7.2 是本文件的正典）\n",
    );
    process.exit(1);
  }
  return canonical[0];
}

const cssBlock = extractCssBlock(doc);
if (cssBlock === null) {
  process.stderr.write("check-tokens 失败：tokens.md 中找不到 ```css 代码块（附录 A 是机器可解析源）\n");
  process.exit(1);
}

const cssLines = cssBlock.split("\n");

/** 把 CSS 文本解析成 { define: Map<name, value>, dark: { define, order }, order: [] }。 */
function parseCssDefinitions(lines) {
  const define = new Map();
  const order = [];
  const darkDefine = new Map();
  const darkOrder = [];
  let inDark = false;
  let selector = "";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("/*") || line.startsWith("*")) {
      continue;
    }
    if (line.endsWith("{")) {
      selector = line.slice(0, -1).trim();
      inDark = selector.includes("data-theme='dark'") || selector.includes('data-theme="dark"');
      continue;
    }
    if (line === "}") {
      selector = "";
      inDark = false;
      continue;
    }
    // 一行里可能有多个定义（`--ap-fs-h2: 17px;   --ap-lh-h2: 26px;` 这类成对写法），
    // 故按 `;` 切开逐段匹配，避免漏掉行内第二个 token。
    for (const segment of line.split(";")) {
      const match = /^\s*(--ap-[a-z0-9-]+)\s*:\s*(.+?)\s*$/.exec(segment);
      if (match === null) {
        continue;
      }
      const [, name, value] = match;
      if (inDark) {
        if (!darkDefine.has(name)) {
          darkOrder.push(name);
        }
        darkDefine.set(name, value.trim());
      } else if (selector === ":root") {
        if (!define.has(name)) {
          order.push(name);
        }
        define.set(name, value.trim());
      }
    }
  }
  return { define, order, darkDefine, darkOrder };
}

const docCss = parseCssDefinitions(cssLines);

/** 递归解析 `var(...)`（单层别名即可：tokens.md 的别名只指向 L1 或同块 token）。 */
function resolveValue(name, define, seen = new Set()) {
  if (seen.has(name)) {
    return null;
  }
  seen.add(name);
  const value = define.get(name);
  if (value === undefined) {
    return null;
  }
  const alias = /^var\(\s*(--ap-[a-z0-9-]+)\s*\)$/.exec(value);
  if (alias === null) {
    return value;
  }
  return resolveValue(alias[1], define, seen);
}

/** tokens.md 中出现的全部 hex（"已登记集合"：任何位置出现即视为登记）。 */
const registeredHex = new Set();
for (const match of doc.matchAll(/#[0-9a-fA-F]{3}\b|#[0-9a-fA-F]{6}\b/g)) {
  registeredHex.add(match[0].toUpperCase());
}

// ── 检查 ①：tokens.css 与 tokens.md 附录 A 一致 ───────────────────────────

const webCssRaw = await readFile(WEB_TOKENS_CSS, "utf8").catch(() => null);
if (webCssRaw === null) {
  fail(`缺少 ${path.relative(REPO_ROOT, WEB_TOKENS_CSS)}（渲染层 token 唯一副本）`);
}
const webCss = webCssRaw === null ? { define: new Map(), order: [], darkDefine: new Map(), darkOrder: [] } : parseCssDefinitions(webCssRaw.split(/\r?\n/));

/**
 * 逐项比对"两份定义块"。
 *
 * 说明：`tokens.md` 与 `tokens.css` 必须**逐项一致**（同一批值），
 * 故这里要求定义集合完全相等——多一个、少一个、值不同都算失败。
 */
function compareBlocks(label, docBlock, webBlock) {
  for (const [name, webValue] of webBlock) {
    if (!docBlock.has(name)) {
      fail(`① ${label}：${name} 在 tokens.css 中定义，但 tokens.md 附录 A 无同名定义（悬空 token）`);
      continue;
    }
    const docValue = docBlock.get(name);
    if (normalize(docValue) !== normalize(webValue)) {
      fail(`① ${label}：${name} 取值不一致 — tokens.md「${docValue}」 vs tokens.css「${webValue}」`);
    }
  }
  for (const name of docBlock.keys()) {
    if (!webBlock.has(name)) {
      fail(`① ${label}：tokens.md 定义 ${name}，但 tokens.css 缺失（漏落盘）`);
    }
  }
}

function normalize(value) {
  return value.replace(/\s+/g, " ").trim().toUpperCase();
}

compareBlocks("明（:root）", docCss.define, webCss.define);
// 暗色块只覆盖一部分 token；比对"双方都定义"的项，并检查 tokens.css 暗块没有文档外的项。
for (const [name, webValue] of webCss.darkDefine) {
  const docValue = docCss.darkDefine.get(name);
  if (docValue === undefined) {
    fail(`① 暗（[data-theme='dark']）：${name} 在 tokens.css 中定义，但 tokens.md 附录 A 暗块无同名定义`);
    continue;
  }
  if (normalize(docValue) !== normalize(webValue)) {
    fail(`① 暗（[data-theme='dark']）：${name} 取值不一致 — tokens.md「${docValue}」 vs tokens.css「${webValue}」`);
  }
}
for (const name of docCss.darkDefine.keys()) {
  if (!webCss.darkDefine.has(name)) {
    fail(`① 暗（[data-theme='dark']）：tokens.md 定义 ${name}，但 tokens.css 暗块缺失（漏落盘）`);
  }
}

// ── 检查 ①b：渲染层样式只引用已定义的 token（悬空引用 = 视觉静默失效） ──────

const APP_CSS = path.join(REPO_ROOT, "apps", "web", "src", "styles", "app.css");
const appCssRaw = await readFile(APP_CSS, "utf8").catch(() => null);
let referencedTokens = 0;
if (appCssRaw === null) {
  fail(`缺少 ${path.relative(REPO_ROOT, APP_CSS)}（渲染层组件样式）`);
} else {
  // 去掉注释再扫，避免把注释里的 `var(--ap-*)` 说明性文字当成真引用。
  const scannable = appCssRaw.replace(/\/\*[\s\S]*?\*\//g, " ");
  const used = new Set([...scannable.matchAll(/var\((--ap-[a-z0-9-]+)/g)].map((match) => match[1]));
  referencedTokens = used.size;
  for (const name of used) {
    if (!webCss.define.has(name) && !webCss.darkDefine.has(name)) {
      fail(`①b app.css 引用了未定义的 token：var(${name})（组件只能用 tokens.css 里存在的 L2/L3）`);
    }
  }
}

// ── 检查 ④：明暗双主题完整（L2 语义色两块都有定义） ───────────────────────

const isL2 = (name) => L2_PREFIXES.some((prefix) => name.startsWith(`--ap-${prefix}-`));
let themePairs = 0;
const themeSameValue = [];
for (const name of docCss.order) {
  if (!isL2(name)) {
    continue;
  }
  if (!docCss.darkDefine.has(name)) {
    // `presence-dot-size` 等结构项在文档里就是主题无关项（两块同值或仅明块定义）——只对"颜色"追责。
    const resolved = resolveValue(name, docCss.define);
    const isColor = resolved !== null && (parseHex(resolved) !== null || resolved.startsWith("rgb("));
    if (!isColor) {
      continue;
    }
    // 文档本身把该色定义为"明暗同值 / 仅明块定义"（如可选的时间氛围 tint）：不算缺失，
    // 但必须显式记录，避免"文档与实现同时漏了暗块"这种双错互相掩盖。
    if (docCss.define.has(name) && !docCss.darkDefine.has(name)) {
      themeSameValue.push(name);
      continue;
    }
    fail(`④ ${name}（L2 颜色）只在明块定义，暗块缺失——暗色下会静默继承浅色值（tokens.md §8 实施提醒）`);
    continue;
  }
  themePairs += 1;
}

// ── 检查 ②：禁裸 hex ──────────────────────────────────────────────────────

async function listFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) {
        continue;
      }
      out.push(...(await listFiles(full)));
    } else if (entry.isFile() && SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

let scannedFiles = 0;
let hexOccurrences = 0;
for (const tree of SCANNED_TREES) {
  const exists = await stat(tree).then(() => true).catch(() => false);
  if (!exists) {
    continue;
  }
  for (const file of await listFiles(tree)) {
    scannedFiles += 1;
    const text = await readFile(file, "utf8");
    const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, " ");
    for (const match of withoutComments.matchAll(/#[0-9a-fA-F]{3}\b|#[0-9a-fA-F]{6}\b/g)) {
      hexOccurrences += 1;
      const value = match[0].toUpperCase();
      if (!registeredHex.has(value)) {
        const line = withoutComments.slice(0, match.index).split("\n").length;
        fail(
          `② 裸 hex 未登记：${path.relative(REPO_ROOT, file)}:${String(line)} → ${match[0]}` +
            `（组件层只能用 var(--ap-*)；L1 取值必须先在 tokens.md 登记，tokens.md §0.1）`,
        );
      }
    }
  }
}

// ── 检查 ③：对比度复核（附录 A 组 A–D + 组 E 可解析色对） ──────────────────

/** 从附录 A 表格里取"某个组"的行：`| \`--ap-x\` | 4.52 | ✅ |`。 */
function appendixRows(groupTitle) {
  const start = docLines.findIndex((line) => line.startsWith(`### 组 ${groupTitle}：`));
  if (start < 0) {
    return [];
  }
  const rows = [];
  for (let index = start + 1; index < docLines.length; index += 1) {
    const line = docLines[index];
    if (line.startsWith("### ")) {
      break;
    }
    const match = /^\|\s*`(--ap-[a-z0-9-]+)`[^|]*\|\s*\*{0,2}([\d.]+)\*{0,2}/.exec(line);
    if (match !== null) {
      // `➖` = 该行按 §0.4 属 **AA 豁免**（禁用态控件），只记录不判阈值。
      const exempt = line.includes("➖");
      rows.push({ token: match[1], declared: Number.parseFloat(match[2]), exempt, line: index + 1 });
    }
  }
  return rows;
}

/** 附录 A 组 E：`| 浅色 \`text-on-accent\` \`#FFFDF8\` / \`accent\` \`#2A2622\`（中性墨色） | **14.77** | ✅ |`。 */
function appendixLightPairs() {
  const start = docLines.findIndex((line) => line.startsWith("### 组 E："));
  if (start < 0) {
    return [];
  }
  const rows = [];
  for (let index = start + 1; index < docLines.length; index += 1) {
    const line = docLines[index];
    if (line.startsWith("### ")) {
      break;
    }
    if (!line.startsWith("| 浅色")) {
      continue;
    }
    const numbers = [...line.matchAll(/`(#[0-9a-fA-F]{6})`/g)].map((m) => m[1]);
    const declared = /\|\s*\*{0,2}([\d.]+)\*{0,2}\s*\|/.exec(line.slice(line.indexOf("|", 1) + 1));
    if (numbers.length < 2 || declared === null) {
      continue;
    }
    rows.push({ fg: numbers[0], bg: numbers[1], declared: Number.parseFloat(declared[1]), line: index + 1 });
  }
  return rows;
}

/** 9 个背景表面的明/暗取值（从 tokens.md 解析：surface-* → L1/字面值）。 */
function surfacesOf(dark) {
  const define = dark ? docCss.darkDefine : docCss.define;
  const merged = new Map([...docCss.define, ...define]);
  const out = new Map();
  for (const token of SURFACE_TOKENS) {
    const value = resolveValue(`--ap-${token}`, merged);
    if (value === null || parseHex(value) === null) {
      fail(`③ 无法解析表面 ${token} 的取值（明暗任一侧）——对比度判定不可信`);
      continue;
    }
    out.set(token, value);
  }
  return [...out.values()];
}

function worstOverSurfaces(fgHex, surfaces) {
  let worst = Number.POSITIVE_INFINITY;
  for (const surface of surfaces) {
    const ratio = contrastRatio(fgHex, surface);
    if (ratio !== null && ratio < worst) {
      worst = ratio;
    }
  }
  return worst;
}

const lightSurfaces = surfacesOf(false);
const darkSurfaces = surfacesOf(true);

const GROUPS = [
  { id: "A", label: "浅色文字 × 9 表面", dark: false, threshold: THRESHOLDS.text },
  { id: "B", label: "浅色非文本指示器 × 9 表面", dark: false, threshold: THRESHOLDS.indicator },
  { id: "C", label: "深色文字 × 9 表面", dark: true, threshold: THRESHOLDS.text },
  { id: "D", label: "深色非文本指示器 × 9 表面", dark: true, threshold: THRESHOLDS.indicator },
];

let contrastChecked = 0;
let exempted = 0;
for (const group of GROUPS) {
  const define = group.dark ? docCss.darkDefine : docCss.define;
  const resolved = new Map([...docCss.define, ...define]);
  for (const row of appendixRows(group.id)) {
    const value = resolveValue(row.token, resolved);
    if (value === null || parseHex(value) === null) {
      fail(`③ 组 ${group.id}：${row.token} 不是可解析的 hex 取值（tokens.md L${String(row.line)}）`);
      continue;
    }
    const surfaces = group.dark ? darkSurfaces : lightSurfaces;
    const computed = worstOverSurfaces(value, surfaces);
    contrastChecked += 1;
    if (row.exempt) {
      exempted += 1;
      continue;
    }
    if (computed < group.threshold) {
      fail(
        `③ 组 ${group.id}（${group.label}）：${row.token} 实测最差 ${computed.toFixed(2)}:1 < 档位阈值 ${String(group.threshold)}:1`,
      );
      continue;
    }
    if (computed < row.declared - CONTRAST_TOLERANCE) {
      fail(
        `③ 组 ${group.id}：${row.token} 实测 ${computed.toFixed(2)}:1 低于声明值 ${row.declared.toFixed(2)}` +
          `（容差 ${String(CONTRAST_TOLERANCE)}；tokens.md L${String(row.line)} 需与实际取值对齐）`,
      );
    }
  }
}

for (const pair of appendixLightPairs()) {
  const computed = contrastRatio(pair.fg, pair.bg);
  if (computed === null) {
    continue;
  }
  contrastChecked += 1;
  if (computed < THRESHOLDS.text) {
    fail(`③ 组 E：${pair.fg} on ${pair.bg} 实测 ${computed.toFixed(2)}:1 < 4.5:1（tokens.md L${String(pair.line)}）`);
    continue;
  }
  if (computed < pair.declared - CONTRAST_TOLERANCE) {
    fail(
      `③ 组 E：${pair.fg} on ${pair.bg} 实测 ${computed.toFixed(2)}:1 低于声明 ${pair.declared.toFixed(2)}` +
        `（tokens.md L${String(pair.line)}）`,
    );
  }
}

// ── 摘要与退出码 ─────────────────────────────────────────────────────────

const tokenCount = docCss.order.length;
const distinctCount = new Set([...docCss.define.keys(), ...docCss.darkDefine.keys()]).size;
const darkCount = docCss.darkDefine.size;

if (failures.length > 0) {
  process.stderr.write("check-tokens 失败（tokens 层门禁，见 tokens.md §0.1/§0.4）：\n");
  for (const message of failures) {
    process.stderr.write(`  ✗ ${message}\n`);
  }
  process.stderr.write(`\n共 ${String(failures.length)} 项失败。修正后重跑：node scripts/check-tokens.mjs\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("VERIFY-OK token 门禁通过（scripts/check-tokens.mjs）\n");
  process.stdout.write(
    `  ① 引用完整性：tokens.css 与 tokens.md 附录 A 逐项一致（明块定义 ${String(tokenCount)} 项 / 暗块定义 ${String(darkCount)} 项，双方集合相等；去重 token ${String(distinctCount)}）；` +
      `app.css 的 ${String(referencedTokens)} 个 token 引用全部有定义\n`,
  );
  process.stdout.write(
    `  ② 禁裸 hex：扫描 ${String(scannedFiles)} 个文件 / ${String(hexOccurrences)} 处 hex，全部已在 tokens.md 登记\n`,
  );
  process.stdout.write(
    `  ③ 对比度复核：重算 ${String(contrastChecked)} 项（组 A–D 按 9 表面取最差 + 组 E 色对），` +
      `最低满足档位阈值且不低于声明值（容差 ${String(CONTRAST_TOLERANCE)}）；` +
      `其中 ${String(exempted)} 项按 §0.4 为 AA 豁免（禁用态，仅记录）\n`,
  );
  process.stdout.write(
    `  ④ 明暗双主题：L2 颜色 token ${String(themePairs)} 项在明暗两块均有定义（另 ${String(themeSameValue.length)} 项文档本身声明为明暗同值/仅明块：${themeSameValue.join(", ")}）\n`,
  );
}
