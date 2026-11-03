import { create } from "zustand";
import { invoke } from "../core/invoke.ts";
import { listen } from "@tauri-apps/api/event";
import { isTauriEnv } from "../core/host.ts";

export interface UpdatePreferences {
  autoCheck: boolean;
  checkIntervalMinutes: number;
  autoDownload: boolean;
  server: string;
  acceleration: boolean;
  contribute: boolean;
}
export interface UpdateManifest {
  version: string;
  notes: string;
  published_at?: string | null;
}
export interface UpdateSnapshot {
  phase: string;
  currentVersion: string;
  ready: UpdateManifest | null;
  available: UpdateManifest | null;
  progress: number;
  error: string | null;
  uploadError: string | null;
  sourceMessages: string[];
  installed: boolean;
  preferences: UpdatePreferences;
}
interface UpdateState {
  snapshot: UpdateSnapshot | null;
  dialog: boolean;
  checking: boolean;
  setDialog: (open: boolean) => void;
  check: () => Promise<void>;
  download: () => Promise<void>;
  preferences: (value: Partial<UpdatePreferences>) => Promise<void>;
}
let preferencesQueue: Promise<void> = Promise.resolve();
export const useUpdateStore = create<UpdateState>((set) => ({
  snapshot: null,
  dialog: false,
  checking: false,
  setDialog: (dialog) => set({ dialog }),
  check: async () => {
    if (!isTauriEnv() || useUpdateStore.getState().checking) return;
    set({ checking: true });
    try {
      await invoke("update_check");
      set({ snapshot: await invoke<UpdateSnapshot>("update_status") });
    } finally {
      set({ checking: false });
    }
  },
  download: async () => {
    if (!isTauriEnv() || useUpdateStore.getState().checking) return;
    set({ checking: true });
    try {
      await invoke("update_download");
      set({ snapshot: await invoke<UpdateSnapshot>("update_status") });
    } finally {
      set({ checking: false });
    }
  },
  preferences: (patch) => {
    const save = preferencesQueue.then(async () => {
      const current = await invoke<UpdateSnapshot>("update_status");
      await invoke("update_preferences", {
        preferences: { ...current.preferences, ...patch },
      });
      set({ snapshot: await invoke<UpdateSnapshot>("update_status") });
    });
    preferencesQueue = save.catch(() => {});
    return save;
  },
}));

/** Native owns the timer and all network work; this listener only projects state. */
export function attachUpdates(): () => void {
  if (!isTauriEnv()) return () => {};
  let disposed = false;
  let revision = 0;
  let unlisten: (() => void) | undefined;
  void (async () => {
    unlisten = await listen<UpdateSnapshot>("desktop-update", ({ payload }) => {
      revision++;
      if (!disposed) useUpdateStore.setState({ snapshot: payload });
    });
    if (disposed) {
      unlisten();
      return;
    }
    const before = revision;
    const snapshot = await invoke<UpdateSnapshot>("update_status");
    if (!disposed && before === revision) useUpdateStore.setState({ snapshot });
  })().catch(() => {});
  return () => {
    disposed = true;
    unlisten?.();
  };
}
