import type {
  DirectoryResult,
  FileEntry,
  FilePreview,
  RemoteDocumentFileProvider,
} from "../../host/types.ts";
import {
  formatRemoteProjectPath,
  parseRemoteProjectPath,
} from "../../../shared/panelPaths.ts";
import type {
  RemoteFSEntry,
  RemoteFSListResult,
  RemoteFilePreviewResult,
  RemoteProjectRecord,
} from "../types.ts";

export interface RemoteFileBackend {
  getById(projectId: string): RemoteProjectRecord | null;
  listDirectory(connectionId: string, path: string): Promise<RemoteFSListResult>;
  stat(connectionId: string, path: string): Promise<RemoteFSEntry>;
  preview(connectionId: string, path: string): Promise<RemoteFilePreviewResult>;
  listWorkspaceFiles(connectionId: string, root: string): Promise<readonly string[]>;
  writeFile?(params: {
    readonly connectionId: string;
    readonly path: string;
    readonly content: string;
    readonly expectedContent?: string;
    readonly force?: boolean;
  }): Promise<unknown>;
}

function resolveTarget(
  backend: RemoteFileBackend,
  virtualPath: string,
): { readonly projectId: string; readonly connectionId: string; readonly remotePath: string } {
  const parsed = parseRemoteProjectPath(virtualPath);
  if (!parsed) {
    throw new Error(`无效的远程项目路径：${virtualPath}`);
  }
  const record = backend.getById(parsed.projectId);
  if (!record) {
    throw new Error(`未找到远程项目记录（${parsed.projectId}）`);
  }
  return {
    projectId: record.projectId,
    connectionId: record.connectionId,
    remotePath: parsed.remotePath,
  };
}

export function createRemoteDocumentFileProvider(
  backend: RemoteFileBackend,
): RemoteDocumentFileProvider {
  return {
    async stat(path: string): Promise<FileEntry> {
      const target = resolveTarget(backend, path);
      const entry = await backend.stat(target.connectionId, target.remotePath);
      return {
        path: formatRemoteProjectPath(target.projectId, entry.path),
        name: entry.name,
        directory: entry.directory,
        symlink: entry.symlink,
      };
    },
    async directory(path: string): Promise<DirectoryResult> {
      const target = resolveTarget(backend, path);
      const result = await backend.listDirectory(
        target.connectionId,
        target.remotePath,
      );
      return {
        entries: result.entries.map((entry) => ({
          path: formatRemoteProjectPath(target.projectId, entry.path),
          name: entry.name,
          directory: entry.directory,
          symlink: entry.symlink,
        })),
        truncated: result.truncated,
      };
    },
    async preview(path: string): Promise<FilePreview> {
      const target = resolveTarget(backend, path);
      const result = await backend.preview(target.connectionId, target.remotePath);
      return {
        kind: result.kind,
        content: result.content,
        mime: result.mime,
        bytes: result.bytes,
      };
    },
    async listWorkspaceFiles(root: string): Promise<readonly string[] | null> {
      const target = resolveTarget(backend, root);
      return backend.listWorkspaceFiles(target.connectionId, target.remotePath);
    },
    async saveMarkdown(
      path: string,
      expected: string,
      contents: string,
      force: boolean,
    ): Promise<void> {
      if (!backend.writeFile) {
        throw new Error("远端项目文件写入服务尚未就绪");
      }
      const target = resolveTarget(backend, path);
      await backend.writeFile({
        connectionId: target.connectionId,
        path: target.remotePath,
        content: contents,
        expectedContent: expected,
        force,
      });
    },
  };
}
