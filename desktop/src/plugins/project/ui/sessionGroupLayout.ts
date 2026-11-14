/**
 * 项目子节点的排列（纯函数）：把属于某个分组的会话收进分组项。
 *
 * - 仍在运行 / 等人处理的分组固定在最前（按发布方给出的顺序）——它们是
 *   眼下要看的，不能被大量历史会话挤到「加载更多」后面；
 * - 已结束的分组占它组内最近一条会话在列表里的位置（列表本身按最近活动排序）；
 * - 组内会话还没出现在列表里的已结束分组也放最前；
 * - 一个会话属于多个分组时归第一个分组；归档的会话不出现；
 * - 没有成员的分组只在仍在运行 / 等人处理时保留（否则是空壳）；
 * - 已归档（hidden）的分组不出现，组内会话也一起隐去。
 */
import type { SessionSummary } from "../conversation/sessionStore.ts";
import type { SessionGroup, SessionGroupMember } from "../sessions/sessionGroups.ts";

export type SessionChildItem =
  | { readonly kind: "session"; readonly session: SessionSummary }
  | {
    readonly kind: "group";
    readonly group: SessionGroup;
    readonly members: readonly { readonly member: SessionGroupMember; readonly session: SessionSummary }[];
  };

export function arrangeSessionChildren(
  sessions: readonly SessionSummary[],
  groups: readonly SessionGroup[],
  isArchived: (sessionId: string) => boolean,
): SessionChildItem[] {
  const owner = new Map<string, number>();
  groups.forEach((group, index) => {
    for (const member of group.members) {
      if (!owner.has(member.sessionId)) owner.set(member.sessionId, index);
    }
  });
  const listed = new Map(sessions.map((session) => [session.id, session]));
  const groupItem = (index: number): SessionChildItem & { kind: "group" } => {
    const group = groups[index]!;
    return {
      kind: "group",
      group,
      members: group.members
        .filter((member) => owner.get(member.sessionId) === index && !isArchived(member.sessionId))
        .map((member) => ({
          member,
          session: listed.get(member.sessionId) ?? { id: member.sessionId, title: member.title, updatedAt: null },
        })),
    };
  };
  // 进行中、或带提醒胶囊（等你回复 / 确认 / 处理）的分组固定在最上面，不被新会话挤到「加载更多」后面。
  const isLive = (group: SessionGroup) => group.status === "running" || group.status === "waiting" || group.attention !== undefined;
  const keep = (item: SessionChildItem & { kind: "group" }) => item.members.length > 0 || isLive(item.group);

  const items: SessionChildItem[] = [];
  const placed = new Set<number>();
  groups.forEach((group, index) => {
    if (group.hidden) {
      placed.add(index);
      return;
    }
    const anyListed = group.members.some((member) => owner.get(member.sessionId) === index && listed.has(member.sessionId));
    if (anyListed && !isLive(group)) return;
    placed.add(index);
    const item = groupItem(index);
    if (keep(item)) items.push(item);
  });
  for (const session of sessions) {
    if (isArchived(session.id)) continue;
    const index = owner.get(session.id);
    if (index === undefined) {
      items.push({ kind: "session", session });
      continue;
    }
    if (placed.has(index)) continue;
    placed.add(index);
    const item = groupItem(index);
    if (keep(item)) items.push(item);
  }
  return items;
}
