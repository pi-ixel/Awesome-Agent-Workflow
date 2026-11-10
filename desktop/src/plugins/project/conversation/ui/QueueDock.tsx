import { useSessionValue } from "../../ui/bindings/conversationView.ts";
import { useProjectComposer } from "../../ui/bindings/composerView.ts";
import { useSessionCommands } from "./useSessionCommands.ts";
import { queuedText, queuedAttachments } from "../queuedPrompt.ts";
/**
 * 排队消息停靠面板（SessionDock 中位）：运行中「稍后发送」的消息队列。
 * - 列表项：一条一行（超两条内部滚动），点击回填输入框可改（回填即出队，
 *   改完再发/再入队由输入区决定）；悬停浮现删除钮；
 * - 暂停横幅：点击停止或取消/出错后队列挂起——「继续队列」放行、「清空」
 *   放弃；未暂停时正常结束自动出队，已暂停则不能被正常完成的响应解除；
 * - 队列是内存态（切会话即清），条数徽标同时进 TurnStatusRow。
 */
import { XIcon } from "../../../../shared/ui/icons.tsx";

export function QueueDock(): React.JSX.Element | null {
  const composer = useProjectComposer();
  const queued = useSessionValue((state) => state.queuedPrompts);
  const paused = useSessionValue((state) => state.queuePaused);
  const { resumeQueue, clearQueue, removeQueuedPrompt } = useSessionCommands();

  if (queued.length === 0) {
    return null;
  }
  return (
    <section
      aria-label="排队消息"
      data-queue-dock=""
      className="w-full overflow-hidden rounded-xl border border-line bg-surface shadow-elev-1"
    >
      <header className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-xs">
        <span className="shrink-0 font-medium text-ink-mute">
          队列 · {queued.length} 条待发
        </span>
        {paused ? (
          <span className="shrink-0 rounded border border-warn-line bg-warn-bg/50 px-1.5 py-0.5 text-2xs text-warn-ink">
            已暂停
          </span>
        ) : (
          <span className="shrink-0 text-2xs text-ink-faint">
            当前轮结束后自动发出
          </span>
        )}
        <span className="min-w-0 flex-1" />
        {paused ? (
          <>
            <button
              type="button"
              onClick={resumeQueue}
              className="rounded border border-line-strong px-2 py-0.5 text-2xs font-medium text-ink transition-colors hover:border-ink-faint hover:bg-raised"
            >
              继续队列
            </button>
            <button
              type="button"
              onClick={clearQueue}
              className="rounded border border-line-strong px-2 py-0.5 text-2xs font-medium text-ink-faint transition-colors hover:border-danger-line hover:text-danger-ink"
            >
              清空
            </button>
          </>
        ) : null}
      </header>
      <ol className="max-h-36 list-none space-y-1 overflow-y-auto border-t border-line px-2 py-1.5">
        {queued.map((text, index) => (
          <li
            key={`${index}-${queuedText(text)}`}
            className="group flex items-start gap-1.5 rounded px-1.5 py-1 transition-colors hover:bg-raised/60"
          >
            <span className="shrink-0 pt-0.5 font-mono text-2xs text-ink-ghost">
              {index + 1}.
            </span>
            {/* 点击回填输入框（出队改写再发） */}
            <button
              type="button"
              onClick={() => {
                if (composer?.prefill(queuedText(text), queuedAttachments(text)))
                  removeQueuedPrompt(index);
              }}
              title="点击回填输入框，可修改后再发送"
              className="min-w-0 flex-1 text-left text-xs leading-5 break-words text-ink-soft"
            >
              {queuedText(text)}
              {queuedAttachments(text).length
                ? ` · ${queuedAttachments(text).length} 张图片`
                : ""}
            </button>
            <button
              type="button"
              aria-label={`删除第 ${index + 1} 条排队消息`}
              onClick={() => {
                removeQueuedPrompt(index);
              }}
              className="shrink-0 rounded p-0.5 text-ink-faint opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 hover:bg-raised hover:text-danger-ink"
            >
              <XIcon className="h-3 w-3" />
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
