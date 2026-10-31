/**
 * 思考行（agent_thought_chunk）：对齐 ZCode ReasoningRowView + ReasoningTrigger。
 *
 * 触发行 = 静态 BrainIcon 在前 + 语义标签 + （流式时）末行摘要 + chevron 在后；
 * 流式态文案「正在思考」走 turn-status-shimmer 扫光，完成态给
 * 「思考 · 持续了 X 秒」三段标签（无时刻记录的历史条目落「持续了几秒」）。
 * 流式摘要视口每次内容增长把单行推到末尾（始终显示最新一行），溢出后加
 * 双缘 16px 渐变 mask（ZCode reasoning.tsx 同款，不再固定截前缀）。
 * 流式且尚无文本时整行不渲染（ZCode ConversationRowView 同规则）。
 * 展开区走 ZCode default variant 的左导线 + max-h-60 内滚动。
 */
import { useEffect, useRef, useState, memo, type CSSProperties } from "react";
import type { ThoughtItem } from "../../stores/sessionStore.ts";
import { BrainIcon, ChevronRightIcon } from "../icons.tsx";

/** 流式摘要：取最后一个非空行（resolveReasoningStreamingSummary 语义）。 */
function streamingSummaryOf(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? "";
}

/** 流式摘要双缘渐变 mask（ZCode REASONING_SUMMARY_MASK）。 */
const STREAMING_SUMMARY_MASK =
  "linear-gradient(to right, transparent 0, black 16px, black calc(100% - 16px), transparent 100%)";

function streamingSummaryMaskStyle(
  overflowing: boolean,
): CSSProperties | undefined {
  if (!overflowing) {
    return undefined;
  }
  return {
    WebkitMaskImage: STREAMING_SUMMARY_MASK,
    maskImage: STREAMING_SUMMARY_MASK,
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
    WebkitMaskSize: "100% 100%",
    maskSize: "100% 100%",
  };
}

function ThoughtBlockBase({ item }: { readonly item: ThoughtItem }) {
  const [isOpen, setIsOpen] = useState(false);
  const [summaryOverflowing, setSummaryOverflowing] = useState(false);
  const summaryViewportRef = useRef<HTMLSpanElement | null>(null);
  const summaryTextRef = useRef<HTMLSpanElement | null>(null);
  const streamingSummary = item.isStreaming ? streamingSummaryOf(item.text) : "";
  // RO 只在流式期订阅一次（依赖 isStreaming 而非摘要文本）：流式摘要每行
  // 都换，若以文本为依赖则每行 disconnect/observe 一次，且回调里读
  // scrollWidth 是强制同步布局——高频流式下就是卡顿源。文本尺寸变化由
  // RO 对 summaryTextRef 的观察覆盖，无需按文本重挂。
  const isStreaming = item.isStreaming;
  useEffect(() => {
    const viewport = summaryViewportRef.current;
    if (!viewport || !isStreaming) {
      return;
    }
    const syncSummaryViewport = () => {
      setSummaryOverflowing((current) => {
        const next = viewport.scrollWidth > viewport.clientWidth + 1;
        return current === next ? current : next;
      });
      // 流式摘要超过可用宽度后，普通 overflow-hidden 会固定显示旧前缀，
      // 最新 token 被裁在右侧。每次内容增长后把单行视口推到末尾，让旧内容向左移。
      viewport.scrollLeft = viewport.scrollWidth;
    };
    syncSummaryViewport();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const resizeObserver = new ResizeObserver(syncSummaryViewport);
    resizeObserver.observe(viewport);
    if (summaryTextRef.current) {
      resizeObserver.observe(summaryTextRef.current);
    }
    return () => resizeObserver.disconnect();
  }, [isStreaming]);
  // 流式且还没有任何思考文本：整行不渲染（ZCode ConversationRowView 同款守卫）
  if (item.isStreaming && item.text.trim().length === 0) {
    return null;
  }
  const durationMs =
    item.startedAt !== null && item.endedAt !== null
      ? Math.max(0, item.endedAt - item.startedAt)
      : null;
  const durationLabel =
    durationMs !== null
      ? `持续了 ${Math.max(1, Math.ceil(durationMs / 1000))} 秒`
      : "持续了几秒";
  return (
    <div className="w-full" data-item-kind="thought" data-item-id={item.id}>
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => {
          setIsOpen((current) => !current);
        }}
        className="group/thought inline-flex max-w-full min-w-0 items-center gap-2 self-start text-left text-ui-base transition-colors"
      >
        {/* 长流式下旋转 loader 会长期占用渲染资源：glyph 固定静态脑形 */}
        <BrainIcon className="size-4 shrink-0 text-ink-mute" />
        <span className="shrink-0 whitespace-nowrap">
          {item.isStreaming ? (
            /* 运行态文案扫光（turn-status-shimmer 为全应用唯一流光实现） */
            <span className="turn-status-shimmer font-medium">正在思考</span>
          ) : (
            <span className="inline-flex items-center gap-2">
              <span className="font-medium text-ink-mute">思考</span>
              <span className="font-normal text-ink-mute">·</span>
              <span className="font-normal text-ink-mute">{durationLabel}</span>
            </span>
          )}
        </span>
        {item.isStreaming && streamingSummary ? (
          <>
            <span className="shrink-0 text-ink-mute">·</span>
            {/* 单行视口：内容增长推到末尾（始终最新一行），溢出后双缘渐变 mask */}
            <span
              ref={summaryViewportRef}
              className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-ink-soft"
              style={streamingSummaryMaskStyle(summaryOverflowing)}
            >
              <span ref={summaryTextRef} className="inline-block min-w-max">
                {streamingSummary}
              </span>
            </span>
          </>
        ) : null}
        <ChevronRightIcon
          className={`size-4 shrink-0 text-ink-mute transition-opacity transition-transform ${isOpen ? "rotate-90 opacity-100" : "rotate-0 opacity-0 group-hover/thought:opacity-100"}`}
        />
      </button>
      {isOpen ? (
        /* pt-3 在导线容器外层：左导线上方留 12px 空隙（ZCode reasoning.tsx 同款） */
        <div className="pt-3">
          <div className="ml-2 border-line border-l pl-3.5">
            <div className="max-h-60 space-y-2 overflow-auto text-ui-base text-ink-mute">
              <p className="whitespace-pre-wrap break-words">{item.text}</p>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** memo：item 引用不变则整树跳过（流式分片只改最后一条的引用）。 */
export const ThoughtBlock = memo(ThoughtBlockBase);
