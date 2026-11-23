/** 在高刷屏上也按相同的时间预算提交，而在有积压时保留可见的推进过程。 */
export const STREAM_COMMIT_MS = 40;
const CATCH_UP_MS = 180;
const MIN_BATCH = 12;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function streamBatchEnd(
  text: string,
  now: number,
  queuedAt: number,
): number {
  const remainingSteps = Math.max(
    1,
    Math.ceil((queuedAt + CATCH_UP_MS - now) / STREAM_COMMIT_MS),
  );
  return graphemeEnd(
    text,
    Math.max(MIN_BATCH, Math.ceil(text.length / remainingSteps)),
  );
}

export function initialStreamBatchEnd(text: string): number {
  return graphemeEnd(text, MIN_BATCH * 2);
}

function graphemeEnd(text: string, limit: number): number {
  if (!text.length) return 0;
  // ACP 可以在 UTF-16 代理项或 ZWJ 序列中跨包。等待续包或回合封口再提交。
  const last = text.charCodeAt(text.length - 1);
  const complete = last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
  if (!complete.length) return 0;
  const segments = segmenter.segment(complete);
  const segment = segments.containing(Math.min(complete.length, limit) - 1);
  if (!segment) return 0;
  return segment.segment.endsWith("\u200d")
    ? segment.index
    : segment.index + segment.segment.length;
}
