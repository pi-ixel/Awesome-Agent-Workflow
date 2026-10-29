/**
 * Markdown 渲染(移植 ZCode 的管线形态):streamdown 流式 markdown 组件
 * + 官方插件族(@streamdown/cjk 中日韩排版、code shiki 双主题高亮、math
 * KaTeX 单美元公式、mermaid 图表),组件映射覆盖块级元素。
 *
 * 与 ZCode 的差异(刻意保留):
 * - desktop 的文件引用链接(fileRoot + onOpenFile)与 renderLocalImage
 *   通道是右栏文件预览的既有约定,原样保留;
 * - 表格走简化版 MarkdownTable(原生横向滚动,未移植自绘虚拟滚动条);
 * - 图片本地加载走 Tauri asset 协议(ZCode 走 fileService)。
 *
 * 单美元公式启发式与连续图片块归一化逐行移植自 ZCode message.tsx /
 * markdown-image.tsx,保证 `$5-$10`、`$HOME` 这类伪公式不被 KaTeX 吞掉。
 */
import { memo, type ReactNode } from "react";
import type { Components } from "streamdown";
import { cjk } from "@streamdown/cjk";
import { createCodePlugin } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import { Streamdown } from "streamdown";
import { useSettingsStore } from "../../stores/settingsStore.ts";
import { resolveFileReference } from "../../core/panelPaths.ts";
import { CodeBlock } from "./markdown/CodeBlock.tsx";
import {
  MarkdownImage,
  MarkdownImageParagraph,
  normalizeConsecutiveMarkdownImageBlocks,
} from "./markdown/MarkdownImage.tsx";
import { MarkdownTable } from "./markdown/MarkdownTable.tsx";

const codePlugin = createCodePlugin({
  themes: ["github-light", "github-dark"],
});
const mathPlugin = createMathPlugin({ singleDollarTextMath: true });
// mermaid 不进静态插件族:引擎经 MermaidBlock 动态加载(省首屏约 2MB),
// 块级 mermaid 由 pre → CodeBlock 拦截后自渲染
const streamdownPlugins = { cjk, code: codePlugin, math: mathPlugin };

// ------------------------------------------------- 单美元公式启发式(移植)

const markdownFencePattern = /^(?: {0,3})(`{3,}|~{3,})/;
const likelyMathSyntaxPattern = /[\\{}^_=+\-*/<>|()[\]∇∂∫∑√∞≈≠≤≥±×÷πΠα-ωΑ-Ω]/u;
const texCommandPattern = /\\[A-Za-z]+/;
const simpleMathIdentifierPattern =
  /^(?:[A-Za-z]|[a-z][A-Za-z0-9]{1,2}|\d+(?:\.\d+)?)$/;
const compactCurrencyRangePrefixPattern =
  /^(?:\d[\d,]*(?:\.\d+)?|\.\d+)[+\-*/]$/;
const compactCurrencyAmountStartPattern = /^(?:\d|\.\d)/;

function getMarkdownFence(line: string): { marker: string; length: number } | null {
  const match = markdownFencePattern.exec(line);
  if (match === null) {
    return null;
  }
  const sequence = match[1] ?? "";
  return { marker: sequence[0] ?? "", length: sequence.length };
}

function isEscapedMarkdownCharacter(text: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) {
    slashCount++;
  }
  return slashCount % 2 === 1;
}

function isSingleDollarDelimiter(text: string, index: number): boolean {
  return (
    text[index] === "$" &&
    text[index - 1] !== "$" &&
    text[index + 1] !== "$" &&
    !isEscapedMarkdownCharacter(text, index)
  );
}

function findClosingSingleDollarDelimiter(text: string, startIndex: number): number {
  for (let index = startIndex; index < text.length; index++) {
    if (isSingleDollarDelimiter(text, index)) {
      return index;
    }
  }
  return -1;
}

function isLikelySingleDollarMath(content: string): boolean {
  if (content === "" || content !== content.trim() || /[\r\n]/.test(content)) {
    return false;
  }
  if (texCommandPattern.test(content) || likelyMathSyntaxPattern.test(content)) {
    return true;
  }
  if (!/\s/.test(content) && simpleMathIdentifierPattern.test(content)) {
    return true;
  }
  return false;
}

function isLikelyCompactCurrencyRangeText(
  text: string,
  closingIndex: number,
  content: string,
): boolean {
  if (!compactCurrencyRangePrefixPattern.test(content)) {
    return false;
  }
  return compactCurrencyAmountStartPattern.test(text.slice(closingIndex + 1));
}

function normalizeSingleDollarMathInText(text: string): string {
  if (!text.includes("$")) {
    return text;
  }
  let output = "";
  for (let index = 0; index < text.length; index++) {
    if (!isSingleDollarDelimiter(text, index)) {
      output += text[index];
      continue;
    }
    const closingIndex = findClosingSingleDollarDelimiter(text, index + 1);
    if (closingIndex === -1) {
      output += text[index];
      continue;
    }
    const content = text.slice(index + 1, closingIndex);
    if (isLikelyCompactCurrencyRangeText(text, closingIndex, content)) {
      // `$5-$10` 这类紧凑价格区间的第二个 `$` 会被误当成公式闭合符
      output += "\\$";
      continue;
    }
    if (isLikelySingleDollarMath(content)) {
      output += text.slice(index, closingIndex + 1);
      index = closingIndex;
      continue;
    }
    // `$5 ... $10` / `$HOME ... $PATH` 这类普通文本只转义当前 `$`
    output += "\\$";
  }
  return output;
}

function normalizeSingleDollarMathOutsideInlineCode(line: string): string {
  let output = "";
  let cursor = 0;
  while (cursor < line.length) {
    const codeStart = line.indexOf("`", cursor);
    if (codeStart === -1) {
      output += normalizeSingleDollarMathInText(line.slice(cursor));
      break;
    }
    output += normalizeSingleDollarMathInText(line.slice(cursor, codeStart));
    let codeFenceEnd = codeStart + 1;
    while (line[codeFenceEnd] === "`") {
      codeFenceEnd++;
    }
    const codeMarker = line.slice(codeStart, codeFenceEnd);
    const codeEnd = line.indexOf(codeMarker, codeFenceEnd);
    if (codeEnd === -1) {
      output += normalizeSingleDollarMathInText(line.slice(codeStart));
      break;
    }
    output += line.slice(codeStart, codeEnd + codeMarker.length);
    cursor = codeEnd + codeMarker.length;
  }
  return output;
}

