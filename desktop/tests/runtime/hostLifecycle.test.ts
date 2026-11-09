import { Context } from "cordis";
import { expect, it, vi } from "vitest";
import "../../src/bootstrap/services.ts";
import type {
  AcpProcessHost,
  CommandResult,
} from "../../src/contracts/host.ts";
import * as hostPlugin from "../../src/plugins/host/plugin.ts";
import { createDemoHost } from "../../src/plugins/host/host.ts";
import { panelService } from "../../src/plugins/host/panelService.ts";
import { notificationHost } from "../../src/plugins/host/notifications.ts";
import type { HostNotificationAction } from "../../src/contracts/host.ts";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl, openPath, revealItemInDir } from "@tauri-apps/plugin-opener";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
  openPath: vi.fn(),
  revealItemInDir: vi.fn(),
}));

const launch = {
  program: "agent",
  args: ["acp"],
  cwd: null,
  extraEnv: null,
  isolated: false,
};

function nativeHost() {
  return {
    spawn: vi.fn<() => Promise<number>>(),
    subscribe: vi.fn<() => Promise<() => void>>(),
    writeLine: vi.fn(() => Promise.resolve()),
    closeInput: vi.fn(() => Promise.resolve()),
    killTree: vi.fn(() => Promise.resolve({ code: 0, signal: null })),
    release: vi.fn(() => Promise.resolve()),
  } satisfies AcpProcessHost;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("keeps the default backend local to each Host and starts fresh on reinstall", async () => {
  const root = new Context();
  const other = new Context();
  const path = "/project/skills/sample/SKILL.md";
  try {
    const fiber = await root.plugin(hostPlugin);
    await other.plugin(hostPlugin);
    const previous = root.host;
    await previous.skills.writeTextFile(path, "skill");
    await expect(previous.archives.readTextFile(path)).resolves.toBe("skill");
    await expect(previous.commands.pathExists(path)).resolves.toBe(true);
    await expect(other.host.commands.pathExists(path)).resolves.toBe(false);

    await fiber.dispose();
    await root.plugin(hostPlugin);
    await expect(root.host.commands.pathExists(path)).resolves.toBe(false);
    await expect(previous.archives.readTextFile(path)).rejects.toThrow("卸载");
    await expect(previous.skills.writeTextFile(path, "late")).rejects.toThrow(
      "卸载",
    );
    await expect(previous.process.exists(path)).rejects.toThrow("卸载");
    expect(root.host.process).not.toBe(previous.process);
  } finally {
    await Promise.all([root.fiber.dispose(), other.fiber.dispose()]);
  }
});

it("discards a pending command result without waiting for it during Host unload", async () => {
  const root = new Context();
  const backend = createDemoHost();
  const pending = deferred<CommandResult>();
  const run = vi
    .spyOn(backend, "runCommand")
    .mockReturnValueOnce(pending.promise);
  const createBackend = vi.fn(createDemoHost).mockReturnValueOnce(backend);
  try {
    const fiber = await root.plugin(hostPlugin, { createBackend });
    const oldCommand = expect(
      root.host.commands.runCommand("agent", []),
    ).rejects.toThrow("卸载");
    expect(run).toHaveBeenCalledOnce();
    await fiber.dispose();
    await root.plugin(hostPlugin, { createBackend });
    expect(createBackend).toHaveBeenCalledTimes(2);
    await expect(
      root.host.commands.runCommand("agent", []),
    ).resolves.toMatchObject({ code: -1 });
    pending.resolve({ code: 0, stdout: "old", stderr: "" });
    await oldCommand;
    expect(run).toHaveBeenCalledOnce();
  } finally {
    pending.resolve({ code: 0, stdout: "", stderr: "" });
    await root.fiber.dispose();
  }
});

it("closes the login window once on normal release or after a late acquisition", async () => {
  const root = new Context();
  const backend = createDemoHost();
  const pending = deferred<void>();
  const open = vi
    .spyOn(backend, "ssoOpenLogin")
    .mockResolvedValueOnce(undefined)
    .mockReturnValueOnce(pending.promise);
  const close = vi.spyOn(backend, "ssoCloseLogin");
  try {
    const fiber = await root.plugin(hostPlugin, {
      createBackend: () => backend,
    });
    const { account } = root.host;
    await account.ssoOpenLogin("https://login.example/first");
    await Promise.all([account.ssoCloseLogin(), account.ssoCloseLogin()]);
    expect(close).toHaveBeenCalledOnce();

    const opening = expect(
      account.ssoOpenLogin("https://login.example/second"),
    ).rejects.toThrow("卸载");
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    const unloading = fiber.dispose();
    expect(close).toHaveBeenCalledOnce();
    pending.resolve();
    await Promise.all([opening, unloading]);
    await account.ssoCloseLogin();
    expect(close).toHaveBeenCalledTimes(2);
  } finally {
    pending.resolve();
    await root.fiber.dispose();
  }
});

it("routes directory selection to one host and preserves native cancellation", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  vi.stubEnv("VITEST", "");
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const root = new Context();
  try {
    await root.plugin(hostPlugin);
    vi.mocked(open)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("D:/selected");
    await expect(
      root.host.dialogs.pickDirectory("选择项目目录"),
    ).resolves.toBeNull();
    await expect(root.host.dialogs.pickDirectory("选择项目目录")).resolves.toBe(
      "D:/selected",
    );
    expect(open).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: "选择项目目录",
    });
    expect(fetch).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    vi.stubGlobal(
      "fetch",
      fetch.mockResolvedValue(
        new Response(JSON.stringify({ path: "D:/browser" })),
      ),
    );
    await expect(root.host.dialogs.pickDirectory("选择项目目录")).resolves.toBe(
      "D:/browser",
    );
    expect(open).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "/dev-bridge/pick-directory",
      expect.objectContaining({ method: "POST" }),
    );
  } finally {
    await root.fiber.dispose();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

it("unregisters a notification subscription that arrives during Host unload", async () => {
  const registration = deferred<() => Promise<void>>();
  const unregister = vi.fn(() => Promise.resolve());
  const listen = vi
    .spyOn(notificationHost, "listen")
    .mockReturnValue(registration.promise);
  const receive = vi.fn<(action: HostNotificationAction) => void>();
  const root = new Context();
  try {
    const fiber = await root.plugin(hostPlugin);
    const pending = expect(
      root.host.notifications.listen(receive),
    ).rejects.toThrow("宿主实例正在卸载");
    await vi.waitFor(() => expect(listen).toHaveBeenCalledOnce());
    const stopping = fiber.dispose();
    registration.resolve(unregister);
    await Promise.all([pending, stopping]);
    listen.mock.calls[0]?.[0]({ actionId: "tap" });
    expect(receive).not.toHaveBeenCalled();
    expect(unregister).toHaveBeenCalledOnce();
  } finally {
    registration.resolve(unregister);
    await root.fiber.dispose();
    listen.mockRestore();
  }
});

it("routes web links and file manager actions through the current Host", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  const browserOpen = vi.spyOn(window, "open").mockReturnValue(null);
  const root = new Context();
  try {
    const fiber = await root.plugin(hostPlugin);
    const { shell, files } = root.host;
    await shell.openExternal("https://example.test/native");
    await files.openInFileManager("D:/project", "directory");
    await files.openInFileManager("D:/project/file.ts", "file");
    expect(openUrl).toHaveBeenCalledExactlyOnceWith(
      "https://example.test/native",
    );
    expect(openPath).toHaveBeenCalledExactlyOnceWith("D:/project");
    expect(revealItemInDir).toHaveBeenCalledExactlyOnceWith(
      "D:/project/file.ts",
    );
    expect(browserOpen).not.toHaveBeenCalled();
    await expect(shell.openExternal("file:///D:/secret")).rejects.toThrow(
      "HTTP",
    );

    await fiber.dispose();
    await expect(
      shell.openExternal("https://example.test/old"),
    ).rejects.toThrow("卸载");
    vi.unstubAllGlobals();
    await root.plugin(hostPlugin);
    await root.host.shell.openExternal("https://example.test/browser");
    expect(browserOpen).toHaveBeenCalledExactlyOnceWith(
      "https://example.test/browser",
      "_blank",
      "noopener,noreferrer",
    );
    expect(openUrl).toHaveBeenCalledOnce();
  } finally {
    await root.fiber.dispose();
    browserOpen.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("discards a native save selection that arrives after Host unload", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  const pending = deferred<string>();
  vi.mocked(save).mockReturnValueOnce(pending.promise);
  const root = new Context();
  try {
    const fiber = await root.plugin(hostPlugin);
    const options = {
      defaultPath: "logs.jsonl",
      filters: [{ name: "JSON Lines", extensions: ["jsonl"] }],
    };
    const selection = root.host.dialogs.saveFile(options);
    await vi.waitFor(() =>
      expect(save).toHaveBeenCalledExactlyOnceWith(options),
    );
    await fiber.dispose();
    pending.resolve("D:/logs.jsonl");
    await expect(selection).resolves.toBeNull();
  } finally {
    pending.resolve("D:/logs.jsonl");
    await root.fiber.dispose();
    vi.unstubAllGlobals();
  }
});

it("releases an ACP handle once and kills only abandoned processes on Host unload", async () => {
  const process = nativeHost();
  process.spawn.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
  const unlisten = vi.fn();
  process.subscribe.mockResolvedValue(unlisten);
  const root = new Context();
  try {
    const fiber = await root.plugin(hostPlugin, { acpProcess: process });
    const host = root.host.acpProcess;
    const stop = await host.subscribe("stdout", () => {});
    const normal = await host.spawn(launch);
    await Promise.all([host.release(normal), host.release(normal)]);
    expect(await host.spawn(launch)).toBe(2);

    await fiber.dispose();
    stop();
    expect(process.release.mock.calls).toEqual([[1], [2]]);
    expect(process.killTree.mock.calls).toEqual([[2]]);
    expect(unlisten).toHaveBeenCalledOnce();
  } finally {
    await root.fiber.dispose();
  }
});

it("waits for late native acquisitions without returning resources from a disposed Host", async () => {
  const process = nativeHost();
  const spawn = deferred<number>();
  const listen = deferred<() => void>();
  process.spawn.mockReturnValue(spawn.promise);
  process.subscribe.mockReturnValue(listen.promise);
  const unlisten = vi.fn();
  const root = new Context();
  try {
    const fiber = await root.plugin(hostPlugin, { acpProcess: process });
    const host = root.host.acpProcess;
    const handle = expect(host.spawn(launch)).rejects.toThrow(
      "宿主实例正在卸载",
    );
    const subscription = expect(
      host.subscribe("stdout", () => {}),
    ).rejects.toThrow("宿主实例正在卸载");
    await vi.waitFor(() => {
      expect(process.spawn).toHaveBeenCalledOnce();
      expect(process.subscribe).toHaveBeenCalledOnce();
    });

    const done = vi.fn();
    const unloading = fiber.dispose().then(done);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    spawn.resolve(3);
    listen.resolve(unlisten);
    await Promise.all([handle, subscription, unloading]);
    expect(unlisten).toHaveBeenCalledOnce();
    expect(process.killTree).toHaveBeenCalledWith(3);
    expect(process.release).toHaveBeenCalledWith(3);
    await expect(host.spawn(launch)).rejects.toThrow("宿主实例正在卸载");
    expect(process.spawn).toHaveBeenCalledOnce();
  } finally {
    await root.fiber.dispose();
  }
});

it("waits for native watch release already started by the calling plugin", async () => {
  const cleanup = deferred<void>();
  const unregister = vi.fn(() => cleanup.promise);
  const watch = vi.spyOn(panelService, "watch").mockResolvedValue(unregister);
  const root = new Context();
  try {
    const fiber = await root.plugin(hostPlugin);
    const stop = await root.host.files.watch(
      [],
      () => {},
      () => {},
    );
    stop();
    expect(unregister).toHaveBeenCalledOnce();
    const done = vi.fn();
    const unloading = fiber.dispose().then(done);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    cleanup.resolve();
    await unloading;
    expect(unregister).toHaveBeenCalledOnce();
  } finally {
    cleanup.resolve();
    await root.fiber.dispose();
    watch.mockRestore();
  }
});
