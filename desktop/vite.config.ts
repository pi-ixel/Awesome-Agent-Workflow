import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import process from "node:process";

import { aawDevBridgePlugin } from "./scripts/devBridgePlugin.ts";

const host = process.env.TAURI_DEV_HOST;

const disableDevClient: Plugin = {
  name: "aaw-disable-dev-client",
  configureServer(server: {
    middlewares: {
      use: (
        handler: (
          request: { url?: string },
          response: {
            setHeader: (name: string, value: string) => void;
            end: (body: string) => void;
          },
          next: () => void,
        ) => void,
      ) => void;
    };
  }) {
    server.middlewares.use((request, response, next) => {
      if (request.url === "/@vite/client") {
        response.setHeader("Cache-Control", "no-store");
        const end = response.end.bind(response);
        response.end = (body: string) => {
          response.setHeader("Cache-Control", "no-store");
          end(body.replaceAll("location.reload()", "void 0"));
        };
      }
      next();
    });
  },
};

// mock 隔离敏感（vi.mock 模块状态在 vmThreads 下不可靠）的用例，留在默认
// forks 池全隔离执行；其余文件进 vmThreads 复用 jsdom 环境（全量 110s→约30s）。
const isolatedPoolTests = [
  "tests/plugins/project/conversation/SessionFactory.compaction.test.ts",
  "tests/plugins/project/conversation/historyCompaction.test.ts",
  "tests/plugins/agents/SettingsPage.test.tsx",
  "tests/integration/SettingsPage.test.tsx",
  "tests/plugins/project/sessions/viteConfig.test.ts",
  "tests/architecture/cordisArchitecture.test.ts",
];

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    aawDevBridgePlugin(),
    ...(host || process.env.AAW_DEV_BRIDGE ? [] : [disableDevClient]),
  ],

  // Vitest：jsdom 环境，测试集中在 tests/ 目录，setup 统一挂 jest-dom 匹配器
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["tests/setup.ts"],
    maxWorkers: 4,
    projects: [
      {
        test: {
          name: "isolated",
          include: isolatedPoolTests,
        },
      },
      {
        test: {
          name: "fast",
          include: ["tests/**/*.test.{ts,tsx}"],
          exclude: isolatedPoolTests,
          pool: "vmThreads",
        },
      },
    ],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
});
