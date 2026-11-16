import { useState } from "react";
import { ConfirmationDialog } from "../../../../shared/ui/ConfirmationDialog.tsx";
import { useProjectComposer } from "../../ui/bindings/composerView.ts";
import { useSessionValue } from "../../ui/bindings/conversationView.ts";
import {
  isSteerOutboxEntry,
  queuedAttachments,
  queuedText,
} from "../queuedPrompt.ts";
import type { QueuedPrompt } from "../types.ts";
import { useSessionCommands } from "./useSessionCommands.ts";

export function SteerRecovery() {
  const composer = useProjectComposer();
  const queue = useSessionValue((state) => state.queuedPrompts);
  const activeIds = useSessionValue((state) => state.activeSteerIds);
  const saveError = useSessionValue((state) => state.queueSaveError);
  const { removeQueuedPromptById, retryQueueSave } = useSessionCommands();
  const [confirmId, setConfirmId] = useState<string>();
  const [noticeId, setNoticeId] = useState<string>();
  const recoverable = queue
    .filter(isSteerOutboxEntry)
    .filter((item) => item.id && !activeIds?.includes(item.id));
  const confirmed = recoverable.find((item) => item.id === confirmId);
  const restore = (id: string, item: QueuedPrompt) => {
    if (
      composer?.prefill(queuedText(item), queuedAttachments(item), {
        ifEmpty: true,
      })
    ) {
      removeQueuedPromptById(id);
      setNoticeId(undefined);
    } else {
      setNoticeId(id);
    }
  };

  return (
    <>
      {saveError && (
        <div role="alert" className="px-3 py-1 text-xs text-warn-ink">
          {saveError}{" "}
          <button type="button" onClick={retryQueueSave}>
            重试保存
          </button>
        </div>
      )}
      {recoverable.map((item) => {
        const id = item.id;
        if (!id) return null;
        return (
          <div
            key={id}
            className="flex items-center gap-2 px-3 py-1 text-ui-caption text-ink-mute"
          >
            <span className="min-w-0 flex-1 truncate" data-hint={item.text}>
              {item.steerDelivery === "unknown"
                ? "引导结果待确认"
                : "引导未发送"}
              {item.text ? ` · ${item.text}` : " · 图片"}
            </span>
            <button
              type="button"
              className="shrink-0 rounded px-2 py-1 hover:bg-hover"
              onClick={() =>
                item.steerDelivery === "unknown"
                  ? setConfirmId(id)
                  : restore(id, item)
              }
            >
              取回草稿
            </button>
          </div>
        );
      })}
      {recoverable.some((item) => item.id === noticeId) && (
        <p role="status" className="px-3 py-1 text-ui-caption text-warn-ink">
          请先处理输入框中的草稿或附件，再取回引导消息。
        </p>
      )}
      {confirmed?.id && (
        <ConfirmationDialog
          label="确认取回引导消息"
          title="先检查上次执行结果"
          confirmLabel="确认并取回"
          tone="neutral"
          onCancel={() => setConfirmId(undefined)}
          onConfirm={() => {
            if (confirmed.id) restore(confirmed.id, confirmed);
            setConfirmId(undefined);
          }}
        >
          上次引导可能已经执行。请先查看会话与文件变化，确认需要重新发送后再取回草稿。
        </ConfirmationDialog>
      )}
    </>
  );
}
