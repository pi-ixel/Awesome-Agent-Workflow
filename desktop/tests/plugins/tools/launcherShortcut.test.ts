import { expect, it, vi } from "vitest";
import { createShortcutController, normalizeShortcut } from "../../../tools-runtime/shortcut.mjs";

/**
 * 录制快捷键时全局热键必须先让出来，否则用户按下的第一下就是当前生效的那组，
 * 窗口会被自己的快捷键关掉——用户想从别的组合键改回 Alt+Space 时，看到的
 * 从来不是"录进去了"，而是界面消失。这几条锁住让位/收回的语义。
 */
function boot(initial = "Alt+Space") {
  const registered = new Set<string>();
  let saved = initial;
  const api = {
    register: vi.fn((accelerator: string) => {
      const key = normalizeShortcut(accelerator);
      if (registered.has(key)) return false;
      registered.add(key);
      return true;
    }),
    unregister: vi.fn((accelerator: string) => { registered.delete(normalizeShortcut(accelerator)); }),
  };
  const store = {
    read: () => ({ shortcut: saved }),
    update: (patch: { shortcut: string }) => { saved = patch.shortcut; },
  };
  const controller = createShortcutController(api, store, () => {});
  return { api, registered, controller, saved: () => saved };
}

it("让出全局热键，恢复后重新注册回同一组", () => {
  const { registered, controller } = boot();
  controller.start();
  expect(registered.has("Alt+Space")).toBe(true);

  controller.pause();
  expect(registered.has("Alt+Space")).toBe(false);

  controller.resume();
  expect(registered.has("Alt+Space")).toBe(true);
  expect(controller.state).toEqual({ shortcut: "Alt+Space", shortcutReady: true });
});

it("暂停期间能从别的组合键改回 Alt+Space", () => {
  const { registered, controller, saved } = boot("Control+Space");
  controller.start();
  expect(registered.has("Control+Space")).toBe(true);

  // 用户点开设置页，开始录快捷键。
  controller.pause();
  expect(registered.has("Control+Space")).toBe(false);

  controller.change("Alt+Space");
  expect(saved()).toBe("Alt+Space");
  // 还在录：存下不等于常驻，否则下一次按键会被它关掉窗口。
  expect(registered.has("Alt+Space")).toBe(false);
  expect(registered.has("Control+Space")).toBe(false);

  controller.resume();
  expect(registered.has("Alt+Space")).toBe(true);
});

it("暂停期间换键：先验证能用，退出录制后才真正注册", () => {
  const { api, registered, controller, saved } = boot();
  controller.start();
  controller.pause();
  api.register.mockClear();

  controller.change("Control+Alt+K");
  expect(api.register).toHaveBeenCalledWith("Control+Alt+K", expect.any(Function));
  expect(saved()).toBe("Control+Alt+K");
  expect(registered.has("Control+Alt+K")).toBe(false);

  controller.resume();
  expect(registered.has("Control+Alt+K")).toBe(true);
});

it("恢复时被别的程序抢走，就把状态标成不可用而不是假装成功", () => {
  const { api, controller } = boot();
  controller.start();
  controller.pause();
  api.register.mockReturnValueOnce(false);

  controller.resume();
  expect(controller.state.shortcutReady).toBe(false);
});

it("saves the active fallback without treating its Ctrl alias as a conflicting shortcut", () => {
  const { api, controller, registered, saved } = boot();
  api.register.mockReturnValueOnce(false);
  expect(controller.start()).toEqual({ ok: true, fallbackFrom: "Alt+Space" });
  expect(registered.has("Control+Alt+Space")).toBe(true);
  expect(() => controller.change("Control+Alt+Space")).not.toThrow();
  expect(controller.state).toEqual({ shortcut: "Control+Alt+Space", shortcutReady: true });
  expect(saved()).toBe("Control+Alt+Space");
});
