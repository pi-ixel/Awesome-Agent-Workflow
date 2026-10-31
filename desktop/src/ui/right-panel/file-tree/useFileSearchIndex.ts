/**
 * 全库文件名搜索索引（对齐 ZCode useWorkspaceFileSearchIndex.ts 的启用语义，
 * 数据来源换成前端 BFS 逐层 readdir——desktop 无 listWorkspaceFiles 后端
 * API）：仅查询非空时启用；跳过依赖/构建目录，限深限量，防环防失控。
 */
import { useEffect, useState } from "react";
import { pathKey } from "../../../core/panelPaths.ts";
import { FILE_TREE_READ_CONCURRENCY } from "./constants.ts";
import { getRelativePath } from "./model.ts";
import { readDirectory } from "./readDirectory.ts";

export interface FileSearchEntry {
  path: string;
  key: string;
  name: string;
  relativePath: string;
  directory: boolean;
}

const SEARCH_SKIP_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".nuxt",
  ".cache",
  ".idea",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "venv",
]);
const SEARCH_MAX_ENTRIES = 20_000;
const SEARCH_MAX_DEPTH = 24;

export function useFileSearchIndex({
  root,
  enabled,
  refreshVersion,
}: {
  root: string;
  enabled: boolean;
  refreshVersion: number;
}): {
  entries: FileSearchEntry[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
} {
  const [state, setState] = useState<{
    entries: FileSearchEntry[];
    loading: boolean;
    loaded: boolean;
    error: string | null;
  }>({ entries: [], loading: false, loaded: false, error: null });
  const rootKey = pathKey(root);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    void Promise.resolve().then(async () => {
      // 复位与置忙同帧完成；microtask 起步避免在 effect 体内同步 setState。
      if (disposed) return;
      setState({ entries: [], loading: true, loaded: false, error: null });
      const entries: FileSearchEntry[] = [];
      const visited = new Set<string>([rootKey]);
      let queue: { path: string; depth: number }[] = [{ path: root, depth: 0 }];
      try {
        while (queue.length > 0 && entries.length < SEARCH_MAX_ENTRIES) {
          if (disposed) return;
          const batch = queue.splice(0, FILE_TREE_READ_CONCURRENCY);
          const results = await Promise.all(
            batch.map(async (item) => {
              try {
                return { item, data: await readDirectory(item.path) };
              } catch {
                return { item, data: null };
              }
            }),
          );
          if (disposed) return;
          const nextQueue: { path: string; depth: number }[] = [];
          for (const { item, data } of results) {
            if (!data) continue;
            for (const entry of data.entries) {
              if (entries.length >= SEARCH_MAX_ENTRIES) break;
              entries.push({
                path: entry.path,
                key: pathKey(entry.path),
                name: entry.name,
                relativePath: getRelativePath(root, entry.path),
                directory: entry.directory,
              });
              if (
                entry.directory &&
                !entry.symlink &&
                item.depth + 1 < SEARCH_MAX_DEPTH &&
                !SEARCH_SKIP_DIRECTORIES.has(entry.name.toLowerCase()) &&
                !visited.has(pathKey(entry.path))
              ) {
                visited.add(pathKey(entry.path));
                nextQueue.push({ path: entry.path, depth: item.depth + 1 });
              }
            }
          }
          queue = nextQueue;
        }
        if (!disposed) {
          setState({ entries, loading: false, loaded: true, error: null });
        }
      } catch (error) {
        if (!disposed) {
          setState({
            entries: [],
            loading: false,
            loaded: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });
    return () => {
      disposed = true;
    };
  }, [enabled, refreshVersion, root, rootKey]);

  return state;
}
