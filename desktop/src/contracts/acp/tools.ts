import type { ToolKind } from "./protocol.ts";

export function parseToolKind(value: unknown): ToolKind | undefined {
  const kinds: readonly ToolKind[] = [
    "read",
    "edit",
    "delete",
    "move",
    "search",
    "execute",
    "think",
    "fetch",
    "switch_mode",
    "other",
  ];
  return kinds.find((kind) => kind === value);
}
