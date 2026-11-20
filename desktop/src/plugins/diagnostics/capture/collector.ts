import type {
  AcpRawDirection,
  AcpRawWriter,
  DiagnosticsStatus,
} from "../types.ts";
import type { DiagnosticsCommand, DiagnosticsHost } from "../../host/types.ts";
import { withDeadline } from "../../../shared/asyncDeadline.ts";
import type { LogSink } from "./logSink.ts";
import type { LogEntry } from "../../../shared/logging/types.ts";
import type { DiagnosticsCapture } from "../config.ts";
import { redactAcpRaw } from "../../../shared/logging/logPrivacy.ts";
import { createDeliveryLane, deliveryTimeoutMs } from "./delivery.ts";
import { publishCaptureHealth } from "./captureHealth.ts";

interface AcpRawRecord {
  readonly line: string;
  readonly connectionId: string;
  readonly direction: AcpRawDirection;
  readonly at: number;
}

/** 主窗口独占采集，原文与脱敏日志分别排队。 */
export function startDiagnosticsCollector(
  host: DiagnosticsHost,
  sink: LogSink,
  { snapshot, cursor, probeConnection }: DiagnosticsCapture,
) {
  const previousLevel = sink.level;
  sink.setLevel("debug");
  let stopped = false;
  let retired = false;
  let flushTask: Promise<void> | undefined;
  let polling = false;
  const epoch = crypto.randomUUID();
  const encoder = new TextEncoder();
  const logs = createDeliveryLane<LogEntry>({
    epoch,
    batchSize: 25,
    send: (entries, delivery) =>
      host.request("diagnostics_append", {
        entries: entries.map(bounded),
        delivery,
      }),
    onAccepted: (entries) => {
      cursor.sequence = Math.max(cursor.sequence, entries.at(-1)?.seq ?? 0);
    },
  });
  const raw = createDeliveryLane<AcpRawRecord>({
    epoch,
    batchSize: 1,
    byteLimit: 64 * 1024 * 1024,
    recordByteLimit: 32 * 1024 * 1024,
    timeoutMs: 5000,
    send: ([record], delivery) =>
      host.request("diagnostics_acp_append", { record, delivery }),
  });
  const recordRaw: AcpRawWriter = (line, connectionId, direction) => {
    if (stopped) return;
    line = redactAcpRaw(line);
    raw.push(
      { line, connectionId, direction, at: Date.now() },
      encoder.encode(line).length,
    );
  };
  function bounded(entry: LogEntry): LogEntry {
    if (encoder.encode(JSON.stringify(entry)).length <= 16 * 1024) return entry;
    return {
      ...entry,
      message: entry.message.slice(0, 1024),
      context: { operationId: entry.context.operationId, truncated: true },
    };
  }
  for (const entry of sink.snapshot()) {
    if (entry.seq > cursor.sequence) logs.push(entry);
  }
  const unsubscribeLog = sink.subscribeEntry(logs.push);
  const stopHealth = publishCaptureHealth(() => ({
    logs: logs.status(),
    raw: raw.status(),
  }));
  const drain = async (deadline: number) => {
    while (
      !retired &&
      (logs.pending() || raw.pending()) &&
      Date.now() < deadline
    ) {
      await Promise.all([raw.flush(100), logs.flush()]);
      if (!retired && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  };
  const writeTimer = setInterval(() => {
    void logs.flush();
    void raw.flush(100);
  }, 250);
  const pollRequests = new Set<DiagnosticsCommand>();
  async function pollRequest<T>(
    command: DiagnosticsCommand,
    args?: Record<string, unknown>,
  ) {
    if (pollRequests.has(command)) return undefined;
    pollRequests.add(command);
    return withDeadline(
      Promise.resolve()
        .then(() => host.request<T>(command, args))
        .finally(() => pollRequests.delete(command)),
      deliveryTimeoutMs,
      "诊断状态查询超时",
    );
  }
  const poll = async () => {
    if (stopped || polling) return;
    polling = true;
    try {
      const status = await pollRequest<DiagnosticsStatus>("diagnostics_status");
      if (!stopped && probeConnection) {
        try {
          const ids = await pollRequest<string[]>("diagnostics_probe_take");
          if (!stopped) {
            for (const id of ids ?? [])
              void probeConnection(id).catch(() => {});
          }
        } catch {
          // Probe IPC failure must not suppress the regular snapshot.
        }
      }
      if (
        !stopped &&
        status?.observing &&
        !pollRequests.has("diagnostics_snapshot")
      )
        await pollRequest("diagnostics_snapshot", { snapshot: snapshot() });
    } catch {
      /* Diagnostic failure never stops main-window work. */
    } finally {
      polling = false;
    }
  };
  const pollTimer = setInterval(() => {
    void poll();
  }, 2000);
  void poll();
  function flushToDisk(): Promise<void> {
    return (flushTask ??= (async () => {
      const deadline = Date.now() + 1500;
      try {
        await withDeadline(drain(deadline), 1500, "诊断排空超时");
      } catch {
        // 继续请求原生端落盘已收到的日志。
      }
      await host.flush();
    })().finally(() => {
      flushTask = undefined;
    }));
  }
  const onPageHide = () => {
    void flushToDisk();
  };
  window.addEventListener("pagehide", onPageHide);
  sink.createLogger("app").info("主窗口启动", { stage: "start" });
  let stopping: Promise<void> | undefined;
  return {
    recordRaw,
    async flush(finalEntry?: LogEntry) {
      const needsFinalEntry = stopped && finalEntry !== undefined;
      await flushToDisk();
      if (needsFinalEntry) await host.flush(finalEntry);
    },
    stop() {
      if (stopping) return stopping;
      stopped = true;
      clearInterval(writeTimer);
      clearInterval(pollTimer);
      stopHealth();
      window.removeEventListener("pagehide", onPageHide);
      unsubscribeLog();
      sink.setLevel(previousLevel);
      return (stopping = flushToDisk().finally(() => {
        retired = true;
        logs.retire();
        raw.retire();
      }));
    },
  };
}
