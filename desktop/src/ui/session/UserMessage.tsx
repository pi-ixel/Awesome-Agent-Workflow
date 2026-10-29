import { memo } from "react";
/**
 * 用户消息：右侧气泡（保留换行）+ hover 浮现的操作行。
 *
 * 操作（弱化呈现，静息不占视觉）：
 * - 「再次发送」：把这条消息填回输入框（可改再发）——ACP 没有消息编辑
 *   语义，诚实的形态是「取回文本」而不是假装原地编辑；
 * - 复制：源文本入剪贴板（CopyButton 自带已复制反馈）。
 */
import type { UserMessageItem } from "../../stores/sessionStore.ts";
import { prefillComposer } from "./composerPrefill.ts";
import { CopyButton } from "./CopyButton.tsx";
import { formatClock } from "./clock.ts";

function UserMessageBase({ item }: { readonly item: UserMessageItem }) {
  return (
    <div className="group flex flex-col items-end gap-1" data-item-kind="user">
      <div
        // hover 时间戳：发送时刻（createdAt 缺省的旧数据不显示）
        title={formatClock(item.createdAt) ?? undefined}
        className="max-w-full rounded-xl rounded-tr-xs border border-line bg-surface px-4 py-3 text-ui-base leading-relaxed break-words text-ink @min-[624px]/conversation:max-w-xl"
      >
        <p className="whitespace-pre-wrap break-words">{item.text}</p>
      </div>
      <div className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
        <button
          type="button"
          onClick={() => {
            prefillComposer(item.text);
          }}
          aria-label="填回输入框"
          title="填回输入框"
          className="rounded px-1.5 py-0.5 text-xs text-ink-faint transition-colors hover:bg-raised hover:text-ink-soft"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="size-3.5"
          >
            <path d="M3 11.5V13h1.5l7.7-7.7-1.5-1.5L3 11.5Z" />
            <path d="m9.8 4.7 1.5 1.5" />
          </svg>
        </button>
        <CopyButton getText={() => item.text} label="复制消息" iconOnly />
      </div>
    </div>
  );
}

/** memo：item 引用不变则整树跳过（流式分片只改最后一条的引用）。 */
export const UserMessage = memo(UserMessageBase);
