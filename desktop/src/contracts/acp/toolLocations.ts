import { asRecord } from "../../shared/valueGuards.ts";

/** ACP lines are one-based uint32; absent/invalid optional lines retain the file. */
export interface ToolLocation {
  readonly path: string;
  readonly line?: number;
}
export function parseToolLocations(value: unknown): readonly ToolLocation[] {
  if (!Array.isArray(value)) return [];
  const result: ToolLocation[] = [];
  for (const item of value as unknown[]) {
    const record = asRecord(item);
    if (typeof record?.path !== "string" || !record.path.trim()) continue;
    const location = {
      path: record.path,
      ...(typeof record.line === "number" &&
      Number.isInteger(record.line) &&
      record.line >= 1 &&
      record.line <= 0xffffffff
        ? { line: record.line }
        : {}),
    };
    if (
      !result.some(
        (entry) => entry.path === location.path && entry.line === location.line,
      )
    )
      result.push(location);
  }
  return result;
}
