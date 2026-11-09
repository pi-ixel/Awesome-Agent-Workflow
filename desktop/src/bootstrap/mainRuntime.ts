import { createDesktopRuntime } from "./bootstrap.ts";
import type { ProjectService } from "../contracts/project.ts";
let runtime: ReturnType<typeof createDesktopRuntime> | undefined;
/** Main-window entry only. Diagnostic windows must not import this module. */
export function startDesktopRuntime(
  diagnosticsSnapshot?: () => object,
  contribute?: Parameters<typeof createDesktopRuntime>[3],
  options?: Parameters<typeof createDesktopRuntime>[4],
) {
  if (runtime) return runtime;
  runtime = createDesktopRuntime(
    undefined,
    undefined,
    diagnosticsSnapshot,
    contribute,
    options,
  );
  return runtime;
}
export function attachDesktopPreloading(): () => void {
  let cancelled = false;
  let detach: (() => void) | undefined;
  void startDesktopRuntime()
    .ready.then(() => {
      if (!cancelled) detach = getDesktopProjectService().attachPreloading();
    })
    .catch((error: unknown) =>
      console.error("ACP runtime startup failed", error),
    );
  return () => {
    cancelled = true;
    detach?.();
  };
}
export function shutdownDesktopRuntime(
  options: { force?: boolean } = {},
): Promise<void> {
  return startDesktopRuntime().shutdown(options);
}

export function readDesktopProjectService(): ProjectService | undefined {
  return runtime?.project;
}

export function getDesktopProjectService(): ProjectService {
  const project = readDesktopProjectService();
  if (!project) throw new Error("Project Service 尚未就绪");
  return project;
}
export async function closeDesktopProjects(options?: {
  force?: boolean;
}): Promise<void> {
  await startDesktopRuntime().ready;
  const project = getDesktopProjectService();
  await project.closeProjects(options);
}
