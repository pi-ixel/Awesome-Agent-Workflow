import {
  panelError,
  panelService,
  type GitSnapshot,
  type WatchPath,
} from "./panelService.ts";
import { pathKey } from "./panelPaths.ts";

export interface ProjectGitState {
  data?: GitSnapshot;
  loading: boolean;
  error?: string;
  watchError?: string;
}
interface GitQueryServices {
  status(project: string): Promise<GitSnapshot>;
  watch(
    paths: WatchPath[],
    changed: () => void,
    failed: (error: string) => void,
  ): Promise<() => void>;
}

/** 一个项目一份状态查询和监听；最后一个订阅者离开后释放原生资源。 */
export function createProjectGitQuery(
  project: string,
  services: GitQueryServices,
) {
  let state: ProjectGitState = { loading: true };
  const listeners = new Set<() => void>();
  let generation = 0,
    started = false,
    inFlight = false,
    queued = false;
  let watchKey = "",
    watchGeneration = 0;
  let stopWatch: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let changeTimer: ReturnType<typeof setTimeout> | undefined;
  let firstInvalidation = 0;
  let registrationError: string | undefined;
  let activeTask: Promise<void> | undefined;
  const publish = (next: ProjectGitState): void => {
    state = {
      ...next,
      watchError:
        [next.data?.watchWarning, registrationError]
          .filter(Boolean)
          .join("；") || undefined,
    };
    listeners.forEach((listener) => listener());
  };
  const invalidate = (): void => {
    if (!started) return;
    firstInvalidation ||= Date.now();
    clearTimeout(timer);
    timer = setTimeout(
      () => {
        firstInvalidation = 0;
        void refresh();
      },
      Math.min(400, Math.max(0, 2000 - (Date.now() - firstInvalidation))),
    );
  };
  const watch = (paths: string[]): void => {
    const signature = JSON.stringify(paths);
    if (signature === watchKey) return;
    watchKey = signature;
    const version = ++watchGeneration;
    stopWatch?.();
    stopWatch = undefined;
    if (!paths.length) {
      registrationError = undefined;
      publish({ ...state });
      return;
    }
    const current = (): boolean => started && version === watchGeneration;
    const fail = (error: string): void => {
      if (!current()) return;
      // 注册失败与运行时错误都使本代失效：下一次状态刷新可以重新监听。
      // 先推进代际再停止旧监听，避免它的回调或迟到的注册结果覆盖新监听。
      watchGeneration++;
      watchKey = "";
      if (changeTimer) clearTimeout(changeTimer);
      const stop = stopWatch;
      stopWatch = undefined;
      stop?.();
      registrationError = `自动监听失败：${error}；可手动刷新`;
      publish({ ...state });
    };
    void services
      .watch(
        paths.map((path) => ({ path, recursive: true })),
        () => {
          if (changeTimer) clearTimeout(changeTimer);
          changeTimer = setTimeout(() => {
            if (current()) invalidate();
          }, 2000);
        },
        fail,
      )
      .then((stop) => {
        if (!current()) stop();
        else {
          stopWatch = stop;
          registrationError = undefined;
          publish({ ...state });
          invalidate();
        }
      })
      .catch((error: unknown) => fail(panelError(error)));
  };
  const refresh = (): Promise<void> => {
    if (!started) return Promise.resolve();
    if (inFlight) {
      queued = true;
      return activeTask ?? Promise.resolve();
    }
    const version = generation;
    inFlight = true;
    publish({ ...state, loading: !state.data, error: undefined });
    activeTask = services
      .status(project)
      .then((data) => {
        if (!started || version !== generation) return;
        publish({ data, loading: false });
        watch(data.watchPaths);
      })
      .catch((error: unknown) => {
        if (started && version === generation)
          publish({ ...state, loading: false, error: panelError(error) });
      })
      .finally(() => {
        if (version !== generation) return;
        inFlight = false;
        if (queued) {
          queued = false;
          return refresh();
        }
      });
    return activeTask;
  };
  return {
    getSnapshot: () => state,
    refresh,
    invalidate,
    isActive: () => started,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      if (!started) {
        started = true;
        generation++;
        queueMicrotask(() => void refresh());
        window.addEventListener("focus", invalidate);
      }
      return () => {
        listeners.delete(listener);
        // StrictMode 同步重放订阅不释放；真正离开后迟到注册/响应均失效。
        queueMicrotask(() => {
          if (listeners.size || !started) return;
          started = false;
          generation++;
          watchGeneration++;
          inFlight = false;
          activeTask = undefined;
          queued = false;
          watchKey = "";
          firstInvalidation = 0;
          clearTimeout(timer);
          stopWatch?.();
          stopWatch = undefined;
          registrationError = undefined;
          window.removeEventListener("focus", invalidate);
          state = { loading: true };
        });
      };
    },
  };
}

const queries = new Map<string, ReturnType<typeof createProjectGitQuery>>();
export function getProjectGitQuery(
  project: string,
): ReturnType<typeof createProjectGitQuery> {
  const key = pathKey(project);
  let query = queries.get(key);
  if (!query) {
    query = createProjectGitQuery(project, {
      status: (path) => panelService.gitStatus(path),
      watch: (paths, changed, failed) =>
        panelService.watch(paths, changed, failed),
    });
    queries.set(key, query);
    // 仅淘汰无订阅的空缓存；不会终止正在使用的项目查询。
    for (const [oldKey, old] of queries) {
      if (queries.size <= 50) break;
      if (oldKey !== key && !old.isActive()) queries.delete(oldKey);
    }
  }
  return query;
}
