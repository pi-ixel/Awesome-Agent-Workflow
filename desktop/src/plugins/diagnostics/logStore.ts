import type { LogSink } from "../../shared/diagnosticEvents/logger.ts";
import type { DiagnosticsLogs } from "../../contracts/diagnostics.ts";
import { createStore } from "zustand";

export function createLogStore(sink: LogSink) {
  let disposed = false;
  const store = createStore<DiagnosticsLogs>((set) => ({
    entries: sink.snapshot(),
    level: sink.level,
    setLevel(level) {
      if (disposed) return;
      sink.setLevel(level);
      set({ level });
    },
    clear() {
      if (!disposed) sink.clear();
    },
  }));
  const unsubscribe = sink.subscribe((entries) =>
    store.setState({ entries, level: sink.level }),
  );
  return {
    store,
    dispose() {
      disposed = true;
      unsubscribe();
      store.setState({ entries: [] });
    },
  };
}
