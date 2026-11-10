import { documentTab } from "../../../src/plugins/documents/ui/documentTabs.tsx";
import type { Context } from "cordis";
import { afterEach, expect, it, vi } from "vitest";
import { ExitCoordinator } from "../../../src/plugins/workbench/exit/exit.ts";
import * as workbenchPlugin from "../../../src/plugins/workbench/index.ts";
import { installDesktopWorkbench } from "../../../src/bootstrap/installDesktopWorkbench.ts";
import type { WorkbenchService } from "../../../src/plugins/workbench/service.ts";
import type { WorkbenchSlot } from "../../../src/plugins/workbench/types.ts";
import {
  LEFT_WIDTH_STORAGE_KEY,
  LEFT_WIDTH_VAR,
} from "../../../src/plugins/workbench/ui/columnWidths.ts";
import { createHostExitGate } from "../../../src/plugins/host/lifecycle/exitGate.ts";
import { createTestDesktopRuntime } from "../../helpers/desktopRuntime.ts";
import type { WindowHost } from "../../../src/plugins/host/types.ts";

function windowHost() {
  return {
    listenForClose: vi.fn<WindowHost["listenForClose"]>(() =>
      Promise.resolve(() => {}),
    ),
    hide: vi.fn(() => Promise.resolve()),
    forceClose: vi.fn(() => Promise.resolve()),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

it("publishes immutable workbench snapshots and releases registrations with the Cordis root", async () => {
  const runtime = createTestDesktopRuntime({
    attachPreloading: () => () => {},
    close: () => Promise.resolve(),
  });
  try {
    const { workbench } = await runtime.ready;
    const changed = vi.fn();
    const unsubscribe = workbench.subscribe(changed);
    const before = workbench.getSnapshot();
    const page = { id: "demo", View: () => null };
    const run = vi.fn();
    const releasePage = workbench.register("pages", page);
    workbench.register("helpItems", { id: "demo", label: "Demo", run });
    expect(before.pages).toEqual([]);
    expect(workbench.getSnapshot().pages).toEqual([page]);
    expect(() => workbench.register("pages", page)).toThrow("Duplicate");
    workbench.getSnapshot().helpItems[0]?.run();
    expect(run).toHaveBeenCalledOnce();
    releasePage();
    releasePage();
    expect(workbench.getSnapshot().pages).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(3);
    unsubscribe();
    await runtime.shutdown();
    expect(workbench.getSnapshot().helpItems).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(3);
    expect(() => workbench.register("pages", page)).toThrow("disposed");
  } finally {
    await runtime.shutdown();
  }
});

it("releases a native close subscription that resolves after disposal", async () => {
  const host = windowHost();
  let finish!: (unlisten: () => void) => void;
  host.listenForClose.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const exit = new ExitCoordinator(host, createHostExitGate());
  const onClose = vi.fn();
  const unlisten = vi.fn();
  exit.listenForClose(onClose);
  exit.dispose();
  host.listenForClose.mock.calls[0]?.[0]();
  finish(unlisten);
  await Promise.resolve();
  expect(onClose).not.toHaveBeenCalled();
  expect(unlisten).toHaveBeenCalledOnce();
});

it("reinstalls the Workbench close listener with a fresh prompt and feedback queue", async () => {
  let root: Context | undefined;
  const previousWidth = localStorage.getItem(LEFT_WIDTH_STORAGE_KEY);
  localStorage.setItem(LEFT_WIDTH_STORAGE_KEY, "350");
  const appearanceRoot = document.createElement("div");
  appearanceRoot.style.setProperty(LEFT_WIDTH_VAR, "280px");
  const nativeMenuSuppressed = () =>
    !document.dispatchEvent(new MouseEvent("contextmenu", { cancelable: true }));
  const runtime = createTestDesktopRuntime(
    { attachPreloading: () => () => {}, close: () => Promise.resolve() },
    undefined,
    (context) => {
      root = context;
    },
  );
  try {
    await runtime.ready;
    const [initial] = root?.registry.get(workbenchPlugin)?.fibers ?? [];
    if (!root || !initial) throw new Error("Workbench fiber is missing");
    const unlisten = vi.fn();
    const listen = vi
      .spyOn(root.host.window, "listenForClose")
      .mockResolvedValue(unlisten);
    await initial.dispose();
    const options = {
      appearanceRoot,
      suppressNativeContextMenu: true,
      shutdownWindow: vi.fn(() => Promise.resolve()),
    };
    const fiber = await root.plugin(workbenchPlugin, options);
    const previous = root.workbench;
    expect(previous).not.toHaveProperty("observeWindowClose");
    expect(previous).not.toHaveProperty("dispose");
    expect(previous).not.toHaveProperty("navigationOwner");
    expect(previous.navigationGuard).not.toHaveProperty("dispose");
    expect(appearanceRoot.style.getPropertyValue(LEFT_WIDTH_VAR)).toBe("350px");
    expect(nativeMenuSuppressed()).toBe(true);
    const release = previous.registerExit({ id: "busy", describeWork: () => "busy" });
    const previousClose = listen.mock.calls[0]?.[0];
    if (!previousClose)
      throw new Error("Workbench did not install a close listener");
    previousClose();
    expect(previous.windowClose.getState()).toEqual({
      kind: "confirm",
      busy: true,
    });
    release();
    expect(previous.windowClose.getState()).toEqual({
      kind: "confirm",
      busy: true,
    });
    const { showToast } = previous;
    expect(previous.toasts).not.toHaveProperty("setState");
    expect(previous.toasts.getState()).not.toHaveProperty("push");
    showToast({ message: "old toast" });
    expect(previous.toasts.getState().items).toHaveLength(1);

    await fiber.dispose();
    expect(unlisten).toHaveBeenCalledOnce();
    expect(previous.windowClose.getState()).toEqual({ kind: "idle" });
    expect(previous.toasts.getState().items).toEqual([]);
    expect(appearanceRoot.style.getPropertyValue(LEFT_WIDTH_VAR)).toBe("280px");
    expect(nativeMenuSuppressed()).toBe(false);
    await root.plugin(workbenchPlugin, options);
    const replacement = root.workbench;
    expect(appearanceRoot.style.getPropertyValue(LEFT_WIDTH_VAR)).toBe("350px");
    expect(nativeMenuSuppressed()).toBe(true);
    expect(replacement.windowClose.getState()).toEqual({ kind: "idle" });
    previousClose();
    showToast({ message: "late toast" });
    await expect(previous.windowClose.confirm()).resolves.toBe(false);
    expect(previous.toasts.getState().items).toEqual([]);
    expect(replacement.toasts.getState().items).toEqual([]);
    expect(previous.windowClose.getState()).toEqual({ kind: "idle" });
    listen.mock.calls[1]?.[0]();
    expect(replacement.windowClose.getState()).toEqual({
      kind: "confirm",
      busy: false,
    });
    replacement.windowClose.dismiss();
    expect(replacement.windowClose.getState()).toEqual({ kind: "idle" });
    expect(options.shutdownWindow).not.toHaveBeenCalled();
  } finally {
    await runtime.shutdown();
    if (previousWidth === null) localStorage.removeItem(LEFT_WIDTH_STORAGE_KEY);
    else localStorage.setItem(LEFT_WIDTH_STORAGE_KEY, previousWidth);
  }
});

it("releases an uncommitted update when its coordinator is disposed", async () => {
  const gate = createHostExitGate();
  const previous = new ExitCoordinator(windowHost(), gate);
  let finish!: () => void;
  const prepared = new Promise<void>((resolve) => {
    finish = resolve;
  });
  previous.registerExit({ id: "project", prepare: () => prepared });
  const handoff = vi.fn(() => Promise.resolve());
  const obsolete = previous.requestExit({
    reason: "update",
    force: true,
    handoff,
  });
  expect(gate.isExiting()).toBe(true);
  previous.dispose();
  expect(gate.isExiting()).toBe(false);

  const replacement = new ExitCoordinator(windowHost(), gate);
  const next = vi.fn(() => Promise.resolve());
  await expect(
    replacement.requestExit({ reason: "update", force: true, handoff: next }),
  ).resolves.toBe(true);
  finish();
  await expect(obsolete).resolves.toBe(false);
  expect(handoff).not.toHaveBeenCalled();
  expect(next).toHaveBeenCalledOnce();
  expect(gate.isExiting()).toBe(true);
});

it("shows the exit overlay before hiding and bounds a hung shutdown before force-close", async () => {
  vi.useFakeTimers();
  const host = windowHost();
  const exit = new ExitCoordinator(host, createHostExitGate());
  const prepare = vi.fn();
  exit.registerExit({ id: "project", prepare });
  const onAccepted = vi.fn();
  const shutdown = vi.fn(() => new Promise<void>(() => {}));
  const request = {
    reason: "window" as const,
    force: true,
    onAccepted,
    shutdown,
  };
  const pending = exit.requestExit(request);
  await expect(exit.requestExit(request)).resolves.toBe(false);
  expect(onAccepted).toHaveBeenCalledOnce();
  expect(prepare).toHaveBeenCalledWith("window", true);
  await vi.advanceTimersByTimeAsync(1_999);
  expect(shutdown).toHaveBeenCalledWith(true);
  expect(host.hide).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(host.hide).toHaveBeenCalledOnce();
  expect(host.forceClose).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(8_000);
  await expect(pending).resolves.toBe(true);
  expect(host.forceClose).toHaveBeenCalledOnce();
  await expect(exit.requestExit(request)).resolves.toBe(false);
});

it("waits for update participants to finish even when one fails and allows retry", async () => {
  const gate = createHostExitGate();
  const exit = new ExitCoordinator(windowHost(), gate);
  const releaseFailure = exit.registerExit({
    id: "project",
    prepare: () => Promise.reject(new Error("cleanup failed")),
  });
  let finishTerminal!: () => void;
  const stopped = new Promise<void>((resolve) => {
    finishTerminal = resolve;
  });
  exit.registerExit({ id: "terminal", prepare: () => stopped });
  const handoff = vi.fn(() => Promise.resolve());
  const request = { reason: "update" as const, force: true, handoff };
  const pending = exit.requestExit(request);
  const failure = expect(pending).rejects.toThrow("cleanup failed");
  await Promise.resolve();
  expect(gate.isExiting()).toBe(true);
  expect(handoff).not.toHaveBeenCalled();
  finishTerminal();
  await failure;
  expect(gate.isExiting()).toBe(false);
  releaseFailure();
  await expect(exit.requestExit(request)).resolves.toBe(true);
  expect(handoff).toHaveBeenCalledOnce();
});

it("restores both feature references and generic layout from the old panel key", async () => {
  const previousKey = "aaw-desktop/right-panel/v1";
  const currentKey = "aaw-desktop/right-panel/zcode-v1";
  const saved = [previousKey, currentKey].map((key) => localStorage.getItem(key));
  const path = "D:/legacy";
  const file = { id: "file:notes", kind: "file", path: path + "/notes.md", line: 7 };
  const diff = {
    id: "diff:notes", kind: "diff", path: file.path, repoRoot: path,
    change: { path: "notes.md", oldPath: null, status: "修改", source: "staged" },
  };
  const raw = JSON.stringify({
    version: 1,
    projects: {
      [path]: { open: true, sizeRatio: 0.6, active: "aaw", aawSegment: "launch", tabs: [file, diff] },
    },
  });
  localStorage.setItem(previousKey, raw);
  localStorage.removeItem(currentKey);
  const runtime = createTestDesktopRuntime({ attachPreloading: () => () => {}, close: () => Promise.resolve() });
  try {
    const { workbench } = await runtime.ready;
    const panel = workbench.panels.getState().projects["d:/legacy"];
    expect(panel).toMatchObject({
      open: false,
      sizeRatio: undefined,
      active: "aaw",
      tabs: [
        { id: file.id, data: { path: file.path, line: 7 } },
        { id: diff.id, data: { path: diff.path, change: diff.change } },
        { id: "aaw", kind: "aaw" },
      ],
      toolViews: { aaw: "launch" },
    });
    expect(localStorage.getItem(currentKey)).toBeNull();
    workbench.panels.getState().open(path);
    expect(localStorage.getItem(previousKey)).toBe(raw);
    expect(JSON.parse(localStorage.getItem(currentKey) ?? "null")).toMatchObject({
      version: 1,
      projects: {
        "d:/legacy": { open: true, active: "aaw", tabs: [file, diff, { id: "aaw", kind: "aaw" }] },
      },
    });
  } finally {
    await runtime.shutdown();
    [previousKey, currentKey].forEach((key, index) => {
      const value = saved[index];
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    });
  }
});

it("restores the complete contribution catalog through Workbench unload and reinstall", async () => {
  let root: Context | undefined;
  const runtime = createTestDesktopRuntime(
    { attachPreloading: () => () => {}, close: () => Promise.resolve() },
    undefined,
    (context) => {
      root = context;
      return installDesktopWorkbench(context);
    },
  );
  const readIds = (workbench: WorkbenchService) => {
    const snapshot = workbench.getSnapshot();
    return Object.fromEntries((Object.keys(snapshot) as WorkbenchSlot[]).map(
      (slot) => [slot, snapshot[slot].map(({ id }) => id).sort()],
    ));
  };
  try {
    const { workbench } = await runtime.ready;
    const [fiber] = root?.registry.get(workbenchPlugin)?.fibers ?? [];
    if (!root || !fiber) throw new Error("Workbench fiber is missing");
    const catalog = readIds(workbench);
    expect(catalog.pages).toContain("settings");
    expect(catalog.settings).toContain("general");
    expect(catalog.helpItems).toContain("diagnostics");
    expect(catalog.panels).toContain("files");
    expect(catalog.docks).toContain("terminal");
    const oldRegistryObserver = vi.fn();
    workbench.subscribe(oldRegistryObserver);

    await fiber.dispose();
    expect(Object.values(workbench.getSnapshot()).flat()).toEqual([]);
    expect(root.workbench).toBeUndefined();
    const notificationsAtDispose = oldRegistryObserver.mock.calls.length;

    await root.plugin(workbenchPlugin, fiber.config as Parameters<typeof workbenchPlugin.apply>[1]);
    const replacement = root.workbench;
    expect(replacement).not.toBe(workbench);
    expect(readIds(replacement)).toEqual(catalog);
    expect(replacement.Window).not.toBe(workbench.Window);
    expect(Object.values(workbench.getSnapshot()).flat()).toEqual([]);
    expect(oldRegistryObserver).toHaveBeenCalledTimes(notificationsAtDispose);
  } finally {
    await runtime.shutdown();
  }
});

it("rebinds navigation on the same Cordis root and drops retired confirmations", async () => {
  let root: Context | undefined;
  const keys = [
    "aaw-desktop/layout/sidebar-collapsed",
    "aaw-desktop/right-panel/zcode-v1",
  ];
  const saved = keys.map((key) => localStorage.getItem(key));
  keys.forEach((key) => localStorage.removeItem(key));
  const runtime = createTestDesktopRuntime(
    { attachPreloading: () => () => {}, close: () => Promise.resolve() },
    undefined,
    (context) => {
      root = context;
    },
  );
  const revisions: (typeof runtime.workbench)[] = [];
  const unsubscribe = runtime.subscribeWorkbench(() =>
    revisions.push(runtime.workbench),
  );
  try {
    const { workbench } = await runtime.ready;
    const [fiber] = root?.registry.get(workbenchPlugin)?.fibers ?? [];
    if (!root || !fiber) throw new Error("Workbench fiber is missing");

    const nav = workbench.navigation.getState();
    const panels = workbench.panels.getState();
    expect(workbench.navigation).not.toHaveProperty("setState");
    expect(workbench.panels).not.toHaveProperty("setState");
    nav.openView("session", "D:/reload");
    nav.toggleSidebarCollapsed();
    nav.openSettingsTab("archive");
    panels.openTab("D:/reload", documentTab("D:/reload/keep.md", false));
    panels.openTab("D:/reload", documentTab("D:/reload/closed.md", false));
    panels.closeTab("D:/reload", "file:d:/reload/closed.md");
    panels.fullViewOpen("D:/reload", "side-pane");
    expect(
      workbench.panels.getState().projects["d:/reload"]?.recentlyClosed,
    ).toHaveLength(1);

    let confirm!: (allowed: boolean) => void;
    let resume!: () => void;
    workbench.navigationGuard.register({
      pending: () => true,
      confirm: () =>
        new Promise((resolve) => {
          confirm = resolve;
        }),
      guard: (action) => {
        resume = action;
        return false;
      },
    });
    const confirmation = workbench.navigationGuard.confirm();
    const stale = vi.fn();
    workbench.navigationGuard.run(stale);
    const viewObserver = vi.fn();
    const panelObserver = vi.fn();
    workbench.navigation.subscribe(viewObserver);
    workbench.panels.subscribe(panelObserver);

    await fiber.dispose();
    expect(runtime.workbench).toBeUndefined();
    await root.plugin(
      workbenchPlugin,
      fiber.config as Parameters<typeof workbenchPlugin.apply>[1],
    );
    const replacement = root.workbench;
    expect(revisions).toEqual([workbench, undefined, replacement]);
    expect(replacement.Window).not.toBe(workbench.Window);

    confirm(true);
    resume();
    await expect(confirmation).resolves.toBe(false);
    expect(stale).not.toHaveBeenCalled();
    expect(replacement.navigationGuard.pending()).toBe(false);
    nav.toggleSidebarCollapsed();
    panels.closeAll("D:/reload");
    expect(viewObserver).not.toHaveBeenCalled();
    expect(panelObserver).not.toHaveBeenCalled();
    expect(replacement.navigation.getState()).toMatchObject({
      contextPath: null,
      overlay: null,
      sidebarCollapsed: true,
      settingsInitialTab: "general",
    });
    const restored = replacement.panels.getState().projects["d:/reload"];
    expect(restored?.tabs.map(({ id }) => id)).toEqual([
      "file:d:/reload/keep.md",
    ]);
    expect(restored?.recentlyClosed).toBeUndefined();
    expect(restored?.fullView).toBeUndefined();
    expect(localStorage.getItem(keys[0]!)).toBe("1");
  } finally {
    unsubscribe();
    await runtime.shutdown();
    keys.forEach((key, index) => {
      const value = saved[index];
      if (value != null) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    });
  }
});
