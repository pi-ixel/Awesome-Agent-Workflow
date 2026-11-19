/* global window, document */
import { _electron as electron, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sampleTool } from "../src/plugins/tools/ui/sample.ts";

const root = mkdtempSync(join(tmpdir(), "aaw-launcher-ui-"));
const runtime = fileURLToPath(new URL("../tools-runtime/dist/", import.meta.url));
let app;
try {
  mkdirSync(join(root, "configuration"));
  writeFileSync(join(root, "configuration", "preferences.json"), JSON.stringify({
    "aaw-desktop.auth.v1": JSON.stringify({ user: { id: "ui-test" } }),
    "aaw-desktop.personal-tools.v1": JSON.stringify({ "user:ui-test": Array.from({ length: 18 }, (_, index) => ({
      package: { ...sampleTool, id: `test-${index}`, name: `测试工具 ${index}` }, settings: { indent: 4 },
      lastOpened: 100 - index,
    })) }),
  }));
  app = await electron.launch({ executablePath: join(runtime, "electron.exe"), env: { ...process.env,
    AAW_TOOLS_DATA_ROOT: root, AAW_TOOLS_HOST_PROFILE: join(root, "profile"), AAW_TOOLS_PARENT_PID: "", AAW_LAUNCHER_PORT: "", AAW_LAUNCHER_TOKEN: "",
  } });
  const page = await app.firstWindow();
  await expect(page.getByRole("heading", { name: "最近使用" })).toBeVisible();
  await expect(page.getByLabel("搜索功能", { exact: true })).toHaveCSS("font-size", "17px");
  await page.screenshot({ path: "node_modules/.cache/launcher-compact.png" });
  await page.getByRole("button", { name: "全部功能", exact: true }).click();
  await expect(page.locator("#results .item")).toHaveCount(20);
  await page.getByLabel("搜索功能", { exact: true }).fill("测试工具 17");
  await expect(page.locator("#results .item")).toHaveCount(1);
  await page.getByRole("button", { name: "固定 测试工具 17", exact: true }).click();
  await expect(page.getByRole("button", { name: "取消固定 测试工具 17", exact: true })).toBeAttached();
  await page.getByLabel("搜索功能", { exact: true }).fill("");
  await expect(page.locator("#pinned .item")).toHaveCount(3);
  await page.getByRole("button", { name: "查看全部最近 (18)", exact: true }).click();
  await expect(page.locator("#results .item")).toHaveCount(18);
  for (const [width, height] of [[800, 360], [360, 300]]) {
    await app.evaluate(({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setResizable(true);
      window.setSize(...size);
      window.setResizable(false);
    }, [width, height]);
    // Windows frameless resize style changes can add a 1px border on either side.
    await expect.poll(async () => Math.abs(await page.evaluate(() => window.innerWidth) - width)).toBeLessThanOrEqual(2);
    const layout = await page.evaluate(() => ({ width: window.innerWidth, overflow: document.documentElement.scrollWidth,
      footer: document.querySelector("footer").getBoundingClientRect().bottom, height: window.innerHeight }));
    if (layout.overflow > layout.width || layout.footer > layout.height) throw new Error(`布局溢出 ${JSON.stringify(layout)}`);
  }
  await page.getByRole("button", { name: "启动器设置", exact: true }).click();
  // 快捷键改成按键捕获：输入框只读，直接按组合键。
  await page.getByLabel("全局唤起快捷键", { exact: true }).focus();
  await page.keyboard.press("Control+Alt+F11");
  await page.getByRole("button", { name: "保存快捷键", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("快捷键已保存，即刻生效。");
  await app.evaluate(({ globalShortcut }) => globalShortcut.register("Control+Alt+F10", () => {}));
  await page.getByLabel("全局唤起快捷键", { exact: true }).focus();
  await page.keyboard.press("Control+Alt+F10");
  await page.getByRole("button", { name: "保存快捷键", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("原快捷键已保留");
  await expect(page.locator("#shortcut")).toHaveText("Ctrl + Alt + F11");
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.getByLabel("搜索功能", { exact: true }).fill("AAW");
  await page.getByRole("button", { name: "AAW 工作流", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("请从 AAW Desktop 打开小窗");
  await page.getByLabel("搜索功能", { exact: true }).fill("测试工具 0");
  const opening = app.waitForEvent("window");
  await page.locator("#results .item").click();
  const toolWindow = await opening;
  await toolWindow.locator("#format").click();
  await expect(toolWindow.locator("#source")).toHaveValue('{\n    "hello": "AAW"\n}');
  process.stdout.write("Electron launcher UI: search, pin, overflow, shortcut conflict and standalone route checks passed.\n");
} finally {
  await app?.close();
  try { rmSync(root, { recursive: true, force: true }); } catch { /* Chromium may release files slightly later. */ }
}
