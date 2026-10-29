/**
 * 代码块 chrome(移植自 ZCode components/ai-elements/code-block.tsx 的
 * 头栏与动作按钮;高亮本体来自 streamdown 的 @streamdown/code 插件,
 * 这里只包壳:语言标签 + 换行切换 + 复制 + mermaid 分支与放大预览)。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { CopyButton } from "../CopyButton.tsx";
import { MermaidBlock } from "./MermaidBlock.tsx";
import { isMermaidLanguage, shouldRenderMermaidCodeBlock } from "./mermaidLanguage.ts";

/** 语言 → 示例文件名(ZCode 同款映射,让语言标签更像文件)。 */
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
  return (
    <button
      type="button"
      aria-label="切换换行"
      aria-pressed={wrapLongLines}
      title="切换自动换行"
      onClick={toggleWrapLongLines}
      className={`shrink-0 rounded p-1 text-ink-faint transition-colors hover:bg-raised hover:text-ink ${
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
function CodeBlockPreviewButton({ disabled, onClick }: {
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label="放大预览图表"
      title="放大预览(双击图表亦可)"
      disabled={disabled}
      onClick={onClick}
      className="shrink-0 rounded p-1 text-ink-faint transition-colors hover:bg-raised hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
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

/** 全屏图表预览:点击 / Esc 关闭,0.5x–2x 缩放循环。 */
function DiagramPreviewDialog({
  open,
  onClose,
  svg,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly svg: string | null;
}) {
  const [zoomIndex, setZoomIndex] = useState(1);
  useEffect(() => {
    if (!open) {
      setZoomIndex(1);
      return;
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);
  if (!open || svg === null) {
    return null;
  }
  const scales = [0.5, 1, 2];
  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/80 p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="图表预览"
    >
      <div
        className="max-h-full w-full overflow-auto rounded-xl bg-surface p-6"
        onClick={(event) => event.stopPropagation()}
      >
        <div
          className="mx-auto w-fit [&_svg]:h-auto"
          style={{ transform: `scale(${scales[zoomIndex]})`, transformOrigin: "center top" }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          className="rounded-md border border-white/30 px-3 py-1 text-xs text-white hover:bg-white/10"
          onClick={(event) => {
            event.stopPropagation();
            setZoomIndex((index) => (index + 1) % scales.length);
          }}
        >
          缩放 {scales[zoomIndex]}x(点击循环)
        </button>
        <button
          type="button"
          className="rounded-md border border-white/30 px-3 py-1 text-xs text-white hover:bg-white/10"
          onClick={onClose}
        >
          关闭(Esc)
        </button>
      </div>
    </div>
  );
}

export type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  /** 原始代码文本(复制 / mermaid 判定用)。 */
  readonly code: string;
  readonly language: string;
  /** 高亮后的 pre > code 子树(由 streamdown 的 code 插件产出)。 */
  readonly children?: ReactNode;
  readonly appTheme: "dark" | "warm";
};

export function CodeBlock({
  code,
  language,
  children,
  appTheme,
  ...props
}: CodeBlockProps) {
  const [isWrapped, setIsWrapped] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewSvg, setPreviewSvg] = useState<string | null>(null);
  const toggleWrapLongLines = useCallback(() => {
    setIsWrapped((current) => !current);
  }, []);
  const contextValue = useMemo(
    () => ({ code, toggleWrapLongLines, wrapLongLines: isWrapped }),
    [code, isWrapped],
  );
  const canRenderMermaid = shouldRenderMermaidCodeBlock(language, code);

  useEffect(() => {
    if (!canRenderMermaid) {
      setPreviewSvg(null);
      setPreviewOpen(false);
    }
  }, [canRenderMermaid]);

  return (
    <CodeBlockContext.Provider value={contextValue}>
      <div
        className="group relative my-3 w-full overflow-hidden rounded-lg border border-line bg-surface"
        data-language={language}
        style={{
          containIntrinsicSize: "auto 200px",
          contentVisibility: "auto",
        }}
        {...props}
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-3 py-1.5 text-xs text-ink-faint">
          <span className="min-w-0 truncate font-mono lowercase">
            {resolveCodeBlockDisplayFile(language)}
          </span>
          <div className="-my-1 -mr-1 flex items-center gap-1">
            {isMermaidLanguage(language) || canRenderMermaid ? (
              <CodeBlockPreviewButton
                disabled={!canRenderMermaid || previewSvg === null}
                onClick={() => setPreviewOpen(true)}
              />
            ) : (
              <CodeBlockWrapButton />
            )}
            <CopyButton getText={() => code} label="复制代码" />
          </div>
        </div>
        <div className="p-2 pb-3 pt-0">
          {canRenderMermaid ? (
            <MermaidBlock
              code={code}
              theme={appTheme}
              onOpenPreview={() => setPreviewOpen(true)}
              onPreviewSvgChange={setPreviewSvg}
            />
          ) : (
            <pre
              className={`p-2 text-sm leading-relaxed ${
                isWrapped ? "whitespace-pre-wrap break-words" : "overflow-x-auto whitespace-pre"
              }`}
            >
              {children}
            </pre>
          )}
        </div>
        <DiagramPreviewDialog
          open={previewOpen}
          onClose={() => setPreviewOpen(false)}
          svg={previewSvg}
        />
      </div>
    </CodeBlockContext.Provider>
  );
}
