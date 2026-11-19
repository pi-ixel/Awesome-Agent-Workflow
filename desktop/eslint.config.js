import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

/**
 * ESLint flat config（ESLint 10）。
 *
 * 分工约定：ESLint 只管代码质量与类型安全（含禁止 any 兜底），
 * 格式统一交给 Prettier（npm run format），二者互不越界。
 */
export default tseslint.config(
  // 全局忽略：产物、Rust 侧、生成文件
  {
    ignores: [
      "dist/**",
      // Electron 工具宿主的构建产物（npm run tools:build 生成，gitignore 不入库）：
      // 里面是复制过的 .mjs 与二进制，不该参与源码 lint。
      "tools-runtime/dist/**",
      // 纯声明文件：不在 tsconfig 的 include 里，类型感知规则会对它直接抛错
      // （`await-thenable` 等），导致整次 `eslint .` 中断。它由 tsc 自己校验。
      "tools-runtime/**/*.d.mts",
      "src-tauri/target/**",
      "src-tauri/target-*/**",
      "src-tauri/gen/**",
      "node_modules/**",
      // ZCode 本地运行时产物（workflow 草稿/运行脚本）与界面设计评审留档：
      // 均为本机生成、gitignore 不入库（见根 .gitignore 的 .zcode/ 与
      // desktop/.gitignore 的 design-review/），不属于项目源码，不参与 lint。
      "**/.zcode/**",
      "design-review/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: {
        // Vite 已由项目服务覆盖，Playwright 配置走 Node 默认项目。
        projectService: {
          allowDefaultProject: ["playwright.config.ts"],
          defaultProject: "tsconfig.node.json",
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],

      // 本项目硬性要求：禁止 any 兜底。需要收窄时用 unknown + 类型守卫。
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      // 协议层大量 async 流，悬空 Promise 一律显式处理
      "@typescript-eslint/no-floating-promises": "error",
      // 导入排序不强制，但必须显式（配合 verbatimModuleSyntax）
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
    },
  },

  {
    files: ["src/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "JSXOpeningElement[name.name=/^[a-z]/] > JSXAttribute[name.name='title']",
          message:
            "Use data-hint for Desktop tooltips. Native title tooltips ignore the app theme.",
        },
        {
          selector:
            "JSXOpeningElement[name.name=/^[a-z]/] > JSXAttribute[name.name='role'][value.value='tooltip']",
          message: "Use HintSurface for rich Desktop tooltips.",
        },
      ],
    },
  },

  // 测试文件放宽：允许 devtool 相关全局（jsdom 环境）
  {
    files: ["tests/**/*.test.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
    },
  },

  // JS 配置文件不参与类型感知检查；本目录的 JS 均为 Node 脚本
  // （eslint.config.js、scripts/*.mjs），提供 Node 全局
  {
    files: ["**/*.{js,mjs,cjs}"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: globals.node,
    },
  },
  // The installer visual prototype runs in a browser, without a native bridge.
  {
    files: ["src-tauri/installer/{prototype,ui}/*.js"],
    languageOptions: {
      globals: globals.browser,
    },
  },
);
