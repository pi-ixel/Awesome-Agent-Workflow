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
        // vite.config.ts 属于 tsconfig.node.json（不被主 tsconfig include），
        // 交给 projectService 的默认项目兜底
        projectService: {
          allowDefaultProject: ["vite.config.ts"],
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
);
