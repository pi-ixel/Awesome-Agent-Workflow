/** unknown → JSON 对象（数组不算）。 */
export function asRecord(
  raw: unknown,
): Readonly<Record<string, unknown>> | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Readonly<Record<string, unknown>>)
    : null;
}

/** unknown → string（null/非字符串返回 null）。 */
export function asString(raw: unknown): string | null {
  return typeof raw === "string" ? raw : null;
}

/** unknown → 有限数字。 */
export function asNumber(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/** unknown → boolean。 */
export function asBoolean(raw: unknown): boolean | null {
  return typeof raw === "boolean" ? raw : null;
}

export function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
