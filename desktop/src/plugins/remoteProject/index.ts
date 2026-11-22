import type { Context } from "cordis";
import type { RemoteProjectService } from "./service.ts";
import type {
  RemoteConnectionDTO,
  RemoteConnectionTestResult,
  RemoteFSEntry,
  RemoteFSListResult,
  RemoteFilePreviewResult,
} from "./types.ts";
import { OpsSidecarClient } from "./sidecar/client.ts";
import { createRemoteProjectStore } from "./store/remoteProjectStore.ts";
import { createRemoteDocumentFileProvider } from "./fs/remoteFileProvider.ts";
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
    },
    async testConnection(params) {
      return sidecar.request<RemoteConnectionTestResult>(
        "project/connection-test",
        { ...params },
      );
    },
    async listDirectory(connectionId, path) {
      const result = await sidecar.request<RemoteFSListResult>(
        "project/fs-list",
        { connectionId, path },
      );
      if (result.path) {
        store.recordRecentDir(connectionId, result.path);
      }
      return result;
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
    shutdown: () => sidecar.shutdown(),
  };

  ctx.provide(name, service);

  const unregisterFiles = ctx.host.registerRemoteDocumentFiles(
    createRemoteDocumentFileProvider(service),
  );

  ctx.effect(() => () => {
    unregisterFiles();
    store.dispose();
    void sidecar.shutdown();
  }, "remoteProject:resources");
}

export async function installWorkbench(ctx: Context): Promise<void> {
  await ctx.plugin(workbenchUi);
}
