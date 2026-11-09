import { DesktopConfiguration } from "../../src/plugins/configuration/service.ts";
import { DesktopDiagnostics } from "../../src/plugins/diagnostics/service.ts";
import { diagnosticsHost } from "../../src/plugins/host/diagnostics.ts";
import { webviewStorage } from "../../src/plugins/host/storage.ts";

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
