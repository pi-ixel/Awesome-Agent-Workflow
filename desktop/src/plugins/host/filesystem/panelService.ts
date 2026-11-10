import type { GitChange, GitDiff, GitSnapshot } from "../types.ts";
import { invoke as defaultInvoke, type NativeInvoke } from "../adapters/invoke.ts";
import { describeUnknownError } from "../../../shared/errors.ts";
import { listen } from "@tauri-apps/api/event";
import { isTauriEnv } from "../adapters/host.ts";
import type { DirectoryResult, FileEntry, FilePreview, WatchPath } from "../types.ts";

export function guardPanelRequest<T>(isExiting: () => boolean, request: () => Promise<T>): Promise<T> {
  // 退出期间停止面板 RPC，避免进程收尾时再次启动 Git 等程序。
  if (isExiting())
    return Promise.reject(new DOMException("宿主正在退出", "AbortError"));
  return request();
}
export class NativePanelService {
  constructor(private readonly invoke: NativeInvoke = defaultInvoke) {}

  private async call<T>(command: string, args: Record<string, unknown>): Promise<T> {
    if (!isTauriEnv()) throw new Error("此功能需要在 desktop 桌面客户端中使用");
    return this.invoke<T>(command, args);
  }

  saveMarkdown(path: string, expected: string, contents: string, force: boolean) {
    return this.call<void>("panel_save_markdown", { path, expected, contents, force });
  }

  stat(path: string) {
    return this.call<FileEntry>("panel_stat", { path });
  }

  directory(path: string) {
    return this.call<DirectoryResult>("panel_directory", { path });
  }

  preview(path: string) {
    return this.call<FilePreview>("panel_preview", { path });
  }

  gitStatus(project: string) {
    return this.call<GitSnapshot>("panel_git_status", { project });
  }

  gitDiff(project: string, change: GitChange) {
    return this.call<GitDiff>("panel_git_diff", { project, change });
  }

  async watch(
    paths: WatchPath[],
    changed: () => void,
    failed: (error: string) => void,
    isExiting: () => boolean,
  ): Promise<() => void | Promise<void>> {
    if (isExiting()) return () => {};
    let id: number | null = null;
    const unlisten = await listen<{ id: number; error: string | null }>(
      "aaw://panel-files-changed",
      ({ payload }) => {
        if (payload.id !== id) return;
        if (payload.error) failed(payload.error);
        else changed();
      },
    );
    try {
      if (isExiting()) {
        unlisten();
        return () => {};
      }
      id = await this.call<number>("panel_watch", { paths });
    } catch (error) {
      unlisten();
      throw error;
    }
    const watchId = id;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      unlisten();
      return this.invoke<void>("panel_unwatch", { id: watchId }).catch((error: unknown) =>
        failed(describeUnknownError(error)),
      );
    };
  }
}

const standalone = new NativePanelService();
export const panelService = {
  saveMarkdown: (...args: Parameters<NativePanelService["saveMarkdown"]>) =>
    standalone.saveMarkdown(...args),
  stat: (path: string) => standalone.stat(path),
  directory: (path: string) => standalone.directory(path),
  preview: (path: string) => standalone.preview(path),
  gitStatus: (project: string) => standalone.gitStatus(project),
  gitDiff: (project: string, change: GitChange) => standalone.gitDiff(project, change),
  watch: (...args: Parameters<NativePanelService["watch"]>) => standalone.watch(...args),
};
