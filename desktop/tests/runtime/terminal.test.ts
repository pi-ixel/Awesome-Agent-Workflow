import type { Context } from "cordis";
import * as terminalPlugin from "../../src/plugins/terminal/index.ts";
import { expect, it, vi } from "vitest";
import { terminalHost } from "../../src/plugins/host/process/terminal.ts";
import type { PtyNativeHost, PtySpawnWire } from "../../src/plugins/host/types.ts";
import { createTerminalService } from "../../src/plugins/terminal/pty/terminal.ts";
import { installDesktopWorkbench } from "../../src/bootstrap/installDesktopWorkbench.ts";
import { createTestDesktopRuntime } from "../helpers/desktopRuntime.ts";

it("closes only terminals owned by the addressed project through the registered close participant", async () => {
  const calls: string[] = [];
  let nextHandle = 0;
  let finishOpening!: (wire: PtySpawnWire) => void;
  const late = new Promise<PtySpawnWire>((resolve) => { finishOpening = resolve; });
  const lateWire = { handle: 3, pid: null, shell: "pwsh", shellName: "pwsh" };
  const native = vi.spyOn(terminalHost, "isNative").mockReturnValue(true);
  const output = vi
    .spyOn(terminalHost, "listenOutput")
    .mockResolvedValue(() => {});
  const exit = vi.spyOn(terminalHost, "listenExit").mockResolvedValue(() => {});
  const spawn = vi.spyOn(terminalHost, "spawn").mockImplementation(() =>
    Promise.resolve({
      handle: ++nextHandle,
      pid: null,
      shell: "pwsh",
      shellName: "pwsh",
    }),
  );
  const kill = vi.spyOn(terminalHost, "kill").mockImplementation((id) => {
    calls.push(`kill:${id}`);
    return Promise.resolve();
  });
  const release = vi.spyOn(terminalHost, "release").mockImplementation((id) => {
    calls.push(`release:${id}`);
    return Promise.resolve();
  });
  let root: Context | undefined;
  const runtime = createTestDesktopRuntime(
    {
      attachPreloading: () => () => {},
      close: () => Promise.resolve(),
      closeProject: () => Promise.resolve(),
    },
    undefined,
    (context) => {
      root = context;
      return installDesktopWorkbench(context);
    },
  );
  try {
    const { terminal, project, workbench } = await runtime.ready;
    expect(workbench.getSnapshot().docks.map(({ id }) => id)).toContain(
      "terminal",
    );
    for (const path of ["D:/first", "D:/second"]) {
      const { handle } = await terminal.open({ cwd: path, cols: 80, rows: 24 });
      terminal.openShellTab(path);
      terminal.attachHandle(terminal.tabs.getState().activeTabId!, handle);
    }
    spawn.mockReturnValueOnce(late);
    terminal.openShellTab("D:/first");
    const opening = terminal.open({ cwd: "D:/home", cols: 80, rows: 24 }, "D:/first");
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(3));
    if (!root) throw new Error("Desktop root was not installed");
    const resume = root.host.exitGate.begin();
    expect(resume).toBeTypeOf("function");
    await expect(
      terminal.open({ cwd: "D:/third", cols: 80, rows: 24 }),
    ).rejects.toThrow("stopping");
    expect(spawn).toHaveBeenCalledTimes(3);
    resume?.();
    const complete = vi.fn();
    const removal = project.projects.removeProject("d:\\FIRST").then((removed) => {
      complete(removed);
      return removed;
    });
    await vi.waitFor(() => expect(calls).toEqual(["kill:1", "release:1"]));
    expect(complete).not.toHaveBeenCalled();
    finishOpening(lateWire);
    await expect(removal).resolves.toBe(true);
    await expect(opening).resolves.toMatchObject({ handle: 3 });
    expect(calls).toEqual(["kill:1", "release:1", "kill:3", "release:3"]);
    expect(terminal.tabs.getState().tabs.map(({ handle }) => handle)).toEqual([
      2,
    ]);
    await runtime.shutdown();
    expect(calls).toEqual(["kill:1", "release:1", "kill:3", "release:3", "kill:2", "release:2"]);
  } finally {
    finishOpening(lateWire);
    await runtime.shutdown();
    native.mockRestore();
    output.mockRestore();
    exit.mockRestore();
    spawn.mockRestore();
    kill.mockRestore();
    release.mockRestore();
  }
});

it("releases listeners and waits for a late PTY spawn to be killed on disposal", async () => {
  const stopOutput = vi.fn();
  const stopExit = vi.fn();
  let finish!: (wire: PtySpawnWire) => void;
  const pending = new Promise<PtySpawnWire>((resolve) => {
    finish = resolve;
  });
  const host = {
    isNative: () => true,
    homeDir: () => Promise.resolve("D:/home"),
    listenOutput: () => Promise.resolve(stopOutput),
    listenExit: () => Promise.resolve(stopExit),
    spawn: vi.fn(() => pending),
    write: vi.fn(() => Promise.resolve()),
    resize: vi.fn(() => Promise.resolve()),
    kill: vi.fn(() => Promise.resolve()),
    release: vi.fn(() => Promise.resolve()),
  } satisfies PtyNativeHost;
  const terminal = createTerminalService(host, () => false);
  const opening = terminal.open({ cwd: null, cols: 80, rows: 24 });
  const rejected = expect(opening).rejects.toThrow("stopping");
  await vi.waitFor(() => expect(host.spawn).toHaveBeenCalledOnce());
  const disposing = terminal.dispose();
  expect(stopOutput).toHaveBeenCalledOnce();
  expect(stopExit).toHaveBeenCalledOnce();
  finish({ handle: 8, pid: null, shell: "pwsh", shellName: "pwsh" });
  await rejected;
  await disposing;
  expect(host.kill).toHaveBeenCalledExactlyOnceWith(8);
  expect(host.release).toHaveBeenCalledExactlyOnceWith(8);
  expect(terminal.find(8)).toBeNull();
});

