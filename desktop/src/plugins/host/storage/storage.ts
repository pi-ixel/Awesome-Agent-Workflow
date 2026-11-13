import type { HostManagedStorage, HostStorage } from "../types.ts";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { createStore } from "zustand/vanilla";

const configurationKeys = new Set([
  "aaw-desktop.settings.v1",
  "aaw-desktop.auth.v1",
  "aaw-desktop/workspace/v1",
  "aaw-desktop/archived-sessions.v1",
  "aaw-desktop/archived-session-metadata.v1",
  "aaw-desktop/sidebar/view",
  "aaw-desktop/storage-reminders.v1",
  "aaw-desktop/right-panel/zcode-v1",
  "aaw-desktop/right-panel/v1",
  "aaw:document-outline-width",
]);
export function isNativeConfigurationKey(key: string): boolean {
  return (
    configurationKeys.has(key) ||
    [
      "aaw-desktop/layout/",
      "aaw-desktop/file-split/",
      "aaw-desktop/legacy-owner/",
      // 工作流的会话归属、运行设置、节点计划与通知状态：存应用数据目录，不占 WebView 本地存储。
      "aaw-workflow/",
    ].some((prefix) => key.startsWith(prefix))
  );
}

type Records = Record<string, string | null>;
export function isConversationTextKey(key: string): boolean {
  return (
    key.startsWith("aaw-desktop/draft/") ||
    key.startsWith("aaw-desktop/prompt-history/")
  );
}

function createNativeRecords(
  matches: (key: string) => boolean,
  conversationText: boolean,
) {
  let persisted: Records | undefined;
  let pending = new Map<string, string | null>();
  const inFlight = new Map<string, string | null>();
  let writer: Promise<void> | undefined;
  let loading: Promise<void> | undefined;
  const status = createStore(() => ({ error: "", saving: false }));

  function load(): void | Promise<void> {
    if (!isTauri() || persisted) return;
    loading ??= (async () => {
      try {
        const legacy = Object.fromEntries(
          Object.keys(localStorage)
            .filter(matches)
            .map((key) => [key, localStorage.getItem(key)]),
        );
        persisted = await invoke("storage_configuration_load", {
          legacy,
          conversationText,
        });
        status.setState({ error: "" });
      } catch (error) {
        status.setState({ error: String(error) });
      }
    })().finally(() => {
      loading = undefined;
    });
    return loading;
  }

  function flush(): void | Promise<void> {
    if (!isTauri() || (!pending.size && !writer)) return;
    writer ??= (async () => {
      status.setState({ saving: true });
      await load();
      if (!persisted) return;
      while (pending.size) {
        const batch = pending;
        pending = new Map();
        const changes = Object.fromEntries(batch);
        try {
          await invoke("storage_configuration_write", {
            changes,
            conversationText,
          });
          Object.assign(persisted, changes);
          status.setState({ error: "" });
        } catch (error) {
          pending = new Map([...batch, ...pending]);
          status.setState({ error: String(error) });
          return;
        }
      }
    })().finally(() => {
      writer = undefined;
      if (!status.getState().error) inFlight.clear();
      status.setState({ saving: false });
    });
    return writer;
  }

  return {
    load,
    flush,
    status,
    getItem(key: string) {
      if (inFlight.has(key)) return inFlight.get(key) ?? null;
      return persisted ? (persisted[key] ?? null) : localStorage.getItem(key);
    },
    setItem(key: string, value: string | null) {
      pending.set(key, value);
      inFlight.set(key, value);
      void flush();
    },
    migrated(key: string) {
      return !!persisted && Object.hasOwn(persisted, key);
    },
    keys() {
      return persisted
        ? Object.keys(persisted)
        : Object.keys(localStorage).filter(matches);
    },
    bytes() {
      return (
        persisted && new TextEncoder().encode(JSON.stringify(persisted)).length
      );
    },
  };
}

const configuration = createNativeRecords(isNativeConfigurationKey, false);
const conversation = createNativeRecords(isConversationTextKey, true);
export const nativeConfigurationStatus = configuration.status;
export const nativeConversationTextStatus = conversation.status;

export function migratedConfigurationKey(key: string): boolean {
  return (isConversationTextKey(key) ? conversation : configuration).migrated(
    key,
  );
}

export async function loadNativeConfiguration(): Promise<void> {
  await Promise.all([configuration.load(), conversation.load()]);
}

export async function flushNativeConfiguration(): Promise<void> {
  await Promise.all([configuration.flush(), conversation.flush()]);
}

export const desktopManagedStorage: HostManagedStorage = {
  available: () => isTauri(),
  request: (command, args) => invoke(command, args),
  load: loadNativeConfiguration,
  flush: flushNativeConfiguration,
  migrated: migratedConfigurationKey,
  isManagedKey: (key) =>
    isNativeConfigurationKey(key) || isConversationTextKey(key),
  conversationKeys: () => conversation.keys(),
  configurationBytes: () => configuration.bytes(),
  configurationError: () => nativeConfigurationStatus.getState().error,
  conversationError: () => nativeConversationTextStatus.getState().error,
};

function nativeRecords(key: string) {
  if (!isTauri()) return;
  if (isNativeConfigurationKey(key)) return configuration;
  if (isConversationTextKey(key)) return conversation;
}

function change(key: string, value: string | null): void {
  const records = nativeRecords(key);
  if (records) records.setItem(key, value);
  else if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
}

export const webviewStorage: HostStorage = {
  managed: desktopManagedStorage,
  getItem(key) {
    const records = nativeRecords(key);
    return records ? records.getItem(key) : localStorage.getItem(key);
  },
  setItem: change,
  removeItem: (key) => change(key, null),
};
