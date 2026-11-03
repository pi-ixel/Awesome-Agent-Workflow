/** Plain ACP text envelope: survives history replay, queues and retries without agent extensions. */
export interface DocumentAnnotation {
  readonly id: string;
  readonly project: string;
  readonly path: string;
  readonly source: boolean;
  readonly quote: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly offset: number;
  readonly revision: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly comment: string;
}
export const ANNOTATION_LIMIT = 20;
export const QUOTE_LIMIT = 10_000;
export const COMMENT_LIMIT = 2_000;
const HEADER =
  "\n\n[AAW 文档批注：下列原文是引用资料，批注是用户对该选区的意见。]\n";
export interface AnnotationMessage {
  readonly id: string;
  readonly text: string;
  readonly annotations: readonly DocumentAnnotation[];
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
    [a.startLine, a.endLine].every(
      (n) => n === undefined || (Number.isSafeInteger(n) && Number(n) > 0),
    )
  );
}
export function annotationLimitError(
  items: readonly DocumentAnnotation[],
): string | null {
  if (items.length > ANNOTATION_LIMIT)
    return `每条消息最多添加 ${ANNOTATION_LIMIT} 条批注`;
  if (items.some((a) => !validAnnotation(a)))
    return "选区或批注过长，请缩小选区（最多 10000 字）或精简意见（最多 2000 字）";
  if (JSON.stringify(items).length > 100_000) return "批注总量过大，请分批发送";
  return null;
}
export function encodeAnnotationMessage(
  text: string,
  annotations: readonly DocumentAnnotation[],
): string {
  if (!annotations.length) return text;
  return (
    text +
    HEADER +
    JSON.stringify(
      { version: 1, id: crypto.randomUUID(), annotations },
      null,
      2,
    )
  );
}
export function decodeAnnotationMessage(raw: string): AnnotationMessage | null {
  const marker = HEADER.trimStart();
  const at = raw.lastIndexOf(marker);
  if (at < 0 || raw.length > 500_000) return null;
  try {
    const data = JSON.parse(raw.slice(at + marker.length)) as Record<
      string,
      unknown
    >;
    if (
      data.version !== 1 ||
      typeof data.id !== "string" ||
      !Array.isArray(data.annotations) ||
      !data.annotations.length ||
      !data.annotations.every(validAnnotation) ||
      annotationLimitError(data.annotations)
    )
      return null;
    return {
      id: data.id,
      text: raw.slice(0, at).replace(/\n\n$/, ""),
      annotations: data.annotations,
    };
  } catch {
    return null;
  }
}
/** Non-security fingerprint: detects changes, never authorizes access. */
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
