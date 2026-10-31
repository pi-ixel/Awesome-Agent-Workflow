import { memo } from "react";
/**
 * 助手消息：Markdown 渲染 + 整条复制（复制 Markdown 源文本）。
 * 流式时正文经 MarkdownView 直接流式渲染，行内无「生成中」指示元素
 * （对齐 ZCode：ConversationRowView 经 MessageResponse 直接流式，无该残留）。
 */
import type { AssistantMessageItem } from "../../stores/sessionStore.ts";
import { CopyButton } from "./CopyButton.tsx";
import { formatActionClock, formatClock } from "./clock.ts";
import { MarkdownView } from "./MarkdownView.tsx";
import { useState } from "react";
import { useWorkspaceStore } from "../../stores/workspaceStore.ts";
import { panelError } from "../../core/panelService.ts";
import { openPanelPath } from "../right-panel/openPanelPath.ts";

function AssistantMessageBase({
  item,
  showActions = true,
}: {
  readonly item: AssistantMessageItem;
  /** 动作行（复制 + 落笔时间）只属于轮次最终回答；折叠区内的中间
   * 过程文本不带（对齐 ZCode：中途 prose 无操作行）。 */
  readonly showActions?: boolean;
}) {
  const project = useWorkspaceStore((state) => state.activePath);
  const [fileError, setFileError] = useState<string | null>(null);
  return (
    // group：复制按钮随卡片 hover 浮现，不再常驻制造噪音
    <div
      className="group flex flex-col items-start gap-1"
      data-item-kind="assistant" data-item-id={item.id}
      title={formatClock(item.createdAt) ?? undefined}
    >
      <div className="w-full py-2">
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
      {showActions && (
        <div className="flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
          <CopyButton getText={() => item.text} label="复制消息" iconOnly />
          {(() => {
            const clock = formatActionClock(item.createdAt);
            return clock !== null ? (
              <span className="text-ui-sm leading-none tabular-nums text-ink-mute">
                {clock}
              </span>
            ) : null;
          })()}
        </div>
      )}
    </div>
  );
}

/** memo：item 引用不变则整树跳过（流式分片只改最后一条的引用）。 */
export const AssistantMessage = memo(AssistantMessageBase);
