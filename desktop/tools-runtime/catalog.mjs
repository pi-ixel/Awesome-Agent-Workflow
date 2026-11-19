import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readToolPackage, resolveToolSettings } from "./package-contract.mjs";

export function readRecord(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

export function defaultRoot() {
  if (process.env.AAW_TOOLS_DATA_ROOT) return process.env.AAW_TOOLS_DATA_ROOT;
  if (process.platform === "win32" && process.env.LOCALAPPDATA)
    return join(process.env.LOCALAPPDATA, "com.aaw.desktop");
  throw new Error("请指定 AAW_TOOLS_DATA_ROOT。");
}

/**
 * 主窗外观（workbench 写在 `aaw-desktop.settings.v1` 里的 theme）。
 *
 * 启动器要跟随主窗：主窗默认就是深色，小窗却长期写死浅色——半夜按快捷键
 * 弹出一整块白板。这里只读，不做任何写入。
 * `warm` 是主窗对浅色主题的叫法（`theme-warm` 根类）。
 */
function appearanceOf(settings) {
  let value;
  try { value = JSON.parse(settings["aaw-desktop.settings.v1"] || "null"); }
  catch { /* 偏好文件里存了坏数据就按默认深色处理 */ }
  return { theme: value?.theme === "warm" ? "warm" : "dark" };
}

function fingerprint(path) {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
  } catch { return "missing"; }
}

/**
 * 配置快照：按文件指纹失效，不再按时间猜。
 *
 * `preferences.json` 里存着每个工具的完整 HTML，能到几 MB；启动器每次唤起、
 * `showLauncher()` 取底色、`openGuide()` 取主题都会读它。以前是"读一遍、解析
 * 一遍"乘以调用次数，还配了一个 1 秒 TTL 的猜测式缓存——装完新工具要等 1 秒
 * 才出现，改了主题也可能晚一拍。
 *
 * 现在缓存 key 是三个相关文件的 mtime/ctime/size：没变就零成本复用，主窗一写
 * 配置文件指纹立刻变，下一个读取就是新内容。比 TTL 又快又准。
 */
let configurationCache;
function configurationOf(root) {
  const location = join(root, "storage-location.json");
  const storage = readRecord(location).active || root;
  const configuration = join(storage, "configuration");
  const preferences = join(configuration, "preferences.json");
  const recent = join(configuration, "tools-recent.json");
  const stamp = `${root}|${fingerprint(location)}|${fingerprint(preferences)}|${fingerprint(recent)}`;
  if (configurationCache && configurationCache.stamp === stamp) return configurationCache.value;
  const value = { settings: readRecord(preferences), configuration, stamp };
  configurationCache = { stamp, value };
  return value;
}

/** 给启动器目录快照用：同一份配置没变就直接复用，变了立刻重读。 */
export function configurationStamp(root) {
  return configurationOf(root).stamp;
}

export function readAppearance(root) {
  return appearanceOf(configurationOf(root).settings);
}

export function getCatalog(root) {
  const { settings, configuration } = configurationOf(root);
  // 主题顺带带走：小窗唤起时不用为它再读一遍同一个文件（里面有每个工具的完整 HTML）。
  const { theme } = appearanceOf(settings);
  const auth = JSON.parse(settings["aaw-desktop.auth.v1"] || "null");
  const library = JSON.parse(settings["aaw-desktop.personal-tools.v1"] || "{}");
  const owner = typeof auth?.user?.id === "string" ? `user:${auth.user.id}` : null;
  if (!owner) return { signedIn: false, theme, tools: [], broken: [] };
  const recentPath = join(configuration, "tools-recent.json");
  const recent = readRecord(recentPath);
  const items = Object.hasOwn(library, owner) ? library[owner] : [];
  /**
   * 读不出来的工具单独列出来，而不是 `return []` 丢掉。
   *
   * 启动器仍然只渲染能跑的（`tools`），但会知道"还有 N 个跑不了"——用户不会
   * 遇到"我明明装过，列表里却没有"这种事却毫无解释。
   */
  const broken = [];
  const tools = (Array.isArray(items) ? items : []).flatMap((entry) => {
    const tool = readToolPackage(entry?.package);
    if (!tool) {
      const id = typeof entry?.package?.id === "string" ? entry.package.id : "";
      if (id) broken.push({
        id,
        name: typeof entry?.package?.name === "string" && entry.package.name.trim()
          ? entry.package.name
          : "无法读取的工具",
      });
      return [];
    }
    const key = `${owner}/${tool.id}`;
    return [{
      tool,
      settings: resolveToolSettings(tool, entry.settings),
      /**
       * 工具的运行目录（作者源码目录 / ZIP 安装落点）。
       *
       * 有它就按目录加载：`index.html`、`node_modules`、图片、wasm 全都从磁盘读，
       * 作者改完文件重新打开就生效，不用重新安装。没有它（老记录）就退回清单里的
       * `html` 快照——存量工具行为完全不变。
       */
      dir: typeof entry.dir === "string" && entry.dir.trim() ? entry.dir : undefined,
      lastOpened: Math.max(Number(entry.lastOpened) || 0, Number(recent[key]) || 0),
      touch() {
        mkdirSync(configuration, { recursive: true });
        const next = { ...readRecord(recentPath), [key]: Date.now() };
        const temp = `${recentPath}.tmp-${process.pid}`;
        writeFileSync(temp, JSON.stringify(next));
        renameSync(temp, recentPath);
      },
    }];
  });
  tools.sort((a, b) => b.lastOpened - a.lastOpened || a.tool.name.localeCompare(b.tool.name, "zh-CN"));
  return { signedIn: true, owner, theme, tools, broken };
}

export function describeTool(tool) {
  return { id: tool.id, name: tool.name, version: tool.version, actions: tool.actions ?? [], settingsSchema: tool.settingsSchema ?? [] };
}
