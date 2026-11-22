/**
 * 节点在会话里正在干什么（ADR 040）。所有界面——运行面板、画布、侧栏分组、
 * 输入框上的工作流条、状态卡、系统通知——只用这一个函数得出说法。
 *
 * 会话是唯一来源：会话视图显示什么（工作中 / 你打断了 / 出错 / 等你处理权限），
 * 工作流就说什么，两边读的是同一份会话状态，所以不会一边说「工作中」一边说
 * 「等你回复」。会话还没在这个窗口里打开时（例如应用刚启动），退回到引擎记下
 * 的最近一轮情况——那也是会话早先报给引擎的原话，不是引擎的推测。
 */
import type { ReadonlySnapshot } from "../../../shared/state/readonlySnapshot.ts";

/** 会话自己的状态（project 插件的会话活动，侧栏会话圆点用的同一份）。 */
export type SessionTurnStatus = "running" | "waiting" | "completed" | "failed" | "cancelled" | "idle";

/** 会话活动的只读快照（结构上与 project 的 `sessions.activity` 一致）。 */
export type SessionActivitySource = ReadonlySnapshot<{
  readonly entries: Readonly<Record<string, {
    readonly sessionId: string;
    readonly status: SessionTurnStatus;
  }>>;
}>;

export type NodeActivity =
  /** Agent 在干活（或这一步刚开始、说明正在送进会话）。 */
  | "working"
  /** Agent 停下来了、没交结果：在等你在会话里回复。 */
  | "awaiting"
  /** Agent 在会话里等你处理权限或问题。 */
  | "asking"
  /** 你在会话里打断了 Agent。 */
  | "interrupted"
  /** 这一轮出错了（网络断开等），可在会话里重试。 */
  | "failed";

export const ACTIVITY_WORD: Readonly<Record<NodeActivity, string>> = {
  working: "进行中",
  awaiting: "等你回复",
  asking: "等你处理",
  interrupted: "你打断了",
  failed: "Agent 出错",
};

/** 节点卡片 / 检视器上的附注（说清楚要你去会话里做什么）。 */
export const ACTIVITY_NOTE: Readonly<Record<NodeActivity, string>> = {
  working: "进行中",
  awaiting: "等你在会话里回复",
  asking: "等你在会话里处理",
  interrupted: "你在会话里打断了 Agent",
  failed: "Agent 出错，可在会话里重试",
};

/** 要你去会话里做点什么。 */
export const needsYou = (activity: NodeActivity | null): boolean => activity !== null && activity !== "working";

/** 节点上引擎给的事实（快照节点与会话关联节点都有这几项）。 */
export interface NodeFacts {
  readonly status: string;
  /** 引擎记下的最近一轮：working / completed / cancelled / failed；这一步还没开始过一轮时为空。 */
  readonly turn?: string | null;
  /** 已经交了结果、还没被采用（正在收尾）。 */
  readonly submitted?: boolean;
}

const fromEngine: Readonly<Record<string, SessionTurnStatus>> = {
  working: "running",
  completed: "completed",
  cancelled: "cancelled",
  failed: "failed",
};

/**
 * 节点此刻的活动；不在执行中（运行停着、这一步做完了）时为 null。
 * `session` 是这个节点会话的实时状态，没在这个窗口里打开时为 undefined。
 */
export function nodeActivity(node: NodeFacts, runActive: boolean, session: SessionTurnStatus | undefined): NodeActivity | null {
  if (!runActive || node.status !== "running") return null;
  // 这一步还没在会话里开始过一轮：说明正在送进会话。会话上残留的上一件事
  // （例如发起运行前你和 Agent 聊完的那一轮）不算这一步的。
  if (node.turn == null) return "working";
  // 「空闲」只是这个窗口还没见过这个会话的一轮（例如页面刚重载、会话刚接回），
  // 不是一轮的结束方式：退回会话早先报给引擎的那份。
  const live = session === undefined || session === "idle" ? undefined : session;
  switch (live ?? fromEngine[node.turn] ?? "running") {
    case "running":
      return "working";
    case "waiting":
      return "asking";
    case "failed":
      return "failed";
    case "cancelled":
      return "interrupted";
    default:
      // 停下来了：交了结果就是在收尾，没交就是在等你回复。
      return node.submitted === true ? "working" : "awaiting";
  }
}

/** 从会话活动里找一个会话的状态。会话 id 由 Agent 生成、全局唯一，不必再按项目区分。 */
export function sessionStatusOf(
  state: ReturnType<SessionActivitySource["getState"]> | undefined,
  sessionId: string | null | undefined,
): SessionTurnStatus | undefined {
  if (!state || !sessionId) return undefined;
  for (const entry of Object.values(state.entries)) {
    if (entry.sessionId === sessionId) return entry.status;
  }
  return undefined;
}

/** 一组节点里最需要你的那个活动（同一会话、同一次运行汇总用）：要你处理的优先，其次在干活。 */
export function leadingActivity(activities: readonly (NodeActivity | null)[]): NodeActivity | null {
  const order: readonly NodeActivity[] = ["failed", "asking", "awaiting", "interrupted", "working"];
  for (const activity of order) {
    if (activities.includes(activity)) return activity;
  }
  return null;
}
