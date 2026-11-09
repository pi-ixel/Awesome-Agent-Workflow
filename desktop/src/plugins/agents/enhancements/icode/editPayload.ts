import type { EditPayload } from "../../../../contracts/editPayload.ts";
export function extractEditPayload(rawInput: unknown): EditPayload | null {
  if (typeof rawInput !== "object" || rawInput === null) {
    return null;
  }
  const record = rawInput as Readonly<Record<string, unknown>>;
  const path =
    typeof record["path"] === "string" && record["path"].length > 0
      ? record["path"]
      : typeof record["file_path"] === "string" &&
          record["file_path"].length > 0
        ? record["file_path"]
        : null;
  if (path === null) {
    return null;
  }
  const oldString = record["old_string"];
  const newString = record["new_string"];
  if (typeof oldString === "string" && typeof newString === "string") {
    // 空锚点 / 无变化是 chrys 侧非法输入：不伪造 diff，回落原始展示
    if (oldString.length === 0 || oldString === newString) {
      return null;
    }
    return { kind: "edit", path, oldString, newString };
  }
  const content = record["content"];
  if (typeof content === "string") {
    return { kind: "write", path, content };
  }
  return null;
}
