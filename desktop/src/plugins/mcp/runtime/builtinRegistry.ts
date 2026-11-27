import { createStore } from "zustand/vanilla";
import type { BuiltinMcp, McpService } from "../service.ts";

export function createBuiltinMcpRegistry(): Pick<
  McpService,
  "builtins" | "registerBuiltin"
> {
  const entries = createStore<readonly BuiltinMcp[]>(() => []);
  return {
    builtins: {
      getState: entries.getState,
      getInitialState: entries.getInitialState,
      subscribe: entries.subscribe,
    },
    registerBuiltin(entry) {
      if (entries.getState().some(({ id }) => id === entry.id))
        throw new Error(`内置 MCP ID 已登记：${entry.id}`);
      entries.setState((current) => [...current, entry], true);
      let registered = true;
      return () => {
        if (!registered) return;
        registered = false;
        entries.setState(
          (current) => current.filter((candidate) => candidate !== entry),
          true,
        );
      };
    },
  };
}
