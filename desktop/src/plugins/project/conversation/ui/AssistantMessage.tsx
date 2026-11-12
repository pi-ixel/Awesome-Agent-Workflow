import type { AssistantMessageItem } from "../types.ts";
import type { TurnTokenCounts } from "../turnUsage.ts";
import { TurnUsageBadge } from "./TurnUsageBadge.tsx";
import { describeUnknownError } from "../../../../shared/errors.ts";
import { useWorkspaceValue } from "../../ui/bindings/workspaceView.ts";
import { ConversationDocumentContext } from "./documentView.ts";
import { MessageAttachments } from "./MessageAttachments.tsx";
import { memo } from "react";
/**
 * 助手消息：Markdown 渲染 + 整条复制（复制 Markdown 源文本）。
 * 流式时正文经 MarkdownView 以 streaming 解析（remend 补全未闭合 markdown），
 * 行内无「生成中」指示元素（对齐 ZCode：ConversationRowView 经 MessageResponse
 * 直接流式，无该残留）。
 */
import { CopyButton } from "../../../../shared/ui/CopyButton.tsx";
import { CopyIcon } from "../../../../shared/ui/icons.tsx";
import { formatActionClock, formatClock } from "./clock.ts";
import { MarkdownView } from "../../../../shared/ui/MarkdownView.tsx";
import { useContext, useState } from "react";

function AssistantMessageBase({
  item,
  showActions = true,
  usage,
}: {
  readonly item: AssistantMessageItem;
  /** 动作行（复制 + 落笔时间）只属于轮次最终回答。 */
  readonly showActions?: boolean;
  readonly usage?: TurnTokenCounts | null;
}) {
  const { assetUrl, openPath, openExternal } = useContext(ConversationDocumentContext) ?? {};
  const project = useWorkspaceValue((state) => state.activePath);
  const [fileError, setFileError] = useState<string | null>(null);
  return (
    // group：复制按钮随卡片 hover 浮现，不再常驻制造噪音
    <div
      className="group flex flex-col items-start gap-1"
      data-item-kind="assistant"
      data-item-id={item.id}
      data-hint={formatClock(item.createdAt) ?? undefined}
    >
      <div className="w-full py-2">
        <MarkdownView
          text={item.text}
          streaming={item.isStreaming}
          fileRoot={project ?? undefined}
          onOpenExternal={openExternal}
          assetUrl={assetUrl}
          onOpenFile={
            openPath
              ? (path, line) => {
                  if (project) {
                    setFileError(null);
                    void openPath(
                      project,
                      path,
                      line,
                    ).catch((error: unknown) =>
                      setFileError(describeUnknownError(error)),
                    );
                  }
                }
              : undefined
          }
        />
        <MessageAttachments blocks={item.attachments} />
        {fileError && (
          <p role="alert" className="mt-2 text-xs text-danger-ink">
            {fileError}
          </p>
        )}
      </div>
      {showActions && (
        <div className="flex flex-wrap items-center gap-2 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 group-hover/assistant-turn:opacity-100 [@media(hover:none)]:opacity-100">
          <CopyButton
            getText={() => item.text}
            label="复制消息"
            iconOnly
            size="md"
            tone="muted"
            icon={<CopyIcon className="size-[15px]" strokeWidth={1.8} />}
          />
          {usage !== undefined && <TurnUsageBadge usage={usage} />}
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
