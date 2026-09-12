import { defineConfig } from "vitest/config";

/**
 * vite-node 2.1.8 的 `isNodeBuiltin()` 用 `node:module` 的 `builtinModules` 判内置模块，
 * 而 `node:sqlite` 是"仅带 `node:` 前缀可用"的内置模块（**不在** `builtinModules` 里）
 * → 它被当成普通依赖去解析，报 `Failed to load url sqlite`。
 *
 * 因此这里把 `node:sqlite` 重定向到一个虚拟 shim：shim 内部用 `createRequire` 原生加载
 * （`node:module` 是常规内置模块，正常解析）。生产源码保持标准的
 * `import { DatabaseSync } from "node:sqlite"`，不受影响。
 * vite-node 上游修好后（prefixedBuiltins 加入 node:sqlite）本 shim 可直接删除。
 */
const NODE_SQLITE_SHIM = "\0agentplant:node-sqlite";

export default defineConfig({
  plugins: [
    {
      name: "agentplant:node-sqlite-shim",
      enforce: "pre",
      resolveId(id) {
        if (id === "node:sqlite" || id === NODE_SQLITE_SHIM) {
          return NODE_SQLITE_SHIM;
        }
        return undefined;
      },
      load(id) {
        if (id === NODE_SQLITE_SHIM) {
          return [
            'import { createRequire } from "node:module";',
            "const require = createRequire(import.meta.url);",
            'export const DatabaseSync = require("node:sqlite").DatabaseSync;',
          ].join("\n");
        }
        return undefined;
      },
    },
  ],
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "references/**"],
  },
});
