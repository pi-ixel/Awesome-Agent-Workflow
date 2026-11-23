import type {
  GitChange,
  GitDiff,
  GitSnapshot,
  RemoteGitProvider,
} from "../../host/types.ts";
import { parseRemoteProjectPath } from "../../../shared/panelPaths.ts";
import type { RemoteProjectRecord } from "../types.ts";

export interface RemoteGitBackend {
  getById(projectId: string): RemoteProjectRecord | null;
  gitStatus(connectionId: string, remoteRoot: string): Promise<GitSnapshot>;
  gitDiff(
    connectionId: string,
    remoteRoot: string,
    change: GitChange,
  ): Promise<GitDiff>;
}

function resolveRemoteProject(
  backend: RemoteGitBackend,
  virtualProjectPath: string,
): RemoteProjectRecord {
  const parsed = parseRemoteProjectPath(virtualProjectPath);
  if (!parsed) {
    throw new Error(`无效的远程项目路径：${virtualProjectPath}`);
  }
  const record = backend.getById(parsed.projectId);
  if (!record) {
    throw new Error(`未找到远程项目记录（${parsed.projectId}）`);
  }
  return record;
}

export function createRemoteGitProvider(
  backend: RemoteGitBackend,
): RemoteGitProvider {
  return {
    async status(project: string): Promise<GitSnapshot> {
      const record = resolveRemoteProject(backend, project);
      const snapshot = await backend.gitStatus(
        record.connectionId,
        record.remoteRoot,
      );
      return {
        ...snapshot,
        // 映射到虚拟项目路径，确保 Git 面板点击变更文件时跳回同一 projectId 下的远程文件预览。
        repoRoot: snapshot.repoRoot ? record.workspacePath : null,
        watchPaths: [],
      };
    },
    async diff(project: string, change: GitChange): Promise<GitDiff> {
      const record = resolveRemoteProject(backend, project);
      return backend.gitDiff(record.connectionId, record.remoteRoot, change);
    },
  };
}
