import { convertFileSrc } from "@tauri-apps/api/core";
import type { DocumentFileHost } from "../../contracts/documents.ts";
import { isTauriEnv } from "./host.ts";
import { invoke } from "./invoke.ts";
import { guardPanelRequest, panelService } from "./panelService.ts";
import { devBridgePost } from "./dev/bridgeClient.ts";

export function createDocumentFileHost(
  isExiting: () => boolean,
): DocumentFileHost {
  return {
    assetUrl: (path) => (isTauriEnv() ? convertFileSrc(path) : undefined),
    async openInFileManager(path, mode) {
      const { openPath, revealItemInDir } =
        await import("@tauri-apps/plugin-opener");
      await (mode === "directory" ? openPath(path) : revealItemInDir(path));
    },
    stat: (path) => guardPanelRequest(isExiting, () => panelService.stat(path)),
    directory: (path) =>
      guardPanelRequest(isExiting, () => panelService.directory(path)),
    preview: (path) =>
      guardPanelRequest(isExiting, () => panelService.preview(path)),
    saveMarkdown: (...args) =>
      guardPanelRequest(isExiting, () => panelService.saveMarkdown(...args)),
    watch: (...args) => panelService.watch(...args, isExiting),
    async listWorkspaceFiles(root) {
      if (isExiting()) return null;
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
