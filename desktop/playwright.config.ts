import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/visual",
  testMatch: "**/*.pw.ts",
  outputDir: "./node_modules/.cache/aaw-visual-results",
  use: {
    baseURL: "http://127.0.0.1:4178",
    channel:
      process.env.PLAYWRIGHT_BROWSER_CHANNEL ||
      (process.platform === "win32" ? "msedge" : undefined),
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 4178 --strictPort",
    url: "http://127.0.0.1:4178/tests/visual/fixture.html",
    reuseExistingServer: false,
  },
});
