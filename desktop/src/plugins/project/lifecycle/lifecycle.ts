import type { ProjectService } from "../service.ts";
import type { WorkbenchExit } from "../../workbench/types.ts";

export function registerProjectExit(
  exit: WorkbenchExit,
  project: Pick<ProjectService, "prepareExit"> & {
    readonly sessions: Pick<ProjectService["sessions"], "hasRunningSessions">;
    readonly conversation: Pick<ProjectService["conversation"], "foreground">;
  },
): () => void {
  return exit.registerExit({
    id: "project",
    describeWork: () => {
      const { session, approval } = project.conversation.foreground;
      if (approval.getState().pending.length > 0)
        return "有审批等待处理，更新会关闭对应会话。";
      if (session.getState().isAgentRunning)
        return "有会话正在执行，更新会中断该会话。";
      return project.sessions.hasRunningSessions()
        ? "后台仍有会话、审批或重连正在处理，更新会中断这些操作。"
        : null;
    },
    prepare: (reason, force) => project.prepareExit(reason, force),
  });
}
