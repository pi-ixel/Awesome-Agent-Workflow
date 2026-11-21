// 连上 WebView2 的调试端口，把 pilot 页面里的四项自检结果读出来并截图。
//
// 为什么不在页面上加"上报"按钮：验证要能自动化跑，而不是靠人眼看。
// 调试端口只由 `scripts/open-tools-pilot.mjs` 打开，发布构建里没有它。
import { chromium } from "playwright";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const port = process.env.AAW_PILOT_CDP_PORT || "9222";
const outDir = process.env.AAW_PILOT_SHOT_DIR || join(tmpdir(), "aaw-pilot");
mkdirSync(outDir, { recursive: true });

// 落盘位置与 Electron 版一致：`<AAW 数据目录>/tools/storage/<账号>/<工具 id>.json`。
// 这里只是"顺手指一下"，真正的路径由 Rust 决定；找不到就算了，不阻断验证。
const dataRoot =
  process.env.AAW_TOOLS_TAURI_DATA_ROOT ||
  (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "com.aaw.desktop") : "");
let dataFile = "";
try {
  const prefs = JSON.parse(readFileSync(join(dataRoot, "configuration", "preferences.json"), "utf8"));
  const auth = JSON.parse(prefs["aaw-desktop.auth.v1"] || "null");
  const owner = String(auth?.user?.id || "").replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[._]+|\.+$/g, "");
  if (owner) dataFile = join(dataRoot, "tools", "storage", owner, "pilot.json");
} catch {
  /* 未登录或没有偏好文件时不显示落盘证据 */
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const pages = browser.contexts().flatMap((context) => context.pages());
const page = pages.find((item) => item.url().includes("aaw-tool")) || pages[0];
if (!page) {
  console.error("没有找到任何页面");
  process.exit(1);
}

console.log("URL:", page.url());

// 刷新一次：dev 期常改工具页面，窗口里挂着的还是上一版 DOM。
// 刷新同时也验证了"注入脚本在每次导航都会重新执行"——初始脚本不是一次性的。
await page.reload({ waitUntil: "domcontentloaded" });
console.log("TITLE:", await page.title());

// 等四项都出结果（store 与动作是异步的）。
await page
  .waitForFunction(() => document.getElementById("score")?.textContent?.includes("/"), { timeout: 20000 })
  .catch(() => console.error("等待自检结果超时"));

// 第 4 项要人点，这里替人点一下：点完等结果位变成带格式的返回体。
await page.click("#btn-act").catch(() => {});
await page
  .waitForFunction(
    () => {
      const text = document.getElementById("out-act")?.textContent || "";
      return text.includes("stats 返回") || text.includes("失败");
    },
    { timeout: 25000 },
  )
  .catch(() => console.error("等待动作调用结果超时"));

const report = await page.evaluate(() => ({
  href: location.href,
  score: document.getElementById("score")?.textContent,
  items: ["scheme", "inject", "store", "act"].map((key) => ({
    key,
    dot: document.getElementById("dot-" + key)?.className,
    text: document.getElementById("out-" + key)?.textContent,
  })),
  facts: {
    settings: document.getElementById("fact-settings")?.textContent,
    context: document.getElementById("fact-context")?.textContent,
    host: document.getElementById("fact-host")?.textContent,
  },
  carrier: document.getElementById("carrier")?.textContent,
}));

console.log(JSON.stringify(report, null, 2));

// ── 持久化：点两次 +1，刷新，值要还在 ─────────────────────────────────
// 刷新等价于"关掉工具再打开"：DOM 与 JS 全部重建，能读回来说明数据真在磁盘上，
// 而不是活在页面内存里。
await page.click("#btn-add");
await page.click("#btn-add");
await page.waitForTimeout(400);
const beforeReload = (await page.evaluate(() => document.getElementById("out-store")?.textContent)) || "";
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction(() => (document.getElementById("out-store")?.textContent || "").includes("count ="), {
  timeout: 15000,
});
const afterReload = await page.evaluate(() => ({
  store: document.getElementById("out-store")?.textContent,
  act: document.getElementById("out-act")?.textContent,
}));

console.log("\n持久化前:", beforeReload.split("\n")[0]);
console.log("刷新后  :", (afterReload.store || "").split("\n")[0]);

// 磁盘上到底有没有这个文件：这是"真的落盘"唯一的硬证据。
if (dataFile) {
  const exists = existsSync(dataFile);
  console.log("落盘文件:", dataFile, exists ? "存在" : "不存在");
  if (exists) console.log("文件内容:", readFileSync(dataFile, "utf8"));
}

const shot = join(outDir, "pilot.png");
await page.setViewportSize({ width: 880, height: 640 });
// 截图前再调一次动作：刷新会把第 4 项重置成"还没调用"，截图该是最终状态。
await page.click("#btn-act").catch(() => {});
await page
  .waitForFunction(() => (document.getElementById("out-act")?.textContent || "").includes("stats 返回"), { timeout: 20000 })
  .catch(() => {});
await page.screenshot({ path: shot, fullPage: true });
console.log("SHOT:", shot);
console.log("最终得分:", await page.evaluate(() => document.getElementById("score")?.textContent));

await browser.close();
