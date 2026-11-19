/**
 * 全局唤起快捷键：校验、注册、让位。
 *
 * 单独成文件是为了能被测试直接 import——`launcher-registry.mjs` 依赖
 * `catalog.mjs`，而 catalog 在运行时要的是构建期生成的 `package-contract.mjs`
 * （esbuild 从 `src/plugins/tools/runtime/package.ts` 打出来），源码目录里没有，
 * 测试一 import 就会 ERR_MODULE_NOT_FOUND。纯逻辑放这里，两边都干净。
 */

export function normalizeShortcut(value) {
  if (typeof value !== "string" || value.length > 80) throw new Error("请输入有效的快捷键。");
  const parts = value.trim().split("+");
  const key = parts.pop();
  const aliases = { ctrl: "Control", control: "Control", alt: "Alt", shift: "Shift", command: "Command", cmd: "Command", commandorcontrol: "CommandOrControl" };
  const modifiers = parts.map((part) => aliases[part.toLowerCase()]);
  if (!modifiers.length || modifiers.some((part) => !part) || new Set(modifiers).size !== modifiers.length || !/^(Space|[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4]))$/i.test(key ?? ""))
    throw new Error("请使用 Alt、Ctrl 或 Shift 加空格、字母、数字或功能键，例如 Alt+Space。");
  return [...modifiers, key.toLowerCase() === "space" ? "Space" : key.toUpperCase()].join("+");
}

/**
 * 快捷键都注册不上时的备选：按"离 Alt+Space 越近越优先"的顺序试。
 * 只在用户自己存的那一组失败时才用，不会悄悄改掉一个还能用的配置。
 */
const fallbackShortcuts = ["Ctrl+Alt+Space", "Ctrl+Shift+Space", "Alt+Shift+Space"];

export function createShortcutController(api, store, callback) {
  let current = "Alt+Space";
  let ready = false;
  let paused = false;
  return {
    get state() { return { shortcut: current, shortcutReady: ready }; },
    /**
     * 启动时注册。返回 `{ ok, fallbackFrom? }`：拿不到任何快捷键时调用方要能
     * 主动告诉用户（系统通知），而不是只靠托盘 tooltip 等人去看。
     */
    start() {
      let configured;
      try { configured = normalizeShortcut(store.read().shortcut ?? "Alt+Space"); }
      catch { configured = "Alt+Space"; }
      if (api.register(configured, callback)) {
        current = configured;
        ready = true;
        return { ok: true };
      }
      for (const candidate of fallbackShortcuts.map(normalizeShortcut)) {
        if (candidate === configured) continue;
        if (!api.register(candidate, callback)) continue;
        current = candidate;
        ready = true;
        // 记下来，下次启动直接用能用的那组，不再反复撞墙。
        try { store.update({ shortcut: candidate }); } catch { /* 写不进去就本次生效 */ }
        return { ok: true, fallbackFrom: configured };
      }
      current = configured;
      ready = false;
      return { ok: false, occupied: configured };
    },
    /**
     * 让出全局热键：用户正在录快捷键时，按下的很可能就是当前生效的那组，
     * 不暂停的话窗口会被自己的快捷键关掉，根本录不进去。
     */
    pause() {
      if (!ready || paused) return;
      api.unregister(current);
      paused = true;
    },
    resume() {
      if (!paused) return;
      paused = false;
      // 暂停期间可能已经换成新键并注册过了，这里只补没注册的情况。
      if (ready) ready = api.register(current, callback);
    },
    change(value) {
      const next = normalizeShortcut(value);
      if (next === current && ready && !paused) return;
      // 注册成功只代表"这组键能用"，不代表录制期间就该常驻——见下面的保持暂停。
      if (!api.register(next, callback))
        throw new Error("这组键被其他程序占用了，原来的快捷键仍然生效。换一组，或先关掉占用它的程序。");
      try { store.update({ shortcut: next }); }
      catch (error) { api.unregister(next); throw error; }
      // 暂停态下 current 早已解绑，重复解绑会把刚注册的新键的语义弄混。
      if (!paused && ready && current !== next) api.unregister(current);
      current = next;
      ready = true;
      if (paused) {
        // 还在录：刚存下的这组立刻让出来，否则用户下一次按键会被它关掉窗口。
        api.unregister(next);
      }
    },
  };
}
