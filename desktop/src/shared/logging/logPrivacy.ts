const privateKey =
  /password|token|secret|authorization|cookie|api[_-]?key|private[_-]?key|prompt|content|payload|stdin|stdout|stderr|args|^text$|^line$/i;
export function redactText(value: string): string {
  return value
    .slice(0, 4096)
    .replace(
      /(bearer\s+|(?:password|token|secret|authorization|api[_-]?key)["']?\s*[=:]\s*["']?(?:bearer\s+)?)[^\s"',;}]+/gi,
      "$1[REDACTED]",
    )
    .replace(/https?:\/\/[^\s]+/g, (url) =>
      url.includes("@") ? "[REDACTED URL]" : url.split(/[?#]/)[0]!,
    );
}
export function redactContext(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[truncated]";
  if (typeof value === "string") return redactText(value);
  if (value instanceof Error)
    return {
      name: value.name,
      message: redactText(value.message),
      stack: redactText(value.stack ?? ""),
    };
  if (Array.isArray(value))
    return value.slice(0, 20).map((v) => redactContext(v, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 40)
        .map(([k, v]) => [
          k,
          privateKey.test(k) ? "[REDACTED]" : redactContext(v, depth + 1),
        ]),
    );
  return typeof value === "bigint" ? String(value) : value;
}
