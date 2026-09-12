import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/out/**",
      "**/release/**",
      "**/coverage/**",
      "references/**",
      // 本地临时草稿目录（`.tmp-*`）：不进仓、不参与门禁
      "**/.tmp-*/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mts,cts,mjs,js,cjs}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
      },
    },
    rules: {
      // 骨架期：M2 stub 只声明类型，允许下划线前缀的占位形参/变量。
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // 浏览器侧文件（渲染层，t21）：`apps/web/src` 的 TS 有 DOM lib，但纯 JS 资产
    // （如 `styles/theme-init.js`，首帧主题解析）没有 lib 声明来源，必须显式给 globals。
    // 范围只限渲染层源码目录，不影响 Node 侧包与脚本（那些仍只有 console/process）。
    files: ["apps/web/src/**/*.{js,mjs}"],
    languageOptions: {
      globals: {
        window: "readonly",
        document: "readonly",
        localStorage: "readonly",
        matchMedia: "readonly",
        requestAnimationFrame: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        queueMicrotask: "readonly",
      },
    },
  },
);
