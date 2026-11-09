/** Compatibility defaults and migration for installations predating the iCode rename. */
export const defaultICodePath = "";
export const defaultICodeCommand = "icode";

export function migrateICodePath(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" && value !== "chrys"
    ? value
    : fallback;
}
