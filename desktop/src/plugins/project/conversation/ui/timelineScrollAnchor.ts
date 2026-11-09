/**
 * 消息流底部锚定状态机（纯函数，无 DOM/React 依赖）。
 *
 * 移植自 ZCode packages/ui/src/v4/timelineScrollAnchor.ts——语义保持，
 * 去掉虚拟列表专用的测高补偿与 prepend 锚段（本项目的窗口化渲染用
 * 「距底距离」平移代替，见 SessionView）。
 *
 * 语义（following）：
 * - 用户位于底部 → following=true，新内容（新条目 / 流式 delta / 补载与
 *   渐进挂载撑高）自动贴底；
 * - 用户上滚离底 → following=false，一切程序化内容变化不得拉回阅读位置；
 * - 用户手动滚回底部（或点「回到底部」）→ 恢复跟随。
 *
 * following 表达用户滚动权，不是瞬时几何快照：只有真实用户滚动输入可以
 * 改变它；程序化贴底、窗口补载和渐进挂载产生的 scroll 事件只更新几何
 * 账目（resolveFollowingAfterScroll 的 source 裁决）。
 */

/** 离底判定容差：小于该距离视为「在底部」。覆盖亚像素滚动与末行 padding。 */
export const BOTTOM_ANCHOR_EPSILON_PX = 48;

export interface TimelineScrollMetrics {
  /** 滚动容器 scrollTop。 */
  scrollTop: number;
  /** 滚动容器可视高度（clientHeight）。 */
  viewportHeight: number;
  /** 内容总高度（scrollHeight）。 */
  contentHeight: number;
}

/** 距底部的剩余可滚动距离（内容不足一屏时为 0）。 */
export function distanceToBottom(metrics: TimelineScrollMetrics): number {
  return Math.max(
    0,
    metrics.contentHeight - metrics.viewportHeight - metrics.scrollTop,
  );
}

export function isAtBottom(
  metrics: TimelineScrollMetrics,
  epsilonPx: number = BOTTOM_ANCHOR_EPSILON_PX,
): boolean {
  return distanceToBottom(metrics) <= epsilonPx;
}

/**
 * scroll 事件后的跟随态。规则：落点在底部 ⇔ 跟随。
 * 覆盖三种来源且无需区分：用户上滚（离底 → 解除）、用户滚回（贴底 → 恢复）、
 * 程序化贴底（落点即底部 → 保持）。
 */
export function nextFollowingAfterScroll(
  metrics: TimelineScrollMetrics,
  epsilonPx: number = BOTTOM_ANCHOR_EPSILON_PX,
): boolean {
  return isAtBottom(metrics, epsilonPx);
}

export type TimelineScrollEventSource = "user" | "programmatic" | "layout";

/**
 * scroll 事件后的滚动权裁决。布局/程序化 scroll 不得改变用户意图；只有用户输入
 * 才按最终落点决定是否跟随。
 */
export function resolveFollowingAfterScroll(input: {
  following: boolean;
  metrics: TimelineScrollMetrics;
  source: TimelineScrollEventSource;
  epsilonPx?: number;
}): boolean {
  if (input.source !== "user") return input.following;
  return nextFollowingAfterScroll(input.metrics, input.epsilonPx);
}

/**
 * 内容变化（条目追加 / 补载前插 / 渐进挂载撑高）后的动作：
 * 跟随中 → 贴底；已解除 → 保持阅读位置（绝不拉回）。
 */
export function anchorActionAfterContentChange(
  following: boolean,
): "stickToBottom" | "hold" {
  return following ? "stickToBottom" : "hold";
}

/** 未观察滚动的判定容差：小于该值的 scrollTop 回退视为亚像素抖动，不算用户上滚。 */
export const UNOBSERVED_SCROLL_EPSILON_PX = 2;

export type TimelineUserScrollIntent =
  | "none"
  | "awayFromBottom"
  | "towardBottom"
  | "unknown";

