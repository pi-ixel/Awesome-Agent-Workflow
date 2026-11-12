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
 *
 * 本地文件链接通道(对齐 ZCode):streamdown 默认的 rehype-harden 会在
 * 自定义 a 渲染器之前把 file:// 与裸文件名链接拦成「[blocked]」灰字。
 * 这里在 harden 之前先用前置 rehype 插件把本地文件目标规整成安全层放行
 * 的形态(盘符 → /D:/x、裸/相对路径 → ./x),harden/URL 归一之后再由
 * resolveLocalReference 对称还原交给 resolveFileReference 分流。
 */
import {
  cloneElement,
  Component,
  createContext,
  isValidElement,
  memo,
  useContext,
  useMemo,
  type ComponentProps,
  type ReactNode,
  type ContextType,
} from "react";
import type { Components } from "streamdown";
import {
  defaultRehypePlugins,
  defaultRemarkPlugins,
  Streamdown,
} from "streamdown";
import { cjk } from "@streamdown/cjk";
import { createMathPlugin } from "@streamdown/math";
import type { Pluggable, PluggableList, Plugin } from "unified";
import remarkCjkFriendlyGfmStrikethrough from "remark-cjk-friendly-gfm-strikethrough";
import type { Logger } from "../logging/logger.ts";
import { LoggerContext, useLogger } from "../logging/react.ts";
import { MarkdownTheme } from "./markdown/theme.ts";
import {
  resolveFileReference,
  type FileReference,
} from "../panelPaths.ts";
import { FileIcon } from "./icons.tsx";
import { CodeBlock } from "./markdown/CodeBlock.tsx";
import { deferredCodePlugin } from "./markdown/deferredCodePlugin.ts";
import {
  MarkdownImage,
  MarkdownImageParagraph,
  normalizeConsecutiveMarkdownImageBlocks,
} from "./markdown/MarkdownImage.tsx";
import { MarkdownTable } from "./markdown/MarkdownTable.tsx";


// 视口门控的 shiki 插件(会话首载只高亮首屏可见块,滚动到才补高亮)
const codePlugin = deferredCodePlugin;
const mathPlugin = createMathPlugin({ singleDollarTextMath: true });

// ------------------------------------------------- 单美元公式启发式(移植)

