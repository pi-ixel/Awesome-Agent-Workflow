import { expect, it } from "vitest";
import { matchRuntime } from "../../../src/plugins/diagnostics/ui/sessionPresentation.ts";
import type { AcpConnectionDiagnostic } from "../../../src/plugins/acpConnection/types.ts";

const connection = (id: string, path: string): AcpConnectionDiagnostic => ({
  id,
  state: "ready",
  probe: null,
  sessions: [
    {
      id: "shared-session",
      state: "ready",
      running: false,
      project: { id: path, path },
    },
  ],
});
it("matches normalized Windows paths and refuses ambiguous session identities", () => {
  const a = connection("a", "C:/One");
  const b = connection("b", "C:/Two");
  const row = {
    sessionId: "shared-session",
    workspacePath: "c:\\one\\",
    busyReason: "审批中",
  };
  const result = matchRuntime([a, b], [row]);
  expect(result.matched.get(a.sessions[0]!)).toEqual([row]);
  expect(result.matched.has(b.sessions[0]!)).toBe(false);
  expect(result.unmatched).toEqual([]);
  expect(
    matchRuntime([a, connection("duplicate", "C:/One")], [row]).unmatched,
  ).toEqual([row]);
});
it("retains unbound, missing-project and crashed runtime rows", () => {
  const rows = [
    { listOnly: true },
    { sessionId: "shared-session" },
    { sessionId: "gone", workspacePath: "C:/One", agentCrashed: "进程退出" },
  ];
  const result = matchRuntime([connection("a", "C:/One")], rows);
  expect(result.unmatched).toEqual(rows);
  expect(result.matched.size).toBe(0);
});
