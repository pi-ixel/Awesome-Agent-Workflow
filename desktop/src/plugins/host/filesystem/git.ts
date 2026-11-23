import type { GitHost, RemoteGitProvider } from "../types.ts";
import { guardPanelRequest, panelService } from "./panelService.ts";
import { isRemoteProjectPath } from "../../../shared/panelPaths.ts";

export function createGitHost(
  isExiting: () => boolean,
  panel = panelService,
  getRemoteProvider: () => RemoteGitProvider | undefined = () => undefined,
): GitHost {
  const requireRemote = (): RemoteGitProvider => {
    const provider = getRemoteProvider();
    if (!provider) {
      throw new Error("远程项目 Git 服务尚未就绪");
    }
    return provider;
  };
  return {
    status: (project) =>
      guardPanelRequest(isExiting, () =>
        isRemoteProjectPath(project)
          ? requireRemote().status(project)
          : panel.gitStatus(project),
      ),
    diff: (project, change) =>
      guardPanelRequest(isExiting, () =>
        isRemoteProjectPath(project)
          ? requireRemote().diff(project, change)
          : panel.gitDiff(project, change),
      ),
    watch: (paths, changed, failed) => {
      if (paths.some((item) => isRemoteProjectPath(item.path))) {
        return Promise.resolve(() => {});
      }
      return panel.watch(paths, changed, failed, isExiting);
    },
  };
}
