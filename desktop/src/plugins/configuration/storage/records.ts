import type {
  ConfigurationRecord,
  ConfigurationScope,
} from "../types.ts";
import type { HostStorage } from "../../host/types.ts";

export function readConfigurationRecord(
  storage: HostStorage,
  key: string,
): ConfigurationRecord | null {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ConfigurationRecord)
    : null;
}

export function createConfigurationScope(
  storage: HostStorage,
  key: string,
  fields?: ReadonlySet<string>,
): ConfigurationScope {
  let disposed = false;
  let pending: ConfigurationRecord | undefined;
  let failure: string | undefined;
  const listeners = new Set<(value: ConfigurationRecord) => void>();
  function ensureActive() {
    if (disposed) throw new Error(`配置作用域已释放：${key}`);
  }
  function select(record: ConfigurationRecord): ConfigurationRecord {
    return fields
      ? Object.fromEntries(
          Object.entries(record).filter(([field]) => fields.has(field)),
        )
      : record;
  }
  const scope: ConfigurationScope = {
    saveFailure: {
      message: () => failure,
      retry: () => { if (pending) scope.update(pending); },
    },
    read() {
      ensureActive();
      const record = readConfigurationRecord(storage, key);
      return record && select(record);
    },
    update(patch) {
      ensureActive();
      if (fields && Object.keys(patch).some((field) => !fields.has(field)))
        throw new Error(`配置字段超出作用域：${key}`);
      let previous: ConfigurationRecord | null = null;
      try {
        previous = readConfigurationRecord(storage, key);
      } catch {
        // 损坏的旧文档仍可由有效设置恢复。
      }
      const combined = { ...pending, ...patch };
      const next = { ...previous, ...combined };
      try {
        storage.setItem(key, JSON.stringify(next));
      } catch (error) {
        pending = combined;
        failure = String(error);
        throw error;
      }
      pending = undefined;
      failure = undefined;
      const snapshot = select(next);
      for (const listener of [...listeners]) listener(snapshot);
    },
    subscribe(listener) {
      ensureActive();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposed = true;
      pending = undefined;
      failure = undefined;
      listeners.clear();
    },
  };
  return scope;
}
