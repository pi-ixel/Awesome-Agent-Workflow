/** 目标捕获与连接/发送共用串行队列；绝不以连接后的全局选中项替代原目标。 */
import { pathKey } from "../../core/panelPaths.ts";
import { useSessionStore } from "../../stores/sessionStore.ts";
import { useWorkspaceStore } from "../../stores/workspaceStore.ts";
import { useWorkbenchUiStore } from "../../stores/workbenchUiStore.ts";
import { openRealWorkspace, switchRealSession } from "../realRuntime.ts";
import { enqueueSessionOpen } from "../workbench/sessionEntry.ts";
import type { WizardSubmitResult } from "../workbench/wizardSubmit.ts";

export function sendAawToTarget(
  project: string,
  target: string,
  prompt: string,
): Promise<WizardSubmitResult> {
  return enqueueSessionOpen(async (isLatest) => {
    const stillSelected = (): boolean =>
      isLatest() &&
      pathKey(useWorkbenchUiStore.getState().contextPath ?? "") ===
        pathKey(project);
    if (!stillSelected())
      return { ok: false, reason: "项目已切换，请回到原项目后重试" };
    const state = useSessionStore.getState();
    const workspace = useWorkspaceStore.getState();
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
        const opened = await openRealWorkspace(
          project,
          target === "new"
            ? { forceNew: true, draft: true }
            : { sessionId: target },
        );
        if (opened === null)
          return {
            ok: false,
            reason:
              useWorkspaceStore.getState().lastConnectError?.message ??
              "连接会话失败",
          };
        const id = opened.sessionId;
        useWorkspaceStore.getState().openWorkspace(project);
        if (target !== "new" && id !== target)
          return {
            ok: false,
            reason: "指定会话未能恢复，未发送命令，请重新选择会话",
          };
        selectedId = id;
      } else {
        if (!(await switchRealSession(target)))
          return { ok: false, reason: "无法切换到指定会话，未发送命令" };
        useSessionStore.getState().openSession(target);
      }
    }
    const current = useSessionStore.getState();
    if (
      !stillSelected() ||
      pathKey(useWorkspaceStore.getState().activePath ?? "") !==
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
    if (current.isAgentRunning || current.queuedPrompts.length > 0)
      current.enqueuePrompt(prompt);
    else current.sendPrompt(prompt);
    if (
      !useSessionStore.getState().isAgentRunning &&
      useSessionStore.getState().queuedPrompts.length === 0
    )
      return {
        ok: false,
        reason: useSessionStore.getState().lastError ?? "消息未能发送",
      };
    useWorkbenchUiStore.getState().openSessionView(project);
    return { ok: true };
  });
}
