import { convertFileSrc } from "@tauri-apps/api/core";
import type { DocumentFileHost, RemoteDocumentFileProvider } from "../types.ts";
import { isTauriEnv } from "../adapters/host.ts";
import { invoke as defaultInvoke, type NativeInvoke } from "../adapters/invoke.ts";
import { guardPanelRequest, panelService } from "./panelService.ts";
import { devBridgePost } from "../dev/bridgeClient.ts";
import { isRemoteProjectPath } from "../../../shared/panelPaths.ts";

export function createDocumentFileHost(
  isExiting: () => boolean,
  panel = panelService,
  invoke: NativeInvoke = defaultInvoke,
  getRemoteProvider: () => RemoteDocumentFileProvider | undefined = () => undefined,
): DocumentFileHost {
  const requireRemote = (): RemoteDocumentFileProvider => {
    const provider = getRemoteProvider();
    if (!provider) {
      throw new Error("远程项目文件服务尚未就绪");
    }
    return provider;
  };
  return {
    assetUrl: (path) =>
      isRemoteProjectPath(path) ? undefined : isTauriEnv() ? convertFileSrc(path) : undefined,
    openInFileManager: (path, action) => guardPanelRequest(isExiting, () => {
      if (isRemoteProjectPath(path)) {
        return Promise.reject(new Error("远端项目文件暂不支持在本地文件管理器中打开"));
      }
      if (!isTauriEnv())
        return Promise.reject(new Error("此功能需要在 desktop 桌面客户端中使用"));
      return invoke<void>("panel_open_file_manager", { path, action });
    }),
    stat: (path) =>
      guardPanelRequest(isExiting, () =>
        isRemoteProjectPath(path) ? requireRemote().stat(path) : panel.stat(path),
      ),
    directory: (path) =>
      guardPanelRequest(isExiting, () =>
        isRemoteProjectPath(path)
          ? requireRemote().directory(path)
          : panel.directory(path),
      ),
    preview: (path) =>
      guardPanelRequest(isExiting, () =>
        isRemoteProjectPath(path)
          ? requireRemote().preview(path)
          : panel.preview(path),
      ),
    saveMarkdown: (path, expected, contents, force) =>
      guardPanelRequest(isExiting, () => {
        if (isRemoteProjectPath(path)) {
          const remote = requireRemote();
          if (!remote.saveMarkdown) {
            return Promise.reject(new Error("远端项目当前为只读浏览模式，暂不支持直接保存"));
          }
          return remote.saveMarkdown(path, expected, contents, force);
        }
        return panel.saveMarkdown(path, expected, contents, force);
      }),
    watch: (paths, changed, failed) => {
      if (paths.some((item) => isRemoteProjectPath(item.path))) {
        // 远端项目首版通过手动刷新发现外部变更，不启用本地文件系统 watch。
        return Promise.resolve(() => {});
      }
      return panel.watch(paths, changed, failed, isExiting);
    },
    async listWorkspaceFiles(root) {
      if (isExiting()) return null;
      if (isRemoteProjectPath(root)) {
        const provider = getRemoteProvider();
        return provider ? provider.listWorkspaceFiles(root) : null;
      }
      if (isTauriEnv()) {
        const paths = await invoke<unknown>("list_workspace_files", { root });
        return Array.isArray(paths)
          ? paths.filter((path): path is string => typeof path === "string")
          : [];
      }
      if (import.meta.env.DEV && !import.meta.env.VITEST) {
        const { paths } = await devBridgePost<{ paths?: unknown }>(
          "/list-workspace-files",
          { root },
        );
        return Array.isArray(paths)
          ? paths.filter((path): path is string => typeof path === "string")
          : [];
      }
      return null;
    },
  };
}
