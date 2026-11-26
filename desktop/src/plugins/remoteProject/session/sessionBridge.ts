import type {
  McpServer,
  RequestPermissionOutcome,
} from "../../../contracts/acp/protocol.ts";
import type { PermissionOption } from "../../acpRuntime/types.ts";
import type {
  SessionToolContext,
  SessionToolProvider,
} from "../../project/service.ts";
import { isRemoteProjectPath, pathName } from "../../../shared/panelPaths.ts";
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
    const oldText =
      typeof input["old_text"] === "string" ? input["old_text"] : "";
    const newText =
      typeof input["new_text"] === "string" ? input["new_text"] : "";
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
    const content =
      typeof input["content"] === "string" ? input["content"] : "";
    const isNew = input["isNew"] === true;
    return {
      toolCallId: event.requestId,
      title:
        event.summary ||
        (isNew ? `新建远端文件 ${path}` : `写入远端文件 ${path}`),
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
  async function provide(
    context: SessionToolContext,
  ): Promise<readonly McpServer[]> {
    if (!isRemoteProjectPath(context.workspacePath)) {
      return [];
    }
    const record = service.getByPath(context.workspacePath);
    if (!record) {
      return [];
    }

    const related = (context.relatedProjects ?? []).map((path) => {
      const project = service.getByPath(path);
      if (!project || project.connectionId !== record.connectionId)
        throw new Error("关联的远程项目必须使用同一条 SSH 连接");
      return project;
    });
    const servers: McpServer[] = [];
    for (const [index, project] of [record, ...related].entries()) {
      const binding = await service.bindSessionMcp({
        projectId: project.projectId,
        connectionId: project.connectionId,
        remoteRoot: project.remoteRoot,
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
            const toolCall = buildToolCallForApproval(event);
            const outcome = await context.requestPermission(
              related.length
                ? {
                    ...toolCall,
                    title: `${pathName(project.remoteRoot)} · ${String(toolCall.title)}`,
                  }
                : toolCall,
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
        await service.unbindSessionMcp(binding.token);
      });

      servers.push({
        type: "http",
        name:
          index === 0
            ? "aaw-remote-project"
            : `aaw-remote-project-${index + 1}`,
        url: binding.url,
        headers: [{ name: "Authorization", value: `Bearer ${binding.token}` }],
      });
    }
    context.onRemoteScopeBound?.();
    return servers;
  }
  return Object.assign(provide, {
    connectionForProject: (path: string) =>
      service.getByPath(path)?.connectionId,
  });
}
