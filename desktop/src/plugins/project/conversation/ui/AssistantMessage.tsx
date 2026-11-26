import type { AssistantMessageItem } from "../types.ts";
import type { TurnUsageDetails } from "../turnUsage.ts";
import { TurnUsageBadge } from "./TurnUsageBadge.tsx";
import { describeUnknownError } from "../../../../shared/errors.ts";
import { useWorkspaceValue } from "../../ui/bindings/workspaceView.ts";
import { useConversation, useSessionValue } from "../../ui/bindings/conversationView.ts";
import { useProject } from "../../ui/bindings/projectView.tsx";
import { ConversationDocumentContext } from "./documentView.ts";
import { MessageAttachments } from "./MessageAttachments.tsx";
import { memo, useCallback, useContext, useMemo, useState } from "react";
import { useStreamingItem } from "./useStreamingItem.ts";
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

function AssistantMessageBase({
  item: layoutItem,
  showActions = true,
  usage,
}: {
  readonly item: AssistantMessageItem;
  /** 动作行（复制 + 落笔时间）只属于轮次最终回答。 */
  readonly showActions?: boolean;
  readonly usage?: TurnUsageDetails | null;
}) {
  const item = useStreamingItem(layoutItem);
  const { assetUrl, openPath, openAbsoluteFile, openExternal, verifyRelativeFile } = useContext(ConversationDocumentContext) ?? {};
  const project = useWorkspaceValue((state) => state.activePath);
  const workspace = useProject()?.projects.workspace;
  const foreground = useConversation()?.session;
  const sessionId = useSessionValue((state) => state.activeSessionId ?? state.openingSessionId);
  const agentKey = useSessionValue((state) => state.agentKey);
  const workingDirectory = useSessionValue((state) => state.workingDirectory);
  const [fileError, setFileError] = useState<string | null>(null);
  const onOpenFile = useCallback((path: string, line?: number, absolute = false) => {
    const open = absolute ? openAbsoluteFile : openPath;
    if (!project || !open) return;
    const isCurrent = () => {
      const state = foreground?.getState();
      return workspace?.getState().activePath === project &&
        state?.agentKey === agentKey &&
        (state?.activeSessionId ?? state?.openingSessionId ?? null) === sessionId &&
        state?.workingDirectory === workingDirectory;
    };
    if (!isCurrent()) return;
    setFileError(null);
    void open(project, path, line, isCurrent).catch((error: unknown) => {
      if (isCurrent()) setFileError(describeUnknownError(error));
    });
  }, [agentKey, foreground, openAbsoluteFile, openPath, project, sessionId, workingDirectory, workspace]);
  const replyFiles = useMemo(() => ({
    root: workingDirectory,
    verify: verifyRelativeFile,
    open: openPath ? onOpenFile : undefined,
    openAbsolute: openAbsoluteFile ? (path: string, line?: number) => onOpenFile(path, line, true) : undefined,
  }), [workingDirectory, verifyRelativeFile, openPath, openAbsoluteFile, onOpenFile]);
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
          canUseCodeRenderers
          fileRoot={project ?? undefined}
          replyFiles={replyFiles}
          onOpenExternal={openExternal}
          assetUrl={assetUrl}
          onOpenFile={openPath ? onOpenFile : undefined}
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
            icon={<CopyIcon className="ui-icon-15" strokeWidth={1.8} />}
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