/** 围栏外的伪 `$...$` 转义,真 LaTeX 才放行给 KaTeX。 */
function normalizeMessageSingleDollarMath(markdown: string): string {
  if (!markdown.includes("$")) {
    return markdown;
  }
  let output = "";
  let cursor = 0;
  let activeFence: { marker: string; length: number } | null = null;
  while (cursor < markdown.length) {
    const newlineIndex = markdown.indexOf("\n", cursor);
    const lineEnd = newlineIndex === -1 ? markdown.length : newlineIndex;
    const line = markdown.slice(cursor, lineEnd);
    const newline = newlineIndex === -1 ? "" : "\n";
    const fence = getMarkdownFence(line);
    if (activeFence !== null) {
      output += line + newline;
      if (
        fence !== null &&
        fence.marker === activeFence.marker &&
        fence.length >= activeFence.length
      ) {
        activeFence = null;
      }
    } else {
      output += normalizeSingleDollarMathOutsideInlineCode(line) + newline;
      if (fence !== null) {
        activeFence = fence;
      }
    }
    cursor = lineEnd + newline.length;
  }
  return output;
}

// ------------------------------------------------------------ 组件映射

const languageClassNamePattern = /(?:^|\s)language-([^\s]+)/;

function inspectCodeChildren(children: ReactNode): {
  language: string;
  text: string;
} {
  let language = "";
  let text = "";
  const visit = (node: ReactNode): void => {
    if (typeof node === "string" || typeof node === "number") {
      text += String(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node as readonly ReactNode[]) {
        visit(child);
      }
      return;
    }
    if (
      typeof node === "object" &&
      node !== null &&
      "props" in node &&
      typeof (node as { props?: unknown }).props === "object" &&
      (node as { props?: object }).props !== null
    ) {
      const element = node as {
        props: { className?: unknown; children?: ReactNode };
      };
      const className = element.props.className;
      if (language === "" && typeof className === "string") {
        language = languageClassNamePattern.exec(className)?.[1] ?? "";
      }
      visit(element.props.children);
    }
  };
  visit(children);
  return { language, text };
}

