import { panelError, type GitChange, type GitDiff } from "./panelService.ts";
import { changeKey, reviewModel, type ReviewModel } from "./gitReview.ts";

export interface DiffEntry {
  data?: GitDiff;
  model?: ReviewModel;
  error?: string;
  loading: boolean;
}
/** 一个 Git 快照一个缓存。关闭/换快照后，旧结果不再发布，等待队列停止。 */
export function createGitDiffCache(
  read: (change: GitChange) => Promise<GitDiff>,
  previous: Readonly<Record<string, DiffEntry>> = {},
) {
  // 旧模型只用于刷新期间展示；每个新快照仍须重新读取，不能以状态/行数代替内容版本。
  let snapshot: Readonly<Record<string, DiffEntry>> = Object.fromEntries(
    Object.entries(previous)
      .filter(([, entry]) => entry.model)
      .map(([key, entry]) => [
        key,
        { ...entry, loading: true, error: undefined },
      ]),
  );
  const validated = new Set<string>();
  const sizeOf = (entry: DiffEntry): number =>
    entry.data
      ? 2 *
          (entry.data.patch.length +
            (entry.data.beforeContent?.length ?? 0) +
            (entry.data.afterContent?.length ?? 0)) +
        (entry.model?.rows.reduce(
          (sum, row) => sum + 128 + row.text.length * 2,
          0,
        ) ?? 0)
      : 0;
  const sizes = new Map(
    Object.entries(snapshot).map(([key, entry]) => [key, sizeOf(entry)]),
  );
  let queue: GitChange[] = [],
    running = 0,
    disposed = false,
    bytes = [...sizes.values()].reduce((sum, size) => sum + size, 0);
  let wanted = new Set<string>();
  const pending = new Set<string>();
  const listeners = new Set<() => void>();
  let owners = 0;
  const publish = (key: string, value: DiffEntry): void => {
    if (disposed) return;
    snapshot = { ...snapshot, [key]: value };
    listeners.forEach((listener) => listener());
  };
  const pump = (): void => {
    while (!disposed && running < 4 && queue.length) {
      const change = queue.shift();
      if (!change) break;
      const key = changeKey(change);
      if (!wanted.has(key) || pending.has(key) || validated.has(key)) continue;
      running++;
      pending.add(key);
      publish(key, { ...snapshot[key], loading: true, error: undefined });
      void read(change)
        .then((data) => {
          if (disposed) return;
          // 先估算行对象成本，防止大量空行在建立模型时就耗尽内存。
          const textSize =
            2 *
            (data.patch.length +
              (data.beforeContent?.length ?? 0) +
              (data.afterContent?.length ?? 0));
          let estimatedRows = 1;
          for (const text of [
            data.patch,
            data.beforeContent ?? "",
            data.afterContent ?? "",
          ]) {
            for (let i = 0; i < text.length; i++)
              if (text.charCodeAt(i) === 10) estimatedRows++;
          }
          if (
            bytes - (sizes.get(key) ?? 0) + textSize * 2 + estimatedRows * 128 >
            64 * 1024 * 1024
          ) {
            validated.add(key);
            publish(key, {
              ...snapshot[key],
              loading: false,
              error: "本次查找内容超过缓存上限，请清空查找并刷新后逐文件查看",
            });
            return;
          }
          const model = reviewModel(data);
          const size =
            textSize +
            model.rows.reduce(
              (total, row) => total + 128 + row.text.length * 2,
              0,
            );
          bytes += size - (sizes.get(key) ?? 0);
          sizes.set(key, size);
          validated.add(key);
          publish(key, { data, model, loading: false });
        })
        .catch((error: unknown) => {
          validated.add(key);
          publish(key, {
            ...snapshot[key],
            error: panelError(error),
            loading: false,
          });
        })
        .finally(() => {
          running--;
          pending.delete(key);
          pump();
        });
    }
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retain() {
      owners++;
      // React StrictMode 会同步重放 setup/cleanup；真正卸载后才终止缓存。
      return () => {
        owners--;
        queueMicrotask(() => {
          if (owners === 0) {
            disposed = true;
            queue = [];
            listeners.clear();
          }
        });
      };
    },
    request(changes: readonly GitChange[]) {
      wanted = new Set(changes.map(changeKey));
      queue = changes.filter(
        (change) =>
          !validated.has(changeKey(change)) && !pending.has(changeKey(change)),
      );
      pump();
    },
    dispose() {
      disposed = true;
      queue = [];
      listeners.clear();
    },
  };
}
