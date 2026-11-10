import type { WorkflowService } from "../service.ts";
import type { ProjectSessions } from "../../project/service.ts";
import type { SessionDeliveryResult } from "../../project/types.ts";

export function sendAawToTarget(
  sessions: Pick<ProjectSessions, "deliverToSession">,
  workflow: Pick<WorkflowService, "isActive" | "submit">,
  project: string,
  target: string,
  prompt: string,
): Promise<SessionDeliveryResult> {
  if (!workflow.isActive())
    return Promise.resolve({ ok: false, reason: "工作流服务尚未就绪" });
  return sessions.deliverToSession(
    project,
    target === "new" ? { kind: "draft" } : { kind: "history", sessionId: target },
    () => workflow.isActive(),
    (owner, queued) => workflow.submit(owner, prompt, queued),
  );
}
