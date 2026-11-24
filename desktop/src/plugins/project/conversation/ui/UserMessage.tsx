import { IconButton } from "../../../../shared/ui/IconButton.tsx";
import { PencilIcon } from "../../../../shared/ui/icons.tsx";
import { foldedText } from "../../../../shared/messageDisplay.ts";
import { Disclosure } from "../../../../shared/ui/Disclosure.tsx";
import type { UserMessageItem } from "../types.ts";
import type { ContentBlock } from "../../../../contracts/acp/protocol.ts";
import { MessageAttachments } from "./MessageAttachments.tsx";
import { decodeAnnotationMessage } from "../../composer/annotationMessage.ts";
import { AnnotationSummary } from "./AnnotationSummary.tsx";
import { Fragment, memo } from "react";
import {
  promptWithEditableSkills,
  readPromptSkillReferences,
} from "../../composer/skillReferences.ts";
import { SkillReferenceToken } from "./SkillReferenceTokens.tsx";
/**
 * 用户消息：右侧气泡（保留换行）+ hover 浮现的操作行。
 *
 * 操作（弱化呈现，静息不占视觉）：
 * - 「再次发送」：把这条消息填回输入框（可改再发）——ACP 没有消息编辑
 *   语义，诚实的形态是「取回文本」而不是假装原地编辑；
 * - 复制：源文本入剪贴板（CopyButton 自带已复制反馈）。
 */
import { useProjectComposer } from "../../ui/bindings/composerView.ts";
import { CopyButton } from "../../../../shared/ui/CopyButton.tsx";
import { formatClock } from "./clock.ts";

function UserMessageBase({
  item,
  showActions = true,
}: {
  readonly item: UserMessageItem;
  readonly showActions?: boolean;
}) {
  const composer = useProjectComposer();
  const visible = item.display ? item.display.visible : item.text;
  const annotated = decodeAnnotationMessage(visible);
  const text = annotated?.text ?? visible;
  const references = readPromptSkillReferences(item.skillReferences, text);
  let offset = 0;
  const renderedSkills = references?.map((reference) => {
    const preceding = text.slice(offset, reference.offset);
    offset = reference.offset + reference.command.length + 1;
    return (
      <Fragment key={reference.offset}>
        {preceding}
        <SkillReferenceToken reference={reference} />
      </Fragment>
    );
  });
  return (
    <div
      className="group flex flex-col items-end gap-1"
      data-item-kind="user"
      data-item-id={item.id}
    >
      {item.steer && <span className="text-ui-caption text-ink-mute">补充</span>}
      <MessageAttachments blocks={item.attachments} compact />
      {annotated && (
        <AnnotationSummary className="" annotations={annotated.annotations} />
      )}
      {text.trim() && (
        <div
          data-user-message-bubble=""
          // hover 时间戳：发送时刻（createdAt 缺省的旧数据不显示）
          data-hint={formatClock(item.createdAt) ?? undefined}
          className="max-w-full rounded-panel bg-conversation-user px-4 py-3 text-ui-base leading-relaxed break-words text-ink @min-[624px]/conversation:max-w-xl"
        >
          <p className="whitespace-pre-wrap break-words">
            {renderedSkills}
            {text.slice(offset)}
          </p>
        </div>
      )}
      {item.display && (
        <Disclosure summary={item.display.foldLabel} className="w-full text-ink-mute">
          <p className="max-h-80 overflow-y-auto rounded-control border border-line bg-surface px-3 py-2 text-ui-sm leading-relaxed whitespace-pre-wrap break-words text-ink-soft">{foldedText(item.text, item.display)}</p>
        </Disclosure>
      )}
      {showActions && text.trim() && (
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
          <IconButton iconSize="compact"
            type="button"
            onClick={() => {
              composer?.prefill(
                promptWithEditableSkills(visible, references),
                item.attachments as readonly ContentBlock[] | undefined,
              );
            }}
            aria-label="填回输入框"
            data-hint="填回输入框"
            className="rounded-control text-xs text-ink-faint transition-colors hover:bg-raised hover:text-ink-soft"
          >
            <PencilIcon className="ui-icon-14" />
          </IconButton>
          <CopyButton getText={() => item.text} label="复制消息" iconOnly />
        </div>
      )}
    </div>
  );
}

/** memo：item 引用不变则整树跳过（流式分片只改最后一条的引用）。 */
export const UserMessage = memo(UserMessageBase);
