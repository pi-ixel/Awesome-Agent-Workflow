import { DiagnosticsWindow } from "../../src/plugins/diagnostics/ui/DiagnosticsWindow.tsx";
import type {
  DiagnosticRecord,
  DiagnosticsReader,
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
  snapshot: () => Promise.resolve(null),
  resources: () =>
    Promise.resolve({
      supported: false,
      groups: [],
      history: [],
      exited: [],
      error: null,
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
