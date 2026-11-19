import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import electron from "electron";
import { renderGuide } from "./guide-render.mjs";

const desktop = fileURLToPath(new URL("../", import.meta.url));
const source = join(desktop, "tools-runtime");
const staged = process.env.AAW_TOOLS_BUILD_DIR ? resolve(process.env.AAW_TOOLS_BUILD_DIR) : join(source, "dist");
const version = JSON.parse(readFileSync(join(desktop, "node_modules", "electron", "package.json"), "utf8")).version;
const marker = join(staged, `electron-${version}`);
mkdirSync(staged, { recursive: true });
let installed = false;
try { installed = readFileSync(marker, "utf8") === version; } catch { /* first build */ }
if (!installed) {
  const distribution = process.platform === "darwin" ? join(dirname(electron), "../../..") : dirname(electron);
  cpSync(distribution, staged, { recursive: true });
}
const resources = process.platform === "darwin"
  ? join(staged, "Electron.app", "Contents", "Resources")
  : join(staged, "resources");
const appDir = join(resources, "app");
mkdirSync(appDir, { recursive: true });
// Include new sibling modules automatically; a manual list can produce a
// successful build whose entry point fails with ERR_MODULE_NOT_FOUND.
for (const entry of readdirSync(source, { withFileTypes: true })) {
  if (entry.isFile() && (entry.name === "package.json" || /\.(?:mjs|cjs|js|html|css)$/.test(entry.name)))
    cpSync(join(source, entry.name), join(appDir, entry.name));
}
cpSync(join(desktop, "src-tauri", "icons", "32x32.png"), join(appDir, "icon.png"));
await build({
  entryPoints: [join(desktop, "src", "plugins", "tools", "runtime", "package.ts")],
  outfile: join(appDir, "package-contract.mjs"),
  bundle: true,
  format: "esm",
});
/**
 * 指导文档：正文与 AI 读的 `AGENTS.md` / `SKILL.md` 同源（都出自 guide.ts），
 * 这里把它渲染成静态页面。放构建期做，窗口打开时就不用再依赖脚本执行成功。
 */
const guideModule = join(staged, "guide-entry.mjs");
await build({
  entryPoints: [join(desktop, "src", "plugins", "tools", "runtime", "guideEntry.ts")],
  outfile: guideModule,
  bundle: true,
  format: "esm",
});
const { markdown } = await import(pathToFileURL(guideModule).href);
const { toc, body } = renderGuide(markdown);
const template = readFileSync(join(source, "guide.html"), "utf8");
writeFileSync(
  join(appDir, "guide.html"),
  template.replace("<!--GUIDE_TOC-->", toc).replace("<!--GUIDE_BODY-->", body),
);
rmSync(guideModule, { force: true });
if (process.platform === "win32") cpSync(join(source, "aaw-tools.cmd"), join(staged, "aaw-tools.cmd"));
writeFileSync(marker, version);
process.stdout.write(`AAW tools runtime staged (Electron ${version}).\n`);
