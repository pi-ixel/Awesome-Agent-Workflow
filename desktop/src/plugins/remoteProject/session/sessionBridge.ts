import type {
  McpServer,
  RequestPermissionOutcome,
} from "../../../contracts/acp/protocol.ts";
import type { PermissionOption } from "../../acpRuntime/types.ts";
import type {
  SessionToolContext,
  SessionToolProvider,
} from "../../project/service.ts";
import { isRemoteProjectPath } from "../../../shared/panelPaths.ts";
import type {
  RemoteApprovalRequestEvent,
  RemoteProjectService,
} from "../service.ts";

const APPROVAL_OPTIONS: readonly PermissionOption[] = [
  { optionId: "allow-once", name: "允许本次操作", kind: "allow_once" },
  { optionId: "reject-once", name: "拒绝", kind: "reject_once" },
];

function buildToolCallForApproval(
  event: RemoteApprovalRequestEvent,
): Readonly<Record<string, unknown>> {
  const input = event.input ?? {};
  const path = typeof input["path"] === "string" ? input["path"] : "";
  if (event.tool === "edit_file") {
    const oldText = typeof input["old_text"] === "string" ? input["old_text"] : "";
    const newText = typeof input["new_text"] === "string" ? input["new_text"] : "";
    return {
      toolCallId: event.requestId,
      title: event.summary || `修改远端文件 ${path}`,
      kind: "edit",
      rawInput: input,
      content: [
        {
          type: "diff",
          path,
          oldText,
          newText,
        },
      ],
    };
  }
  if (event.tool === "write_file") {
    const content = typeof input["content"] === "string" ? input["content"] : "";
    const isNew = input["isNew"] === true;
    return {
      toolCallId: event.requestId,
      title: event.summary || (isNew ? `新建远端文件 ${path}` : `写入远端文件 ${path}`),
      kind: "edit",
      rawInput: input,
      content: [
        {
          type: "diff",
          path,
          oldText: isNew ? "" : undefined,
          newText: content,
        },
      ],
    };
  }
  return {
    toolCallId: event.requestId,
    title: event.summary || `运行远端命令`,
    kind: "execute",
    rawInput: input,
  };
}

function isPermissionApproved(outcome: RequestPermissionOutcome): boolean {
  return outcome.outcome === "selected" && outcome.optionId === "allow-once";
}

export function createRemoteSessionToolProvider(
  service: Pick<
    RemoteProjectService,
    | "getByPath"
    | "bindSessionMcp"
    | "unbindSessionMcp"
    | "replyApproval"
    | "onApprovalRequest"
  >,
): SessionToolProvider {
  return async (context: SessionToolContext): Promise<readonly McpServer[]> => {
    if (!isRemoteProjectPath(context.workspacePath)) {
      return [];
    }
    const record = service.getByPath(context.workspacePath);
    if (!record) {
      return [];
    }

    const binding = await service.bindSessionMcp({
      projectId: record.projectId,
      connectionId: record.connectionId,
      remoteRoot: record.remoteRoot,
      sessionHint: context.sessionId ?? `draft-${record.projectId}`,
    });

    const unlistenApproval = service.onApprovalRequest((event) => {
      if (event.token !== binding.token) return;
      void (async () => {
        try {
          if (!context.requestPermission) {
            await service.replyApproval(
              event.requestId,
              false,
              "当前会话审批入口不可用，已拒绝执行",
            );
            return;
          }
          const outcome = await context.requestPermission(
            buildToolCallForApproval(event),
            APPROVAL_OPTIONS,
          );
          const approved = isPermissionApproved(outcome);
          await service.replyApproval(
            event.requestId,
            approved,
            approved ? "" : "用户在会话中拒绝了该远端项目操作",
          );
        } catch (error) {
          await service
            .replyApproval(
              event.requestId,
              false,
              error instanceof Error ? error.message : String(error),
            )
            .catch(() => undefined);
        }
      })();
    });

    context.onDispose?.(async () => {
      unlistenApproval();
      await service.unbindSessionMcp(binding.token).catch(() => undefined);
    });

    const server: McpServer = {
      type: "http",
      name: "aaw-remote-project",
      url: binding.url,
      headers: [{ name: "Authorization", value: `Bearer ${binding.token}` }],
    };
    return [server];
  };
}