/** wheel 的 deltaY 与 scrollTop 同向：负值阅读更早内容，正值靠近底部。 */
export function timelineWheelScrollIntent(
  deltaY: number,
): TimelineUserScrollIntent {
  if (deltaY < 0) return "awayFromBottom";
  if (deltaY > 0) return "towardBottom";
  return "none";
}

/** touch 手指位移与 scrollTop 反向：手指下移表示阅读更早内容。 */
export function timelineTouchScrollIntent(
  previousClientY: number,
  nextClientY: number,
): TimelineUserScrollIntent {
  if (nextClientY > previousClientY) return "awayFromBottom";
  if (nextClientY < previousClientY) return "towardBottom";
  return "none";
}

/** 键盘滚动意图；输入控件内的光标按键不属于 timeline 滚动。 */
export function timelineKeyboardScrollIntent(input: {
  key: string;
  shiftKey: boolean;
  editableTarget: boolean;
}): TimelineUserScrollIntent {
  if (input.editableTarget) return "none";
  if (
    input.key === "ArrowUp" ||
    input.key === "PageUp" ||
    input.key === "Home"
  ) {
    return "awayFromBottom";
  }
  if (
    input.key === "ArrowDown" ||
    input.key === "PageDown" ||
    input.key === "End"
  ) {
    return "towardBottom";
  }
  if (input.key === " ") {
    return input.shiftKey ? "awayFromBottom" : "towardBottom";
  }
  return "none";
}

/**
 * 内容变化 commit 贴底前，对账用户滚动意图。
 *
 * 跟随态由 scroll 事件驱动，但 scroll 事件在滚动发生后的下一渲染帧才派发：
 * 用户上滚（wheel）之后、事件派发之前，若恰好落进一个内容变化的 React
 * commit（流式 delta、补载、渐进挂载批），贴底动作会拿着**过期的
 * following=true** 把 scrollTop 拽回底部——用户的上滚被整体吞掉
 * （「内容 commit 夺走滚动权」）。
 *
 * 对账规则（在贴底动作之前执行，输入为 commit 时刻的实时指标）：
 * 1. 明确向上滚动 → 立即解除跟随，同帧布局 commit 也必须让位；
 * 2. 没有用户输入 → 原样保持 following；
 * 3. 方向未知或向下的用户输入 → 落点在底则恢复跟随，明显回退则解除，其余保持。
 */
export function reconcileFollowingForContentAnchor(input: {
  /** 当前跟随态（scroll 事件驱动的既有值）。 */
  following: boolean;
  /** commit 时刻（贴底动作前）的实时滚动指标。 */
  metrics: TimelineScrollMetrics;
  /** 组件最近一次「已账目」的 scrollTop（scroll 事件读取值或程序化写入后的回读值）。 */
  lastObservedScrollTop: number;
  /** 内容 commit 前捕获到的用户滚动意图；省略时按未知来源对账。 */
  userScrollIntent?: TimelineUserScrollIntent;
  bottomEpsilonPx?: number;
  scrollEpsilonPx?: number;
}): boolean {
  const userScrollIntent = input.userScrollIntent ?? "unknown";
  if (userScrollIntent === "awayFromBottom") return false;
  if (userScrollIntent === "none") return input.following;
  if (
    isAtBottom(input.metrics, input.bottomEpsilonPx ?? BOTTOM_ANCHOR_EPSILON_PX)
  ) {
    return true;
  }
  const unobservedUpscroll =
    input.metrics.scrollTop <
    input.lastObservedScrollTop -
      (input.scrollEpsilonPx ?? UNOBSERVED_SCROLL_EPSILON_PX);
  if (unobservedUpscroll) {
    return false;
  }
  return input.following;
}

/** 会话切换 / 首次绑定：重置为跟随（打开会话定位到最新消息）。 */
export function initialFollowing(): boolean {
  return true;
}
