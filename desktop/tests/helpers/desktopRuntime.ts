import { createDesktopRuntime } from "../../src/runtime/bootstrap.ts";
import type { AcpRuntimeHost } from "../../src/runtime/acp/service.ts";

/** Unused test operations fail loudly; production always supplies the full host. */
export function createTestDesktopRuntime(
  host: Pick<AcpRuntimeHost, "attachPreloading" | "close"> &
    Partial<AcpRuntimeHost>,
) {
  const unused = (): never => {
    throw new Error("Unexpected runtime host operation in this test");
  };
  return createDesktopRuntime({
    answerForm: unused,
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
    ...host,
  });
}
