/**
 * 运行 → 侧栏会话分组（project 扩展点 registerSessionGroups 的工作流发布方）。
 *
 * - 一次运行一个分组：标题是运行标题（缺省取需求第一行），悬停提示带工作流名；
 * - 组内按执行顺序列出 Agent 会话（同一角色跨节点复用同一个会话），名字是它
 *   最近在做的那一步（与画布同名），第 2 轮起附注轮次；
 * - 要你去会话里做点什么的会话（等你回复、你打断了、Agent 出错、等你处理）
 *   与它所在的分组带胶囊，说法与会话一致（ADR 040，status/nodeActivity.ts）；
 * - 已经叫停、还没停下来的运行写「正在停止」；
 * - 进行中的运行里，节点都已做完的角色会话标为 done（侧栏收进「已完成」）；
 *   之后再被派活（如设计修正）会重新回到眼前；
 * - 进行中的运行默认展开，已结束的默认收起。
 */
import { ACTIVITY_WORD, leadingActivity, needsYou, nodeActivity, type NodeActivity } from "../status/nodeActivity.ts";
import type { SessionLookup } from "../status/snapshot.ts";
import type { SessionGroup, SessionGroupMember, SessionGroupStatus } from "../../project/service.ts";
import type { RunSessionLink, RunSessionLinks } from "../types.ts";

export const AWAITING_INPUT_CHIP = ACTIVITY_WORD.awaiting;
/** 已经叫停、执行还没停下来（ADR 040）。 */
export const STOPPING_CHIP = "正在停止";
/** 运行停在确认关卡上（ADR 031）。 */
export const AWAITING_CONFIRM_CHIP = "等你确认";
/** 流程走到停下的去向（阻塞），等你去面板上处理；和运行列表同词。 */
export const BLOCKED_CHIP = "已阻塞";
/** 运行出错停下，等你去处理（重跑、跳过或归档）。 */
export const STOPPED_ON_ERROR_CHIP = "出错停下";

const groupStatus = (run: RunSessionLinks, waiting: boolean): SessionGroupStatus => {
  if (run.active) return waiting ? "waiting" : "running";
  if (run.status === "waiting" || run.status === "blocked") return "waiting";
  if (run.status === "completed") return "completed";
  if (run.status === "failed") return "failed";
  return "stopped";
};

/** 这个会话里的节点此刻最需要你的那个活动（ADR 040）。 */
export function linkActivity(link: RunSessionLink, active: boolean, session?: SessionLookup): NodeActivity | null {
  const status = session?.(link.sessionId);
  return leadingActivity(link.nodes.map((node) => nodeActivity(node, active, status)));
}

function member(link: RunSessionLink, active: boolean, foldDone: boolean, openSession?: (sessionId: string) => void, session?: SessionLookup): SessionGroupMember {
  const latest = link.nodes[link.nodes.length - 1];
  const activity = linkActivity(link, active, session);
  const waiting = needsYou(activity);
  // 运行已结束时整组本就收起，不再区分。
  const done = foldDone && link.nodes.length > 0 && link.nodes.every((node) => node.status !== "running");
  const note = latest && latest.ordinal > 1 ? `第 ${latest.ordinal} 轮` : undefined;
  return {
    sessionId: link.sessionId,
    ...(openSession ? { open: () => openSession(link.sessionId) } : {}),
    // 和画布上的步骤同名：写它最近在做的那一步，而不是内部角色名。
    title: latest?.label || link.actorName || "Agent",
    ...(note ? { note } : {}),
    ...(waiting
      ? {
          attention: ACTIVITY_WORD[activity!],
          attentionTone: activity === "failed" ? ("danger" as const) : ("warn" as const),
        }
      : {}),
    ...(done ? { done } : {}),
  };
}

export function runSessionGroups(
  runs: readonly RunSessionLinks[],
  open: (runId: string) => void,
  openSession?: (sessionId: string, runId: string) => void,
  archive?: (runId: string) => void,
  session?: SessionLookup,
): SessionGroup[] {
  return runs.map((run) => {
    if (run.archived) return { id: run.runId, title: run.title, status: "idle", members: run.links.map((link) => ({ sessionId: link.sessionId, title: link.actorName })), hidden: true };
    // 停下等你确认时也收起做完的会话，不让十几个会话一下全摊开。
    const stopping = run.active && run.stopping === true;
    const openMember = openSession ? (sessionId: string) => openSession(sessionId, run.runId) : undefined;
    const members = run.links.map((link) => member(link, run.active && !stopping, run.active || run.status === "waiting", openMember, session));
    const waiting = members.some((item) => item.attention !== undefined);
    const leadMember = members.find((item) => item.attention !== undefined);
    const confirming = !run.active && run.status === "waiting";
    const blocked = !run.active && run.status === "blocked";
    const failedStop = !run.active && run.status === "stopped" && run.failed === true;
    return {
      id: run.runId,
      title: run.title || `${run.workflowName || "工作流"} · ${run.runId.slice(0, 8)}`,
      status: groupStatus(run, waiting),
      ...(stopping
        ? { attention: STOPPING_CHIP, attentionTone: "neutral" as const }
        : waiting && leadMember?.attention
          ? { attention: leadMember.attention, attentionTone: leadMember.attentionTone ?? ("warn" as const) }
          : confirming
            ? { attention: AWAITING_CONFIRM_CHIP, attentionTone: "warn" as const }
            : blocked
              ? { attention: BLOCKED_CHIP, attentionTone: "warn" as const }
              : failedStop
                ? { attention: STOPPED_ON_ERROR_CHIP, attentionTone: "danger" as const }
                : {}),
      members,
      defaultExpanded: run.active || confirming,
      open: () => open(run.runId),
      openLabel: "在 AAW 面板中查看",
      // 进行中的运行不能归档（引擎同样拒绝）。
      ...(archive && !run.active ? { archive: () => archive(run.runId), archiveLabel: "归档这次运行" } : {}),
    };
  });
}