it("retires the terminal dock, tabs and late PTY on the same Cordis root", async () => {
  let root: Context | undefined;
  let finish!: (wire: PtySpawnWire) => void;
  const late = new Promise<PtySpawnWire>((resolve) => {
    finish = resolve;
  });
  const wire = (handle: number) => ({
    handle,
    pid: null,
    shell: "pwsh",
    shellName: "pwsh",
  });
  const unlisten = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
  const native = vi.spyOn(terminalHost, "isNative").mockReturnValue(true);
  const output = vi
    .spyOn(terminalHost, "listenOutput")
    .mockResolvedValueOnce(unlisten[0]!)
    .mockResolvedValueOnce(unlisten[2]!);
  const exit = vi
    .spyOn(terminalHost, "listenExit")
    .mockResolvedValueOnce(unlisten[1]!)
    .mockResolvedValueOnce(unlisten[3]!);
  const spawn = vi
    .spyOn(terminalHost, "spawn")
    .mockResolvedValueOnce(wire(7))
    .mockReturnValueOnce(late)
    .mockResolvedValueOnce(wire(7));
  const kill = vi.spyOn(terminalHost, "kill").mockResolvedValue(undefined);
  const release = vi
    .spyOn(terminalHost, "release")
    .mockResolvedValue(undefined);
  const runtime = createTestDesktopRuntime(
    { attachPreloading: () => () => {}, close: () => Promise.resolve() },
    undefined,
    (context) => {
      root = context;
      return installDesktopWorkbench(context);
    },
  );
  try {
    const { terminal, workbench } = await runtime.ready;
    const [fiber] = root?.registry.get(terminalPlugin)?.fibers ?? [];
    if (!root || !fiber) throw new Error("Terminal fiber is missing");
    const options = { cwd: "D:/terminal", cols: 80, rows: 24 };
    const first = await terminal.open(options);
    expect(terminal.tabs).not.toHaveProperty("setState");
    expect(terminal.tabs.getState()).not.toHaveProperty("openShellTab");
    terminal.openShellTab(options.cwd);
    const tab = terminal.tabs.getState().tabs[0]!;
    terminal.attachHandle(tab.id, first.handle);
    terminal.setConnectionError(tab.id, "retired");
    const oldListener = vi.fn();
    terminal.tabs.subscribe(oldListener);
    workbench.navigation.getState().toggleDock("terminal");
    expect(workbench.navigation.getState().openDock).toBe("terminal");
    const pending = expect(terminal.open(options)).rejects.toThrow("stopping");
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));

    const disposal = fiber.dispose();
    await vi.waitFor(() => expect(terminal.isActive()).toBe(false));
    expect(terminal.tabs.getState()).toMatchObject({
      tabs: [],
      activeTabId: null,
      connectionErrors: {},
    });
    finish(wire(8));
    await pending;
    await disposal;
    expect(workbench.getSnapshot().docks).toEqual([]);
    expect(workbench.navigation.getState().openDock).toBeNull();
    expect(kill.mock.calls).toEqual([[7], [8]]);
    expect(release.mock.calls).toEqual([[7], [8]]);
    expect(unlisten[0]).toHaveBeenCalledOnce();
    expect(unlisten[1]).toHaveBeenCalledOnce();

    await root.plugin(terminalPlugin);
    const replacement = root.terminal;
    expect(workbench.getSnapshot().docks.map(({ id }) => id)).toEqual([
      "terminal",
    ]);
    expect(replacement.tabs.getState().tabs).toEqual([]);
    const newConnection = await replacement.open(options);
    replacement.openShellTab(options.cwd);
    expect(replacement.tabs.getState().activeTabId).toBe(tab.id);
    terminal.openShellTab("D:/stale");
    terminal.setConnectionError(tab.id, "stale");
    await terminal.close(first.handle);
    await terminal.closeTab(tab.id);
    expect(terminal.tabs.getState().tabs).toEqual([]);
    expect(oldListener).not.toHaveBeenCalled();
    expect(replacement.tabs.getState().connectionErrors).toEqual({});
    expect(replacement.find(newConnection.handle)).toBe(newConnection);
    expect(kill).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
    await runtime.shutdown();
    expect(unlisten[2]).toHaveBeenCalledOnce();
    expect(unlisten[3]).toHaveBeenCalledOnce();
    expect(release.mock.calls).toEqual([[7], [8], [7]]);
  } finally {
    finish(wire(8));
    await runtime.shutdown();
    for (const mock of [native, output, exit, spawn, kill, release])
      mock.mockRestore();
  }
});

vi.mock(import("../../src/plugins/host/process/terminal.ts"), async (original) => {
  const host = await original();
  return { ...host, createTerminalHost: () => host.terminalHost };
});
