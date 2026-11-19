/**
 * 文档预览（技能详情、工作流规范文件共用）：标题栏写文件名，Markdown 可在「正文」（渲染）
 * 与「原文」之间切换；正文去掉开头带完整边界的 YAML 文件头，原文始终是原样内容。
 */
import { lazy, Suspense, useState, type ReactNode } from "react";
import { SegmentedControl } from "./controls/SegmentedControl.tsx";
import { FileIcon } from "./icons.tsx";

const MarkdownView = lazy(async () => ({
  default: (await import("./MarkdownView.tsx")).MarkdownView,
}));

/** 去掉文档开头带有完整边界的 YAML 文件头。 */
export function stripFrontMatter(text: string): string {
  return text.replace(/^﻿?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/, "");
}

export function DocumentPreview({
  name,
  text,
  rawOnly = false,
  emptyText = "暂无可预览的内容",
  emptyBody,
}: {
  /** 标题栏上的文件名。 */
  readonly name: string;
  readonly text: string;
  /** 只给原文（不是 Markdown 的内容）。 */
  readonly rawOnly?: boolean;
  readonly emptyText?: string;
  /** 去掉文件头后正文为空时的提示。 */
  readonly emptyBody?: ReactNode;
}) {
  const [mode, setMode] = useState<"body" | "source">("body");
  const body = stripFrontMatter(text);
  const raw = rawOnly || mode === "source";
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-5 py-2 sm:px-7">
        <h4 className="flex items-center gap-2 font-mono text-xs text-ink-mute">
          <FileIcon className="ui-icon-14" />
          {name}
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
        className="min-h-0 flex-1 overflow-auto overscroll-contain px-5 py-5 sm:px-8"
      >
        <div className="mx-auto max-w-[800px]">
          {!text ? (
            <p className="text-xs text-ink-mute">{emptyText}</p>
          ) : raw ? (
            <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed">
              {text}
            </pre>
          ) : body.trim() ? (
            <Suspense fallback={<p role="status">正在加载预览…</p>}>
              <MarkdownView text={body} />
            </Suspense>
          ) : (
            emptyBody ?? <p className="text-xs text-ink-mute">{emptyText}</p>
          )}
        </div>
      </div>
    </section>
  );
}
