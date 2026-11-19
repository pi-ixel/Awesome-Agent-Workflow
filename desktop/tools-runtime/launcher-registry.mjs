import { mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRecord, getCatalog, configurationStamp } from "./catalog.mjs";
import { toneOf, toolGlyph } from "./tone.mjs";

export function createLauncherStore(root) {
  const path = join(root, "launcher-settings.json");
  return {
    read: () => readRecord(path),
    update(patch) {
      mkdirSync(root, { recursive: true });
      const next = { ...readRecord(path), ...patch };
      const temp = `${path}.tmp-${process.pid}`;
      writeFileSync(temp, JSON.stringify(next));
      renameSync(temp, path);
    },
    /** 固定/最近使用变了也要让目录快照失效，否则"最近使用"排序不更新。 */
    stamp() {
      try {
        const stat = statSync(path);
        return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
      } catch { return "missing"; }
    },
  };
}

// Providers own execution; the renderer only receives serializable presentation data.
export function createLauncherRegistry() {
  const providers = new Map();
  return {
    register(id, provider) {
      if (providers.has(id)) throw new Error(`重复的启动项来源：${id}`);
      providers.set(id, provider);
      return () => providers.delete(id);
    },
    entries() {
      const entries = [...providers.values()].flatMap((provider) => provider());
      if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
        throw new Error("启动项 ID 必须唯一。");
      return entries;
    },
  };
}

export function createLauncherCatalog(root, store, { openTool, openDesktop }) {
  const registry = createLauncherRegistry();
  /**
   * 目录快照按"文件指纹"失效，不再按时间猜。
   *
   * `getCatalog()` 要解析几 MB 的 `preferences.json`（里面是每个工具的完整 HTML），
   * 而一次 `read()` 里 owner 判断与 personal provider 会各调一次。指纹没变就直接
   * 复用同一份结果：连续唤起零解析；主窗装了新工具、改了主题、点了固定或打开过
   * 工具，相关文件一写指纹立刻变，下一次读取就是新内容——没有旧版 TTL 那 1 秒
   * 的"装完还看不到"。
   */
  let snapshot;
  function catalog() {
    const stamp = `${configurationStamp(root)}|${store.stamp()}`;
    if (snapshot && snapshot.stamp === stamp) return snapshot.value;
    const value = getCatalog(root);
    snapshot = { stamp, value };
    return value;
  }
  registry.register("personal", () => catalog().tools.map((entry) => ({
    id: `personal:${entry.tool.id}`, name: entry.tool.name,
    description: `个人工具 · v${entry.tool.version}`, keywords: [entry.tool.id, "工具", "plugin"],
    source: "personal", scope: "personal", icon: "tool",
    // 字形与色板在这里算好再下发：页面只负责渲染，避免主窗/小窗两份实现漂移。
    glyph: toolGlyph(entry.tool), tone: toneOf(entry.tool.id),
    recent: entry.lastOpened,
    open: async () => { await openTool(entry.tool, entry.settings, entry.dir); entry.touch(); },
  })));
  registry.register("builtin", () => [
    { id: "builtin:aaw", name: "AAW 工作流", description: "在主窗口打开当前项目的工作流", keywords: ["workflow", "工作流"], icon: "workflow", target: "aaw" },
    { id: "builtin:tools", name: "工具中心", description: "管理、导入和开发个人工具", keywords: ["工具", "插件", "管理", "开发"], icon: "library", target: "tools" },
  ].map((entry) => ({ ...entry, source: "builtin", scope: "builtin", recent: 0, trackRecent: false,
    open: () => openDesktop(entry.target),
  })));
  function read() {
    const { owner, signedIn, theme } = catalog();
    const user = store.read().users?.[owner ?? "guest"] ?? {};
    const pinned = user.pinned ?? ["builtin:aaw", "builtin:tools"];
    return { owner, signedIn, theme, entries: registry.entries().map((entry) => ({ ...entry,
      recent: entry.trackRecent === false ? 0 : Math.max(entry.recent, Number(user.recent?.[entry.id]) || 0), pinned: pinned.includes(entry.id), pinOrder: pinned.indexOf(entry.id),
    })).sort((a, b) => b.recent - a.recent || a.name.localeCompare(b.name, "zh-CN")) };
  }
  function updateUser(patch, owner = read().owner) {
    const users = store.read().users ?? {};
    const key = owner ?? "guest";
    store.update({ users: { ...users, [key]: { ...users[key], ...patch(users[key] ?? {}) } } });
  }
  return {
    registry, read,
    async open(id) {
      const snapshot = read();
      const entry = snapshot.entries.find((item) => item.id === id);
      if (!entry) throw new Error("此功能已移除或当前账号不可用，请重新搜索。");
      await entry.open();
      if (entry.trackRecent !== false) updateUser((user) => ({ recent: { ...user.recent, [id]: Date.now() } }), snapshot.owner);
    },
    pin(id, pinned) {
      const entries = read().entries;
      if (!entries.some((entry) => entry.id === id) || typeof pinned !== "boolean") throw new Error("无效的固定入口。");
      const ids = entries.filter((entry) => entry.pinned && entry.id !== id).sort((a, b) => a.pinOrder - b.pinOrder).map((entry) => entry.id);
      updateUser(() => ({ pinned: pinned ? [...ids, id] : ids }));
    },
  };
}


// 快捷键控制器搬到 shortcut.mjs（不依赖 catalog，便于单测）；这里保持原有导出面。
export { normalizeShortcut, createShortcutController } from "./shortcut.mjs";
