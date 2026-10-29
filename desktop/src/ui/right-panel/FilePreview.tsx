import { useEffect, useMemo, useState } from "react";
import hljs from "highlight.js/lib/common";
import {
  insidePath,
  parentPath,
  pathName,
  resolveFileReference,
} from "../../core/panelPaths.ts";
import {
  panelError,
  panelService,
  type FilePreview as Preview,
} from "../../core/panelService.ts";
import { MarkdownView } from "../session/MarkdownView.tsx";
import { CopyButton } from "../session/CopyButton.tsx";

function LocalImage({
  root,
  base,
  src,
  alt,
}: {
  root: string;
  base: string;
  src: string;
  alt: string;
}) {
  const target = resolveFileReference(root, src, base);
  const path = target?.path;
  const [value, setValue] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let current = true;
    void panelService
      .preview(path)
      .then((result) => {
        if (current) {
          if (result.kind === "image")
            setValue(`data:${result.mime};base64,${result.content}`);
          else if (/\.svg$/i.test(path))
            setValue(
              `data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.content)}`,
            );
        }
      })
      .catch(() => {
        if (current) setValue(null);
      });
    return () => {
      current = false;
    };
  }, [path]);
  return value ? (
    <img src={value} alt={alt} className="max-w-full" />
  ) : (
    <span className="text-xs text-ink-faint">图片暂不可预览：{alt || src}</span>
  );
}
function PreviewBody({
  data,
  path,
  project,
  line,
  onOpen,
}: {
  data: Preview;
  path: string;
  project: string;
  line?: number;
  onOpen: (path: string, line?: number) => void;
}) {
  const [mode, setMode] = useState<"preview" | "code">(
    line ? "code" : "preview",
  );
  const [imageFailed, setImageFailed] = useState(false);
  const [visible, setVisible] = useState(
    Math.max(1000, Math.min(line ?? 0, 10000)),
  );
  const markdown = /\.(md|markdown)$/i.test(path);
  const svg = /\.svg$/i.test(path);
  const language = path.split(".").at(-1) ?? "text";
  const lines = useMemo(() => {
    // 超大/未知语言使用纯文本；避免高亮器在长单行上占满 UI。
    if (
      data.kind !== "text" ||
      data.content.length > 100_000 ||
      !hljs.getLanguage(language)
    )
      return null;
    try {
      return hljs
        .highlight(data.content, { language, ignoreIllegals: true })
        .value.split("\n");
    } catch {
      return null;
    }
  }, [data, language]);
  const rawLines = data.content.split("\n");
  useEffect(() => {
    if (line)
      document
        .getElementById(`panel-line-${line}`)
        ?.scrollIntoView?.({ block: "center" });
  }, [line, mode]);
  const base = parentPath(path);
  const root = insidePath(project, path) ? project : base;
  return (
    <>
      {(markdown || svg) && (
        <div className="flex gap-2 border-b border-line p-2 text-ui-base">
          <button
            aria-pressed={mode === "preview"}
            className="rounded border border-line px-2 py-1"
            onClick={() => setMode("preview")}
          >
            预览
          </button>
          <button
            aria-pressed={mode === "code"}
            className="rounded border border-line px-2 py-1"
            onClick={() => setMode("code")}
          >
            源码
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {imageFailed && (data.kind === "image" || mode === "preview") ? (
          <p role="alert" className="p-4 text-ui-base text-warn-ink">
            图片无法解码，请检查文件格式或内容
          </p>
        ) : data.kind === "image" ? (
          <div className="flex h-full items-center justify-center p-6">
            <img
              src={`data:${data.mime};base64,${data.content}`}
              alt={pathName(path)}
              onError={() => setImageFailed(true)}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        ) : svg && mode === "preview" ? (
          <img
            alt={pathName(path)}
            onError={() => setImageFailed(true)}
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(data.content)}`}
            className="h-full w-full object-contain p-6"
          />
        ) : markdown && mode === "preview" ? (
          <div className="p-4">
            <MarkdownView
              text={data.content}
              fileRoot={root}
              fileBase={base}
              onOpenFile={onOpen}
              renderLocalImage={(src, alt) => (
                <LocalImage
                  key={src}
                  root={root}
                  base={base}
                  src={src}
                  alt={alt}
                />
              )}
            />
          </div>
        ) : data.content.length === 0 ? (
          <p className="p-4 text-ui-base text-ink-faint">文件为空</p>
        ) : (
          <div
            className="w-max min-w-full font-mono text-xs leading-6"
            aria-label="文件源码"
          >
            {rawLines.slice(0, visible).map((text, index) => (
              <div
                id={`panel-line-${index + 1}`}
                key={index}
                className={`flex ${line === index + 1 ? "bg-info-bg" : ""}`}
              >
                <span className="sticky left-0 w-12 shrink-0 select-none border-r border-line bg-surface pr-2 text-right text-ink-faint">
                  {index + 1}
                </span>
                {lines?.[index] !== undefined ? (
                  <code
                    className="whitespace-pre px-3"
                    dangerouslySetInnerHTML={{ __html: lines[index] }}
                  />
                ) : (
                  <code className="whitespace-pre px-3">{text || " "}</code>
                )}
              </div>
            ))}
            {rawLines.length > visible && (
              <button
                className="p-3 text-accent-ink"
                onClick={() => setVisible((old) => old + 1000)}
              >
                继续显示（共 {rawLines.length} 行）
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
export function FilePreview({
  path,
  project,
  line,
  onOpen,
}: {
  path: string;
  project: string;
  line?: number;
  onOpen: (path: string, line?: number) => void;
}) {
  const [result, setResult] = useState<{ data?: Preview; error?: string }>({});
  useEffect(() => {
    let current = true;
    void panelService
      .preview(path)
      .then((data) => {
        if (current) setResult({ data });
      })
      .catch((error: unknown) => {
        if (current) setResult({ error: panelError(error) });
      });
    return () => {
      current = false;
    };
  }, [path]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-line p-2 text-ui-base">
        <span className="min-w-0 flex-1 truncate" title={path}>
          {path}
        </span>
        {!insidePath(project, path) && (
          <span className="text-warn-ink">项目外</span>
        )}
        <CopyButton getText={() => path} label="复制路径" />
      </div>
      {result.error ? (
        <p role="alert" className="break-words p-4 text-sm text-warn-ink">
          {result.error}
        </p>
      ) : result.data ? (
        <PreviewBody
          key={path}
          data={result.data}
          path={path}
          project={project}
          line={line}
          onOpen={onOpen}
        />
      ) : (
        <p className="p-4 text-ui-base text-ink-faint">正在读取文件…</p>
      )}
    </div>
  );
}
