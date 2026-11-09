import { createDesktopRuntime } from "../../src/bootstrap/bootstrap.ts";
import type { DesktopSessionOperations } from "../../src/bootstrap/bootstrap.ts";
import type { AcpProcessHost, HostRuntime } from "../../src/contracts/host.ts";

/** Unused test operations fail loudly; production always supplies the full host. */
export function createTestDesktopRuntime(
  host: Pick<DesktopSessionOperations, "attachPreloading" | "close"> &
    Partial<DesktopSessionOperations>,
  processHost?: AcpProcessHost,
  contribute?: Parameters<typeof createDesktopRuntime>[3],
  backend?: HostRuntime,
) {
  const unused = (): never => {
    throw new Error("Unexpected runtime host operation in this test");
  };
  return createDesktopRuntime(
    {
      registerProject: unused,
      preloadSessionList: unused,
      renameSession: unused,
      beginDraft: unused,
      focusSession: unused,
      recoverSession: unused,
      stopRecovery: unused,
      switchAgent: unused,
      openSession: unused,
      closeProject: unused,
      closeSession: unused,
      findSession: unused,
      hasRunningSessions: () => false,
      busySessionIds: () => new Set(),
      runtimeDebugSnapshot: () => [],
      ...host,
    },
    processHost,
    undefined,
    contribute,
    { createHostBackend: backend && (() => backend) },
  );
}
