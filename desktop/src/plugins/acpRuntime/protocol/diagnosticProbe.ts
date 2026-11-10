import {
  ACP_METHOD,
  type InitializeResult,
} from "../../../contracts/acp/protocol.ts";
import { asRecord } from "../../../shared/valueGuards.ts";
import type { AcpDiagnosticProbePlan } from "../../acpConnection/types.ts";

export function diagnosticProbeFor(
  handshake: InitializeResult,
): AcpDiagnosticProbePlan {
  const supportsSessionList = Boolean(
    asRecord(handshake.agentCapabilities.sessionCapabilities)?.list,
  );
  return (cwd) => {
    if (!supportsSessionList) return { status: "unsupported" };
    if (!cwd) return { status: "no-project" };
    return { method: ACP_METHOD.sessionList, params: { cwd } };
  };
}
