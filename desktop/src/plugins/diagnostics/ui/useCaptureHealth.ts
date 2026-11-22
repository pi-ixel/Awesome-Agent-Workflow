import { useEffect, useState } from "react";
import {
  captureHealthExpiry,
  captureHealthInterval,
  type CaptureHealth,
} from "../capture/captureHealth.ts";
import type { DiagnosticsReader } from "../types.ts";

export function useCaptureHealth(
  subscribe: DiagnosticsReader["subscribeCaptureHealth"],
) {
  const [health, setHealth] = useState<CaptureHealth>();
  const [isStale, setIsStale] = useState(false);
  useEffect(() => {
    if (!subscribe) return;
    let lastUpdate = Date.now();
    const unsubscribe = subscribe((next) => {
      lastUpdate = Date.now();
      setIsStale(false);
      setHealth(next);
    });
    const timer = setInterval(() => {
      setIsStale(Date.now() - lastUpdate >= captureHealthExpiry);
    }, captureHealthInterval);
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, [subscribe]);

  const lanes = health && [
    { name: "普通日志", ...health.logs },
    { name: "ACP 原文", ...health.raw },
  ];
  const stalled =
    lanes?.filter(({ paused, failures }) => paused || failures >= 2) ?? [];
  const dropped = lanes?.reduce((sum, lane) => sum + lane.dropped, 0) ?? 0;
  const unconfirmed =
    lanes?.reduce((sum, lane) => sum + lane.unconfirmed, 0) ?? 0;

  return { isStale, stalled, dropped, unconfirmed };
}
