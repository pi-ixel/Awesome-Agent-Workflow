import { PencilIcon } from "../../../../shared/ui/icons.tsx";
import { useContext, useState } from "react";
import { ConversationDocumentContext } from "./documentView.ts";
import { COMMENT_LIMIT } from "../../../documents/config.ts";
import type { DocumentAnnotation } from "../../../documents/types.ts";
export function AnnotationCards({
  annotations,
  onChange,
  onRemove,
}: {
  annotations: readonly DocumentAnnotation[];
  onChange?: (annotation: DocumentAnnotation) => boolean;
  onRemove?: (id: string) => void;
}) {
  const openAnnotation = useContext(ConversationDocumentContext)?.openAnnotation;
  const [editing, setEditing] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  if (!annotations.length) return null;
  return (
    <div
      aria-label="文档批注"
      className="flex max-h-64 flex-col gap-2 overflow-auto p-3"
      data-file-find-ignore
    >
      {annotations.map((a) => (
        <div
          key={a.id}
          className="rounded-lg border border-line bg-base p-2 text-ui-caption"
        >
          <div className="flex items-center gap-2">
            <button
              type="button"
              title={a.path}
              disabled={!openAnnotation}
              className="min-w-0 flex-1 truncate text-left font-medium text-ink hover:underline"
              onClick={() => openAnnotation?.(a, !!onRemove)}
            >
              {a.path.split(/[\\/]/).at(-1)}
              {a.startLine
                ? ` · ${a.startLine}${a.endLine !== a.startLine ? `–${a.endLine}` : ""} 行`
                : ""}
            </button>
            {onChange && (
              <button
                type="button"
                aria-label={`编辑批注 ${a.path.split(/[\\/]/).at(-1)}`}
                title="编辑评论"
                className="flex size-7 shrink-0 items-center justify-center rounded hover:bg-hover"
                onClick={() => {
                  setEditing(a.id);
                  setComment(a.comment);
                }}
              >
                <PencilIcon className="size-3.5" />
              </button>
            )}
            {onRemove && (
              <button
                type="button"
                aria-label={`删除批注 ${a.path.split(/[\\/]/).at(-1)}`}
                title="删除评论"
                className="flex size-7 shrink-0 items-center justify-center rounded border border-danger-line bg-danger-bg text-danger-ink hover:brightness-95"
                onClick={() => onRemove(a.id)}
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 16 16"
                  className="size-3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.6 9.5h6.8L12 4M6.5 6.5v4.5M9.5 6.5v4.5" />
                </svg>
              </button>
            )}
          </div>
          <blockquote className="mt-1 max-h-20 overflow-auto whitespace-pre-wrap border-l-2 border-info-line pl-2 leading-[1.35] text-ink-mute">
            {a.quote.split(/\r?\n/).map((line, i) => (
              <span
                key={i}
                className={line.trim() ? "block min-h-[1.35em]" : "block h-1"}
              >
                {line || "\u00a0"}
              </span>
            ))}
          </blockquote>
          {editing === a.id && onChange ? (
            <div
              className="mt-2"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setEditing(null);
                }
              }}
            >
              <textarea
                autoFocus
                aria-label="修改批注意见"
                maxLength={COMMENT_LIMIT}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                className="w-full rounded border border-line bg-surface p-2"
              />
              <button
                type="button"
                className="rounded px-2 py-1 hover:bg-hover"
                onClick={() => {
                  if (onChange({ ...a, comment: comment.trim() }))
                    setEditing(null);
                }}
              >
                保存
              </button>
              <button
                type="button"
                className="rounded px-2 py-1 hover:bg-hover"
                onClick={() => setEditing(null)}
              >
                取消
              </button>
            </div>
          ) : (
            a.comment && (
              <p className="mt-2 whitespace-pre-wrap text-ink">{a.comment}</p>
            )
          )}
        </div>
      ))}
    </div>
  );
}