const markdownFencePattern = /^(?: {0,3})(`{3,}|~{3,})/;
const likelyMathSyntaxPattern = /[\\{}^_=+\-*/<>|()[\]∇∂∫∑√∞≈≠≤≥±×÷πΠα-ωΑ-Ω]/u;
const texCommandPattern = /\\[A-Za-z]+/;
const simpleMathIdentifierPattern =
  /^(?:[A-Za-z]|[a-z][A-Za-z0-9]{1,2}|\d+(?:\.\d+)?)$/;
const compactCurrencyRangePrefixPattern =
  /^(?:\d[\d,]*(?:\.\d+)?|\.\d+)[+\-*/]$/;
const compactCurrencyAmountStartPattern = /^(?:\d|\.\d)/;

function getMarkdownFence(
  line: string,
): { marker: string; length: number } | null {
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

function findClosingSingleDollarDelimiter(
  text: string,
  startIndex: number,
): number {
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
  if (
    texCommandPattern.test(content) ||
    likelyMathSyntaxPattern.test(content)
  ) {
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

// --------------------------------------------- 删除线 singleTilde(对齐 GFM)

/** remark 插件条目的具体形态(统一 plugin + options 的二元组)。 */
type RemarkPluginTuple = [attacher: Plugin, options: Record<string, unknown>];

/**
 * remark-gfm 与 streamdown CJK 删除线扩展都默认开启 singleTilde,后者还会
 * 覆盖前者的解析结果;两处必须同时关闭,才能让 `~text~` 按规范保留原文。
 * (移植 ZCode message.tsx disableSingleTilde)
 */
function disableSingleTilde(plugin: Pluggable): Pluggable {
  if (typeof plugin === "function") {
    const entry: RemarkPluginTuple = [plugin, { singleTilde: false }];
    return entry;
  }
  if (!Array.isArray(plugin)) {
    return plugin; // preset 等复合形态不动
  }
  const attacher = plugin[0];
  const existingOptions: unknown = plugin[1];
  const entry: RemarkPluginTuple = [
    attacher,
    {
      ...(typeof existingOptions === "object" && existingOptions !== null
        ? existingOptions
        : {}),
      singleTilde: false,
    },
  ];
  return entry;
}

// 显式传 remarkPlugins 会整体覆盖 streamdown 默认列表;codeMeta 等其余
// 默认插件原样保留,仅把 gfm 换成关闭 singleTilde 的版本。
const markdownRemarkPlugins: PluggableList = Object.entries(
  defaultRemarkPlugins,
).map(([name, plugin]) =>
  name === "gfm" ? disableSingleTilde(plugin) : plugin,
);

// CJK 删除线扩展(singleTilde 缺省 true)随 cjk 插件的 remarkPluginsAfter
// 注入,须重建 cjk 插件对象替换该条目。
const markdownCjkRemarkPluginsAfter = cjk.remarkPluginsAfter.map((plugin) => {
  const attacher = Array.isArray(plugin) ? plugin[0] : plugin;
  return attacher === remarkCjkFriendlyGfmStrikethrough
    ? disableSingleTilde(plugin)
    : plugin;
});

/** 关闭 CJK 删除线 singleTilde 后的 cjk 插件(remarkPlugins 字段同步重建)。 */
const markdownCjkPlugin: typeof cjk = {
  ...cjk,
  remarkPlugins: [...cjk.remarkPluginsBefore, ...markdownCjkRemarkPluginsAfter],
  remarkPluginsAfter: markdownCjkRemarkPluginsAfter,
};

// mermaid 不进静态插件族:引擎经 MermaidBlock 动态加载(省首屏约 2MB),
// 块级 mermaid 由 pre → CodeBlock 拦截后自渲染
const streamdownPlugins = {
  cjk: markdownCjkPlugin,
  code: codePlugin,
  math: mathPlugin,
};

// ------------------------------------------------- 本地文件链接前置改写

const fileUrlProtocolPattern = /^file:\/\//i;
const windowsDriveAbsolutePathPattern = /^[a-zA-Z]:[/\\]/;
const urlSchemePattern = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const markdownFileExtensionPattern = /\.[a-z0-9]+$/i;

/** hast 元素节点的最小结构面(rehype 插件内遍历用,不引入 hast 类型依赖)。 */
interface HastElementLike {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastElementLike[];
}

/** href 里的百分号编码(remark 会把 `\` 编成 %5C)先解码再判形态。 */
function decodeMarkdownHref(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

/** file:// URL → 本地路径形态(盘符去前导 /,保留 #L 片段);UNC 原样。 */
function parseFileUrlTargetPath(href: string): string | null {
  try {
    const url = new URL(href);
    return `${url.hostname && url.hostname !== "localhost" ? `//${url.hostname}` : ""}${url.pathname}${url.hash}`.replace(
      /^\/([a-z]:\/)/i,
      "$1",
    );
  } catch {
    return null;
  }
}

/**
 * 是否值得按本地文件链接改写:file:// / Windows 盘符绝对路径,或带分隔符、
 * 带扩展名的裸相对路径。锚点、外链 scheme(https:、mailto:)不动。
 */
function shouldRewriteMarkdownFileTarget(href: string): boolean {
  const path = decodeMarkdownHref(href);
  if (fileUrlProtocolPattern.test(path)) {
    return parseFileUrlTargetPath(path) !== null;
  }
  if (windowsDriveAbsolutePathPattern.test(path)) return true;
  if (
    path.startsWith("./") ||
    path.startsWith("/") ||
    path.startsWith("#") ||
    path.startsWith("../")
  ) {
    return false;
  }
  if (urlSchemePattern.test(path)) return false;
  return (
    path.includes("/") ||
    path.includes("\\") ||
    markdownFileExtensionPattern.test(path.split(/[/\\]/).at(-1) ?? "")
  );
}

/**
 * 规整成安全层放行的形态(经实测管线验证):
 * - file:///D:/x → /D:/x:harden 按普通 path 放行,且 URL 归一会保住盘符
 *   大小写;渲染层 resolveLocalReference 再对称剥掉前导 /。
 * - 裸文件名/相对路径 → ./x:parseUrl 对裸名返回 null 会被 harden 拦成
 *   [blocked],补 ./ 前缀走相对路径通道(harden 归一成 /x,渲染层还原)。
 * 行号后缀(:12 / #L5)随路径原样保留,由 resolveFileReference 解析。
 */
function rewriteMarkdownFileTarget(href: string): string {
  const decoded = decodeMarkdownHref(href);
  const path = fileUrlProtocolPattern.test(decoded)
    ? parseFileUrlTargetPath(decoded)
    : decoded;
  if (path === null || path.startsWith("//")) {
    return href; // file:// 解析失败或 UNC(file://host/share)不动
  }
  const normalized = path.replaceAll("\\", "/");
  if (windowsDriveAbsolutePathPattern.test(normalized)) {
    return `/${normalized}`;
  }
  return `./${normalized}`;
}

/** 在默认 raw/sanitize/harden 之前改写 a[href] 与 img[src] 的本地文件目标。 */
function rewriteLocalFileTargetsRehypePlugin() {
  return (tree: HastElementLike) => {
    const visitNode = (node: HastElementLike): void => {
      const targetProperty =
        node.tagName === "a" ? "href" : node.tagName === "img" ? "src" : null;
      if (
        node.type === "element" &&
        targetProperty !== null &&
        typeof node.properties?.[targetProperty] === "string" &&
        shouldRewriteMarkdownFileTarget(node.properties[targetProperty])
      ) {
        node.properties[targetProperty] = rewriteMarkdownFileTarget(
          node.properties[targetProperty],
        );
      }
      node.children?.forEach(visitNode);
    };
    visitNode(tree);
  };
}

// rehypePlugins 会整体替换 streamdown 默认管线(raw + sanitize + harden),
// 所以前置改写之后必须接回默认插件族;sanitize 的协议白名单按「第一个冒号
// 在第一个斜杠之后即相对路径」放行 /D:/x 与 ./x 形态。
const markdownRehypePlugins: PluggableList = [
  rewriteLocalFileTargetsRehypePlugin,
  ...Object.values(defaultRehypePlugins),
];

/**
 * harden/URL 归一后的 href 还原:盘符形态(/D:/x)剥前导 / 保住大小写;
 * 其余 /x 是 dummy-base 归一产物,还原成工程相对路径 ./x。还原结果同时
 * 交给下游二次解析方(renderLocalImage → resolveFileReference)。
 */
function resolveRenderHref(href: string): string {
  if (/^\/[a-z]:\//i.test(href)) {
    return href.slice(1);
  }
  if (href.startsWith("/") && !href.startsWith("//")) {
    return `./${href.slice(1)}`;
  }
  return href;
}

/** 经 harden 还原后的本地文件引用分流(resolveFileReference 失败即外链)。 */
function resolveLocalReference(
  root: string,
  href: string,
  base?: string,
): FileReference | null {
  return resolveFileReference(root, resolveRenderHref(href), base);
}

/** 外链仅放行 HTTP 和 HTTPS。 */
function isExternalWebHref(href: string): boolean {
  try {
    const protocol = new URL(href).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ 组件映射

/**
 * pre → CodeBlock 拦截链内渲染的 code 视作块级(streamdown 默认实现给子 code
 * 注入 data-block;AAW 的块级 code 一律经 pre 进 CodeBlock,用上下文等价判块,
 * 不再靠 className 猜——无语言围栏的 code 没有 language- 前缀,曾因此落进
 * inline 分支渲染成行内药丸)。
 */
const BlockCodeContext = createContext(false);

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

/**
 * 行内/块级 code 双态渲染:BlockCodeContext 为真(pre → CodeBlock 拦截链内)
 * 即块级,继承正文色;否则行内药丸。
 */
function MarkdownCode({
  className,
  children,
  node: _node,
  ...props
}: ComponentProps<"code"> & { node?: unknown }) {
  void _node;
  if (useContext(BlockCodeContext)) {
    return (
      <code className={`font-mono text-ui-base text-ink ${className ?? ""}`}>
        {children}
      </code>
    );
  }
  return (
    <code
      className={`mx-0.5 rounded-md bg-raised px-1.5 py-0.5 font-mono text-ui-sm ${className ?? ""}`}
      {...props}
    >
      {children}
    </code>
  );
}

/** 递归裁剪代码子树末尾的空行:只动最后一个字符串叶子,shiki span 树安全。 */
function trimTrailingNewlinesInCodeTree(node: ReactNode): ReactNode {
  if (typeof node === "string") {
    return node.replace(/\n+$/, "");
  }
  if (typeof node === "object" && node !== null && Symbol.iterator in node) {
    // 数组 / Iterable<ReactNode>(React 19 节点形态):只裁最末一个叶子
    const items = [...node];
    for (let index = items.length - 1; index >= 0; index--) {
      const original = items[index];
      const trimmed = trimTrailingNewlinesInCodeTree(original);
      if (trimmed !== original) {
        items[index] = trimmed;
        return items;
      }
      if (trimmed !== "") {
        break;
      }
    }
    return node;
  }
  if (isValidElement(node)) {
    const children = (node.props as { children?: ReactNode }).children;
    const trimmed = trimTrailingNewlinesInCodeTree(children);
    if (trimmed !== children) {
      return cloneElement(node, undefined, trimmed);
    }
  }
  return node;
}

function buildMarkdownComponents(options: {
  logger: Logger;
  fileRoot?: string;
  fileBase?: string;
  onOpenFile?: (path: string, line?: number) => void;
  onOpenExternal?: (url: string) => Promise<void>;
  assetUrl?: (path: string) => string | undefined;
  renderLocalImage?: (src: string, alt: string) => ReactNode;
  appTheme: "dark" | "warm";
  /** 消息级 streaming 透传 CodeBlock:流式期跳过 mermaid 分支。 */
  streaming: boolean;
}): Components {
  const {
    fileRoot,
    fileBase,
    onOpenFile,
    onOpenExternal,
    assetUrl,
    renderLocalImage,
    appTheme,
    streaming,
    logger,
  } = options;
  return {
    pre: ({ children }) => {
      const { language, text } = inspectCodeChildren(children);
      return (
        <CodeBlock
          code={text}
          language={language}
          appTheme={appTheme}
          streaming={streaming}
        >
          <BlockCodeContext.Provider value={true}>
            {trimTrailingNewlinesInCodeTree(children)}
          </BlockCodeContext.Provider>
        </CodeBlock>
      );
    },
    code: MarkdownCode,
    p: MarkdownImageParagraph,
    img: ({ src, alt, ...props }) => {
      if (typeof src === "string" && fileRoot !== undefined) {
        const reference = resolveLocalReference(fileRoot, src, fileBase);
        if (reference !== null && renderLocalImage !== undefined) {
          // 传还原后的 href,下游二次解析(renderLocalImage)不再见到 harden 伪影
          return <>{renderLocalImage(resolveRenderHref(src), alt ?? "")}</>;
        }
      }
      return (
        <MarkdownImage
          src={typeof src === "string" ? resolveRenderHref(src) : undefined}
          alt={typeof alt === "string" ? alt : undefined}
          workspacePath={fileRoot}
          assetUrl={assetUrl}
          {...props}
        />
      );
    },
    a: ({ children, href }) => {
      if (fileRoot !== undefined && typeof href === "string") {
        const reference = resolveLocalReference(fileRoot, href, fileBase);
        if (reference !== null && onOpenFile !== undefined) {
          return (
            <button
              type="button"
              className="inline-flex max-w-full cursor-pointer items-baseline gap-1 wrap-anywhere bg-transparent p-0 text-left align-baseline text-accent-ink no-underline decoration-dotted underline-offset-4 hover:underline"
              data-hint={reference.path}
              onClick={() => onOpenFile(reference.path, reference.line)}
            >
              <FileIcon className="h-4 w-4 shrink-0 self-center" />
              <span className="min-w-0 self-baseline">{children}</span>
            </button>
          );
        }
      }
      if (onOpenExternal && typeof href === "string" && isExternalWebHref(href)) {
        return (
          <button
            type="button"
            className="wrap-anywhere cursor-pointer bg-transparent p-0 text-left font-medium text-accent-ink no-underline decoration-dotted underline-offset-4 hover:underline"
            data-hint={href}
            onClick={() => {
              void onOpenExternal(href).catch((error: unknown) => {
                logger.warn("打开外链失败", { url: href, error });
              });
            }}
          >
            {children}
          </button>
        );
      }
      // 锚点/自定义 scheme/无法解析的目标:不可点 span(ZCode 同款降级)
      return (
        <span
          className="wrap-anywhere font-medium text-accent-ink no-underline"
          data-hint={typeof href === "string" ? href : undefined}
        >
          {children}
        </span>
      );
    },
    h1: ({ children }) => (
      <h1 className="mb-4 mt-6 text-ui-xl font-semibold text-ink">
        {children}
      </h1>
    ),
    h2: ({ children }) => (
      <h2 className="mb-4 mt-6 text-ui-lg font-semibold text-ink">
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 className="mb-4 mt-6 text-ui-base font-semibold text-ink">
        {children}
      </h3>
    ),
    h4: ({ children }) => (
      <h4 className="mb-4 mt-6 text-ui-base font-semibold text-ink">
        {children}
      </h4>
    ),
    h5: ({ children }) => (
      <h5 className="mb-4 mt-6 text-ui-base font-medium text-ink">
        {children}
      </h5>
    ),
    h6: ({ children }) => (
      <h6 className="mb-4 mt-6 text-ui-base font-normal text-ink">
        {children}
      </h6>
    ),
    strong: ({ children }) => (
      <strong className="font-medium">{children}</strong>
    ),
    blockquote: ({ children }) => (
      <blockquote className="my-4 border-l-2 border-border pl-3 text-ink-mute [&_p]:my-0 [&_p+p]:mt-2">
        {children}
      </blockquote>
    ),
    ul: ({ children }) => (
      <ul className="my-3 list-disc space-y-1.5 pl-5 marker:text-ink-faint [&_ol]:my-1.5 [&_ul]:my-1.5">
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol className="my-3 list-inside list-decimal space-y-1.5 pl-0 marker:text-ink-faint [&_ol]:my-1.5 [&_ul]:my-1.5">
        {children}
      </ol>
    ),
    li: ({ children }) => (
      <li className="pl-1 [&>p]:my-0 [&>p]:inline">{children}</li>
    ),
    table: MarkdownTable,
    th: ({
      children,
      node: _node,
      ...props
    }: ComponentProps<"th"> & { node?: unknown }) => {
      void _node;
      return (
        <th
          className="min-w-16 max-w-md whitespace-normal break-words border-b border-line px-2.5 py-1.5 text-left font-normal text-ink-faint"
          {...props}
        >
          {children}
        </th>
      );
    },
    td: ({
      children,
      node: _node,
      ...props
    }: ComponentProps<"td"> & { node?: unknown }) => {
      void _node;
      return (
        <td
          className="min-w-16 max-w-md whitespace-normal break-words border-b border-line px-2.5 py-1.5 align-top"
          {...props}
        >
          {children}
        </td>
      );
    },
    tr: ({
      children,
      node: _node,
      ...props
    }: ComponentProps<"tr"> & { node?: unknown }) => {
      void _node;
      return (
        <tr
          className="transition-colors last:[&>td]:border-b-0 hover:bg-hover/20"
          {...props}
        >
          {children}
        </tr>
      );
    },
  };
}

// ------------------------------------------------- 消息级渲染错误边界

type MarkdownRenderBoundaryProps = {
  readonly children: ReactNode;
  /** 出错时降级展示的 markdown 原文。 */
  readonly fallbackText: string;
  /** 内容变化时重置错误态(流式期间逐 chunk 自愈重试)。 */
  readonly resetKey: string;
};

type MarkdownRenderBoundaryState = {
  readonly error: string | null;
};

/**
 * 单条消息的 markdown 渲染异常在此降级为纯文本,不再冒泡到面板级边界
 * 打挂整个时间线(对齐 ZCode MessageResponseMarkdownBoundary)。
 */
class MarkdownRenderBoundary extends Component<
  MarkdownRenderBoundaryProps,
  MarkdownRenderBoundaryState
> {
  override state: MarkdownRenderBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): MarkdownRenderBoundaryState {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  static override contextType = LoggerContext;
  declare context: ContextType<typeof LoggerContext>;

  override componentDidCatch(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.context("markdown").warn("markdown 渲染失败，已降级为纯文本", {
      errorMessage: message,
      markdownLength: this.props.fallbackText.length,
    });
  }

  override componentDidUpdate(
    previousProps: MarkdownRenderBoundaryProps,
  ): void {
    if (
      this.state.error !== null &&
      previousProps.resetKey !== this.props.resetKey
    ) {
      this.setState({ error: null });
    }
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="break-words whitespace-pre-wrap">
          {this.props.fallbackText}
        </div>
      );
    }
    return this.props.children;
  }
}

function MarkdownViewBase({
  text,
  fileRoot,
  fileBase,
  onOpenFile,
  onOpenExternal,
  assetUrl,
  renderLocalImage,
  streaming = false,
}: {
  readonly text: string;
  readonly fileRoot?: string;
  readonly fileBase?: string;
  readonly onOpenFile?: (path: string, line?: number) => void;
  readonly onOpenExternal?: (url: string) => Promise<void>;
  readonly assetUrl?: (path: string) => string | undefined;
  readonly renderLocalImage?: (src: string, alt: string) => ReactNode;
  /** 流式输出中:streaming 解析模式 + remend 补全未闭合 markdown。 */
  readonly streaming?: boolean;
}) {
  const theme = useContext(MarkdownTheme);
  const logger = useLogger("markdown");
  // 保持组件类型稳定，正文或外层布局更新不能把已加载图片重新挂载。
  const components = useMemo(
    () =>
      buildMarkdownComponents({
        fileRoot,
        fileBase,
        onOpenFile,
        onOpenExternal,
        assetUrl,
        renderLocalImage,
        appTheme: theme,
        logger,
        streaming,
      }),
    [fileRoot, fileBase, onOpenFile, onOpenExternal, assetUrl, renderLocalImage, theme, streaming, logger],
  );
  const normalized = normalizeConsecutiveMarkdownImageBlocks(
    normalizeMessageSingleDollarMath(text),
  );
  return (
    // break-words:超长不可断 token(Windows 路径 / URL)按字符折行,不撑出横向滚动
    <div
      className="text-ui-base leading-[1.75] tracking-wide break-words text-ink"
      data-markdown-theme={theme}
    >
      <MarkdownRenderBoundary fallbackText={normalized} resetKey={normalized}>
        <Streamdown
          animated={false}
          components={components}
          // 只有真实流式输出进 streaming 解析(remend 补全未闭合的粗体/
          // 围栏/链接),完成态收敛 static,避免 React #185(ZCode 同款收敛)。
          mode={streaming ? "streaming" : "static"}
          parseIncompleteMarkdown={streaming}
          plugins={streamdownPlugins}
          rehypePlugins={markdownRehypePlugins}
          remarkPlugins={markdownRemarkPlugins}
          shikiTheme={["github-light", "github-dark"]}
        >
          {normalized}
        </Streamdown>
      </MarkdownRenderBoundary>
    </div>
  );
}

/**
 * memo(按 props 浅比较):内容和文件链接处理不变时跳过整棵 Markdown 重解析
 * ——streamdown 的 unified 管线是消息流里最贵的渲染路径,配合条目级引用
 * 稳定,历史消息在流式期间零重渲。
 */
export const MarkdownView = memo(MarkdownViewBase);
