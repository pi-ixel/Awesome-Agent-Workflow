/**
 * skill 名录的兜底：chrys 的 `_chrys/runtime_update` 顶层 `skillNames`
 * 在部分配置下为空（skill 懒加载），但 `runtimeDetails.skill_sources`
 * 的 key 是**每个 skill 自己的目录全路径**（如
 * `C:/users/.agents/skills/aaw-workflow`）——取路径末段即 skill 名，
 * 无需扫盘。
 *
 * 优先级约定：调用方先用 runtime.skillNames（wire 权威），为空才走本
 * 兜底；结果按 sources 签名 + 30s TTL 缓存。
 */
const TTL_MS = 30_000;

let cache: { sourcesKey: string; names: string[]; loadedAt: number } | null =
  null;

/** 路径末段（兼容 / 与 \ 分隔）。 */
function basenameOf(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash === -1 ? path : path.slice(slash + 1);
}

/** skill 名 = 各 source 路径的末段（去重排序；空段过滤）。 */
export function skillNamesFromSources(
  sources: readonly { readonly source: string; readonly count: number }[],
): string[] {
  const names = new Set<string>();
  for (const entry of sources) {
    const name = basenameOf(entry.source).trim();
    if (name.length > 0) {
      names.add(name);
    }
  }
  return [...names].sort();
}

/** 带 TTL 缓存的包装（签名变化或过期时重算；纯内存计算，成本极低）。 */
export function listSkillNamesFromSources(
  sources: readonly { readonly source: string; readonly count: number }[],
): string[] {
  const sourcesKey = sources
    .map((entry) => `${entry.source}:${entry.count}`)
    .join("|");
  if (
    cache !== null &&
    cache.sourcesKey === sourcesKey &&
    Date.now() - cache.loadedAt < TTL_MS
  ) {
    return cache.names;
  }
  const list = skillNamesFromSources(sources);
  cache = { sourcesKey, names: list, loadedAt: Date.now() };
  return list;
}

/** 测试复位。 */
export function resetSkillCatalogForTests(): void {
  cache = null;
}
