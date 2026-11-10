import { createStore } from "zustand";
import type { MemorySample } from "../types.ts";
import { createSnapshotView } from "../../../shared/state/readonlySnapshot.ts";

export const MAX_MEMORY_SAMPLES = 600;

function readMemory(): number | undefined {
  if (typeof performance === "undefined") return;
  const memory = (
    performance as Performance & {
      readonly memory?: { readonly usedJSHeapSize?: number };
    }
  ).memory;
  return memory?.usedJSHeapSize;
}

export function createMemorySampler(read = readMemory) {
  const supported = typeof read() === "number";
  const samples = createStore<readonly MemorySample[]>(() => []);
  const view = createSnapshotView(samples, (state) => state);
  let timer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  const record = (at: number, bytes: number) => {
    if (disposed) return;
    samples.setState(
      [...samples.getState().slice(1 - MAX_MEMORY_SAMPLES), { at, bytes }],
      true,
    );
  };

  return {
    supported,
    samples: view.snapshot,
    record,
    start() {
      if (disposed || !supported || timer !== undefined) return;
      timer = setInterval(() => {
        const bytes = read();
        if (typeof bytes === "number") record(Date.now(), bytes);
      }, 1000);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
      samples.setState([], true);
      view.dispose();
    },
  };
}
