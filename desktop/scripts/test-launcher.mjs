import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLauncherCatalog, createLauncherRegistry, createLauncherStore, createShortcutController } from "../tools-runtime/dist/resources/app/launcher-registry.mjs";

test("providers are removable and reject ambiguous identities", () => {
  const registry = createLauncherRegistry();
  const remove = registry.register("builtin", () => [{ id: "builtin:aaw" }]);
  assert.throws(() => registry.register("builtin", () => []));
  registry.register("other", () => [{ id: "builtin:aaw" }]);
  assert.throws(() => registry.entries());
  remove();
  assert.equal(registry.entries().length, 1);
});

test("catalog isolates account pins, merges recents and routes builtins independently", async () => {
  const root = mkdtempSync(join(tmpdir(), "aaw-launcher-test-"));
  try {
    mkdirSync(join(root, "configuration"));
    const pkg = { schemaVersion: 1, id: "test-tool", name: "Test tool", version: "1.0.0", html: "<p>Hello</p>" };
    const preferences = {
      "aaw-desktop.personal-tools.v1": JSON.stringify({ "user:first": [{ package: pkg, lastOpened: 42 }] }),
    };
    const login = (id) => writeFileSync(join(root, "configuration", "preferences.json"), JSON.stringify({ ...preferences,
      "aaw-desktop.auth.v1": JSON.stringify({ user: { id } }),
    }));
    login("first");
    const opened = [];
    const store = createLauncherStore(root);
    store.update({ users: { "user:first": { recent: { "builtin:aaw": Date.now(), "builtin:tools": Date.now() } } } });
    const catalog = createLauncherCatalog(root, store, { openTool: async (tool) => opened.push(tool.id), openDesktop: async (target) => opened.push(target) });
    assert.equal(catalog.read().entries[0].id, "personal:test-tool");
    catalog.pin("personal:test-tool", true);
    await catalog.open("builtin:aaw");
    await catalog.open("builtin:tools");
    assert.equal(catalog.read().entries.find((item) => item.id === "builtin:aaw").recent, 0);
    assert.equal(catalog.read().entries.find((item) => item.id === "builtin:tools").recent, 0);
    assert.equal(catalog.read().entries[0].id, "personal:test-tool");
    await catalog.open("personal:test-tool");
    assert.deepEqual(opened, ["aaw", "tools", "test-tool"]);
    assert.equal(catalog.read().entries.find((item) => item.id === "personal:test-tool").pinned, true);
    login("second");
    assert.equal(catalog.read().entries.length, 2);
    assert.equal(catalog.read().entries.every((item) => item.recent === 0), true);
    await assert.rejects(catalog.open("personal:test-tool"));
    login("first");
    assert.equal(catalog.read().entries.find((item) => item.id === "personal:test-tool").pinned, true);
    const failing = createLauncherCatalog(root, store, { openTool: async () => {}, openDesktop: async () => { throw new Error("not ready"); } });
    const before = JSON.stringify(store.read());
    await assert.rejects(failing.open("builtin:tools"));
    assert.equal(JSON.stringify(store.read()), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("shortcut changes preserve working key on conflict or write failure, persist and restore", () => {
  let saved = {};
  let failSave = false;
  const registered = new Set(["Control+Q"]);
  const api = { register: (key) => { if (registered.has(key)) return false; registered.add(key); return true; }, unregister: (key) => registered.delete(key) };
  const store = { read: () => saved, update: (patch) => { if (failSave) throw new Error("disk full"); saved = { ...saved, ...patch }; } };
  const controller = createShortcutController(api, store, () => {});
  controller.start();
  assert.deepEqual(controller.state, { shortcut: "Alt+Space", shortcutReady: true });
  assert.throws(() => controller.change("Ctrl+Q"), /占用/);
  assert.equal(registered.has("Alt+Space"), true);
  failSave = true;
  assert.throws(() => controller.change("Ctrl+Shift+Space"), /disk full/);
  assert.equal(registered.has("Control+Shift+Space"), false);
  assert.equal(registered.has("Alt+Space"), true);
  failSave = false;
  controller.change("Ctrl+Shift+Space");
  assert.equal(registered.has("Alt+Space"), false);
  assert.equal(saved.shortcut, "Control+Shift+Space");
  registered.delete(saved.shortcut);
  const restarted = createShortcutController(api, store, () => {});
  restarted.start();
  assert.deepEqual(restarted.state, { shortcut: "Control+Shift+Space", shortcutReady: true });
  assert.throws(() => restarted.change("Space"));
  assert.throws(() => restarted.change("Ctrl+Ctrl+K"));
});

test("falls back to a free shortcut and reports when none is available", () => {
  const taken = new Set(["Alt+Space", "Ctrl+Alt+Space"]);
  let saved = {};
  const api = {
    register: (key) => (taken.has(key) ? false : (taken.add(key), true)),
    unregister: (key) => taken.delete(key),
  };
  const store = { read: () => saved, update: (patch) => { saved = { ...saved, ...patch }; } };
  const controller = createShortcutController(api, store, () => {});
  const result = controller.start();
  assert.equal(result.ok, true);
  assert.equal(result.fallbackFrom, "Alt+Space");
  assert.equal(controller.state.shortcut, "Ctrl+Shift+Space");
  // 换到的那组要落盘，下次启动不再撞同一个键。
  assert.equal(saved.shortcut, "Ctrl+Shift+Space");

  const blocked = createShortcutController(
    { register: () => false, unregister: () => {} },
    { read: () => ({}), update: () => {} },
    () => {},
  );
  const failed = blocked.start();
  assert.equal(failed.ok, false);
  assert.equal(failed.occupied, "Alt+Space");
  assert.equal(blocked.state.shortcutReady, false);
});
