import { useCallback, useEffect, useRef, useState } from "react";
import type { BuiltinMcp } from "../service.ts";

interface ControlState {
  readonly enabled: boolean | null;
  readonly pending: boolean;
  readonly error?: string;
}

export function useBuiltinControls(entries: readonly BuiltinMcp[]) {
  const [states, setStates] = useState<ReadonlyMap<BuiltinMcp, ControlState>>(
    new Map(),
  );
  const activeEntries = useRef(new Set<BuiltinMcp>());
  const update = useCallback(
    (entry: BuiltinMcp, patch: Partial<ControlState>) => {
      if (!activeEntries.current.has(entry)) return;
      setStates((current) => {
        if (!activeEntries.current.has(entry)) return current;
        return new Map(
          [...current].filter(([candidate]) =>
            activeEntries.current.has(candidate),
          ),
        ).set(entry, {
          enabled: null,
          pending: false,
          ...current.get(entry),
          ...patch,
        });
      });
    },
    [],
  );

  useEffect(() => {
    let active = true;
    const releases: (() => void)[] = [];
    const mounted = new Set(entries);
    activeEntries.current = mounted;
    for (const entry of entries) {
      const control = entry.enabled;
      if (!control) continue;
      let observed = false;
      void Promise.resolve()
        .then(() =>
          control.watch((enabled) => {
            observed = true;
            if (active) update(entry, { enabled });
          }),
        )
        .then((release) => {
          if (active) releases.push(release);
          else release();
        })
        .catch((error) => {
          if (active) update(entry, { error: String(error) });
        })
        .then(async () => {
          if (!active || observed) return;
          const enabled = await control.read();
          if (active && !observed) update(entry, { enabled });
        })
        .catch((error) => {
          if (active) update(entry, { error: String(error) });
        });
    }
    return () => {
      active = false;
      mounted.clear();
      for (const release of releases) release();
    };
  }, [entries, update]);

  function change(entry: BuiltinMcp, enabled: boolean) {
    const control = entry.enabled;
    if (!control || states.get(entry)?.pending) return;
    update(entry, { pending: true });
    void Promise.resolve()
      .then(() => control.set(enabled))
      .then(
        (actual) =>
          update(entry, { enabled: actual, error: undefined, pending: false }),
        (error: unknown) =>
          update(entry, { error: String(error), pending: false }),
      );
  }

  return { states, change };
}
