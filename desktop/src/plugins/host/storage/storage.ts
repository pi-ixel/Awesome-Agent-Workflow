import type { HostManagedStorage, HostStorage } from "../types.ts";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { createStore } from "zustand/vanilla";
import { retainedSessions, finishSessionRecovery } from "./sessionRecovery.ts";

const configurationKeys = new Set([
  "aaw-desktop.settings.v1",
  "aaw-desktop/session-deletions.v1",
  "aaw-desktop/model-probe-sessions.v1",
  "aaw-desktop.auth.v1",
  "aaw-desktop/workspace/v1",
  "aaw-desktop/remote-projects/v1",
  "aaw-desktop/sidebar/view",
  "aaw-desktop/storage-reminders.v1",
  "aaw-desktop/scheduled-tasks.v1",
  "aaw-desktop/skill-packages.v1",
  "aaw-desktop/close-to-tray.v1",
  "aaw-desktop/right-panel/zcode-v1",
  "aaw-desktop/right-panel/v1",
  "aaw:document-outline-width",
]);
const legacySessionKeys = new Set([
  "aaw-desktop/archived-sessions.v1",
  "aaw-desktop/archived-session-metadata.v1",
  "aaw-desktop/session-project-owners.v1",
  "aaw-desktop/session-working-directories.v1",
  "aaw-desktop/session-unread-replies.v1",
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
    key.startsWith("aaw-desktop/prompt-history/") ||
    key.startsWith("aaw-desktop/session-projects/")
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
  let confirmed: Promise<void> | undefined;
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
    if (!isTauri()) return;
    if (confirmed) return confirmed.catch(() => {}).then(() => flush());
    if (!pending.size && !writer) return;
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

  function writeConfirmed(changes: Readonly<Record<string, string>>): Promise<void> {
    const previous = confirmed ?? writer;
    const task = Promise.resolve(previous).catch(() => {}).then(async () => {
      await load();
      if (!persisted) throw new Error(status.getState().error || "配置存储未就绪");
      const replaced = new Map<string, string | null>();
      for (const key of Object.keys(changes)) {
        if (pending.has(key)) {
          replaced.set(key, pending.get(key) ?? null);
          pending.delete(key);
        }
      }
      try {
        await invoke("storage_configuration_write", { changes, conversationText });
      } catch (error) {
        pending = new Map([...replaced, ...pending]);
        throw error;
      }
      Object.assign(persisted, changes);
      for (const key of Object.keys(changes)) {
        if (!pending.has(key)) inFlight.delete(key);
      }
      if (!pending.size) status.setState({ error: "" });
    }).finally(() => {
      if (confirmed !== task) return;
      confirmed = undefined;
      void flush();
    });
    confirmed = task;
    return task;
  }

  return {
    load,
    flush,
    status,
    writeConfirmed,
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
  retainedSessions,
  finishSessionRecovery,
  available: () => isTauri(),
  request: (command, args) => invoke(command, args),
  load: loadNativeConfiguration,
  flush: flushNativeConfiguration,
  async flushConfiguration() { await configuration.flush(); },
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

async function setConfigurationItems(changes: Readonly<Record<string, string>>): Promise<void> {
  const keys = Object.keys(changes);
  if (keys.some((key) => !isNativeConfigurationKey(key)))
    throw new Error("未登记的配置键");
  if (isTauri()) return configuration.writeConfirmed(changes);
  const previous = new Map<string, string | null>();
  try {
    for (const key of keys) {
      const old = localStorage.getItem(key);
      localStorage.setItem(key, changes[key]!);
      previous.set(key, old);
    }
  } catch (error) {
    for (const [key, value] of [...previous].reverse()) {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }
    throw error;
  }
}

export const webviewStorage: HostStorage = {
  managed: desktopManagedStorage,
  getItem(key) {
    const records = nativeRecords(key);
    return records ? records.getItem(key) : localStorage.getItem(key);
  },
  setItem: change,
  async setConfigurationItem(key, value) {
    if (!isTauri() && legacySessionKeys.has(key)) {
      localStorage.setItem(key, value);
      return;
    }
    await setConfigurationItems({ [key]: value });
  },
  setConfigurationItems,
  removeItem: (key) => change(key, null),
};
