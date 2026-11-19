import { pathKey } from "../../../shared/panelPaths.ts";
import { managedProjectStorage } from "../lifecycle/persistence.ts";

export interface ContextUsage {
  readonly capacity: number;
  readonly used: number | null;
}

interface ContextUsageKey {
  readonly workspace: string;
  readonly agent: string;
  readonly session: string;
}

const pendingWrites = new Map<string, Promise<void>>();

function args(key: ContextUsageKey) {
  return {
    workspace: pathKey(key.workspace),
    agent: key.agent,
    session: key.session,
  };
}

/** 同一会话按上报顺序落盘，删除也等已发出的写入收尾。 */
function enqueue(
  key: ContextUsageKey,
  write: () => Promise<void>,
): Promise<void> {
  const id = JSON.stringify(args(key));
  const task = (pendingWrites.get(id) ?? Promise.resolve())
    .catch(() => {})
    .then(write);
  pendingWrites.set(id, task);
  return task.finally(() => {
    if (pendingWrites.get(id) === task) pendingWrites.delete(id);
  });
}

export async function readContextUsage(
  key: ContextUsageKey,
): Promise<ContextUsage | null> {
  const storage = managedProjectStorage();
  if (!storage?.available()) return null;
  const scope = args(key);
  await pendingWrites.get(JSON.stringify(scope))?.catch(() => {});
  return storage.request<ContextUsage | null>("usage_context_read", scope);
}

export function writeContextUsage(
  key: ContextUsageKey,
  usage: ContextUsage,
): Promise<void> {
  const storage = managedProjectStorage();
  if (!storage?.available()) return Promise.resolve();
  return enqueue(key, () =>
    storage.request("usage_context_write", { ...args(key), usage }),
  );
}

export function deleteContextUsage(key: ContextUsageKey): Promise<void> {
  const storage = managedProjectStorage();
  if (!storage?.available()) return Promise.resolve();
  return enqueue(key, () => storage.request("usage_context_delete", args(key)));
}

export async function flushContextUsageWrites(): Promise<void> {
  await Promise.allSettled(pendingWrites.values());
}
