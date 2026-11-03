/**
 * 工作区文件列举（@ 提及的数据源）：Tauri `list_workspace_files` 的
 * 包装 + 短 TTL 缓存。@ 面板打开期间反复敲键不反复走路径扫描；过期
 * （30s）后下一次触发重新扫。非 Tauri 环境 / 失败一律返回空数组——
 * 提及面板显示「无候选」，绝不阻断输入。
 */
import { invoke } from "../core/invoke.ts";

import { isTauriEnv } from "../core/host.ts";
import { createLogger } from "../core/logger.ts";
import { devBridgePost } from "../dev/bridgeClient.ts";

const logger = createLogger("aaw");

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  readonly paths: readonly string[];
  readonly expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** 列举工作区文件（相对路径，`/` 分隔；跳过依赖目录，见 Rust 侧）。 */
export async function listWorkspaceFiles(
  workspacePath: string,
): Promise<readonly string[]> {
  const trimmed = workspacePath.trim();
  if (trimmed.length === 0) {
    return [];
  }
  const cached = cache.get(trimmed);
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    return cached.paths;
  }
  if (!isTauriEnv()) {
    // dev 浏览器（npm run dev:web）：dev bridge 代扫（同一跳过/上限
    // 语义）；bridge 未启动则退空态。生产构建折叠 DEV，分支被摇走
    if (import.meta.env.DEV && !import.meta.env.VITEST) {
      try {
        const wire = await devBridgePost<{ paths?: unknown }>(
          "/list-workspace-files",
          { root: trimmed },
        );
        const raw = Array.isArray(wire.paths) ? wire.paths : [];
        const viaBridge = raw.filter(
          (item): item is string => typeof item === "string",
        );
        cache.set(trimmed, {
          paths: viaBridge,
          expiresAt: Date.now() + CACHE_TTL_MS,
        });
        return viaBridge;
      } catch {
        return [];
      }
    }
    return [];
  }
  try {
    const paths = await invoke<string[]>("list_workspace_files", {
      root: trimmed,
    });
    const normalized = Array.isArray(paths) ? paths : [];
    cache.set(trimmed, {
      paths: normalized,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return normalized;
  } catch (error) {
    logger.debug("文件列举失败（提及面板退空态）", {
      workspacePath: trimmed,
      reason: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/** 测试复位（清缓存）。 */
export function resetFileListingCacheForTests(): void {
  cache.clear();
}
