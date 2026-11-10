import type { HostStorage } from "../../host/types.ts";
import type { PromptHistory } from "./types.ts";

const MAX_ENTRIES = 100;
const STORAGE_PREFIX = "aaw-desktop/prompt-history/";

function storageKeyOf(
  workspacePath: string,
  sessionId: string,
  agentKey?: string,
): string {
  if (agentKey !== undefined)
    return `${STORAGE_PREFIX}v2/${encodeURIComponent(agentKey)}/${encodeURIComponent(workspacePath)}/${encodeURIComponent(sessionId)}`;
  return `${STORAGE_PREFIX}${encodeURIComponent(workspacePath)}/${encodeURIComponent(sessionId)}`;
}

/** Recent prompts are isolated by workspace, session and Agent. */
export function createPromptHistory(
  storage: HostStorage,
): PromptHistory & { dispose(): void } {
  let active = true;
  let scopeKey: string | null = null;
  const entries: string[] = [];
  function persist() {
    if (scopeKey === null) return;
    try {
      storage.setItem(scopeKey, JSON.stringify(entries));
    } catch {
      // 仍可在当前输入区回溯。
    }
  }

  return {
    setScope(workspacePath, sessionId = "__new__", agentKey) {
      if (!active) return;
      const key =
        workspacePath === null
          ? null
          : storageKeyOf(workspacePath, sessionId, agentKey);
      if (key === scopeKey) return;
      scopeKey = key;
      entries.length = 0;
      if (key === null) return;
      try {
        const raw: unknown = JSON.parse(storage.getItem(key) ?? "null");
        if (Array.isArray(raw))
          entries.push(
            ...raw
              .filter(
                (entry): entry is string =>
                  typeof entry === "string" && entry.length > 0,
              )
              .slice(-MAX_ENTRIES),
          );
      } catch {
        // 读取失败时从空历史开始。
      }
    },
    record(text) {
      const value = text.trim();
      if (!active || !value) return;
      const index = entries.lastIndexOf(value);
      if (index >= 0) entries.splice(index, 1);
      entries.push(value);
      if (entries.length > MAX_ENTRIES) entries.shift();
      persist();
    },
    get(restored = []) {
      if (!active) return [];
      // 用当前会话回放补齐历史，保留已被压缩的提示词。
      if (restored.length) {
        const merged = [...entries];
        for (const text of restored) {
          const value = text.trim();
          if (!value) continue;
          const index = merged.indexOf(value);
          if (index >= 0) merged.splice(index, 1);
          merged.push(value);
        }
        entries.splice(0, entries.length, ...merged.slice(-MAX_ENTRIES));
        persist();
      }
      return entries.slice();
    },
    dispose() {
      active = false;
      scopeKey = null;
      entries.length = 0;
    },
  };
}
