/**
 * 代码块 chrome(移植自 ZCode components/ai-elements/code-block.tsx 的
 * 头栏与动作按钮;高亮本体来自 streamdown 的 @streamdown/code 插件,
 * 这里只包壳:语言图标 + 语言标签 + 换行切换 + 复制 + mermaid 分支与放大预览)。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { CopyButton } from "../CopyButton.tsx";
import { useHintTooltip } from "../../controls/HintTooltip.tsx";
import { createLogger } from "../../../core/logger.ts";
import { FileDisplayIcon } from "../../right-panel/file-tree/fileDisplay.tsx";
import { resolveIconName } from "../../right-panel/file-tree/fileDisplayHelpers.ts";
import { DiagramPreviewDialog } from "./DiagramPreviewDialog.tsx";
import { MermaidBlock } from "./MermaidBlock.tsx";
import {
  codeHashOf,
  isCodeVisible,
  markCodeVisibleAndFlush,
} from "./deferredCodePlugin.ts";
import {
  getCurrentMermaidDocumentVisibility,
  isMermaidLanguage,
  resolveMermaidAutoRenderDecision,
  shouldRenderMermaidCodeBlock,
} from "./mermaidLanguage.ts";

const logger = createLogger("ui");

/** 语言 → 示例文件名(ZCode 同款映射,用作头栏标签并解析文件图标)。 */
const LANGUAGE_DISPLAY_FILE_BY_LANGUAGE: Record<string, string> = {
  bash: "script.sh",
  cjs: "index.cjs",
  css: "style.css",
  go: "main.go",
  html: "index.html",
  javascript: "index.js",
  js: "index.js",
  jsx: "component.jsx",
  json: "data.json",
  markdown: "README.md",
  md: "README.md",
  mermaid: "diagram.mmd",
  mmd: "diagram.mmd",
  mjs: "index.mjs",
  python: "main.py",
  py: "main.py",
  rs: "main.rs",
  rust: "main.rs",
  sh: "script.sh",
  shell: "script.sh",
  toml: "config.toml",
  ts: "index.ts",
  tsx: "component.tsx",
  typescript: "index.ts",
  yaml: "config.yaml",
  yml: "config.yml",
  zsh: "script.zsh",
};

export function resolveCodeBlockDisplayFile(language: string): string {
  const normalized = language.trim().toLowerCase();
  return (
    LANGUAGE_DISPLAY_FILE_BY_LANGUAGE[normalized] ??
    `code.${normalized === "" ? "txt" : normalized}`
  );
}

interface CodeBlockContextType {
  code: string;
  toggleWrapLongLines: () => void;
  wrapLongLines: boolean;
}

const CodeBlockContext = createContext<CodeBlockContextType>({
  code: "",
  toggleWrapLongLines: () => {},
  wrapLongLines: false,
});

/**
 * 页面可见性修订号(移植 ZCode useDocumentVisibilityRevision):mermaid
 * 候选块在 visibilitychange 时重算渲染预算——后台标签页攒下的块回前台后
 * 有机会补渲染。仅 mermaid 候选注册监听,普通代码块不批量挂监听。
 */
function useDocumentVisibilityRevision(enabled: boolean): number {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    if (
      typeof document === "undefined" ||
      typeof document.addEventListener !== "function"
    ) {
      return;
    }

    const handleVisibilityChange = () => {
      setRevision((current) => current + 1);
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [enabled]);

  return revision;
}

function CodeBlockIcon({ children }: { readonly children: ReactNode }) {
  return (
    <span
      aria-hidden={true}
      className="inline-flex size-3.5 items-center justify-center [&_svg]:h-3.5 [&_svg]:w-3.5"
    >
      {children}
    </span>
  );
}

/** 换行切换钮(无 lucide 依赖:内联 WrapText 语义图形)。 */
function CodeBlockWrapButton() {
  const { toggleWrapLongLines, wrapLongLines } = useContext(CodeBlockContext);
  const hint = useHintTooltip("自动换行");
  return (
    <button
      type="button"
      aria-label="自动换行"
      aria-pressed={wrapLongLines}
      onClick={toggleWrapLongLines}
      {...hint}
      className={`flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-raised hover:text-ink ${
        wrapLongLines ? "bg-raised text-ink" : ""
      }`}
    >
      <CodeBlockIcon>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 6h18" />
          <path d="M3 12h13a3 3 0 1 1 0 6h-4" />
          <path d="m14 16-2 2 2 2" />
          <path d="M3 18h4" />
        </svg>
      </CodeBlockIcon>
    </button>
  );
}

