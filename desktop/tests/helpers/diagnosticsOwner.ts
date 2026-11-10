import { vi } from "vitest";
import type { DesktopDiagnostics } from "../../src/plugins/diagnostics/lifecycle/diagnostics.ts";
import type { DiagnosticsService } from "../../src/plugins/diagnostics/service.ts";

const owners = vi.hoisted(() => new WeakMap<DiagnosticsService, DesktopDiagnostics>());

vi.mock(import("../../src/plugins/diagnostics/lifecycle/diagnostics.ts"), async (original) => {
  const module = await original();
  return {
    ...module,
    DesktopDiagnostics: class extends module.DesktopDiagnostics {
      constructor(...args: ConstructorParameters<typeof module.DesktopDiagnostics>) {
        super(...args);
        owners.set(this.service, this);
      }
    },
  };
});

export function diagnosticsOwner(service: DiagnosticsService): DesktopDiagnostics {
  const owner = owners.get(service);
  if (!owner) throw new Error("Missing Diagnostics test owner");
  return owner;
}
