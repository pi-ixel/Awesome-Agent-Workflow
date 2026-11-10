import type { ExitDiagnostics, HostOptions } from "../types.ts";
import type { HostService } from "../service.ts";
import { createTauriAcpProcessHost } from "../process/acpProcess.ts";
import { createAccountHost } from "../adapters/account.ts";
import { webviewStorage } from "../storage/storage.ts";
import { diagnosticsHost } from "../adapters/diagnostics.ts";
import { createHostRuntime, isTauriEnv } from "../adapters/host.ts";
import { createBridgeAcpClient } from "../dev/bridgeClient.ts";
import { windowChromeHost, windowHost } from "../window/window.ts";
import { openExternal } from "../window/shell.ts";
import { dialogHost } from "../window/dialogs.ts";
import { notificationHost } from "../window/notifications.ts";
import { createDocumentFileHost } from "../filesystem/documentFiles.ts";
import { createGitHost } from "../filesystem/git.ts";
import { createHostExitGate } from "./exitGate.ts";
import { createTerminalHost } from "../process/terminal.ts";
import { createHostProcessRunner } from "../process/processRunner.ts";
import { createUpdatesHost } from "../adapters/updates.ts";
import { createInvoke, type NativeInvoke } from "../adapters/invoke.ts";
import { createLogger } from "../../../shared/logging/logger.ts";
import { NativePanelService } from "../filesystem/panelService.ts";
import { HostResources, trackProcesses } from "./effects.ts";
import type { PtySpawnWire } from "../types.ts";

export class DesktopHost implements HostService {
  private readonly resources = new HostResources();
  private readonly invoke: NativeInvoke;
  private bridge?: ReturnType<typeof createBridgeAcpClient>;
  readonly storage = webviewStorage;
  readonly diagnostics = diagnosticsHost;
  readonly exitGate = createHostExitGate();
  private exitDiagnostics?: ExitDiagnostics;
  private readonly flushForExit: ExitDiagnostics = (entry) =>
    this.exitDiagnostics?.(entry) ??
    this.diagnostics.flush(entry);

  registerExitDiagnostics(flush: ExitDiagnostics): () => void {
    if (!this.resources.isActive()) throw new Error("宿主实例正在卸载");
    if (this.exitDiagnostics)
      throw new Error("Exit diagnostics is already registered");
    this.exitDiagnostics = flush;
    return () => {
      if (this.exitDiagnostics === flush) this.exitDiagnostics = undefined;
    };
  }
  readonly commands: HostService["commands"];
  readonly archives: HostService["archives"];
  readonly window: HostService["window"] = {
    ...windowHost,
    chrome: isTauriEnv() ? {
      ...windowChromeHost,
      listenForResize: (receive) =>
        this.resources.listen(() => windowChromeHost.listenForResize(() => {
          if (this.resources.isActive()) receive();
        })),
    } : undefined,
    forceClose: () =>
      this.invoke("force_close", undefined, undefined, this.flushForExit),
    listenForClose: (receive) =>
      this.resources.listen(() => windowHost.listenForClose(receive)),
  };
  readonly dialogs: HostService["dialogs"] = {
    pickDirectory: async (title) => {
      if (!this.resources.isActive()) return null;
      const path = await dialogHost.pickDirectory(title);
      return this.resources.isActive() ? path : null;
    },
    saveFile: async (options) => {
      if (!this.resources.isActive()) return null;
      const path = await dialogHost.saveFile(options);
      return this.resources.isActive() ? path : null;
    },
  };
  readonly shell: HostService["shell"] = {
    openExternal: (url) => this.resources.isActive()
      ? openExternal(url)
      : Promise.reject(new Error("宿主实例正在卸载")),
  };
  readonly notifications: HostService["notifications"] = {
    isAvailable: () => this.resources.isActive() && notificationHost.isAvailable(),
    listen: (receive) => this.resources.acquire(async () => {
      let active = true;
      const unregister = await notificationHost.listen((action) => {
        if (active && this.resources.isActive()) receive(action);
      });
      const release = this.resources.own(() => {
        active = false;
        return unregister();
      });
      return () => release();
    }),
    ensurePermission: () => this.resources.isActive()
      ? notificationHost.ensurePermission()
      : Promise.resolve(false),
    send: (notification) => this.resources.isActive()
      ? notificationHost.send(notification)
      : Promise.resolve(),
  };
  readonly files: HostService["files"];
  readonly git: HostService["git"];
  readonly terminal: HostService["terminal"];
  readonly process: HostService["process"];
  readonly skills: HostService["skills"];
  readonly account: HostService["account"];
  readonly updates: HostService["updates"];
  readonly acpProcess: HostService["acpProcess"];

