import type { GitHost, GitService } from "../../contracts/git.ts";
import type { HostStorage } from "../../contracts/host.ts";
import { pathKey } from "../../shared/panelPaths.ts";
import { clampWidth, readColumnWidth, saveColumnWidth } from "../../shared/ui/controls/columnWidth.ts";
import { createProjectGitQuery } from "./projectQuery.ts";

const reviewRailStorageKey = "aaw-desktop/layout/git-review-rail-w";
export const reviewRailWidths = { initial: 256, min: 220, max: 560 };

export function createGitService(
  host: GitHost,
  storage: HostStorage,
): GitService & { dispose(): void } {
  const queries = new Map<string, ReturnType<typeof createProjectGitQuery>>();
  let disposed = false;
  const { initial, min, max } = reviewRailWidths;
  let railWidth = clampWidth(readColumnWidth(storage, reviewRailStorageKey) ?? initial, min, max);
  const assertOpen = () => {
    if (disposed) throw new Error("Git service is disposed");
  };
  async function read<T>(request: () => Promise<T>): Promise<T> {
    assertOpen();
    const result = await request();
    assertOpen();
    return result;
  }
  return {
    get reviewRailWidth() {
      return railWidth;
    },
    setReviewRailWidth: (width) => {
      if (disposed || !Number.isFinite(width)) return;
      railWidth = clampWidth(width, min, max);
      saveColumnWidth(storage, reviewRailStorageKey, railWidth);
    },
    status: (project) => read(() => host.status(project)),
    diff: (project, change) => read(() => host.diff(project, change)),
    query(project) {
      assertOpen();
      const key = pathKey(project);
      let query = queries.get(key);
      if (!query) {
        query = createProjectGitQuery(project, host);
        queries.set(key, query);
        for (const [oldKey, old] of queries) {
          if (queries.size <= 50) break;
          if (oldKey !== key && !old.isActive()) queries.delete(oldKey);
        }
      }
      return query;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const query of queries.values()) query.dispose();
      queries.clear();
    },
  };
}
