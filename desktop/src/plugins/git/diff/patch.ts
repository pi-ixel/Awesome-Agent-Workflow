export interface PatchRow {
  text: string;
  old: number | null;
  next: number | null;
  kind: "add" | "del" | "meta" | "context";
}
export function parsePatch(patch: string): PatchRow[] {
  let old = 0,
    next = 0,
    hunk = false;
  return patch.split("\n").map((text) => {
    if (text.startsWith("diff --git ")) hunk = false;
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (header) {
      old = Number(header[1]);
      next = Number(header[2]);
      hunk = true;
      return { text, old: null, next: null, kind: "meta" };
    }
    if (
      !hunk ||
      text.startsWith("\\") ||
      (!text.startsWith(" ") && !text.startsWith("+") && !text.startsWith("-"))
    )
      return { text, old: null, next: null, kind: "meta" };
    if (text.startsWith("+"))
      return { text, old: null, next: next++, kind: "add" };
    if (text.startsWith("-"))
      return { text, old: old++, next: null, kind: "del" };
    return { text, old: old++, next: next++, kind: "context" };
  });
}
