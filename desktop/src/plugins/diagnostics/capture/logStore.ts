import type { LogSink } from "./logSink.ts";
import type { LogEntry, LogLevel } from "../../../shared/logging/types.ts";
import { createStore } from "zustand";
import { createSnapshotView } from "../../../shared/state/readonlySnapshot.ts";

interface DiagnosticsLogs {
  readonly entries: readonly LogEntry[];
  readonly level: LogLevel;
}

export function createLogStore(sink: LogSink) {
  let disposed = false;
  const store = createStore<DiagnosticsLogs>(() => ({
    entries: sink.snapshot(),
    level: sink.level,
  }));
  const view = createSnapshotView(store, (state) => state);
  const unsubscribe = sink.subscribe((entries) =>
    store.setState({ entries, level: sink.level }),
  );
  return {
    view: view.snapshot,
    setLevel: (level: LogLevel) => {
      if (disposed) return;
      sink.setLevel(level);
      store.setState({ level });
    },
    clear: () => {
      if (!disposed) sink.clear();
    },
    dispose() {
      disposed = true;
      unsubscribe();
      store.setState({ entries: [] });
      view.dispose();
    },
  };
}
