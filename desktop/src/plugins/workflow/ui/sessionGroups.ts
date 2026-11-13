/**
 * 运行 → 侧栏会话分组（project 扩展点 registerSessionGroups 的工作流发布方）。
 *
 * - 一次运行一个分组：标题是运行标题（缺省取需求第一行），悬停提示带工作流名；
 * - 组内按角色列出 Agent 会话（同一角色跨节点复用同一个会话），附注写它
 *   最近处理的节点与轮次；
 * - 引擎标记「在等用户回复」的会话与它所在的分组带「等你回复」胶囊，替换
 *   会话自身误导人的「已完成未读」点；
 * - 进行中的运行里，节点都已做完的角色会话标为 done（侧栏收进「已完成」）；
 *   之后再被派活（如设计修正）会重新回到眼前；
 * - 进行中的运行默认展开，已结束的默认收起。
 */
import type { SessionGroup, SessionGroupMember, SessionGroupStatus } from "../../project/service.ts";
import type { RunSessionLink, RunSessionLinks } from "../types.ts";

export const AWAITING_INPUT_CHIP = "等你回复";

const groupStatus = (run: RunSessionLinks, waiting: boolean): SessionGroupStatus => {
  if (run.active) return waiting ? "waiting" : "running";
  if (run.status === "completed") return "completed";
  if (run.status === "failed") return "failed";
  return "stopped";
};

function member(link: RunSessionLink, active: boolean): SessionGroupMember {
  const latest = link.nodes[link.nodes.length - 1];
  const waiting = active && link.nodes.some((node) => node.status === "running" && node.awaitingInput);
  // 运行已结束时整组本就收起，不再区分。
  const done = active && link.nodes.length > 0 && link.nodes.every((node) => node.status !== "running");
  const note = latest
    ? `${latest.label}${latest.ordinal > 1 ? ` 第 ${latest.ordinal} 轮` : ""}`
    : undefined;
  return {
    sessionId: link.sessionId,
    title: link.actorName || "Agent",
    // 角色名与节点名相同（单节点角色）时不重复写。
    ...(note && note !== link.actorName ? { note } : {}),
    ...(waiting ? { attention: AWAITING_INPUT_CHIP } : {}),
    ...(done ? { done } : {}),
  };
}

export function runSessionGroups(
  runs: readonly RunSessionLinks[],
  open: (runId: string) => void,
): SessionGroup[] {
  return runs.map((run) => {
    const members = run.links.map((link) => member(link, run.active));
    const waiting = members.some((item) => item.attention !== undefined);
    return {
      id: run.runId,
      title: run.title || `${run.workflowName || "工作流"} · ${run.runId.slice(0, 8)}`,
      status: groupStatus(run, waiting),
      ...(waiting ? { attention: AWAITING_INPUT_CHIP } : {}),
      members,
      defaultExpanded: run.active,
      open: () => open(run.runId),
      openLabel: "在 AAW 面板中查看",
    };
  });
}
