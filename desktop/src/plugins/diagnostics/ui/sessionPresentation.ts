import type { AcpConnectionDiagnostic } from "../../acpConnection/types.ts";
import type { DiagnosticsSnapshot } from "../types.ts";

export type RuntimeRow = DiagnosticsSnapshot["data"]["runtime"][number];
type Session = AcpConnectionDiagnostic["sessions"][number];
const pathKey = (path: string) =>
  path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

// Runtime snapshots have no connection ID. Only attach a row when both
// session identity and workspace identify one unambiguous connection slot.
export function matchRuntime(
  connections: readonly AcpConnectionDiagnostic[],
  runtime: readonly RuntimeRow[],
) {
  const matched = new Map<Session, RuntimeRow[]>();
  const unmatched: RuntimeRow[] = [];
  for (const row of runtime) {
    const candidates =
      row.sessionId && row.workspacePath
        ? connections
            .flatMap((connection) => connection.sessions)
            .filter(
              (session) =>
                session.id === row.sessionId &&
                session.project &&
                pathKey(session.project.path) === pathKey(row.workspacePath!),
            )
        : [];
    if (candidates.length !== 1) unmatched.push(row);
    else
      matched.set(candidates[0]!, [
        ...(matched.get(candidates[0]!) ?? []),
        row,
      ]);
  }
  return { matched, unmatched };
}

export function runtimeStatus(row: RuntimeRow) {
  return (
    row.agentCrashed ||
    row.busyReason ||
    (Number(row.pendingApprovals) > 0 ? "等待审批" : row.busy ? "忙碌" : "空闲")
  );
}
