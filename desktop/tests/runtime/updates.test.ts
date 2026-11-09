import type { Context } from "cordis";
import { expect, it, vi } from "vitest";
import type {
  UpdateSnapshot,
  UpdatesHost,
} from "../../src/contracts/updates.ts";
import { createUpdates } from "../../src/plugins/updates/service.ts";
import { updatesHost } from "../../src/plugins/host/updates.ts";
import * as updatesPlugin from "../../src/plugins/updates/plugin.ts";
import { installDesktopWorkbench } from "../../src/bootstrap/installDesktopWorkbench.ts";
import { createTestDesktopRuntime } from "../helpers/desktopRuntime.ts";

function updateHost() {
  return {
    isNative: () => true,
    listen: vi.fn<UpdatesHost["listen"]>(),
    status: vi.fn<UpdatesHost["status"]>(),
    check: vi.fn<UpdatesHost["check"]>(),
    download: vi.fn<UpdatesHost["download"]>(),
    preferences: vi.fn<UpdatesHost["preferences"]>(),
    prepare: vi.fn<UpdatesHost["prepare"]>(),
    cancel: vi.fn<UpdatesHost["cancel"]>(),
    install: vi.fn<UpdatesHost["install"]>(),
    openFolder: vi.fn<UpdatesHost["openFolder"]>(),
  };
}

it("registers the update settings and entry points through the main-window composition", async () => {
  const runtime = createTestDesktopRuntime(
    {
      attachPreloading: () => () => {},
      close: () => Promise.resolve(),
    },
    undefined,
    installDesktopWorkbench,
  );
  try {
    const { updates, workbench } = await runtime.ready;
    expect(updates.state.getState().snapshot).toBeNull();
    expect(
      workbench.getSnapshot().settings.find(({ id }) => id === "updates")
        ?.order,
    ).toBe(10);
    expect(workbench.getSnapshot().chrome.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        "updates-dialog",
        "updates-button",
        "updates-button-compact",
      ]),
    );
  } finally {
    await runtime.shutdown();
  }
});

it("starts updates before rendering, awaits a late listener on unload, and rebinds the UI on reinstall", async () => {
  const oldStop = vi.fn();
  const newStop = vi.fn();
  let finish!: (stop: () => void) => void;
  const pending = new Promise<() => void>((resolve) => {
    finish = resolve;
  });
  const native = vi.spyOn(updatesHost, "isNative").mockReturnValue(true);
  const listen = vi.spyOn(updatesHost, "listen")
    .mockReturnValueOnce(pending)
    .mockResolvedValueOnce(newStop);
  const status = vi.spyOn(updatesHost, "status").mockRejectedValue(new Error("offline"));
  let root: Context | undefined;
  const runtime = createTestDesktopRuntime(
    { attachPreloading: () => () => {}, close: () => Promise.resolve() },
    undefined,
    async (context) => {
      root = context;
      await installDesktopWorkbench(context);
    },
  );
  try {
    const { updates, workbench } = await runtime.ready;
    const [fiber] = root?.registry.get(updatesPlugin)?.fibers ?? [];
    if (!root || !fiber) throw new Error("Updates fiber is missing");
    expect(listen).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(updates.state.getState().initialization).toEqual({ phase: "failed", error: "offline" }),
    );
    expect(status).toHaveBeenCalledOnce();
    const view = () => workbench.getSnapshot().chrome.find(({ id }) => id === "updates-dialog")?.View;
    const oldView = view();
    expect(oldView).toBeDefined();
    updates.state.setState({ dialog: true, checking: true });
    const completed = vi.fn();
    const unloading = fiber.dispose().then(completed);
    await vi.waitFor(() =>
      expect(updates.state.getState()).toMatchObject({ dialog: false, checking: false }),
    );
    expect(completed).not.toHaveBeenCalled();
    finish(oldStop);
    await unloading;
    expect(oldStop).toHaveBeenCalledOnce();
    expect(status).toHaveBeenCalledOnce();
    expect(view()).toBeUndefined();
    expect(workbench.getSnapshot().settings.some(({ id }) => id === "updates")).toBe(false);
    updates.state.getState().setDialog(true);
    expect(updates.state.getState().dialog).toBe(false);

    await root.plugin(updatesPlugin);
    await vi.waitFor(() => expect(listen).toHaveBeenCalledTimes(2));
    expect(view()).toBeDefined();
    expect(view()).not.toBe(oldView);
    expect(root.updates).not.toBe(updates);
  } finally {
    finish(oldStop);
    await runtime.shutdown();
    native.mockRestore();
    listen.mockRestore();
    status.mockRestore();
  }
  expect(newStop).toHaveBeenCalledOnce();
});

it("waits for a late preparation before cancelling its reservation on disposal", async () => {
  const host = updateHost();
  let finish!: () => void;
  host.prepare.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  host.cancel.mockResolvedValue();
  const exit = {
    registerExit: vi.fn(),
    hasExitWork: () => false,
    requestExit: vi.fn(),
    listenForClose: vi.fn(),
  };
  const updates = createUpdates(host, () => Promise.resolve());
  const installing = updates.install("0.2.0", false, exit);
  await vi.waitFor(() =>
    expect(host.prepare).toHaveBeenCalledExactlyOnceWith("0.2.0"),
  );
  const disposal = updates.dispose();
  expect(host.cancel).not.toHaveBeenCalled();
  finish();
  await disposal;
  await expect(installing).resolves.toBe("cancelled");
  expect(host.cancel).toHaveBeenCalledOnce();
  expect(exit.requestExit).not.toHaveBeenCalled();
  expect(host.install).not.toHaveBeenCalled();
  expect(updates.state.getState().snapshot).toEqual(
    null as UpdateSnapshot | null,
  );
});
