import { DesktopConfiguration } from "../../src/plugins/configuration/registry/scopes.ts";
import { DesktopDiagnostics } from "../../src/plugins/diagnostics/lifecycle/diagnostics.ts";
import { diagnosticsHost } from "../../src/plugins/host/adapters/diagnostics.ts";
import { webviewStorage } from "../../src/plugins/host/storage/storage.ts";

export function createTestDiagnostics() {
  const configuration = new DesktopConfiguration(webviewStorage);
  const diagnostics = new DesktopDiagnostics(diagnosticsHost, configuration, () => Promise.resolve(null));
  return {
    diagnostics,
    async dispose() {
      await diagnostics.dispose();
      configuration.dispose();
    },
  };
}
