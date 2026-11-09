import type { ConversationExpansion } from "../../../contracts/foreground.ts";

export function createConversationExpansion(): ConversationExpansion & {
  dispose(): void;
} {
  let active = true;
  const values = new Map<string, boolean>();
  const listeners = new Map<string, Set<() => void>>();
  return {
    get: (key) => values.get(key),
    set(key, open) {
      if (!active || values.get(key) === open) return;
      values.set(key, open);
      listeners.get(key)?.forEach((listener) => listener());
    },
    subscribe(key, listener) {
      if (!active) return () => {};
      const group = listeners.get(key) ?? new Set<() => void>();
      listeners.set(key, group);
      group.add(listener);
      return () => {
        group.delete(listener);
        if (!group.size && listeners.get(key) === group) listeners.delete(key);
      };
    },
    dispose() {
      if (!active) return;
      active = false;
      values.clear();
      for (const group of listeners.values())
        group.forEach((listener) => listener());
      listeners.clear();
    },
  };
}
