import {
  createContext,
  useCallback,
  useContext,
  useState,
  useSyncExternalStore,
  type SetStateAction,
} from "react";

export const ExpansionScope = createContext<string | null>(null);
const states = new Map<string, boolean>();
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** In-memory state survives remounts; absent scope uses local component state. */
export function useExpansionState(
  id: string,
  defaultOpen = false,
): [boolean, (value: SetStateAction<boolean>) => void] {
  const scope = useContext(ExpansionScope);
  const key = scope === null ? null : JSON.stringify([scope, id]);
  const [local, setLocal] = useState(defaultOpen);
  const getSnapshot = useCallback(
    () => (key === null ? defaultOpen : (states.get(key) ?? defaultOpen)),
    [key, defaultOpen],
  );
  const shared = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const setOpen = useCallback(
    (value: SetStateAction<boolean>) => {
      if (key === null) {
        setLocal(value);
        return;
      }
      const current = states.get(key) ?? defaultOpen;
      states.set(key, typeof value === "function" ? value(current) : value);
      listeners.forEach((listener) => listener());
    },
    [key, defaultOpen],
  );
  return [key === null ? local : shared, setOpen];
}
