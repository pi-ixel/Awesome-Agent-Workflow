import { createLogger } from "../../../shared/logging/logger.ts";

interface UsageObservation {
  readonly sessionId: string | null;
  readonly source: "standard" | "extension";
  readonly sourceId?: string;
  readonly decision:
    "selected" | "ignored-subagent" | "ignored-source-priority";
  readonly used: number | null;
  readonly capacity: number | null;
  readonly sessionTotal: number | null;
  readonly reportedPercent: number | null;
  readonly details?: Readonly<Record<string, number | null>>;
  readonly basis:
    "context" | "latest-call" | "session-total-fallback" | "missing";
}

/** Uses the shared diagnostic sink: live window, persistence and export. Counts
 * deliberately avoid credential-like field names; never pass raw ACP payloads. */
export function createUsageDiagnostics(logger = createLogger("usage")) {
  const recent = new Map<
    string,
    { at: number; signature: string; skipped: number }
  >();
  return {
    reset: () => recent.clear(),
    record: (value: UsageObservation): void => {
      const reasons: string[] = [];
      const counts = [value.used, value.capacity, value.sessionTotal];
      if (counts.some((n) => n !== null && (!Number.isFinite(n) || n < 0)))
        reasons.push("invalid-count");
      if (value.capacity === null || value.capacity <= 0)
        reasons.push("missing-capacity");
      if (value.basis === "session-total-fallback")
        reasons.push("cumulative-used-as-context");
      const calculatedPercent =
        value.used !== null &&
        Number.isFinite(value.used) &&
        value.capacity !== null &&
        Number.isFinite(value.capacity) &&
        value.capacity > 0
          ? (value.used / value.capacity) * 100
          : null;
      if (calculatedPercent !== null && calculatedPercent > 100)
        reasons.push("used-exceeds-capacity");
      if (
        value.reportedPercent !== null &&
        (!Number.isFinite(value.reportedPercent) ||
          value.reportedPercent < 0 ||
          value.reportedPercent > 100)
      )
        reasons.push("invalid-reported-percent");
      if (
        calculatedPercent !== null &&
        value.reportedPercent !== null &&
        Math.abs(calculatedPercent - value.reportedPercent) > 1
      )
        reasons.push("percent-mismatch");

      const key = JSON.stringify([
        value.sessionId,
        value.source,
        value.sourceId,
      ]);
      const signature = JSON.stringify([value.decision, value.basis, reasons]);
      const previous = recent.get(key);
      const now = Date.now();
      // First observation and reason/selection changes are immediate, even
      // within the sampling interval. Repeated streaming updates are bounded.
      if (
        previous &&
        previous.signature === signature &&
        now - previous.at < 30_000
      ) {
        previous.skipped++;
        return;
      }
      if (!previous && recent.size >= 16)
        recent.delete(recent.keys().next().value!);
      recent.set(key, { at: now, signature, skipped: 0 });
      const numeric = (n: number | null) =>
        n === null || Number.isFinite(n) ? n : String(n);
      logger[reasons.length ? "warn" : "info"](
        reasons.length ? "上下文用量上报异常" : "上下文用量快照",
        {
          sessionId: value.sessionId,
          source: value.source,
          sourceId: value.sourceId ?? null,
          decision: value.decision,
          basis: value.basis,
          unit: "tokens",
          used: numeric(value.used),
          capacity: numeric(value.capacity),
          sessionTotal: numeric(value.sessionTotal),
          reportedPercent: numeric(value.reportedPercent),
          details: value.details,
          calculatedPercent,
          reasons,
          sampledUpdates: previous?.skipped ?? 0,
        },
      );
    },
  };
}
