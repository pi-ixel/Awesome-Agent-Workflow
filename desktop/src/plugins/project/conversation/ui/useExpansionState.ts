import {
  createContext,
  useCallback,
  useContext,
  useState,
  useSyncExternalStore,
  type SetStateAction,
} from "react";
import type { ConversationExpansion } from "../viewState.ts";

export const ExpansionScope = createContext<{
  readonly scope: string;
  readonly state: ConversationExpansion;
} | null>(null);

/** In-memory state survives remounts; absent scope uses local component state. */
export function useExpansionState(
  id: string,
  defaultOpen = false,
): [boolean, (value: SetStateAction<boolean>) => void] {
  const context = useContext(ExpansionScope);
  const state = context?.state;
  const key = context ? JSON.stringify([context.scope, id]) : null;
  const [local, setLocal] = useState(defaultOpen);
  const subscribe = useCallback(
    (listener: () => void) =>
      key === null ? () => {} : (state?.subscribe(key, listener) ?? (() => {})),
    [key, state],
  );
  const getSnapshot = useCallback(
    () => (key === null ? defaultOpen : (state?.get(key) ?? defaultOpen)),
    [key, state, defaultOpen],
  );
  const shared = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const setOpen = useCallback(
    (value: SetStateAction<boolean>) => {
      if (key === null || !state) {
        setLocal(value);
        return;
      }
      const current = state.get(key) ?? defaultOpen;
      state.set(key, typeof value === "function" ? value(current) : value);
    },
    [key, state, defaultOpen],
  );
  return [key === null ? local : shared, setOpen];
}
