import type { DocumentAnnotation } from "../types.ts";
import { COMMENT_LIMIT, QUOTE_LIMIT } from "../config.ts";

function validDiff(value: unknown, start: unknown, end: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  const nonempty = (s: unknown) => typeof s === "string" && s.length > 0;
  const positive = (n: unknown) => Number.isSafeInteger(n) && Number(n) > 0;
  return (
    (a.side === "old" || a.side === "new") &&
    nonempty(a.root) &&
    nonempty(a.file) &&
    positive(a.first) &&
    positive(a.last) &&
    Number(a.first) <= Number(a.last) &&
    (a.fragment === undefined
      ? start === a.first && end === a.last
      : a.kind === "turn" &&
        positive(a.fragment) &&
        start === undefined &&
        end === undefined) &&
    (a.kind === "turn"
      ? nonempty(a.recordId) && nonempty(a.sessionId)
      : a.kind === "git" && nonempty(a.change) && nonempty(a.target))
  );
}

export function validAnnotation(value: unknown): value is DocumentAnnotation {
  if (!value || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  return (
    [
      "id",
      "project",
      "path",
      "quote",
      "prefix",
      "suffix",
      "revision",
      "comment",
    ].every((k) => typeof a[k] === "string") &&
    typeof a.source === "boolean" &&
    Number.isSafeInteger(a.offset) &&
    Number(a.offset) >= 0 &&
    String(a.quote).length > 0 &&
    String(a.quote).length <= QUOTE_LIMIT &&
    String(a.comment).length <= COMMENT_LIMIT &&
    String(a.prefix).length <= 64 &&
    String(a.suffix).length <= 64 &&
    (a.diff === undefined || validDiff(a.diff, a.startLine, a.endLine)) &&
    [a.startLine, a.endLine].every(
      (n) => n === undefined || (Number.isSafeInteger(n) && Number(n) > 0),
    )
  );
}

/** 用于检测内容变动，不用于身份认证。 */
export function documentRevision(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++)
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${text.length}:${hash >>> 0}`;
}

export function locateAnnotation(
  text: string,
  a: DocumentAnnotation,
  revision: string,
): number | null {
  if (a.diff) return null;
  if (
    revision === a.revision &&
    text.slice(a.offset, a.offset + a.quote.length) === a.quote
  )
    return a.offset;
  const matches: number[] = [];
  let from = 0;
  while (from <= text.length) {
    const at = text.indexOf(a.quote, from);
    if (at < 0) break;
    matches.push(at);
    from = at + Math.max(1, a.quote.length);
  }
  if (matches.length === 1) return matches[0]!;
  const contextual = matches.filter(
    (at) =>
      text.slice(Math.max(0, at - a.prefix.length), at) === a.prefix &&
      text.slice(at + a.quote.length, at + a.quote.length + a.suffix.length) ===
        a.suffix,
  );
  return contextual.length === 1 ? contextual[0]! : null;
}
