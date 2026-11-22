/*
 * 启动器与宿主之间的一层薄 shim。
 *
 * 页面本身（launcher.js）是从 Electron 版原样搬过来的：它只认 `window.launcher`
 * 这个对象。这个文件把那几个方法接到 Tauri 命令上，于是三栏搜索、固定项、
 * 快捷键录制这些打磨过的交互一行都不用重写。
 *
 * 为什么不给主窗用同一套：主窗是 React 应用、有服务层；启动器是一次性打开的
 * 纯 DOM 页面，走命令比引入整套状态管理便宜得多。
 */
(function () {
  "use strict";
  var internals = window.__TAURI_INTERNALS__;

  function invoke(command, args) {
    if (!internals || typeof internals.invoke !== "function") {
      return Promise.reject(new Error("启动器没有连上宿主，请重启 AAW。"));
    }
    return internals.invoke(command, args || {});
  }

  var refresh = null;
  var shortcutPressed = null;

  window.launcher = {
    entries: function () { return invoke("launcher_entries"); },
    // 打开工具的失败原因要能显示出来：宿主 reject 的是字符串，页面读的是
    // `error.message`，不折成 Error 就只剩一句 "undefined"。
    open: function (id) {
      return invoke("launcher_open", { id: id }).catch(function (error) {
        throw error instanceof Error
          ? error
          : new Error(typeof error === "string" && error ? error : "打开工具失败。");
      });
    },
    hide: function () { return invoke("launcher_hide"); },
    pin: function (id, pinned) { return invoke("launcher_pin", { id: id, pinned: pinned === true }); },
    shortcut: function (value) { return invoke("launcher_shortcut", { value: value }); },
    capture: function (active) { return invoke("launcher_capture", { active: active === true }); },
    theme: function () { return invoke("launcher_theme"); },
    onRefresh: function (callback) { refresh = callback; },
    onShortcutPressed: function (callback) { shortcutPressed = callback; },
  };

  // 宿主用 eval 调这两个钩子：刷新目录、回送录制中的组合键。
  window.__launcherRefresh = function () {
    try { if (refresh) refresh(); } catch (_) { /* 页面自己的错不该冒到宿主 */ }
  };
  window.__launcherShortcut = function (value) {
    try { if (shortcutPressed) shortcutPressed(value); } catch (_) { /* 同上 */ }
  };
})();
