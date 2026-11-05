export type EditPayload =
  | {
      readonly kind: "edit";
      readonly path: string;
      readonly oldString: string;
      readonly newString: string;
    }
  | {
      readonly kind: "write";
      readonly path: string;
      readonly content: string;
    };

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
