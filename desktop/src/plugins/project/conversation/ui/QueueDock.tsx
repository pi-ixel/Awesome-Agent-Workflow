import { useRef, useState } from "react";
import { useSessionValue } from "../../ui/bindings/conversationView.ts";
import { useProjectComposer } from "../../ui/bindings/composerView.ts";
import { useSessionCommands } from "./useSessionCommands.ts";
import { queuedText, queuedAttachments } from "../queuedPrompt.ts";
import {
  GripVerticalIcon,
  PencilIcon,
} from "../../../../shared/ui/icons.tsx";

export function QueueDock(): React.JSX.Element | null {
  const composer = useProjectComposer();
  const queued = useSessionValue((state) => state.queuedPrompts);
  const paused = useSessionValue((state) => state.queuePaused);
  const saveError = useSessionValue((state) => state.queueSaveError);
  const {
    resumeQueue,
    clearQueue,
    removeQueuedPromptById,
    moveQueuedPrompt,
    retryQueueSave,
  } = useSessionCommands();
  const dragId = useRef<string | null>(null);
  const [notice, setNotice] = useState("");
  const idOf = (item: (typeof queued)[number]) =>
    typeof item === "string" ? undefined : item.id;

  if (queued.length === 0 && !saveError) return null;
  return (
    <section
      aria-label="排队消息"
      data-queue-dock=""
      className="border-b border-line bg-raised/50"
    >
      {saveError && (
        <div role="alert" className="px-3 py-1 text-xs text-warn-ink">
          {saveError}{" "}
          <button type="button" onClick={retryQueueSave}>
            重试保存
          </button>
        </div>
      )}
      {paused && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-warn-ink">
          <span>队列已暂停</span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={resumeQueue}
            className="rounded px-2 py-1 hover:bg-surface"
          >
            继续队列
          </button>
          <button
            type="button"
            onClick={clearQueue}
            className="rounded px-2 py-1 hover:bg-surface"
          >
            清空
          </button>
        </div>
      )}
      {notice && (
        <div role="status" className="px-3 py-1 text-xs text-warn-ink">
          {notice}
        </div>
      )}
      <ol className="max-h-36 list-none overflow-y-auto">
        {queued.map((item, index) => {
          const id = idOf(item);
          const content = queuedText(item);
          const count = queuedAttachments(item).length;
          return (
            <li
              key={id ?? index}
              className="flex min-h-10 items-center gap-2 border-b border-line/60 px-3 last:border-b-0"
              onDragOver={(event) => {
                if (dragId.current && id && dragId.current !== id) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }
              }}
              onDrop={(event) => {
                if (!dragId.current || !id) return;
                event.preventDefault();
                const bounds = event.currentTarget.getBoundingClientRect();
                if (
                  moveQueuedPrompt(
                    dragId.current,
                    id,
                    event.clientY > bounds.top + bounds.height / 2
                      ? "after"
                      : "before",
                  )
                )
                  setNotice("队列顺序已调整");
                dragId.current = null;
              }}
            >
              <button
                type="button"
                draggable={!!id}
                aria-label={`调整第 ${index + 1} 条排队消息顺序`}
                title="拖动或使用上下方向键调整顺序"
                className="shrink-0 cursor-grab rounded p-1 text-ink-faint hover:bg-surface focus-visible:outline focus-visible:outline-2"
                onDragStart={(event) => {
                  if (!id) {
                    event.preventDefault();
                    return;
                  }
                  dragId.current = id;
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", id);
                }}
                onDragEnd={() => {
                  dragId.current = null;
                }}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowUp" && event.key !== "ArrowDown")
                    return;
                  event.preventDefault();
                  const next = event.key === "ArrowUp" ? index - 1 : index + 1;
                  const target = queued[next];
                  const targetId = target && idOf(target);
                  if (
                    id &&
                    targetId &&
                    moveQueuedPrompt(
                      id,
                      targetId,
                      next < index ? "before" : "after",
                    )
                  )
                    setNotice(`已移动至第 ${next + 1} 条`);
                }}
              >
                <GripVerticalIcon className="h-4 w-4" />
              </button>
              <span
                className="min-w-0 flex-1 truncate text-sm text-ink"
                title={content}
              >
                {content || "图片"}
                {count ? ` · ${count} 张图片` : ""}
              </span>
              <button
                type="button"
                aria-label={`编辑第 ${index + 1} 条排队消息`}
                title="编辑"
                className="shrink-0 rounded p-1.5 text-ink-faint hover:bg-surface hover:text-ink focus-visible:outline focus-visible:outline-2"
                onClick={() => {
                  if (!id) return;
                  if (
                    composer?.prefill(content, queuedAttachments(item), {
                      ifEmpty: true,
                    })
                  ) {
                    removeQueuedPromptById(id);
                    setNotice("");
                  } else
                    setNotice("请先处理输入框中的草稿或附件，再编辑排队消息。");
                }}
              >
                <PencilIcon className="h-4 w-4" />
              </button>
              <button
                type="button"
                aria-label={`删除第 ${index + 1} 条排队消息`}
                title="删除"
                className="shrink-0 rounded p-1.5 text-ink-faint hover:bg-surface hover:text-danger-ink focus-visible:outline focus-visible:outline-2"
                onClick={() => {
                  if (id) removeQueuedPromptById(id);
                }}
              >
                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                  <path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3" />
                </svg>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
