import type { Context } from "cordis";
import type { HostService } from "./service.ts";
import type { HostOptions } from "./types.ts";
import { DesktopHost } from "./lifecycle/runtime.ts";

export const name = "host";
export const inject = [];

export function apply(ctx: Context, options?: HostOptions): void {
  const host = new DesktopHost(options);
  ctx.provide(name, {
    isNative: host.isNative.bind(host),
    acpProcess: host.acpProcess,
    browser: host.browser,
    openDevelopmentAcpTransport: host.openDevelopmentAcpTransport,
    storage: host.storage,
    mcp: host.mcp,
    turnChanges: host.turnChanges,
    diagnostics: host.diagnostics,
    registerExitDiagnostics: host.registerExitDiagnostics.bind(host),
    commands: host.commands,
    window: host.window,
    dialogs: host.dialogs,
    shell: host.shell,
    exitGate: host.exitGate,
    notifications: host.notifications,
    archives: host.archives,
    files: host.files,
    registerRemoteDocumentFiles: host.registerRemoteDocumentFiles.bind(host),
    git: host.git,
    registerRemoteGit: host.registerRemoteGit.bind(host),
    terminal: host.terminal,
    registerRemoteTerminalResolver: host.registerRemoteTerminalResolver.bind(host),
    process: host.process,
    skills: host.skills,
    account: host.account,
    readCodeAgentCredit: host.readCodeAgentCredit,
    readCodeAgentTokenQuota: host.readCodeAgentTokenQuota,
    updates: host.updates,
    workflowEngine: host.workflowEngine,
    opsSidecar: host.opsSidecar,
  } satisfies HostService);
  ctx.effect(() => () => host.dispose(), "host:resources");
}
