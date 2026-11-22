import { DiagnosticsWindow } from "../../src/plugins/diagnostics/ui/DiagnosticsWindow.tsx";
import type {
  DiagnosticRecord,
  DiagnosticsReader,
  DesktopMemoryPoint,
} from "../../src/plugins/diagnostics/types.ts";

const record: DiagnosticRecord = {
  id: 120,
  at: Date.now(),
  runId: "desktop-preview",
  source: "示例 Agent",
  channel: "acp",
  level: "info",
  message: "收到工作区初始化结果",
  context: { operationId: "op-release", durationMs: 35 },
  hasRaw: true,
};

const rawText = JSON.stringify(
  {
    jsonrpc: "2.0",
    id: 120,
    result: { title: "发布检查示例", cwd: "D:/release", status: "ready" },
  },
  null,
  2,
);

const showResources = new URLSearchParams(location.search).has("resources");
const session = { scope: "workspace+agent", sessionId: "example" };
const point = (
  age: number,
  ui: number,
  browser: number,
): DesktopMemoryPoint => {
  const mib = 1024 ** 2;
  return {
    at: record.at - age,
    memory: {
      total: (90 + ui + browser) * mib,
      executable: 90 * mib,
      interface: ui * mib,
      browser: browser * mib,
      other: 0,
    },
  };
};

const reader: DiagnosticsReader = {
  isNative: () => true,
  status: () =>
    Promise.resolve({
      now: Date.now(),
      droppedBatches: 0,
      error: null,
      observing: true,
      latestId: record.id,
    }),
  snapshot: () =>
    Promise.resolve(
      showResources
        ? {
            at: record.at,
            data: {
              runtime: [
                {
                  diagnosticScope: session.scope,
                  sessionId: session.sessionId,
                  isActive: true,
                },
              ],
              memory: [],
              memorySamplingSupported: true,
              theme: "light",
            },
          }
        : null,
    ),
  resources: (focused) =>
    Promise.resolve({
      supported: showResources,
      groups: [],
      history: [],
      exited: [],
      error: null,
      ...(focused?.scope === session.scope &&
      focused.sessionId === session.sessionId
        ? {
            desktopMemory: point(0, 600, 640),
            turnMemory: {
              session,
              startedAt: record.at - 26000,
              endedAt: record.at - 2000,
              before: point(27000, 810, 0),
              peak: point(12000, 810, 1148),
              hasOverlap: true,
            },
          }
        : {}),
    }),
  probeConnection: () => Promise.resolve(),
  query: (filters) =>
    Promise.resolve(
      filters.after === record.id || filters.before === record.id
        ? []
        : [record],
    ),
  raw: async () => {
    const response = await fetch(
      "/tests/visual/fixture.html?sample-diagnostics-request",
    );
    if (!response.ok) throw new Error("原始报文读取失败");
    return rawText;
  },
  export: () => Promise.resolve(null),
};

export function DiagnosticsWindowFixture() {
  return <DiagnosticsWindow reader={reader} />;
}
