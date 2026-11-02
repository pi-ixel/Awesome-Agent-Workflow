/**
 * Mermaid 识别与渲染预算（移植自 ZCode lib/mermaidLanguage.ts 与
 * lib/mermaidRenderBudget.ts,按 desktop 场景简化）。
 */

/** 显式 mermaid 语言别名。 */
export function isMermaidLanguage(
  language: string | null | undefined,
): boolean {
  const normalized = (language ?? "").trim().toLowerCase();
  return normalized === "mermaid" || normalized === "mmd";
}

/**
 * 模型经常不标语言直接输出图代码：只对空语言 / 纯文本块做窄首行识别，
 * 显式给了其他语言的块一律不判 mermaid。
 */
const MERMAID_AUTODETECT_LANGUAGES = new Set([
  "",
  "text",
  "txt",
  "plain",
  "plaintext",
]);
/** mermaid 允许源码带 ---frontmatter--- 元数据块（标题/配置）。 */
const MERMAID_LEADING_DIRECTIVE_PATTERN = /^---[\s\S]*?---\s*/;
/** 图类型首行集合（对表 ZCode：含 packet-beta / c4 族，不含 classDef 等子指令）。 */
const MERMAID_DIAGRAM_START_PATTERN =
  /^(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|quadrantChart|requirementDiagram|gitGraph|mindmap|timeline|sankey-beta|xychart-beta|block-beta|packet-beta|architecture-beta|c4(?:Context|Container|Component|Dynamic|Deployment))/i;

/**
 * 首个非空行是否像 mermaid 图源：剥掉 leading frontmatter 后再取行，
 * 大小写不敏感（『SequenceDiagram』也算）。
 */
export function isLikelyMermaidCode(code: string): boolean {
  const firstMeaningfulLine = code
    .trim()
    .replace(MERMAID_LEADING_DIRECTIVE_PATTERN, "")
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0);

  return firstMeaningfulLine
    ? MERMAID_DIAGRAM_START_PATTERN.test(firstMeaningfulLine.trim())
    : false;
}

export function shouldRenderMermaidCodeBlock(
  language: string | null | undefined,
  code: string,
): boolean {
  const normalizedLanguage = (language ?? "").trim().toLowerCase();
  if (isMermaidLanguage(normalizedLanguage)) {
    return true;
  }
  return (
    MERMAID_AUTODETECT_LANGUAGES.has(normalizedLanguage) &&
    isLikelyMermaidCode(code)
  );
}

// ---------------------------------------------------------------- 渲染预算

export const MERMAID_AUTO_RENDER_MAX_SOURCE_CHARS = 20_000;
export const MERMAID_AUTO_RENDER_MAX_LINES = 600;
export const MERMAID_AUTO_RENDER_MAX_COMPLEXITY_SCORE = 1_500;

export type MermaidDocumentVisibilityState =
  "visible" | "hidden" | "prerender" | "unloaded" | "unknown";

export type MermaidAutoRenderSkipReason =
  | "document-hidden"
  | "source-too-large"
  | "line-count-too-large"
  | "complexity-too-large";

export interface MermaidAutoRenderMetrics {
  sourceChars: number;
  lineCount: number;
  edgeLikeTokenCount: number;
  nodeLikeTokenCount: number;
  complexityScore: number;
}

export type MermaidAutoRenderDecision =
  | {
      shouldRender: true;
      metrics: MermaidAutoRenderMetrics;
    }
  | {
      shouldRender: false;
      reason: MermaidAutoRenderSkipReason;
      metrics: MermaidAutoRenderMetrics;
    };

interface MermaidAutoRenderOptions {
  documentVisibilityState?: MermaidDocumentVisibilityState;
  maxSourceChars?: number;
  maxLines?: number;
  maxComplexityScore?: number;
}

const MERMAID_EDGE_TOKEN_PATTERN =
  /(?:<-->|<--|-->|---|-\.->|==>|--x|--o|x--|o--)/gu;
const MERMAID_NODE_TOKEN_PATTERN =
  /(?:^|\n)\s*[A-Za-z][\w-]*(?:\[[^\]\n]{0,200}\]|\([^)\n]{0,200}\)|\{[^}\n]{0,200}\})/gu;

function countPatternMatches(value: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  let count = 0;
  while (pattern.exec(value)) {
    count += 1;
  }
  return count;
}

function countLines(value: string): number {
  if (!value) {
    return 0;
  }

  let lineCount = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) {
      lineCount += 1;
    }
  }
  return lineCount;
}

export function getCurrentMermaidDocumentVisibility(): MermaidDocumentVisibilityState {
  if (typeof document === "undefined") {
    return "visible";
  }

  const visibilityState = document.visibilityState as
    MermaidDocumentVisibilityState | undefined;
  if (
    visibilityState === "visible" ||
    visibilityState === "hidden" ||
    visibilityState === "prerender" ||
    visibilityState === "unloaded"
  ) {
    return visibilityState;
  }

  return document.hidden ? "hidden" : "visible";
}

function measureMermaidSource(source: string): MermaidAutoRenderMetrics {
  const sourceChars = source.length;
  const lineCount = countLines(source);
  const edgeLikeTokenCount = countPatternMatches(
    source,
    MERMAID_EDGE_TOKEN_PATTERN,
  );
  const nodeLikeTokenCount = countPatternMatches(
    source,
    MERMAID_NODE_TOKEN_PATTERN,
  );
  const complexityScore = lineCount + edgeLikeTokenCount + nodeLikeTokenCount;

  return {
    sourceChars,
    lineCount,
    edgeLikeTokenCount,
    nodeLikeTokenCount,
    complexityScore,
  };
}

export function resolveMermaidAutoRenderDecision(
  source: string,
  options: MermaidAutoRenderOptions = {},
): MermaidAutoRenderDecision {
  const metrics = measureMermaidSource(source);
  const documentVisibilityState = options.documentVisibilityState ?? "visible";
  const maxSourceChars =
    options.maxSourceChars ?? MERMAID_AUTO_RENDER_MAX_SOURCE_CHARS;
  const maxLines = options.maxLines ?? MERMAID_AUTO_RENDER_MAX_LINES;
  const maxComplexityScore =
    options.maxComplexityScore ?? MERMAID_AUTO_RENDER_MAX_COMPLEXITY_SCORE;

  // Mermaid/DOMPurify 渲染会在 native 层构造大 DOM/SVG 字符串，事后 catch
  // 或截断无法阻止 OOM；必须在进入 render 前按源码规模与页面可见性做预算门禁。
  if (
    documentVisibilityState !== "visible" &&
    documentVisibilityState !== "unknown"
  ) {
    return {
      shouldRender: false,
      reason: "document-hidden",
      metrics,
    };
  }

  if (metrics.sourceChars > maxSourceChars) {
    return {
      shouldRender: false,
      reason: "source-too-large",
      metrics,
    };
  }

  if (metrics.lineCount > maxLines) {
    return {
      shouldRender: false,
      reason: "line-count-too-large",
      metrics,
    };
  }

  if (metrics.complexityScore > maxComplexityScore) {
    return {
      shouldRender: false,
      reason: "complexity-too-large",
      metrics,
    };
  }

  return {
    shouldRender: true,
    metrics,
  };
}
