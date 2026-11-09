import { useEffect, useMemo } from "react";

/** Coalesce pointer/observer bursts without putting transient geometry in React. */
function createFrameTask() {
  let frame: number | null = null;
  let pending: (() => void) | null = null;
  const cancel = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    pending = null;
  };
  const flush = () => {
    const run = pending;
    cancel();
    run?.();
  };
  return {
    schedule(run: () => void) {
      pending = run;
      if (frame === null) frame = requestAnimationFrame(flush);
    },
    flush,
    cancel,
  };
}

export function useFrameTask() {
  const task = useMemo(() => createFrameTask(), []);
  useEffect(() => () => task.cancel(), [task]);
  return task;
}
