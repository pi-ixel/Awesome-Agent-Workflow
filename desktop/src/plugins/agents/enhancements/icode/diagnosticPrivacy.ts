import type { AcpDiagnosticPrivacy } from "../../../../contracts/acp/diagnosticPrivacy.ts";
import { asRecord } from "../../../../shared/valueGuards.ts";

export const icodeDiagnosticPrivacy: AcpDiagnosticPrivacy = {
  isSensitiveRequest: (method) =>
    method === "_mcp/test" ||
    method === "_mcp/list" ||
    method === "_profiles/agents/read",
  redactNotification(method, params) {
    if (method !== "_chrys/runtime_update") return params;
    const runtime = asRecord(params.runtime);
    const details = asRecord((runtime ?? params).runtimeDetails);
    if (!details || !("mcp_failures" in details)) return params;
    const runtimeDetails = { ...details, mcp_failures: "[REDACTED]" };
    return runtime
      ? { ...params, runtime: { ...runtime, runtimeDetails } }
      : { ...params, runtimeDetails };
  },
};