  isNative(): boolean {
    return isTauriEnv();
  }

  readonly openDevelopmentAcpTransport: HostService["openDevelopmentAcpTransport"] = (options) => {
    if (!import.meta.env.DEV || import.meta.env.VITEST)
      return Promise.resolve(null);
    return this.resources.acquire(async () => {
      this.bridge ??= createBridgeAcpClient(() => this.resources.isActive());
      const transport = await this.bridge.open(options, () => {
        void release(() => {}).catch(() => {});
      });
      const release = this.resources.own(async () => {
        if (!transport.isClosed) await transport.kill();
        transport.dispose();
      });
      return transport;
    });
  };

  constructor(options: HostOptions = {}) {
    this.invoke = createInvoke((options.createLogger ?? createLogger)("host"));
    const backend = options.createBackend?.() ?? createHostRuntime(this.invoke);
    const runner = createHostProcessRunner(this.invoke);
    const updates = createUpdatesHost(this.invoke);
    this.updates = {
      ...updates,
      install: () => this.invoke("update_install", undefined, undefined, this.flushForExit),
      listen: (receive) => this.resources.listen(() => updates.listen(receive)),
    };
    const pathExists = (path: string) =>
      this.resources.run(() => backend.pathExists(path));
    const userDataDir = (namespace: string, directory: string) =>
      this.resources.run(() => backend.userDataDir(namespace, directory));
    const homeDir = backend.homeDir?.bind(backend);
    this.commands = {
      pathExists,
      userDataDir,
      homeDir: homeDir && (() => this.resources.run(homeDir)),
      runCommand: (program, args) =>
        this.resources.run(() => backend.runCommand(program, args)),
    };
    this.archives = {
      userDataDir,
      readTextFile: (path) => this.resources.run(() => backend.readTextFile(path)),
    };
    this.skills = {
      pathExists,
      userDataDir,
      listDirNames: (path) => this.resources.run(() => backend.listDirNames(path)),
      copyDir: (from, to) => this.resources.run(() => backend.copyDir(from, to)),
      writeTextFile: (path, text) => this.resources.run(() => backend.writeTextFile(path, text)),
    };
    this.account = createAccountHost(backend, this.resources);
    this.process = {
      run: (request) => this.resources.run(() => runner.run(request)),
      exists: (path) => this.resources.run(() => runner.exists(path)),
    };
    const panel = new NativePanelService(this.invoke);
    const files = createDocumentFileHost(this.exitGate.isExiting, panel, this.invoke);
    const git = createGitHost(this.exitGate.isExiting, panel);
    this.files = {
      ...files,
      watch: (...args) => this.resources.listen(() => files.watch(...args)),
    };
    this.git = {
      ...git,
      watch: (...args) => this.resources.listen(() => git.watch(...args)),
    };
    const process = options.acpProcess ?? createTauriAcpProcessHost(this.invoke);
    const acp = trackProcesses<number>(
      this.resources,
      (handle) => handle,
      (handle) => process.killTree(handle),
      (handle) => process.release(handle),
    );
    this.acpProcess = {
      spawn: (launch) => acp.spawn(() => process.spawn(launch)),
      subscribe: (...args) =>
        this.resources.listen(() => process.subscribe(...args)),
      writeLine: (...args) => process.writeLine(...args),
      closeInput: (handle) => process.closeInput(handle),
      killTree: (handle) => process.killTree(handle),
      release: acp.release,
    };
    const terminalHost = createTerminalHost(this.invoke);
    const terminal = trackProcesses<PtySpawnWire>(
      this.resources,
      (process) => process?.handle,
      (handle) => terminalHost.kill(handle),
      (handle) => terminalHost.release(handle),
    );
    this.terminal = {
      ...terminalHost,
      spawn: (request) => terminal.spawn(() => terminalHost.spawn(request)),
      listenOutput: (receive) =>
        this.resources.listen(() => terminalHost.listenOutput(receive)),
      listenExit: (receive) =>
        this.resources.listen(() => terminalHost.listenExit(receive)),
      release: terminal.release,
    };
  }

  dispose(): Promise<void> {
    this.exitDiagnostics = undefined;
    return this.resources.dispose().finally(() => this.bridge?.dispose());
  }
}
