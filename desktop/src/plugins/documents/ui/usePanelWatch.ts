import type { WatchPath } from "../../host/types.ts";
import { describeUnknownError } from "../../../shared/errors.ts";
import { useEffect, useState } from "react";
import type { DocumentsService } from "../service.ts";

/** 监听只负责使目录/Git 失效；文本预览不调用本 hook。迟到注册也立即释放。 */
export function usePanelWatch(
  documents: DocumentsService,
  paths: readonly WatchPath[],
  enabled: boolean,
  project = paths[0]?.path ?? "",
): { revision: number; error: string | null } {
  const [result, setResult] = useState({
    revision: 0,
    error: null as string | null,
  });
  const signature = JSON.stringify(paths);
  useEffect(() => {
    if (!enabled || signature === "[]") return;
    let disposed = false;
    let release: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let first = 0;
    const fail = (error: string): void => {
      if (!disposed)
        setResult((old) => ({
          ...old,
          error: `自动监听失败：${error}；可手动刷新`,
        }));
    };
    const changed = (): void => {
      if (disposed) return;
      first ||= Date.now();
      clearTimeout(timer);
      // 突发合并，但连续写入也不能无限延后。
      timer = setTimeout(
        () => {
          first = 0;
          if (!disposed)
            setResult((old) => ({ revision: old.revision + 1, error: null }));
        },
        Math.min(400, Math.max(0, 2000 - (Date.now() - first))),
      );
    };
    void documents
      .watch(project, JSON.parse(signature) as WatchPath[], changed, fail)
      .then((stop) => {
        if (disposed) stop();
        else {
          release = stop;
          changed();
        }
      })
      .catch((error: unknown) => fail(describeUnknownError(error)));
    return () => {
      disposed = true;
      clearTimeout(timer);
      release?.();
    };
  }, [documents, signature, enabled, project]);
  return result;
}
