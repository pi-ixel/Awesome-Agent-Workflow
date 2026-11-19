import type { DocumentAnnotation } from "../../documents/types.ts";
import { validAnnotation } from "../../documents/service.ts";
import type { BrowserElement } from "../../../contracts/browser/types.ts";
import {
  BROWSER_ELEMENT_MESSAGE_HEADER,
  encodeBrowserElementMessage,
} from "../../../shared/browser/elementReferenceMessage.ts";

const HEADER =
  "\n\n[AAW 文档批注：下列原文是引用资料，批注是用户对该选区的意见。]\n";
const BROWSER_HEADER = BROWSER_ELEMENT_MESSAGE_HEADER;
interface AnnotationMessage {
  readonly id: string;
  readonly text: string;
  readonly annotations: readonly DocumentAnnotation[];
  readonly browserElements: readonly BrowserElement[];
}
const ANNOTATION_LIMIT = 20;
const BROWSER_ELEMENT_LIMIT = 20;

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

const boundedString = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum;
const finiteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export function validBrowserElement(value: unknown): value is BrowserElement {
  if (!value || typeof value !== "object") return false;
  const element = value as Partial<BrowserElement>;
  const rect = element.rect;
  const style = element.style;
  return (
    boundedString(element.referenceId, 128) &&
    boundedString(element.sessionId, 256) &&
    boundedString(element.tabId, 256) &&
    typeof element.tabGeneration === "number" &&
    Number.isSafeInteger(element.tabGeneration) &&
    element.tabGeneration > 0 &&
    boundedString(element.url, 4096) &&
    boundedString(element.role, 128) &&
    boundedString(element.selector, 4096) &&
    boundedString(element.xpath, 4096) &&
    typeof element.text === "string" &&
    element.text.length <= 200 &&
    !!rect &&
    finiteNumber(rect.x) &&
    finiteNumber(rect.y) &&
    finiteNumber(rect.width) &&
    finiteNumber(rect.height) &&
    rect.width >= 0 &&
    rect.height >= 0 &&
    !!style &&
    boundedString(style.display, 128) &&
    boundedString(style.position, 128) &&
    boundedString(style.visibility, 128) &&
    Array.isArray(element.framePath) &&
    element.framePath.length <= 16 &&
    element.framePath.every((frame) => boundedString(frame, 512))
  );
}

export function browserElementLimitError(
  items: readonly BrowserElement[],
): string | null {
  if (items.length > BROWSER_ELEMENT_LIMIT)
    return `每条消息最多添加 ${BROWSER_ELEMENT_LIMIT} 个页面元素引用`;
  if (items.some((element) => !validBrowserElement(element)))
    return "页面元素引用已失效或内容过长，请重新拾取";
  if (JSON.stringify(items).length > 100_000)
    return "页面元素引用总量过大，请分批发送";
  return null;
}

export function encodeAnnotationMessage(
  text: string,
  annotations: readonly DocumentAnnotation[],
  browserElements: readonly BrowserElement[] = [],
): string {
  if (browserElements.length)
    return encodeBrowserElementMessage(text, browserElements, annotations);
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
  if (raw.length > 500_000) return null;
  const legacyMarker = HEADER.trimStart();
  const browserMarker = BROWSER_HEADER.trimStart();
  const legacyAt = raw.lastIndexOf(legacyMarker);
  const browserAt = raw.lastIndexOf(browserMarker);
  const browserMessage = browserAt > legacyAt;
  const marker = browserMessage ? browserMarker : legacyMarker;
  const at = browserMessage ? browserAt : legacyAt;
  if (at < 0) return null;
  try {
    const data = JSON.parse(raw.slice(at + marker.length)) as Record<
      string,
      unknown
    >;
    if (
      typeof data.id !== "string" ||
      !Array.isArray(data.annotations) ||
      !data.annotations.every(validAnnotation) ||
      annotationLimitError(data.annotations)
    )
      return null;
    if (browserMessage) {
      if (
        data.version !== 2 ||
        !Array.isArray(data.browserElements) ||
        !data.browserElements.length ||
        !data.browserElements.every(validBrowserElement) ||
        browserElementLimitError(data.browserElements)
      )
        return null;
      return {
        id: data.id,
        text: raw.slice(0, at).replace(/\n\n$/, ""),
        annotations: data.annotations,
        browserElements: data.browserElements,
      };
    }
    if (data.version !== 1 || !data.annotations.length) return null;
    return {
      id: data.id,
      text: raw.slice(0, at).replace(/\n\n$/, ""),
      annotations: data.annotations,
      browserElements: [],
    };
  } catch {
    return null;
  }
}

export function mergePromptText(first: string, second: string): string | null {
  const original = decodeAnnotationMessage(first);
  const supplement = decodeAnnotationMessage(second);
  const annotations = [...(original?.annotations ?? []), ...(supplement?.annotations ?? [])];
  if (annotationLimitError(annotations)) return null;
  return encodeAnnotationMessage(
    [original?.text ?? first, supplement?.text ?? second].filter(Boolean).join("\n\n"),
    annotations,
  );
}
