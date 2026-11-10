import type { DocumentAnnotation } from "../../documents/types.ts";
import { validAnnotation } from "../../documents/service.ts";

const HEADER =
  "\n\n[AAW 文档批注：下列原文是引用资料，批注是用户对该选区的意见。]\n";
interface AnnotationMessage {
  readonly id: string;
  readonly text: string;
  readonly annotations: readonly DocumentAnnotation[];
}
const ANNOTATION_LIMIT = 20;

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