/** mermaid 放大预览钮(渲染完成后可用)。 */
function CodeBlockPreviewButton({
  disabled,
  onClick,
}: {
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  const hint = useHintTooltip("放大查看(双击图表亦可)");
  return (
    <button
      type="button"
      aria-label="放大预览图表"
      disabled={disabled}
      {...hint}
      onClick={onClick}
      className="flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-raised hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
    >
      <CodeBlockIcon>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M15 3h6v6" />
          <path d="M9 21H3v-6" />
          <path d="M21 3l-7 7" />
          <path d="M3 21l7-7" />
        </svg>
      </CodeBlockIcon>
    </button>
  );
}

export type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  /** 原始代码文本(复制 / mermaid 判定用)。 */
  readonly code: string;
  readonly language: string;
  /** 高亮后的 pre > code 子树(由 streamdown 的 code 插件产出)。 */
  readonly children?: ReactNode;
  readonly appTheme: "dark" | "warm";
  /**
   * 消息是否仍在流式输出(由 MarkdownView 的 pre 映射从消息级 streaming
   * 透传;缺省 false 兼容静态渲染)。流式期按 ZCode 跳过 mermaid 分支、
   * 只显示纯代码,完成后一次性入队渲染——避免逐 chunk 重挂 MermaidBlock
   * 反复占用全局串行渲染队列。
   */
  readonly streaming?: boolean;
};

