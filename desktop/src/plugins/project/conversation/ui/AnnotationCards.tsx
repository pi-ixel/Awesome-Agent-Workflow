import { TextLink } from "../../../../shared/ui/TextLink.tsx";
import { ActionButton } from "../../../../shared/ui/controls.tsx";
import { settingsTextareaClass } from "../../../../shared/ui/SettingsPageParts.tsx";
import { IconButton } from "../../../../shared/ui/IconButton.tsx";
import { PencilIcon, TrashIcon } from "../../../../shared/ui/icons.tsx";
import { useContext, useState } from "react";
import { ConversationDocumentContext } from "./documentView.ts";
import { COMMENT_LIMIT } from "../../../documents/service.ts";
import type { DocumentAnnotation } from "../../../documents/types.ts";
import { diffRangeLabel } from "../../../../shared/annotations/diffSelection.ts";
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
  const [unavailable, setUnavailable] = useState<ReadonlySet<string>>(
    new Set(),
  );
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
          className="rounded-control border border-line bg-base p-2 text-ui-caption"
        >
          <div className="flex items-center gap-2">
            <TextLink
              type="button"
              data-hint={a.path}
              disabled={!openAnnotation}
              className="flex-1 truncate font-medium"
              onClick={() => {
                const result = openAnnotation?.(a, !!onRemove);
                if (result)
                  void result.then((opened) =>
                    setUnavailable((current) => {
                      const next = new Set(current);
                      if (opened) next.delete(a.id);
                      else next.add(a.id);
                      return next;
                    }),
                  );
              }}
            >
              {a.path.split(/[\\/]/).at(-1)}
              {a.diff
                ? ` · ${a.diff.kind === "turn" ? "轮次 Diff" : "Git Changes"} · ${diffRangeLabel(a.diff)}`
                : a.startLine
                  ? ` · ${a.startLine}${a.endLine !== a.startLine ? `–${a.endLine}` : ""} 行`
                  : ""}
            </TextLink>
            {onChange && (
              <IconButton iconSize="compact"
                type="button"
                aria-label={`编辑批注 ${a.path.split(/[\\/]/).at(-1)}`}
                data-hint="编辑评论"
                className="flex shrink-0 items-center justify-center rounded-control hover:bg-hover"
                onClick={() => {
                  setEditing(a.id);
                  setComment(a.comment);
                }}
              >
                <PencilIcon className="ui-icon-14" />
              </IconButton>
            )}
            {onRemove && (
              <IconButton iconSize="compact"
                type="button"
                aria-label={`删除批注 ${a.path.split(/[\\/]/).at(-1)}`}
                data-hint="删除评论"
                className="flex shrink-0 items-center justify-center rounded-control border border-danger-line bg-danger-bg text-danger-ink hover:brightness-95"
                onClick={() => onRemove(a.id)}
              >
                <TrashIcon className="ui-icon-14" />
              </IconButton>
            )}
          </div>
          {unavailable.has(a.id) && (
            <p role="status" className="mt-1 text-ink-mute">
              原差异版本不可用，以下是批注保存时的内容。
            </p>
          )}
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
                className={settingsTextareaClass}
              />
              <ActionButton
                tone="secondary"
                size="compact"
                type="button"
                onClick={() => {
                  if (onChange({ ...a, comment: comment.trim() }))
                    setEditing(null);
                }}
              >
                保存
              </ActionButton>
              <ActionButton
                tone="ghost"
                size="compact"
                type="button"
                onClick={() => setEditing(null)}
              >
                取消
              </ActionButton>
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
