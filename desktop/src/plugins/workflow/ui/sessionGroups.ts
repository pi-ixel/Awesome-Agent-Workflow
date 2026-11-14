/**
 * 运行 → 侧栏会话分组（project 扩展点 registerSessionGroups 的工作流发布方）。
 *
 * - 一次运行一个分组：标题是运行标题（缺省取需求第一行），悬停提示带工作流名；
 * - 组内按执行顺序列出 Agent 会话（同一角色跨节点复用同一个会话），名字是它
 *   最近在做的那一步（与画布同名），第 2 轮起附注轮次；
 * - 引擎标记「在等用户回复」的会话与它所在的分组带「等你回复」胶囊，替换
 *   会话自身误导人的「已完成未读」点；
 * - 进行中的运行里，节点都已做完的角色会话标为 done（侧栏收进「已完成」）；
 *   之后再被派活（如设计修正）会重新回到眼前；
 * - 进行中的运行默认展开，已结束的默认收起。
 */
import type { SessionGroup, SessionGroupMember, SessionGroupStatus } from "../../project/service.ts";
import type { RunSessionLink, RunSessionLinks } from "../types.ts";

export const AWAITING_INPUT_CHIP = "等你回复";
/** 运行停在确认关卡上（ADR 031）。 */
export const AWAITING_CONFIRM_CHIP = "等你确认";

const groupStatus = (run: RunSessionLinks, waiting: boolean): SessionGroupStatus => {
  if (run.active) return waiting ? "waiting" : "running";
  if (run.status === "waiting") return "waiting";
  if (run.status === "completed") return "completed";
  if (run.status === "failed") return "failed";
  return "stopped";
};

function member(link: RunSessionLink, active: boolean, openSession?: (sessionId: string) => void): SessionGroupMember {
  const latest = link.nodes[link.nodes.length - 1];
  const waiting = active && link.nodes.some((node) => node.status === "running" && node.awaitingInput);
  // 运行已结束时整组本就收起，不再区分。
  const done = active && link.nodes.length > 0 && link.nodes.every((node) => node.status !== "running");
  const note = latest && latest.ordinal > 1 ? `第 ${latest.ordinal} 轮` : undefined;
  return {
    sessionId: link.sessionId,
    ...(openSession ? { open: () => openSession(link.sessionId) } : {}),
    // 和画布上的步骤同名：写它最近在做的那一步，而不是内部角色名。
    title: latest?.label || link.actorName || "Agent",
    ...(note ? { note } : {}),
    ...(waiting ? { attention: AWAITING_INPUT_CHIP } : {}),
    ...(done ? { done } : {}),
  };
}

export function runSessionGroups(
  runs: readonly RunSessionLinks[],
  open: (runId: string) => void,
  openSession?: (sessionId: string) => void,
  archive?: (runId: string) => void,
): SessionGroup[] {
  return runs.map((run) => {
    if (run.archived) return { id: run.runId, title: run.title, status: "idle", members: run.links.map((link) => ({ sessionId: link.sessionId, title: link.actorName })), hidden: true };
    const members = run.links.map((link) => member(link, run.active, openSession));
    const waiting = members.some((item) => item.attention !== undefined);
    const confirming = !run.active && run.status === "waiting";
    return {
      id: run.runId,
      title: run.title || `${run.workflowName || "工作流"} · ${run.runId.slice(0, 8)}`,
      status: groupStatus(run, waiting),
      ...(waiting ? { attention: AWAITING_INPUT_CHIP } : confirming ? { attention: AWAITING_CONFIRM_CHIP } : {}),
      members,
      defaultExpanded: run.active || confirming,
      open: () => open(run.runId),
      openLabel: "在 AAW 面板中查看",
      // 进行中的运行不能归档（引擎同样拒绝）。
      ...(archive && !run.active ? { archive: () => archive(run.runId), archiveLabel: "归档这次运行" } : {}),
    };
  });
}
