/**
 * execute 类工具的输出视图（工具卡展开区输出段的替身）：
 * - 默认 5 行窗口（内容不足时按实际行数收缩），内部滚动；
 * - 吸底跟随：新内容到达时贴底滚入；用户上滚即冻结（盯中间输出不被
 *   新行顶走），滚回底部自动恢复跟随（LogView 贴底模式的同款语义）。
 *
 * 高度按行数估算（leading-relaxed × text-xs ≈ 1.625em/行）：长行折行会
 * 使实际视觉行数偏多，多出的部分仍可滚动，不影响跟随语义。
 */
import { useEffect, useRef, useState } from "react";

const WINDOW_LINES = 5;
/** 每行高度（em，相对组件 font-size）：text-xs × leading-relaxed。 */
const LINE_HEIGHT_EM = 1.625;
/** 距底 ≤4px 视为贴底（亚像素与取整余量）。 */
const NEAR_BOTTOM_PX = 4;

function countLines(text: string): number {
  if (text.length === 0) {
    return 1;
  }
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return Math.max(1, lines.length);
}

export function TerminalOutput({
  text,
  failed = false,
  fill = false,
}: {
  readonly text: string;
  readonly failed?: boolean;
  /**
   * 填满宿主高度（底部终端面板用：面板体已是定高滚动容器，视图按 100%
   * 撑满）。默认 false——消息流工具卡内渲染零变化。
   */
  readonly fill?: boolean;
}) {
  const preRef = useRef<HTMLPreElement | null>(null);
  const [follows, setFollows] = useState(true);
  const lineCount = countLines(text);

  // 新内容到达：跟随态下贴底滚入（直跳，不拖影）
  useEffect(() => {
    const element = preRef.current;
    if (follows && element !== null) {
      element.scrollTop = element.scrollHeight;
    }
  }, [text, follows]);

  const handleScroll = (): void => {
    const element = preRef.current;
    if (element === null) {
      return;
    }
    const distance =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    setFollows(distance <= NEAR_BOTTOM_PX);
  };

  return (
    <pre
      ref={preRef}
      onScroll={handleScroll}
      aria-label="终端输出"
      style={{
        height: fill
          ? "100%"
          : `${Math.min(lineCount, WINDOW_LINES) * LINE_HEIGHT_EM}em`,
      }}
      className={`overflow-auto rounded bg-base/70 p-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words ${
        failed ? "text-danger-ink" : "text-ink-soft"
      }`}
    >
      {text}
    </pre>
  );
}
