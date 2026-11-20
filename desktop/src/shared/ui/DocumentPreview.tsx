/**
 * 技能详情与工作流规范共用的文档预览。正文隐藏完整的 YAML 文件头，原文保留原样。
 */
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { SegmentedControl } from "./controls/SegmentedControl.tsx";
import { FileIcon } from "./icons.tsx";
import { Disclosure } from "./Disclosure.tsx";
import { NavigationRow } from "./NavigationRow.tsx";

const MarkdownView = lazy(async () => ({
  default: (await import("./MarkdownView.tsx")).MarkdownView,
}));

/** 去掉文档开头带有完整边界的 YAML 文件头。 */
export function stripFrontMatter(text: string): string {
  return text.replace(
    /^\uFEFF?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/,
    "",
  );
}

export function DocumentPreview({
  name,
  text,
  rawOnly = false,
  emptyText = "暂无可预览的内容",
  emptyBody,
  presentation = "compact",
  isComplete = true,
}: {
  readonly name: string;
  readonly text: string;
  readonly rawOnly?: boolean;
  readonly emptyText?: string;
  readonly emptyBody?: ReactNode;
  readonly presentation?: "compact" | "workbench";
  readonly isComplete?: boolean;
}) {
  const [mode, setMode] = useState<"body" | "source">("body");
  const [headings, setHeadings] = useState<HTMLElement[]>([]);
  const [activeHeading, setActiveHeading] = useState<HTMLElement>();
  const bodyRef = useRef<HTMLDivElement>(null);
  const body = stripFrontMatter(text);
  const raw = rawOnly || mode === "source";
  const isWorkbench = presentation === "workbench";
  const lines = isWorkbench && text ? text.split("\n").length : 0;

  useEffect(() => {
    const root = bodyRef.current;
    if (!isWorkbench || raw || !root) return;
    const update = () => {
      const next = Array.from(
        root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6"),
      );
      setHeadings((previous) =>
        previous.length === next.length &&
        previous.every((heading, index) => heading === next[index])
          ? previous
          : next,
      );
    };
    const observer = new MutationObserver(update);
    observer.observe(root, { childList: true, subtree: true });
    const frame = requestAnimationFrame(update);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [body, isWorkbench, raw]);

  const hasOutline = isWorkbench && headings.length > 0 && !raw;
  const outlineRows =
    hasOutline &&
    headings.map((heading, index) => (
      <NavigationRow
        key={index}
        layout="tree"
        aria-current={
          heading === (activeHeading?.isConnected ? activeHeading : headings[0])
            ? "location"
            : undefined
        }
        className="text-ink-soft"
        data-hint={heading.textContent ?? undefined}
        onClick={() => {
          setActiveHeading(heading);
          heading.scrollIntoView({ block: "start" });
        }}
      >
        <span className="min-w-0 truncate">{heading.textContent}</span>
      </NavigationRow>
    ));

  return (
    <section
      className={
        isWorkbench
          ? "@container min-w-0"
          : "flex min-h-0 min-w-0 flex-1 flex-col"
      }
    >
      <div
        className={
          isWorkbench
            ? "flex flex-wrap items-center justify-between gap-2 border-y border-line py-3"
            : "flex shrink-0 items-center justify-between gap-2 border-b border-line px-5 py-2 sm:px-7"
        }
      >
        <h4 className="flex min-w-0 items-center gap-2 font-mono text-ui-caption text-ink-mute">
          <FileIcon className="ui-icon-14 shrink-0" />
          <span className="min-w-0 truncate" data-hint={name}>
            {name}
          </span>
          {isComplete && lines > 0 && (
            <span className="shrink-0">· {lines} 行</span>
          )}
        </h4>
        {!rawOnly && text && (
          <SegmentedControl
            groupLabel="文档显示方式"
            value={mode}
            options={[
              { value: "body", label: "正文" },
              { value: "source", label: "原文" },
            ]}
            onChange={setMode}
          />
        )}
      </div>
      <div
        key={mode}
        role="region"
        aria-label={name + (raw ? " 原文" : " 正文")}
        tabIndex={0}
        className={
          isWorkbench
            ? "min-w-0 py-5"
            : "min-h-0 flex-1 overflow-auto overscroll-contain px-5 py-5 sm:px-8"
        }
      >
        <div className={isWorkbench ? "min-w-0" : "mx-auto max-w-[800px]"}>
          {!text ? (
            <p className="text-ui-caption text-ink-mute">{emptyText}</p>
          ) : raw ? (
            isWorkbench ? (
              <div className="flex min-w-0 overflow-x-auto rounded-lg border border-line bg-base font-mono text-ui-sm leading-relaxed">
                <pre
                  aria-hidden="true"
                  className="shrink-0 select-none border-r border-line px-3 py-3 text-right text-ink-mute"
                >
                  {Array.from({ length: lines }, (_, index) => index + 1).join(
                    "\n",
                  )}
                </pre>
                <pre className="px-3 py-3">{text}</pre>
              </div>
            ) : (
              <pre className="whitespace-pre-wrap break-all font-mono text-ui-caption leading-relaxed">
                {text}
              </pre>
            )
          ) : body.trim() ? (
            <div
              className={
                hasOutline
                  ? "grid min-w-0 gap-4 @min-[680px]:grid-cols-[minmax(8rem,10rem)_minmax(0,1fr)]"
                  : undefined
              }
            >
              {hasOutline && (
                <>
                  <Disclosure
                    summary="文档目录"
                    className="@min-[680px]:hidden"
                  >
                    <nav aria-label="文档目录" className="space-y-1">
                      {outlineRows}
                    </nav>
                  </Disclosure>
                  <nav
                    aria-label="文档目录"
                    className="sticky top-4 hidden max-h-[45dvh] space-y-1 overflow-y-auto self-start @min-[680px]:block"
                  >
                    <p className="pb-1 text-ui-caption text-ink-mute">
                      文档目录
                    </p>
                    {outlineRows}
                  </nav>
                </>
              )}
              <div
                ref={bodyRef}
                className={isWorkbench ? "min-w-0 max-w-[72ch]" : undefined}
              >
                <Suspense fallback={<p role="status">正在加载预览…</p>}>
                  <MarkdownView text={body} />
                </Suspense>
              </div>
            </div>
          ) : (
            (emptyBody ?? (
              <p className="text-ui-caption text-ink-mute">{emptyText}</p>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
