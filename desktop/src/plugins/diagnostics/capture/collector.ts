import type { AcpRawDirection, AcpRawWriter, DiagnosticsStatus } from "../types.ts";
import type { DiagnosticsHost } from "../../host/types.ts";
import { withDeadline } from "../../../shared/asyncDeadline.ts";
import type { LogSink } from "./logSink.ts";
import type { LogEntry } from "../../../shared/logging/types.ts";
import type { DiagnosticsCapture } from "../config.ts";

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
  const logger = sink.createLogger("diagnostics");
  const previousLevel = sink.level;
  sink.setLevel("debug");
  let stopped = false;
  let retired = false;
  let flushTask: Promise<void> | undefined;
  let queue: LogEntry[] = sink
    .snapshot()
    .filter(({ seq }) => seq > cursor.sequence);
  let dropped = 0;
  let sending = false;
  let polling = false;
  const rawQueue: AcpRawRecord[] = [];
  let rawBytes = 0;
  let rawSending = false;
  const recordRaw: AcpRawWriter = (line, connectionId, direction) => {
    if (stopped) return;
    const bytes = new TextEncoder().encode(line).length;
    if (
      bytes > 32 * 1024 * 1024 ||
      rawBytes + bytes > 64 * 1024 * 1024 ||
      rawQueue.length >= 2000
    ) {
      logger.error("ACP 原文队列已满，报文未保存", {
        connectionId,
        bytes,
      });
      return;
    }
    rawQueue.push({ line, connectionId, direction, at: Date.now() });
    rawBytes += bytes;
  };
  const flushRaw = async () => {
    if (retired || rawSending || !rawQueue.length) return;
    rawSending = true;
    try {
      for (let count = 0; count < 100 && rawQueue.length && !retired; count++) {
        const record = rawQueue[0]!;
        await host.request("diagnostics_acp_append", { record });
        rawQueue.shift();
        rawBytes -= new TextEncoder().encode(record.line).length;
      }
    } catch {
      // Keep the record for the next attempt, with a bounded queue.
    } finally {
      rawSending = false;
    }
  };
  const bounded = (entry: LogEntry): LogEntry => {
    if (new TextEncoder().encode(JSON.stringify(entry)).length <= 16 * 1024)
      return entry;
    return {
      ...entry,
      message: entry.message.slice(0, 1024),
      context: { operationId: entry.context.operationId, truncated: true },
    };
  };
  const unsubscribeLog = sink.subscribeEntry((entry) => {
    if (queue.length >= 2000) {
      queue.shift();
      dropped++;
    }
    queue.push(entry);
  });
  const flush = async () => {
    if (retired || sending || queue.length === 0) return;
    sending = true;
    const batch = queue.splice(0, 25).map(bounded);
    try {
      await host.request("diagnostics_append", { entries: batch });
      cursor.sequence = Math.max(cursor.sequence, batch.at(-1)?.seq ?? 0);
      if (dropped) {
        const count = dropped;
        dropped = 0;
        logger.warn("日志队列拥塞，部分记录未保存", {
          count,
        });
      }
    } catch {
      // Retry boundedly without recursively logging a failing log sink.
      const pending = [...batch, ...queue];
      dropped += Math.max(0, pending.length - 2000);
      queue = pending.slice(-2000);
    } finally {
      sending = false;
    }
  };
  const drain = async (deadline: number) => {
    while (
      !retired &&
      (queue.length > 0 || sending || rawQueue.length > 0 || rawSending) &&
      Date.now() < deadline
    ) {
      await Promise.all([flushRaw(), flush()]);
      if (!retired && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  };
  const writeTimer = setInterval(() => {
    void flush();
    void flushRaw();
  }, 250);
  const poll = async () => {
    if (stopped || polling) return;
    polling = true;
    try {
      const status =
        await host.request<DiagnosticsStatus>("diagnostics_status");
      if (!stopped && probeConnection) {
        try {
          const ids = await host.request<string[]>("diagnostics_probe_take");
          if (!stopped) {
            for (const id of ids)
              void probeConnection(id).catch(() => {});
          }
        } catch {
          // Probe IPC failure must not suppress the regular snapshot.
        }
      }
      if (!stopped && status.observing)
        await host.request("diagnostics_snapshot", { snapshot: snapshot() });
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
      window.removeEventListener("pagehide", onPageHide);
      unsubscribeLog();
      sink.setLevel(previousLevel);
      return (stopping = flushToDisk().finally(() => {
        retired = true;
      }));
    },
  };
}
