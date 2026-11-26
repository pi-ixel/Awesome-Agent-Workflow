import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BrowserSpace,
  BrowserTab,
} from "../../../contracts/browser/types.ts";
import type { HostService } from "../../host/service.ts";
import { createBrowserRestorePlan } from "../domain/model.ts";

type RestoreSnapshot = Awaited<
  ReturnType<HostService["browser"]["readRestore"]>
>;

export function useBrowserRestore(
  host: HostService["browser"],
  workspaceId: string,
  sessionId: string,
  space: BrowserSpace | null,
  createTab: (url: string) => Promise<BrowserTab | undefined>,
  agentKey?: string,
) {
  const scope = useMemo(
    () => ({ workspaceId, sessionId, ...(agentKey ? { agentKey } : {}) }),
    [workspaceId, sessionId, agentKey],
  );
  const hasSpace = space !== null;
  const liveSpace = useRef(space);
  useEffect(() => {
    liveSpace.current = space;
  }, [space]);
  const [snapshot, setSnapshot] = useState<RestoreSnapshot>();
  const [pendingTabs, setPendingTabs] = useState<string[] | null>(null);
  const [error, setError] = useState<string>();
  const [isSaving, setIsSaving] = useState(false);
  const inFlight = useRef(false);
  const lastAttempt = useRef<string | undefined>(undefined);
  const pendingSave = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    const flush = () => pendingSave.current?.();
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  useEffect(() => {
    if (!hasSpace) return;
    let isActive = true;
    void (async () => {
      try {
        const saved = await host.readRestore(scope);
        if (!isActive) return;
        setSnapshot(saved);
        const restored: string[] = [];
        if (saved.revision !== null && liveSpace.current?.tabs.length === 0) {
          for (const url of saved.urls) {
            if (!isActive) return;
            const tab = await createTab(url);
            if (!tab) {
              if (isActive)
                setError(
                  "部分浏览器标签未能恢复。上次保存的快照仍可在下次打开时重试。",
                );
              return;
            }
            restored.push(tab.tabId);
          }
        }
        if (isActive) setPendingTabs(restored);
      } catch {
        if (isActive)
          setError("无法读取浏览器标签恢复数据。当前浏览仍可使用。");
      }
    })();
    return () => {
      isActive = false;
    };
  }, [createTab, hasSpace, host, scope]);

  const committed = JSON.stringify(
    createBrowserRestorePlan(
      space?.tabs.flatMap((tab) =>
        tab.lifecycle !== "closed" && tab.committedUrl
          ? [tab.committedUrl]
          : [],
      ) ?? [],
    ),
  );

  const save = useCallback(
    async (enabled: boolean, value: string) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setIsSaving(true);
      try {
        const current = snapshot ?? (await host.readRestore(scope));
        const urls = (JSON.parse(value) as string[])
          .filter((url) => url.length <= 4096)
          .slice(0, 32);
        lastAttempt.current = value;
        setSnapshot(
          await host.saveRestore(scope, { ...current, enabled, urls }),
        );
        setPendingTabs([]);
        setError(undefined);
      } catch (cause) {
        if (String(cause).includes("BROWSER_RESTORE_CHANGED")) {
          const latest = await host.readRestore(scope).catch(() => undefined);
          if (latest) {
            setSnapshot(latest);
            if (enabled === (latest.revision !== null)) return;
          }
        }
        setError("无法保存浏览器标签恢复数据。当前浏览仍可使用。");
      } finally {
        inFlight.current = false;
        setIsSaving(false);
      }
    },
    [host, scope, snapshot],
  );

  const enabled = snapshot?.revision != null;
  const isReady =
    pendingTabs !== null &&
    pendingTabs.every((tabId) => {
      const tab = space?.tabs.find((item) => item.tabId === tabId);
      return tab && (tab.lifecycle === "closed" || tab.committedUrl !== null);
    });
  useEffect(() => {
    pendingSave.current = undefined;
    if (!enabled || !isReady || isSaving || committed === lastAttempt.current)
      return;
    const savePending = () => {
      if (pendingSave.current !== savePending) return;
      pendingSave.current = undefined;
      void save(true, committed);
    };
    pendingSave.current = savePending;
    const timer = setTimeout(savePending, 300);
    return () => clearTimeout(timer);
  }, [committed, enabled, isReady, isSaving, save]);

  return {
    initialized: pendingTabs !== null || Boolean(error),
    enabled,
    isSaving: isSaving || (!snapshot && !error),
    error,
    toggle: (next: boolean) => save(next, committed),
  };
}
