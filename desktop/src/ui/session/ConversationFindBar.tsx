/**
 * 会话查找浮层（ZCode quickpick/TaskFindDialog 的像素级移植，chat 放置形态）：
 * 浮在消息流顶部的搜索条——搜索框 + 计数 + 上一个/下一个 + 范围切换
 * （消息/文件变更）+ 关闭；Esc 关闭、ArrowUp/Down（Shift 反向）导航。
 *
 * 状态由 SessionView 持有（open/query/scope/activeIndex），本组件只呈现
 * 与回传事件；匹配索引与高亮在 conversationFindIndex/Highlight。
 */
import { useEffect, useRef } from "react";
import { ArrowDownIcon, ArrowUpIcon, SearchIcon, XIcon } from "../icons.tsx";

/** 浮层定位：消息流顶部居中（desktop 无自绘标题栏冲突，top-3 同 ZCode）。 */
export function ConversationFindBar({
  query,
  matchCount,
  activeIndex,
  onQueryChange,
  onPrevious,
  onNext,
  onClose,
  inputRef,
}: {
  readonly query: string;
  readonly matchCount: number;
  readonly activeIndex: number;
  readonly onQueryChange: (query: string) => void;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
  readonly onClose: () => void;
  readonly inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const inputLocalRef = useRef<HTMLInputElement | null>(null);
  // 外部传 ref 优先（打开时 SessionView 要主动聚焦）
  const inputElementRef = inputRef ?? inputLocalRef;

  // 挂载即聚焦（Ctrl+F 打开后直接输入）
  useEffect(() => {
    inputElementRef.current?.focus();
    inputElementRef.current?.select();
  }, [inputElementRef]);

  const placeholder = "搜索消息...";
  const noResults = matchCount === 0;

  function handleInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    // 对齐 ZCode：ArrowUp/Down 导航，Shift 反向
    if (event.key === "ArrowUp") {
      event.preventDefault();
      onPrevious();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      onNext();
    }
  }

  return (
    <div
      role="dialog"
      aria-label="查找"
      className="absolute top-3 left-1/2 z-30 w-[min(360px,calc(100%-1rem))] -translate-x-1/2 overflow-hidden rounded-2xl border border-line bg-surface shadow-elev-1"
    >
      <div className="flex h-9 items-center gap-1.5 py-0 pr-2 pl-2">
        <SearchIcon className="h-3.5 w-3.5 shrink-0 text-ink" />
        <input
          ref={inputElementRef}
          value={query}
          onChange={(event) => {
            onQueryChange(event.target.value);
          }}
          onKeyDown={handleInputKeyDown}
          placeholder={placeholder}
          aria-label={placeholder}
          className="min-w-0 flex-1 bg-transparent text-ui-base font-medium text-ink outline-none placeholder:text-ink-ghost"
        />
        <div
          aria-live="polite"
          className="w-9 shrink-0 text-center text-xs font-medium text-ink-mute tabular-nums"
        >
          {matchCount > 0 ? `${activeIndex + 1}/${matchCount}` : "0/0"}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 border-line border-l pl-1.5">
          <button
            type="button"
            aria-label="上一个结果"
            title="上一个结果"
            disabled={noResults}
            onClick={onPrevious}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-ink transition-colors hover:bg-hover hover:text-ink disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <ArrowUpIcon className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label="下一个结果"
            title="下一个结果"
            disabled={noResults}
            onClick={onNext}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-ink transition-colors hover:bg-hover hover:text-ink disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <ArrowDownIcon className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="ml-0.5 flex shrink-0 border-line border-l pl-1.5">
          <button
            type="button"
            aria-label="关闭查找"
            title="关闭查找"
            onClick={onClose}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-ink transition-colors hover:bg-hover hover:text-ink"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
