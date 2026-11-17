import { UiIcon } from "../../../../shared/ui/UiIcon.tsx";
import { useRef, useState } from "react";
import { useSessionValue } from "../../ui/bindings/conversationView.ts";
import { useProjectComposer } from "../../ui/bindings/composerView.ts";
import { useSessionCommands } from "./useSessionCommands.ts";
import { isSteerOutboxEntry, queuedText, queuedAttachments } from "../queuedPrompt.ts";
import { GripVerticalIcon, PencilIcon } from "../../../../shared/ui/icons.tsx";

export function QueueDock(): React.JSX.Element | null {
  const composer = useProjectComposer();
  const queuedPrompts = useSessionValue((state) => state.queuedPrompts);
  const directSteering = useSessionValue((state) => state.directSteering);
  const steerEditableId = useSessionValue((state) => state.steerEditableId);
  const steerPhase = useSessionValue((state) => state.steerPhase);
  const queued = queuedPrompts.filter((item) =>
    isSteerOutboxEntry(item) ? item.id === steerEditableId || item.steerPaused : !directSteering);
  const hasOrdinary = queued.some((item) => !isSteerOutboxEntry(item));
  const paused = useSessionValue((state) => state.queuePaused);
  const {
    resumeQueue,
    stopSteering,
    clearQueue,
    removeQueuedPromptById,
    moveQueuedPrompt,
  } = useSessionCommands();
  const dragId = useRef<string | null>(null);
  const [notice, setNotice] = useState("");
  const idOf = (item: (typeof queued)[number]) =>
    typeof item === "string" ? undefined : item.id;

  if (queued.length === 0) return null;
  return (
    <section aria-label="排队消息" data-queue-dock="" className="border-b border-line bg-raised/50">
      {paused && hasOrdinary && (
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
      {steerEditableId && (
        <div className="flex justify-end px-3 py-1 text-xs text-ink-mute">
          <button
            type="button"
            onClick={stopSteering}
            className="rounded px-2 py-1 hover:bg-surface"
          >
            停止等待
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
          const steer = isSteerOutboxEntry(item);
          const content = queuedText(item);
          const count = queuedAttachments(item).length;
          return (
            <li
              key={id ?? index}
              className="flex min-h-10 items-center gap-2 border-b border-line/60 px-3 last:border-b-0"
              onDragOver={(event) => {
                if (!steer && dragId.current && id && dragId.current !== id) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }
              }}
              onDrop={(event) => {
                if (steer || !dragId.current || !id) return;
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
                disabled={steer}
                draggable={!!id && !steer}
                aria-label={`调整第 ${index + 1} 条排队消息顺序`}
                data-hint="拖动或使用上下方向键调整顺序"
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
                  const targetId = target && !isSteerOutboxEntry(target) ? idOf(target) : undefined;
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
                <GripVerticalIcon className="ui-icon-16" />
              </button>
              <span
                className="min-w-0 flex-1 truncate text-sm text-ink"
                data-hint={content}
              >
                {steer && (id === steerEditableId
                  ? steerPhase === "saving" ? "正在保存 · " : "等待 Agent 首次回传 · "
                  : "待手动处理 · ")}
                {content || "图片"}
                {count ? ` · ${count} 张图片` : ""}
              </span>
              <button
                type="button"
                aria-label={`编辑第 ${index + 1} 条排队消息`}
                data-hint="编辑"
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
                <PencilIcon className="ui-icon-16" />
              </button>
              <button
                type="button"
                aria-label={`删除第 ${index + 1} 条排队消息`}
                data-hint="删除"
                className="shrink-0 rounded p-1.5 text-ink-faint hover:bg-surface hover:text-danger-ink focus-visible:outline focus-visible:outline-2"
                onClick={() => {
                  if (id) removeQueuedPromptById(id);
                }}
              >
                <UiIcon
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="ui-icon-16"
                >
                  <path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3" />
                </UiIcon>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
