import type { DiagnosticsReader } from "../../contracts/diagnostics.ts";
import type { DiagnosticsCommand, DiagnosticsHost, HostDialogs } from "../../contracts/host.ts";

export function createDiagnosticsReader(
  host: DiagnosticsHost,
  saveFile: HostDialogs["saveFile"],
  isActive: () => boolean,
): DiagnosticsReader {
  const assertActive = () => {
    if (!isActive()) throw new Error("Diagnostics service is disposed");
  };
  async function read<T>(command: DiagnosticsCommand, args?: Record<string, unknown>): Promise<T> {
    assertActive();
    const result = await host.request<T>(command, args);
    assertActive();
    return result;
  }
  return {
    isNative: () => isActive() && host.isNative(),
    status: () => read("diagnostics_status"),
    snapshot: () => read("diagnostics_snapshot"),
    query: (query) => read("diagnostics_query", { query }),
    raw: (id) => read("diagnostics_raw", { id }),
    async export(query) {
      assertActive();
      const path = await saveFile({
        defaultPath: `aaw-diagnostics-${Date.now()}.jsonl`,
        filters: [{ name: "JSON Lines", extensions: ["jsonl"] }],
      });
      return path && isActive() ? read("diagnostics_export", { path, query }) : null;
    },
  };
}
