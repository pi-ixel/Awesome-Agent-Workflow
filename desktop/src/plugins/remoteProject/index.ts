import type { Context } from "cordis";
import type {} from "../mcp/service.ts";
import type { GitDiff, GitSnapshot } from "../host/types.ts";
import type { RemoteProjectService } from "./service.ts";
import type {
  RemoteApprovalRequestEvent,
  RemoteConnectionDTO,
  RemoteConnectionTestResult,
  RemoteExecResult,
  RemoteFSEntry,
  RemoteFSListResult,
  RemoteFilePreviewResult,
  RemoteFileReadResult,
  RemoteFileWriteResult,
  RemoteMcpBindResult,
  RemoteTerminalPrepareResult,
} from "./types.ts";
import { OpsSidecarClient } from "./sidecar/client.ts";
import { createRemoteProjectStore } from "./store/remoteProjectStore.ts";
import { createRemoteDocumentFileProvider } from "./fs/remoteFileProvider.ts";
import { createRemoteGitProvider } from "./git/remoteGitProvider.ts";
import * as workbenchUi from "./ui/workbench.tsx";

export const name = "remoteProject";
export const inject = ["host", "diagnostics"];

export function apply(ctx: Context): void {
  const logger = ctx.diagnostics.createLogger("remoteProject");
  const sidecar = new OpsSidecarClient(ctx.host.opsSidecar, logger);
  const store = createRemoteProjectStore(ctx.host.storage, logger);

  const service: RemoteProjectService = {
    projects: store.snapshot,
    getByPath: store.getByPath,
    getById: store.getById,
    listProjectsForConnection: store.listProjectsForConnection,
    addProject: store.addProject,
    saveProjectGroup: store.saveProjectGroup,
    repairProject(path, connectionId, relatedPaths = []) {
      return store.repairProjectGroup(
        path,
        connectionId,
        relatedPaths,
        async (root) => {
          const entry = await service.stat(connectionId, root);
          if (!entry.directory) throw new Error(`原远端路径不是目录：${root}`);
        },
      );
    },
    removeProjectByPath: store.removeProjectByPath,
    recordRecentDir: store.recordRecentDir,
    async listConnections() {
      const data = await sidecar.request<{
        readonly connections?: readonly RemoteConnectionDTO[];
      }>("project/connections-list");
      return data?.connections ?? [];
    },
    async createConnection(input) {
      const data = await sidecar.request<{
        readonly connection: RemoteConnectionDTO;
      }>("project/connection-create", { ...input });
      return data.connection;
    },
    async updateConnection(id, input) {
      const data = await sidecar.request<{
        readonly connection: RemoteConnectionDTO;
      }>("project/connection-update", { id, ...input });
      return data.connection;
    },
    async deleteConnection(id) {
      const refs = store.listProjectsForConnection(id);
      if (refs.length > 0) {
        throw new Error(
          `该连接仍被 ${refs.length} 个远程项目引用（${refs.map((r) => r.name).join("、")}），请先移除相关项目`,
        );
      }
      await sidecar.request("project/connection-delete", { id });
      await store.removeConnectionMetadata(id);
    },
    async testConnection(params) {
      return sidecar.request<RemoteConnectionTestResult>(
        "project/connection-test",
        { ...params },
      );
    },
    listDirectory(connectionId, path) {
      return sidecar.request<RemoteFSListResult>(
        "project/fs-list",
        { connectionId, path },
      );
    },
    async stat(connectionId, path) {
      return sidecar.request<RemoteFSEntry>("project/fs-stat", {
        connectionId,
        path,
      });
    },
    async preview(connectionId, path) {
      return sidecar.request<RemoteFilePreviewResult>("project/fs-preview", {
        connectionId,
        path,
      });
    },
    async listWorkspaceFiles(connectionId, root) {
      const data = await sidecar.request<{ readonly paths?: readonly string[] }>(
        "project/fs-list-files",
        { connectionId, root },
      );
      return data?.paths ?? [];
    },
    async readFile(connectionId, path) {
      return sidecar.request<RemoteFileReadResult>("project/fs-read", {
        connectionId,
        path,
      });
    },
    async writeFile(params) {
      return sidecar.request<RemoteFileWriteResult>("project/fs-write", {
        ...params,
      });
    },
    async execCommand(params) {
      return sidecar.request<RemoteExecResult>(
        "project/exec",
        { ...params },
        180_000,
      );
    },
    async cancelCommand(opId) {
      const data = await sidecar.request<{ readonly cancelled?: boolean }>(
        "project/exec-cancel",
        { opId },
      );
      return data?.cancelled === true;
    },
    async gitStatus(connectionId, remoteRoot) {
      return sidecar.request<GitSnapshot>("project/git-status", {
        connectionId,
        remoteRoot,
      });
    },
    async gitDiff(connectionId, remoteRoot, change) {
      return sidecar.request<GitDiff>("project/git-diff", {
        connectionId,
        remoteRoot,
        path: change.path,
        source: change.source,
      });
    },
    async bindSessionMcp(params) {
      return sidecar.request<RemoteMcpBindResult>("project/mcp-bind", {
        ...params,
      });
    },
    async unbindSessionMcp(token) {
      await sidecar.request("project/mcp-unbind", { token });
    },
    async replyApproval(requestId, approved, reason) {
      await sidecar.request("project/approval-reply", {
        requestId,
        approved,
        ...(reason ? { reason } : {}),
      });
    },
    onApprovalRequest(handler) {
      return sidecar.subscribeEvent("project.approval.request", (raw) => {
        if (typeof raw !== "object" || raw === null) return;
        const payload = raw as Partial<RemoteApprovalRequestEvent>;
        if (
          typeof payload.requestId !== "string" ||
          typeof payload.token !== "string"
        ) {
          return;
        }
        handler({
          requestId: payload.requestId,
          token: payload.token,
          projectId: typeof payload.projectId === "string" ? payload.projectId : "",
          connectionId:
            typeof payload.connectionId === "string" ? payload.connectionId : "",
          sessionHint:
            typeof payload.sessionHint === "string" ? payload.sessionHint : "",
          tool: typeof payload.tool === "string" ? payload.tool : "",
          summary: typeof payload.summary === "string" ? payload.summary : "",
          input:
            typeof payload.input === "object" && payload.input !== null
              ? payload.input
              : {},
        });
      });
    },
    async prepareTerminal(connectionId, remoteRoot) {
      return sidecar.request<RemoteTerminalPrepareResult>(
        "project/terminal-prepare",
        { connectionId, remoteRoot },
      );
    },
    shutdown: () => sidecar.shutdown(),
  };

  ctx.provide(name, service);
  ctx.inject(["mcp"], (scoped) => {
    scoped.effect(() => scoped.mcp.registerBuiltin({
      id: "aaw-remote-project",
      name: "远程项目工具",
      description: "提供当前远程项目及关联目录的操作。",
      scope: "SSH 项目会话",
      matchesServer: (name) => /^aaw-remote-project(?:-\d+)?$/.test(name),
    }), "remoteProject:mcp-catalog");
  });

  const unregisterFiles = ctx.host.registerRemoteDocumentFiles(
    createRemoteDocumentFileProvider(service),
  );
  const unregisterGit = ctx.host.registerRemoteGit(
    createRemoteGitProvider(service),
  );

  ctx.effect(() => () => {
    unregisterFiles();
    unregisterGit();
    store.dispose();
    void sidecar.shutdown();
  }, "remoteProject:resources");
}

export async function installWorkbench(ctx: Context): Promise<void> {
  await ctx.plugin(workbenchUi);
}
