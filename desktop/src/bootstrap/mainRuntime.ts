import { createDesktopRuntime } from "./bootstrap.ts";
import type { ProjectService } from "../plugins/project/service.ts";
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
export function readDesktopProjectService(): ProjectService | undefined {
  return runtime?.project;
}