export function CodeBlock({
  code,
  language,
  children,
  appTheme,
  streaming = false,
  ...props
}: CodeBlockProps) {
  const [isWrapped, setIsWrapped] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewSvg, setPreviewSvg] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // 最新代码哈希（流式期逐 chunk 变化）；IO 回调经此取当前块
  const hashRef = useRef<string>("");
  useLayoutEffect(() => {
    hashRef.current = codeHashOf(code);
  }, [code]);
  const closePreview = useCallback(() => setPreviewOpen(false), []);
  const toggleWrapLongLines = useCallback(() => {
    setIsWrapped((current) => !current);
  }, []);
  const contextValue = useMemo(
    () => ({ code, toggleWrapLongLines, wrapLongLines: isWrapped }),
    [code, isWrapped, toggleWrapLongLines],
  );
  const canRenderMermaidCode = shouldRenderMermaidCodeBlock(language, code);
  const documentVisibilityRevision =
    useDocumentVisibilityRevision(canRenderMermaidCode);
  // 渲染预算门禁(移植 ZCode):可见性 + 源码规模 + 复杂度评分,
  // 超限退纯文本——防巨型图在 native 层构造大 SVG 造成 OOM。
  const mermaidAutoRenderDecision = useMemo(() => {
    if (!canRenderMermaidCode) {
      return null;
    }

    return resolveMermaidAutoRenderDecision(code, {
      documentVisibilityState: getCurrentMermaidDocumentVisibility(),
    });
    // documentVisibilityRevision 不被读、只做重算触发器：visibilitychange
    // 后用当前页面可见性重评预算（ZCode 同款机制）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canRenderMermaidCode, code, documentVisibilityRevision]);
  const canRenderMermaid =
    canRenderMermaidCode && mermaidAutoRenderDecision?.shouldRender === true;
  // 流式期跳过 mermaid 分支(见 streaming prop 注释)
  const showMermaid = canRenderMermaid && !streaming;

  useEffect(() => {
    if (!mermaidAutoRenderDecision || mermaidAutoRenderDecision.shouldRender) {
      return;
    }

    logger.debug("[CodeBlock] Mermaid 自动渲染跳过", {
      reason: mermaidAutoRenderDecision.reason,
      ...mermaidAutoRenderDecision.metrics,
    });
  }, [mermaidAutoRenderDecision]);

  const [previousShowMermaid, setPreviousShowMermaid] = useState(showMermaid);
  if (previousShowMermaid !== showMermaid) {
    setPreviousShowMermaid(showMermaid);
    if (!showMermaid) {
      setPreviewSvg(null);
      setPreviewOpen(false);
    }
  }

  // 首帧同步量位（useLayoutEffect 在绘制前跑）：本块在首屏视口内（±200px
  // 预高亮带）就立即标记可见并冲刷排队高亮——微任务在绘制前完成，首屏块
  // 不会出现素色闪烁。视口外块走下方 IO。mermaid 分支接管时不排高亮
  // （图渲染成功后 code 子树不可见；流式期/超预算退回的代码块照常高亮）。
  useLayoutEffect(() => {
    if (showMermaid) return;
    const hash = hashRef.current;
    if (isCodeVisible(hash)) return;
    const node = containerRef.current;
    if (node === null) return;
    const rect = node.getBoundingClientRect();
    if (rect.top < window.innerHeight + 200 && rect.bottom > -200) {
      markCodeVisibleAndFlush(hash);
    }
  });

  // 视口外块：进入视口（±200px 预高亮带）后冲刷高亮。观察的是节点而非
  // 代码内容，流式换哈希不重建观察器。
  useEffect(() => {
    if (showMermaid) return;
    const node = containerRef.current;
    if (node === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        const hash = hashRef.current;
        if (!isCodeVisible(hash)) {
          markCodeVisibleAndFlush(hash);
        }
      },
      { rootMargin: "200px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [showMermaid]);

  // 头栏标签 = 原始语言 token（ZCode languageLabel 语义，空语言兜底
  // "text"）；语言映射的示例文件名只用于解析头栏文件图标。
  const displayFile = resolveCodeBlockDisplayFile(language.trim());
  const fileIconName = resolveIconName(displayFile);
  const languageLabel = language.trim() === "" ? "text" : language.trim();

  return (
    <CodeBlockContext.Provider value={contextValue}>
      <div
        ref={containerRef}
        className="group relative my-4 w-full overflow-hidden rounded-xl border border-line bg-surface"
        data-language={language}
        style={{
          containIntrinsicSize: "auto 200px",
          contentVisibility: "auto",
        }}
        {...props}
      >
        <div className="flex items-center justify-between gap-3 px-3 py-2 text-ui-base text-ink-mute">
          <span className="flex min-w-0 items-center gap-2">
            <FileDisplayIcon
              name={fileIconName}
              size={16}
              className="shrink-0"
            />
            <span className="min-w-0 truncate font-mono lowercase">
              {languageLabel}
            </span>
          </span>
          <div className="-my-1 -mr-1 flex items-center gap-1">
            {/* 有意偏离 ZCode：启发式命中的无标注块也显示放大钮（ZCode 只看
                isMermaidLanguage，启发式块给出的是对图主体无效的换行钮）。 */}
            {isMermaidLanguage(language) || canRenderMermaid ? (
              <CodeBlockPreviewButton
                disabled={!canRenderMermaid || previewSvg === null}
                onClick={() => setPreviewOpen(true)}
              />
            ) : (
              <CodeBlockWrapButton />
            )}
            <CopyButton
              getText={() => code}
              label="复制代码"
              iconOnly
              size="md"
            />
          </div>
        </div>
        <div className="p-2 pb-3 pt-0">
          {showMermaid ? (
            <MermaidBlock
              key={`${appTheme}:${code}`}
              code={code}
              theme={appTheme}
              onOpenPreview={() => setPreviewOpen(true)}
              onPreviewSvgChange={setPreviewSvg}
            />
          ) : (
            <pre
              className={`p-2 text-ui-sm leading-relaxed [&_code]:text-ui-sm ${
                isWrapped
                  ? "whitespace-pre-wrap break-words"
                  : "overflow-x-auto whitespace-pre"
              }`}
            >
              {children}
            </pre>
          )}
        </div>
        {previewSvg !== null && (
          <DiagramPreviewDialog
            key={String(previewOpen)}
            open={previewOpen}
            onClose={closePreview}
            svg={previewSvg}
          />
        )}
      </div>
    </CodeBlockContext.Provider>
  );
}
