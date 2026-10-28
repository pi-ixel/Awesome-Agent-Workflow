import { memo } from "react";
/**
 * 助手消息：Markdown 渲染 + 流式指示 + 整条复制（复制 Markdown 源文本）。
 */
import type { AssistantMessageItem } from "../../stores/sessionStore.ts";
import { CopyButton } from "./CopyButton.tsx";
import { formatClock } from "./clock.ts";
import { MarkdownView } from "./MarkdownView.tsx";
import { useState } from "react";
import { useWorkspaceStore } from "../../stores/workspaceStore.ts";
import { panelError } from "../../core/panelService.ts";
import { openPanelPath } from "../right-panel/openPanelPath.ts";

function AssistantMessageBase({
  item,
}: {
  readonly item: AssistantMessageItem;
}) {
  const project = useWorkspaceStore((state) => state.activePath);
  const [fileError, setFileError] = useState<string | null>(null);
  return (
    // group：复制按钮随卡片 hover 浮现，不再常驻制造噪音
    <div
      className="group flex flex-col items-start gap-1"
      data-item-kind="assistant"
      title={formatClock(item.createdAt) ?? undefined}
    >
      <div className="flex w-full items-center justify-between">
        <div className="flex items-center gap-2">
          {item.isStreaming ? (
            <span
              className="flex items-center gap-1 text-xs text-accent-ink"
              role="status"
            >
              <span className="inline-block size-1.5 animate-pulse rounded-full bg-sky-400" />
              生成中…
            </span>
          ) : null}
        </div>
        <CopyButton
          getText={() => item.text}
          label="复制消息"
          iconOnly={true}
          revealOnHover={true}
        />
      </div>
      <div className="w-full rounded-lg border border-line bg-surface/60 px-4 py-3">
        <MarkdownView
          text={item.text}
          fileRoot={project ?? undefined}
          onOpenFile={(path, line) => {
            if (project) {
              setFileError(null);
              void openPanelPath(project, path, line).catch((error: unknown) =>
                setFileError(panelError(error)),
              );
            }
          }}
        />
        {fileError && (
          <p role="alert" className="mt-2 text-xs text-danger-ink">
            {fileError}
          </p>
        )}
      </div>
    </div>
  );
}

/** memo：item 引用不变则整树跳过（流式分片只改最后一条的引用）。 */
export const AssistantMessage = memo(AssistantMessageBase);
