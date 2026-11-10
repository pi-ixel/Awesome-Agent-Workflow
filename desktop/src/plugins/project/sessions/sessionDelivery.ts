import { projectConversationPageId } from "../workspace/pageIds.ts";
import type { WorkbenchLayout } from "../../workbench/types.ts";
import { pathKey } from "../../../shared/panelPaths.ts";
import type { DesktopProject } from "../lifecycle/project.ts";
import type { SessionDeliveryResult, SessionSelection } from "../types.ts";
import type { SessionTarget } from "./types.ts";

/** Resolve an explicit target and deliver only while it is still the selected one. */
export async function deliverToSession(
  service: Pick<
    DesktopProject,
    "enqueueSessionNavigation" | "workspace" | "foreground" | "openSession"
  >,
  layout: WorkbenchLayout,
  project: string,
  selection: SessionSelection,
  isActive: () => boolean,
  deliver: (owner: SessionTarget, queued: boolean) => boolean,
): Promise<SessionDeliveryResult> {
  if (
    layout.navigationGuard.pending() &&
    !(await layout.navigationGuard.confirm())
  )
    return { ok: false, reason: "已取消切换" };
  if (!isActive() || !layout.navigationGuard.isActive())
    return { ok: false, reason: "发送入口已关闭" };
  const target = selection.kind === "draft" ? null : selection.sessionId;
  return service.enqueueSessionNavigation<SessionDeliveryResult>(
    async (isLatest) => {
      const stillSelected = (): boolean =>
        isLatest() &&
        layout.navigationGuard.isActive() &&
        isActive() &&
        pathKey(layout.navigation.getState().contextPath ?? "") ===
          pathKey(project);
      if (!stillSelected())
        return { ok: false, reason: "项目已切换，请回到原项目后重试" };
      const { session } = service.foreground;
      const state = session.getState();
      const workspace = service.workspace.getState();
      const sameProject =
        pathKey(workspace.activePath ?? "") === pathKey(project);
      const sameTarget =
        target !== null &&
        sameProject &&
        state.activeSessionId === target &&
        state.isBound;
      if (
        !sameTarget &&
        (state.isAgentRunning ||
          state.queuedPrompts.length > 0 ||
          state.isConnecting)
      )
        return {
          ok: false,
          reason: "当前会话仍在运行或有待发消息，请先处理后再切换执行会话",
        };
      let selectedId: string | null = target;
      if (!sameTarget) {
        if (target === null || !sameProject || !state.isBound) {
          workspace.selectWorkspace(project);
          // 新会话先连接草稿，首条消息被接受后再转为正式会话。
          const opened = await service.openSession(
            project,
            target === null
              ? { forceNew: true, draft: true, shouldFocus: stillSelected }
              : { sessionId: target, shouldFocus: stillSelected },
          );
          if (!stillSelected())
            return { ok: false, reason: "项目或会话目标已变化，未发送命令" };
          if (opened === null)
            return {
              ok: false,
              reason:
                service.workspace.getState().lastConnectError?.message ??
                "连接会话失败",
            };
          const id = opened.sessionId;
          service.workspace.getState().openWorkspace(project);
          if (target !== null && id !== target)
            return {
              ok: false,
              reason: "指定会话未能恢复，未发送命令，请重新选择会话",
            };
          selectedId = id;
        } else {
          if (
            (await service.openSession(project, {
              sessionId: target,
              shouldFocus: stillSelected,
            })) === null
          )
            return { ok: false, reason: "无法切换到指定会话，未发送命令" };
          if (!stillSelected())
            return { ok: false, reason: "项目或会话目标已变化，未发送命令" };
          session.getState().openSession(target);
        }
      }
      const current = session.getState();
      if (
        !stillSelected() ||
        pathKey(service.workspace.getState().activePath ?? "") !==
          pathKey(project) ||
        !current.isBound ||
        current.activeSessionId !== selectedId
      )
        return { ok: false, reason: "项目或会话目标已变化，未发送命令" };
      if (current.queuePaused)
        return {
          ok: false,
          reason: "消息队列已暂停，请手动继续或清空队列后再发送",
        };
      if (!current.agentKey) return { ok: false, reason: "会话尚未就绪" };
      const owner = {
        workspacePath: project,
        agentKey: current.agentKey,
        sessionId: selectedId,
      };
      try {
        const accepted = deliver(
          owner,
          current.isAgentRunning || current.queuedPrompts.length > 0,
        );
        if (!accepted)
          return {
            ok: false,
            reason: session.getState().lastError ?? "消息未能发送",
          };
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      if (
        !session.getState().isAgentRunning &&
        session.getState().queuedPrompts.length === 0
      )
        return {
          ok: false,
          reason: session.getState().lastError ?? "消息未能发送",
        };
      layout.navigation.getState().openView(projectConversationPageId, project);
      return { ok: true };
    },
    { ok: false, reason: "项目服务已关闭" },
  );
}
