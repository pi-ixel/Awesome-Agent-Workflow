/**
 * Mermaid 识别与渲染预算（移植自 ZCode lib/mermaidLanguage.ts 与
 * lib/mermaidRenderBudget.ts,按 desktop 场景简化）。
 */

/** 显式 mermaid 语言别名。 */
export function isMermaidLanguage(language: string | null | undefined): boolean {
  const normalized = (language ?? "").trim().toLowerCase();
  return normalized === "mermaid" || normalized === "mmd";
}

/**
 * 模型经常不标语言直接输出图代码：对空语言 / 纯文本块做首行启发式识别。
 * 显式给了其他语言的块一律不判 mermaid。
 */
const MERMAID_FIRST_LINE_PATTERN =
  /^\s*(?:flowchart(?:-v2|-beta)?|graph\b|sequenceDiagram|classDiagram|classDef\b|stateDiagram(?:-v2)?|erDiagram|journey\b|gantt\b|pie\b|quadrantChart|quadrant-beta|timeline\b|mindmap\b|gitGraph\b|sankey-beta|xychart(?:-beta)?|requirementDiagram|C4Context|C4Container|C4Component|C4Dynamic|C4Person|block-beta|architecture-beta)\b/;

export function shouldRenderMermaidCodeBlock(
  language: string | null | undefined,
  code: string,
): boolean {
  const trimmed = code.trim();
  if (trimmed === "") {
    return false;
  }
  const normalized = (language ?? "").trim().toLowerCase();
  if (isMermaidLanguage(normalized)) {
    return true;
  }
  if (normalized !== "" && normalized !== "text" && normalized !== "plaintext") {
    return false;
  }
  return MERMAID_FIRST_LINE_PATTERN.test(trimmed.split("\n", 1)[0] ?? "");
}

// ---------------------------------------------------------------- 渲染预算

/** 超过任一阈值即放弃渲染,回退纯文本(防巨型图拖垮 webview)。 */
const MAX_SOURCE_CHARS = 20_000;
const MAX_LINES = 600;

export type MermaidRenderDecision = {
  shouldRender: boolean;
  reason: "visible" | "too-many-chars" | "too-many-lines" | "document-hidden";
  metrics: { chars: number; lines: number };
};

export function getCurrentMermaidDocumentVisibility(): "visible" | "hidden" {
  if (typeof document === "undefined") {
    return "hidden";
  }
  return document.visibilityState === "visible" ? "visible" : "hidden";
}

export function resolveMermaidAutoRenderDecision(
  code: string,
  context: { documentVisibilityState: "visible" | "hidden" },
): MermaidRenderDecision {
  const metrics = {
    chars: code.length,
    lines: code.split("\n").length,
  };
  if (context.documentVisibilityState === "hidden") {
    return { shouldRender: false, reason: "document-hidden", metrics };
  }
  if (metrics.chars > MAX_SOURCE_CHARS) {
    return { shouldRender: false, reason: "too-many-chars", metrics };
  }
  if (metrics.lines > MAX_LINES) {
    return { shouldRender: false, reason: "too-many-lines", metrics };
  }
  return { shouldRender: true, reason: "visible", metrics };
}
