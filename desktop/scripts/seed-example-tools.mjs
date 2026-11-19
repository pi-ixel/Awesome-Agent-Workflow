import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { exampleTools } from "../src/plugins/tools/runtime/examples.ts";

/**
 * 给当前登录账号预装内置示例工具（幂等、只增不覆盖）。
 *
 * 用途是本地验收「有插件时工具中心长什么样」，不是产品行为——正常使用请点
 * 空状态里的「载入示例工具」。改的是 AAW 自己的配置文件，不碰任何权限层。
 *
 * 重要：应用运行时内存里有配置快照，退出时会回写并覆盖这里的改动。请先退出
 * AAW 桌面客户端，再运行 `npm run tools:seed`，然后重新打开。
 */
function dataRoot() {
  if (process.env.AAW_TOOLS_DATA_ROOT) return process.env.AAW_TOOLS_DATA_ROOT;
  if (process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, "com.aaw.desktop");
  return join(homedir(), "AppData", "Local", "com.aaw.desktop");
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw new Error(`读不出 ${path}：${error.message}`, { cause: error });
  }
}

const root = dataRoot();
const active = readJson(join(root, "storage-location.json"), {}).active || root;
const configuration = join(active, "configuration");
const preferences = join(configuration, "preferences.json");
const raw = readJson(preferences, {});
const account = (() => {
  try { return JSON.parse(raw["aaw-desktop.auth.v1"] || "null"); }
  catch { return null; }
})();
const userId = account?.user?.id;
if (!userId) {
  console.error("找不到当前登录账号：请先打开 AAW 并登录一次，再运行本脚本。");
  process.exit(1);
}

const owner = `user:${userId}`;
const library = (() => {
  try { return JSON.parse(raw["aaw-desktop.personal-tools.v1"] || "{}"); }
  catch { return {}; }
})();
const current = Array.isArray(library[owner]) ? library[owner] : [];
const installed = new Set(current.map((entry) => entry?.package?.id));
const added = [];

for (const tool of exampleTools) {
  if (installed.has(tool.id)) continue;
  current.push({ package: tool, settings: {}, installedAt: Date.now() });
  installed.add(tool.id);
  added.push(tool.name);
}

if (!added.length) {
  console.log(`示例工具已经装好了（${owner}），没有改动配置。`);
  process.exit(0);
}

mkdirSync(configuration, { recursive: true });
const next = { ...raw, "aaw-desktop.personal-tools.v1": JSON.stringify({ ...library, [owner]: current }) };
const backup = `${preferences}.bak-${Date.now()}`;
if (existsSync(preferences)) copyFileSync(preferences, backup);
const temp = `${preferences}.tmp-${process.pid}`;
writeFileSync(temp, JSON.stringify(next));
renameSync(temp, preferences);
console.log(`已为 ${owner} 装入 ${added.length} 个示例工具：${added.join("、")}`);
if (existsSync(backup)) console.log(`原配置备份：${backup}`);
console.log("现在可以重新打开 AAW 桌面客户端查看「已安装」。");