function buildMarkdownComponents(options: {
  fileRoot?: string;
  fileBase?: string;
  onOpenFile?: (path: string, line?: number) => void;
  renderLocalImage?: (src: string, alt: string) => ReactNode;
  appTheme: "dark" | "warm";
}): Components {
  const { fileRoot, fileBase, onOpenFile, renderLocalImage, appTheme } = options;
  return {
    pre: ({ children }) => {
      const { language, text } = inspectCodeChildren(children);
      return (
        <CodeBlock code={text} language={language} appTheme={appTheme}>
          {children}
        </CodeBlock>
      );
    },
    code: ({ className, children }) => {
      const isBlock =
        typeof className === "string" &&
        /(?:^|\s)(language-|hljs|data-streamdown)/.test(className);
      if (isBlock) {
        return (
          <code className={`font-mono text-sm text-ink ${className ?? ""}`}>
            {children}
          </code>
        );
      }
      return (
        <code className="mx-0.5 rounded bg-raised px-1.5 py-0.5 font-mono text-xs text-ink-soft">
          {children}
        </code>
      );
    },
    p: MarkdownImageParagraph,
    img: ({ src, alt, ...props }) => {
      if (typeof src === "string" && fileRoot !== undefined) {
        const reference = resolveFileReference(fileRoot, src, fileBase);
        if (reference !== null && renderLocalImage !== undefined) {
          return <>{renderLocalImage(src, alt ?? "")}</>;
        }
      }
      return (
        <MarkdownImage
          src={typeof src === "string" ? src : undefined}
          alt={typeof alt === "string" ? alt : undefined}
          workspacePath={fileRoot}
          {...props}
        />
      );
    },
    a: ({ children, href }) => {
      if (fileRoot !== undefined && href !== undefined) {
        const reference = resolveFileReference(fileRoot, href, fileBase);
        if (reference !== null && onOpenFile !== undefined) {
          return (
            <button
              className="break-all text-accent-ink underline decoration-dotted underline-offset-4 hover:underline"
              title={reference.path}
              onClick={() => onOpenFile(reference.path, reference.line)}
            >
              {children}
            </button>
          );
        }
      }
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="break-all font-medium text-accent-ink no-underline decoration-dotted underline-offset-4 hover:underline"
        >
          {children}
        </a>
      );
    },
    h1: ({ children }) => (
      <h1 className="mb-4 mt-6 text-lg font-semibold text-ink">{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="mb-4 mt-6 text-base font-semibold text-ink">{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="mb-4 mt-6 text-sm font-semibold text-ink">{children}</h3>
    ),
    h4: ({ children }) => (
      <h4 className="mb-4 mt-6 text-sm font-semibold text-ink">{children}</h4>
    ),
    h5: ({ children }) => (
      <h5 className="mb-4 mt-6 text-sm font-medium text-ink">{children}</h5>
    ),
    h6: ({ children }) => (
      <h6 className="mb-4 mt-6 text-sm font-normal text-ink">{children}</h6>
    ),
    strong: ({ children }) => <strong className="font-medium">{children}</strong>,
    blockquote: ({ children }) => (
      <blockquote className="my-2 border-l-2 border-line-strong pl-3 text-ink-mute [&_p]:my-0">
        {children}
      </blockquote>
    ),
    ul: ({ children }) => (
      <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>
    ),
    li: ({ children }) => <li className="leading-6 [&_p]:my-0">{children}</li>,
    table: MarkdownTable,
    th: ({ children }) => (
      <th className="border-b border-line bg-surface px-2.5 py-1.5 text-left font-medium">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="border-b border-line px-2.5 py-1.5 align-top">{children}</td>
    ),
    hr: () => <hr className="my-4 border-line" />,
  } as Components;
}

function MarkdownViewBase({
  text,
  fileRoot,
  fileBase,
  onOpenFile,
  renderLocalImage,
}: {
  readonly text: string;
  readonly fileRoot?: string;
  readonly fileBase?: string;
  readonly onOpenFile?: (path: string, line?: number) => void;
  readonly renderLocalImage?: (src: string, alt: string) => ReactNode;
}) {
  const theme = useSettingsStore((state) => state.theme);
  const components = buildMarkdownComponents({
    fileRoot,
    fileBase,
    onOpenFile,
    renderLocalImage,
    appTheme: theme,
  });
  const normalized = normalizeConsecutiveMarkdownImageBlocks(
    normalizeMessageSingleDollarMath(text),
  );
  return (
    // break-words:超长不可断 token(Windows 路径 / URL)按字符折行,不撑出横向滚动
    <div className="text-sm break-words text-ink" data-markdown-theme={theme}>
      <Streamdown
        animated={false}
        components={components}
        mode="static"
        parseIncompleteMarkdown={false}
        plugins={streamdownPlugins}
        shikiTheme={["github-light", "github-dark"]}
      >
        {normalized}
      </Streamdown>
    </div>
  );
}

/**
 * memo(按 props 浅比较):内容和文件链接处理不变时跳过整棵 Markdown 重解析
 * ——streamdown 的 unified 管线是消息流里最贵的渲染路径,配合条目级引用
 * 稳定,历史消息在流式期间零重渲。
 */
export const MarkdownView = memo(MarkdownViewBase);
