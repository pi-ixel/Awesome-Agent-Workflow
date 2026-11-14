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
    openDevelopmentAcpTransport: host.openDevelopmentAcpTransport,
    storage: host.storage,
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
    git: host.git,
    terminal: host.terminal,
    process: host.process,
    skills: host.skills,
    account: host.account,
    updates: host.updates,
    workflowEngine: host.workflowEngine,
  } satisfies HostService);
  ctx.effect(() => () => host.dispose(), "host:resources");
}
