import type { WorkflowService } from "../../../contracts/workflow.ts";
import type { WorkbenchLayout } from "../../../contracts/workbench.ts";
/** 目标捕获与连接/发送共用串行队列；绝不以连接后的全局选中项替代原目标。 */
import { pathKey } from "../../../shared/panelPaths.ts";
import type { ProjectService } from "../../../contracts/project.ts";
import type { WizardSubmitResult } from "./wizardSubmit.ts";

export function sendAawToTarget(
  service:
    | Pick<
        ProjectService,
        "enqueueSessionNavigation" | "openSession" | "workspace" | "foreground"
      >
    | undefined,
  workflow: Pick<WorkflowService, "isActive" | "submit"> | undefined,
  layout: WorkbenchLayout | undefined,
  project: string,
  target: string,
  prompt: string,
): Promise<WizardSubmitResult> {
  if (!service)
    return Promise.resolve({ ok: false, reason: "项目服务尚未就绪" });
  if (!workflow?.isActive())
    return Promise.resolve({ ok: false, reason: "工作流服务尚未就绪" });
  if (!layout?.navigationGuard.isActive())
    return Promise.resolve({ ok: false, reason: "工作台尚未就绪" });
  if (layout.navigationGuard.pending())
    return layout.navigationGuard
      .confirm()
      .then((allowed) =>
        allowed
          ? sendAawToTarget(service, workflow, layout, project, target, prompt)
          : { ok: false, reason: "已取消切换" },
      );
  return service.enqueueSessionNavigation<WizardSubmitResult>(
    async (isLatest) => {
      const stillSelected = (): boolean =>
        isLatest() &&
        layout.navigationGuard.isActive() &&
        workflow.isActive() &&
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
        target !== "new" &&
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
        if (target === "new" || !sameProject || !state.isBound) {
          workspace.selectWorkspace(project);
          // new 走草稿：会话待 AAW 命令真正发送时创建（sendPrompt 转正）
          const opened = await service.openSession(
            project,
            target === "new"
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
          if (target !== "new" && id !== target)
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
        const accepted = workflow.submit(
          owner,
          prompt,
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
      layout.navigation.getState().openSessionView(project);
      return { ok: true };
    },
    { ok: false, reason: "项目服务已关闭" },
  );
}
