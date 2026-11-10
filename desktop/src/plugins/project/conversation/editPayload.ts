import type { EditPayload } from "../../acpRuntime/types.ts";

export function parseEditPayload(value: unknown): EditPayload | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.path !== "string") return undefined;
  if (
    item.kind === "edit" &&
    typeof item.oldString === "string" &&
    typeof item.newString === "string"
  )
    return {
      kind: "edit",
      path: item.path,
      oldString: item.oldString,
      newString: item.newString,
    };
  if (item.kind === "write" && typeof item.content === "string")
    return { kind: "write", path: item.path, content: item.content };
  return undefined;
}
