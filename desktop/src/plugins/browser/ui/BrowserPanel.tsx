import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BrowserApproval,
  BrowserSpace,
} from "../../../contracts/browser/types.ts";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CameraIcon,
  DatabaseIcon,
  MousePointer2Icon,
  PlusIcon,
  RefreshIcon,
  SquareIcon,
  XIcon,
} from "../../../shared/ui/icons.tsx";
import { IconButton } from "../../../shared/ui/IconButton.tsx";
import type { HostService } from "../../host/service.ts";
import type {
  BrowserCleanupPreview,
  BrowserCleanupResult,
  BrowserDataCatalogEntry,
  BrowserDialog,
  BrowserDownload,
  BrowserPermission,
} from "../../../contracts/browser/types.ts";
import {
  applyBrowserNavigation,
  calculateBrowserBounds,
  changeBrowserPageZoom,
  createBrowserNavigationState,
  createBrowserRestorePlan,
  normalizeBrowserNavigationTarget,
} from "../domain/model.ts";
import { isNativeOccludingLayer } from "../domain/occlusion.ts";

export interface BrowserPanelProps {
  host: HostService["browser"];
  sessionId: string;
  workspaceId?: string;
  visible: boolean;
}

type CleanupScope = "site" | "cache" | "session" | "workspace" | "all";

interface CleanupResultView {
  scope: CleanupScope;
  result: BrowserCleanupResult;
}

export function BrowserPanel(props: BrowserPanelProps) {
  return <BrowserPanelSession key={props.sessionId} {...props} />;
}

function BrowserPanelSession({
  host,
  sessionId,
  workspaceId = sessionId,
  visible,
}: BrowserPanelProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [space, setSpace] = useState<BrowserSpace | null>(null);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [navigation, setNavigation] = useState(createBrowserNavigationState);
  const [error, setError] = useState<string | null>(null);
  const [cancelResult, setCancelResult] = useState<{
    tabId: string;
    ids: string[];
  } | null>(null);
  const [approvals, setApprovals] = useState<BrowserApproval[]>([]);
  const [permissions, setPermissions] = useState<BrowserPermission[]>([]);
  const [dialogs, setDialogs] = useState<BrowserDialog[]>([]);
  const [downloads, setDownloads] = useState<BrowserDownload[]>([]);
  const [dialogInput, setDialogInput] = useState("");
  const [evidenceUrl, setEvidenceUrl] = useState<string | null>(null);
  const [dataOpen, setDataOpen] = useState(false);
  const [catalog, setCatalog] = useState<BrowserDataCatalogEntry[]>([]);
  const [preview, setPreview] = useState<BrowserCleanupPreview | null>(null);
  const [confirmCleanup, setConfirmCleanup] = useState<CleanupScope | null>(
    null,
  );
  const [cleanupResult, setCleanupResult] = useState<CleanupResultView | null>(
    null,
  );
  const [activeCleanupTask, setActiveCleanupTask] = useState<string | null>(
    null,
  );
  const [picking, setPicking] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(1280);
  const [viewportHeight, setViewportHeight] = useState(720);
  const [restoreEnabled, setRestoreEnabled] = useState(
    () =>
      window.localStorage.getItem(
        `aaw-browser-restore:${sessionId}:enabled`,
      ) === "true",
  );
  const activeTab =
    space?.tabs.find(
      (tab) => tab.tabId === activeTabId && tab.lifecycle !== "closed",
    ) ?? null;
  const agentActive = space?.agentActive ?? false;
  const userCanControl = !agentActive;
  const cancelledIds =
    cancelResult?.tabId === activeTabId ? cancelResult.ids : null;
  const pickingRef = useRef(false);
  const activeTabIdRef = useRef<string | null>(activeTabId);
  const pageKey = activeTab
    ? `${activeTab.tabId}:${activeTab.generation}`
    : null;
  const previousPageRef = useRef({
    key: pageKey,
    tabId: activeTab?.tabId ?? null,
  });
  useEffect(() => {
    pickingRef.current = picking;
  }, [picking]);
  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);
  useEffect(() => {
    const previous = previousPageRef.current;
    const changed = previous.key !== pageKey;
    if (!changed && !agentActive) return;
    const tabId = changed ? previous.tabId : (activeTab?.tabId ?? null);
    if (pickingRef.current && tabId)
      void host.pickCancel(sessionId, tabId).catch(() => undefined);
    previousPageRef.current = { key: pageKey, tabId: activeTab?.tabId ?? null };
    pickingRef.current = false;
    setPicking(false);
  }, [activeTab?.tabId, agentActive, host, pageKey, sessionId]);
  useEffect(
    () => () => {
      const tabId = activeTabIdRef.current;
      if (pickingRef.current && tabId)
        void host.pickCancel(sessionId, tabId).catch(() => undefined);
    },
    [host, sessionId],
  );
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !pickingRef.current) return;
      const tabId = activeTabIdRef.current;
      if (!tabId) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void host
        .pickCancel(sessionId, tabId)
        .then(() => {
          pickingRef.current = false;
          setPicking(false);
        })
        .catch((cause) => setError(String(cause)));
    };
    window.addEventListener("keydown", cancel, true);
    return () => window.removeEventListener("keydown", cancel, true);
  }, [host, sessionId]);

  const refresh = useCallback(async () => {
    const snapshot = await host.snapshot(sessionId);
    setSpace(snapshot);
    if (
      !snapshot.tabs.some(
        (tab) => tab.tabId === activeTabId && tab.lifecycle !== "closed",
      )
    ) {
      const nextActiveId = snapshot.tabs.find(
        (tab) => tab.lifecycle !== "closed",
      )?.tabId;
      setActiveTabId(nextActiveId ?? null);
      setDraft(
        snapshot.tabs.find((tab) => tab.tabId === nextActiveId)?.committedUrl ??
          "",
      );
    }
  }, [activeTabId, host, sessionId]);

  useEffect(() => {
    if (!dataOpen) return;
    let active = true;
    void Promise.all([host.dataCatalog(), host.cleanupPreview(sessionId)])
      .then(([entries, cleanupPreview]) => {
        if (!active) return;
        setCatalog(entries);
        setPreview(cleanupPreview);
      })
      .catch((cause) => setError(String(cause)));
    return () => {
      active = false;
    };
  }, [dataOpen, host, sessionId]);

  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};
    void host
      .approvalSnapshot(sessionId)
      .then((items) => {
        if (active) setApprovals(items);
      })
      .catch((cause) => setError(String(cause)));
    void host
      .onApproval((approval) => {
        if (!active || approval.sessionId !== sessionId) return;
        setApprovals((current) => [
          ...current.filter((item) => item.approvalId !== approval.approvalId),
          approval,
        ]);
      })
      .then((release) => {
        unsubscribe = release;
        if (!active) release();
      })
      .catch((cause) => setError(String(cause)));
    return () => {
      active = false;
      unsubscribe();
    };
  }, [host, sessionId]);

  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};
    void host
      .permissionSnapshot(sessionId)
      .then((items) => {
        if (active) setPermissions(items);
      })
      .catch((cause) => setError(String(cause)));
    void host
      .onPermission(({ sessionId: owner, permission }) => {
        if (!active || owner !== sessionId) return;
        setPermissions((current) => [
          ...current.filter(
            (item) =>
              item.origin !== permission.origin ||
              item.permissionKind !== permission.permissionKind,
          ),
          permission,
        ]);
      })
      .then((release) => {
        unsubscribe = release;
        if (!active) release();
      })
      .catch((cause) => setError(String(cause)));
    return () => {
      active = false;
      unsubscribe();
    };
  }, [host, sessionId]);

  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};
    void host
      .dialogSnapshot(sessionId)
      .then((items) => {
        if (active) setDialogs(items);
      })
      .catch((cause) => setError(String(cause)));
    void host
      .onDialog((event) => {
        if (!active) return;
        const dialog = "dialog" in event ? event.dialog : event;
        if (dialog.sessionId !== sessionId) return;
        if ("cancelApplied" in event && !event.cancelApplied)
          setError("对话框超时取消未能确认，请检查页面实际状态");
        setDialogs((current) =>
          dialog.status === "pending"
            ? [
                ...current.filter((item) => item.dialogId !== dialog.dialogId),
                dialog,
              ]
            : current.filter((item) => item.dialogId !== dialog.dialogId),
        );
        if (dialog.status === "pending")
          setDialogInput(dialog.defaultValue ?? "");
      })
      .then((release) => {
        unsubscribe = release;
        if (!active) release();
      })
      .catch((cause) => setError(String(cause)));
    return () => {
      active = false;
      unsubscribe();
    };
  }, [host, sessionId]);

  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};
    void host
      .downloadSnapshot(sessionId)
      .then((items) => {
        if (active) setDownloads(items);
      })
      .catch((cause) => setError(String(cause)));
    void host
      .onDownload((download) => {
        if (!active || download.sessionId !== sessionId) return;
        setDownloads((current) => [
          ...current.filter((item) => item.downloadId !== download.downloadId),
          download,
        ]);
      })
      .then((release) => {
        unsubscribe = release;
        if (!active) release();
      })
      .catch((cause) => setError(String(cause)));
    return () => {
      active = false;
      unsubscribe();
    };
  }, [host, sessionId]);

  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};
    void host
      .onElement((element) => {
        if (active && element.sessionId === sessionId) {
          pickingRef.current = false;
          setPicking(false);
        }
      })
      .then((release) => {
        unsubscribe = release;
        if (!active) release();
      })
      .catch((cause) => setError(String(cause)));
    return () => {
      active = false;
      unsubscribe();
    };
  }, [host, sessionId]);

  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};
    void host
      .onPickCancel((event) => {
        if (!active || event.sessionId !== sessionId) return;
        pickingRef.current = false;
        setPicking(false);
      })
      .then((release) => {
        unsubscribe = release;
        if (!active) release();
      })
      .catch((cause) => setError(String(cause)));
    return () => {
      active = false;
      unsubscribe();
    };
  }, [host, sessionId]);

  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};
    void host
      .onActivity((snapshot) => {
        if (!active || snapshot.sessionId !== sessionId) return;
        setSpace(snapshot);
        setCancelResult(null);
        void host
          .approvalSnapshot(sessionId)
          .then((items) => {
            if (active) setApprovals(items);
          })
          .catch((cause) => setError(String(cause)));
      })
      .then((release) => {
        unsubscribe = release;
        if (!active) release();
      })
      .catch((cause) => setError(String(cause)));
    return () => {
      active = false;
      unsubscribe();
    };
  }, [host, sessionId]);

  const bounds = useCallback(() => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0, width: 640, height: 480 };
    return calculateBrowserBounds(rect, window.devicePixelRatio || 1);
  }, []);

  const createTab = useCallback(
    async (url = "about:blank") => {
      try {
        const tab = await host.createTab(sessionId, url, bounds());
        setSpace((current) =>
          current
            ? {
                ...current,
                tabs: [
                  ...current.tabs.filter((item) => item.tabId !== tab.tabId),
                  tab,
                ],
              }
            : current,
        );
        setActiveTabId(tab.tabId);
        setDraft(tab.committedUrl ?? "");
        setError(null);
      } catch (cause) {
        setError(String(cause));
      }
    },
    [bounds, host, sessionId],
  );

  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};
    void host
      .onPage((event) => {
        if (!active || event.sessionId !== sessionId) return;
        if (event.event === "Started" || event.event === "Finished") {
          if (event.event === "Started") {
            pickingRef.current = false;
            setPicking(false);
          }
          setNavigation((current) => ({
            ...current,
            loading: event.event === "Started",
          }));
        }
        void refresh().catch((cause) => setError(String(cause)));
      })
      .then((release) => {
        unsubscribe = release;
        if (!active) release();
      })
      .catch((cause) => setError(String(cause)));
    return () => {
      active = false;
      unsubscribe();
    };
  }, [host, refresh, sessionId]);

  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};
    void host
      .onZoom((event) => {
        if (
          !active ||
          event.sessionId !== sessionId ||
          event.tabId !== activeTab?.tabId ||
          event.tabGeneration !== activeTab.generation
        )
          return;
        setNavigation((current) => ({ ...current, pageZoom: event.zoom }));
      })
      .then((release) => {
        unsubscribe = release;
        if (!active) release();
      })
      .catch((cause) => setError(String(cause)));
    return () => {
      active = false;
      unsubscribe();
    };
  }, [activeTab?.tabId, activeTab?.generation, host, sessionId]);

  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};
    void host
      .onPopup((popup) => {
        if (active && popup.sessionId === sessionId) void createTab(popup.url);
      })
      .then((release) => {
        unsubscribe = release;
        if (!active) release();
      })
      .catch((cause) => setError(String(cause)));
    return () => {
      active = false;
      unsubscribe();
    };
  }, [createTab, host, sessionId]);

  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};
    void host
      .onSelect(({ sessionId: owner, tabId }) => {
        if (!active || owner !== sessionId) return;
        if (
          space?.tabs.some(
            (tab) => tab.tabId === tabId && tab.lifecycle !== "closed",
          )
        ) {
          setActiveTabId(tabId);
        }
      })
      .then((release) => {
        unsubscribe = release;
        if (!active) release();
      })
      .catch((cause) => setError(String(cause)));
    return () => {
      active = false;
      unsubscribe();
    };
  }, [host, sessionId, space]);

  useEffect(() => {
    let active = true;
    const open = async () => {
      try {
        const created = await host.createSpace("main", workspaceId, sessionId);
        if (active && created) {
          setSpace(created);
          setActiveTabId(
            (current) =>
              current ??
              created.tabs.find((tab) => tab.lifecycle !== "closed")?.tabId ??
              null,
          );
          if (created.tabs.length === 0 && restoreEnabled) {
            try {
              const saved: unknown = JSON.parse(
                window.localStorage.getItem(
                  `aaw-browser-restore:${sessionId}:tabs`,
                ) ?? "[]",
              );
              if (Array.isArray(saved)) {
                for (const url of createBrowserRestorePlan(
                  saved.filter(
                    (item): item is string => typeof item === "string",
                  ),
                )) {
                  await createTab(url);
                }
              }
            } catch (cause) {
              setError(`标签恢复失败：${String(cause)}`);
            }
          }
        }
      } catch (cause) {
        if (!String(cause).includes("SESSION_EXISTS")) {
          if (active) setError(String(cause));
          return;
        }
        if (active) await refresh();
      }
    };
    void open();
    return () => {
      active = false;
    };
  }, [createTab, host, refresh, restoreEnabled, sessionId, workspaceId]);

  useEffect(() => {
    if (!activeTab) return;
    const element = viewportRef.current;
    if (!element) return;
    const synchronize = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      void host
        .setBounds(sessionId, activeTab.tabId, bounds())
        .catch((cause) => setError(String(cause)));
    };
    if (typeof ResizeObserver === "undefined") {
      synchronize();
      return;
    }
    const observer = new ResizeObserver(synchronize);
    observer.observe(element);
    synchronize();
    return () => observer.disconnect();
  }, [activeTab, bounds, host, sessionId]);

  const nativeTabId = activeTab?.tabId;
  const [nativeOccluded, setNativeOccluded] = useState(false);
  useEffect(() => {
    if (!nativeTabId || !visible) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    let frame: number | null = null;
    const evaluate = () => {
      frame = null;
      const viewportRect = viewport.getBoundingClientRect();
      const candidates = document.querySelectorAll<HTMLElement>(
        '[aria-modal="true"], .fixed, .absolute, [style*="position: fixed"], [style*="position:fixed"]',
      );
      let occluded = false;
      for (const element of candidates) {
        if (
          element === viewport ||
          viewport.contains(element) ||
          element.contains(viewport)
        )
          continue;
        const style = getComputedStyle(element);
        const layerVisible =
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity) > 0;
        if (!layerVisible) continue;
        if (element.getAttribute("aria-modal") === "true") {
          occluded = true;
          break;
        }
        const rect = element.getBoundingClientRect();
        occluded = isNativeOccludingLayer(
          {
            position: style.position,
            zIndex: Number.parseInt(style.zIndex, 10) || 0,
            visible: rect.width > 0 && rect.height > 0,
            withinViewport: false,
            containsViewport: false,
            rect,
          },
          viewportRect,
        );
        if (occluded) break;
      }
      setNativeOccluded(occluded);
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(evaluate);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "class",
        "style",
        "hidden",
        "aria-modal",
        "aria-hidden",
      ],
    });
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    document.addEventListener("transitionend", schedule, true);
    document.addEventListener("animationend", schedule, true);
    schedule();
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
      document.removeEventListener("transitionend", schedule, true);
      document.removeEventListener("animationend", schedule, true);
    };
  }, [nativeTabId, visible]);

  useEffect(() => {
    if (!nativeTabId) return;
    const tabId = nativeTabId;
    void host
      .setVisible(sessionId, tabId, visible && !nativeOccluded)
      .catch((cause) => setError(String(cause)));
    return () => {
      void host
        .setVisible(sessionId, tabId, false)
        .catch((cause) => setError(String(cause)));
    };
  }, [host, nativeOccluded, nativeTabId, sessionId, visible]);

  useEffect(() => {
    if (!space) return;
    const urls = createBrowserRestorePlan(
      space.tabs
        .filter((tab) => tab.lifecycle !== "closed")
        .map((tab) => tab.committedUrl)
        .filter((url): url is string => typeof url === "string"),
    );
    window.localStorage.setItem(
      `aaw-browser-restore:${sessionId}:tabs`,
      JSON.stringify(urls),
    );
  }, [sessionId, space]);

  const navigate = async () => {
    if (!userCanControl) {
      setError("CONTROL_NOT_GRANTED：Agent 正在操作，可点击页面中的“我来接管”");
      return;
    }
    const target = normalizeBrowserNavigationTarget(draft);
    if (target.error || !target.url) {
      setError(
        target.error === "NAVIGATION_DENIED"
          ? "该协议不允许在 AAW 中打开"
          : "请输入有效的 HTTP/HTTPS 地址",
      );
      return;
    }
    try {
      if (activeTab) {
        const tab = await host.navigate(sessionId, activeTab.tabId, target.url);
        setSpace((current) =>
          current
            ? {
                ...current,
                tabs: current.tabs.map((item) =>
                  item.tabId === tab.tabId ? tab : item,
                ),
              }
            : current,
        );
      } else {
        await createTab(target.url);
      }
      setNavigation((current) =>
        applyBrowserNavigation(current, { type: "navigate", url: target.url }),
      );
      setError(null);
    } catch (cause) {
      setError(String(cause));
    }
  };

  const changeZoom = (direction: "in" | "out" | "reset") => {
    const next = changeBrowserPageZoom(navigation, direction);
    if (activeTab)
      void host
        .setZoom(sessionId, activeTab.tabId, next.pageZoom)
        .catch((cause) => setError(String(cause)));
  };

  const executeCleanup = async (
    scope: CleanupScope | null = confirmCleanup,
  ) => {
    if (!scope) return;
    const taskId = crypto.randomUUID();
    setCleanupResult(null);
    if (scope === "workspace" || scope === "all") setActiveCleanupTask(taskId);
    try {
      let result: BrowserCleanupResult;
      if (scope === "workspace")
        result = await host.clearWorkspaceData(workspaceId, taskId);
      else if (scope === "all") result = await host.clearAllData(taskId);
      else {
        let status: string;
        if (scope === "cache") status = await host.clearCache(sessionId);
        else if (scope === "session")
          status = await host.clearSessionData(sessionId);
        else {
          const origin = activeTab?.committedUrl
            ? new URL(activeTab.committedUrl).origin
            : null;
          if (!origin) throw new Error("NO_ACTIVE_SITE");
          status = await host.clearSiteData(sessionId, origin);
        }
        result = { status, items: [{ itemId: scope, status }] };
      }
      setCleanupResult({ scope, result });
      setConfirmCleanup(null);
      setCatalog(await host.dataCatalog());
      setPreview(await host.cleanupPreview(sessionId));
      await refresh();
      setError(null);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setActiveCleanupTask(null);
    }
  };

  const saveEvidence = async () => {
    if (!activeTab) return;
    try {
      const evidence = await host.screenshot(sessionId, activeTab.tabId);
      const bytes = await host.readEvidence(sessionId, evidence.artifactId);
      if (evidenceUrl) URL.revokeObjectURL(evidenceUrl);
      setEvidenceUrl(
        URL.createObjectURL(
          new Blob([new Uint8Array(bytes)], { type: "image/png" }),
        ),
      );
      setError(null);
    } catch (cause) {
      setError(String(cause));
    }
  };

  useEffect(
    () => () => {
      if (evidenceUrl) URL.revokeObjectURL(evidenceUrl);
    },
    [evidenceUrl],
  );

  return (
    <section
      aria-label="内嵌浏览器"
      data-testid="browser-panel"
      className="relative flex h-full min-h-0 min-w-0 flex-col bg-base text-ink"
      onKeyDown={(event) => {
        if (!event.ctrlKey) return;
        if (event.key === "0") changeZoom("reset");
        if (event.key === "+" || event.key === "=") changeZoom("in");
        if (event.key === "-") changeZoom("out");
      }}
    >
      <div className="flex min-h-10 min-w-0 flex-nowrap items-center gap-0.5 border-b border-line px-1">
        <IconButton
          type="button"
          aria-label="后退"
          data-hint={
            userCanControl ? "后退" : "Agent 正在操作，点击“我来接管”后可操作"
          }
          disabled={!userCanControl || !activeTab || navigation.index <= 0}
          className="rounded shrink-0 p-1 hover:bg-hover disabled:opacity-40"
          onClick={() => {
            if (!userCanControl || !activeTab) return;
            void host
              .back(sessionId, activeTab.tabId)
              .then(refresh)
              .catch((cause) => setError(String(cause)));
            setNavigation((current) =>
              applyBrowserNavigation(current, { type: "back" }),
            );
          }}
        >
          <ArrowLeftIcon className="ui-icon-16" />
        </IconButton>
        <IconButton
          type="button"
          aria-label="前进"
          data-hint={
            userCanControl ? "前进" : "Agent 正在操作，点击“我来接管”后可操作"
          }
          disabled={
            !userCanControl ||
            !activeTab ||
            navigation.index >= navigation.entries.length - 1
          }
          className="rounded shrink-0 p-1 hover:bg-hover disabled:opacity-40"
          onClick={() => {
            if (!userCanControl || !activeTab) return;
            void host
              .forward(sessionId, activeTab.tabId)
              .then(refresh)
              .catch((cause) => setError(String(cause)));
            setNavigation((current) =>
              applyBrowserNavigation(current, { type: "forward" }),
            );
          }}
        >
          <ArrowRightIcon className="ui-icon-16" />
        </IconButton>
        <IconButton
          type="button"
          aria-label="刷新"
          data-hint={
            userCanControl ? "刷新" : "Agent 正在操作，点击“我来接管”后可操作"
          }
          disabled={!userCanControl || !activeTab}
          className="rounded shrink-0 p-1 hover:bg-hover disabled:opacity-40"
          onClick={() =>
            userCanControl &&
            activeTab &&
            void host
              .reload(sessionId, activeTab.tabId)
              .catch((cause) => setError(String(cause)))
          }
        >
          <RefreshIcon className="ui-icon-16" />
        </IconButton>
        <form
          className="min-w-16 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            void navigate();
          }}
        >
          <input
            aria-label="地址栏"
            value={draft}
            disabled={!userCanControl}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={
              userCanControl ? "输入 HTTP/HTTPS 地址" : "Agent 正在操作"
            }
            className="min-h-7 w-full rounded-full border border-line bg-surface px-3 text-xs outline-none focus:border-focus-ring disabled:opacity-50"
          />
        </form>
        <span className="w-8 shrink-0 text-center text-2xs text-ink-muted">
          {Math.round(navigation.pageZoom * 100)}%
        </span>
        <IconButton
          type="button"
          aria-label={picking ? "取消拾取" : "拾取元素"}
          aria-pressed={picking}
          data-hint={
            !userCanControl
              ? "Agent 正在操作，点击“我来接管”后可拾取"
              : picking
                ? "取消拾取（Esc 同效）"
                : "拾取元素"
          }
          disabled={!userCanControl || !activeTab}
          className={`rounded shrink-0 p-1 transition-colors hover:bg-hover hover:text-ink disabled:opacity-40 ${picking ? "bg-selected text-brand" : ""}`}
          onClick={() => {
            if (!userCanControl || !activeTab) return;
            if (picking) {
              void host
                .pickCancel(sessionId, activeTab.tabId)
                .then(() => {
                  pickingRef.current = false;
                  setPicking(false);
                })
                .catch((cause) => setError(String(cause)));
            } else {
              void host
                .pickStart(sessionId, activeTab.tabId)
                .then(() => {
                  pickingRef.current = true;
                  setPicking(true);
                })
                .catch((cause) => setError(String(cause)));
            }
          }}
        >
          <MousePointer2Icon className="ui-icon-16" />
        </IconButton>
        <IconButton
          type="button"
          aria-label="保存证据"
          data-hint="保存证据"
          disabled={!activeTab}
          className="rounded shrink-0 p-1 transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
          onClick={() => void saveEvidence()}
        >
          <CameraIcon className="ui-icon-16" />
        </IconButton>
        <IconButton
          type="button"
          aria-label="停止 Agent 浏览器操作"
          data-hint="停止 Agent 浏览器操作"
          disabled={!activeTab}
          className="rounded shrink-0 p-1 text-danger-ink transition-colors hover:bg-hover disabled:opacity-40"
          onClick={() =>
            void host
              .cancelRequests(sessionId)
              .then((ids) => {
                if (activeTab) setCancelResult({ tabId: activeTab.tabId, ids });
                setError(null);
              })
              .catch((cause) => setError(String(cause)))
          }
        >
          <SquareIcon className="ui-icon-16" />
        </IconButton>
        <IconButton
          type="button"
          aria-label="浏览器数据管理"
          aria-expanded={dataOpen}
          data-hint={dataOpen ? "关闭数据管理" : "浏览器数据管理"}
          className="rounded shrink-0 p-1 transition-colors hover:bg-hover hover:text-ink"
          onClick={() => setDataOpen((current) => !current)}
        >
          <DatabaseIcon className="ui-icon-16" />
        </IconButton>
        <IconButton
          type="button"
          aria-label="新建标签页"
          data-hint={
            userCanControl
              ? "新建标签页"
              : "Agent 正在操作，点击“我来接管”后可新建"
          }
          disabled={!userCanControl}
          className="rounded shrink-0 p-1 hover:bg-hover disabled:opacity-40"
          onClick={() => void createTab()}
        >
          <PlusIcon className="ui-icon-16" />
        </IconButton>
      </div>
      {space && space.tabs.length > 0 && (
        <div className="flex min-h-8 items-center gap-1 overflow-x-auto border-b border-line px-2">
          {space.tabs
            .filter((tab) => tab.lifecycle !== "closed")
            .map((tab) => (
              <div
                key={tab.tabId}
                className={`flex min-w-24 max-w-48 items-center gap-1 rounded pr-1 text-xs ${tab.tabId === activeTabId ? "bg-selected" : "hover:bg-hover"}`}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate rounded px-2 py-1 text-left"
                  onClick={() => {
                    setActiveTabId(tab.tabId);
                    setDraft(tab.committedUrl ?? "");
                  }}
                >
                  {tab.committedUrl || "空白页"}
                </button>
                <IconButton
                  aria-label={`关闭标签 ${tab.tabId}`}
                  disabled={!userCanControl}
                  className="rounded p-1 text-ink-mute hover:bg-hover"
                  onClick={() => {
                    void host
                      .closeTab(sessionId, tab.tabId)
                      .then(refresh)
                      .catch((cause) => setError(String(cause)));
                  }}
                >
                  <XIcon className="ui-icon-12" />
                </IconButton>
              </div>
            ))}
        </div>
      )}
      {error && (
        <p
          role="alert"
          className="border-b border-line px-3 py-1 text-xs text-danger-ink"
        >
          {error}
        </p>
      )}
      {cancelledIds !== null && (
        <p
          role="status"
          className="border-b border-line px-3 py-1 text-xs text-ink-muted"
        >
          {cancelledIds.length > 0
            ? `已停止 ${cancelledIds.length} 个 Agent 动作`
            : "当前没有执行中的 Agent 动作"}
        </p>
      )}
      <div
        ref={viewportRef}
        data-browser-viewport={sessionId}
        className="relative min-h-0 flex-1 bg-white"
        onWheel={(event) => {
          if (!event.ctrlKey) return;
          event.preventDefault();
          changeZoom(event.deltaY < 0 ? "in" : "out");
        }}
      >
        {activeTab?.lifecycle === "crashed" && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-base text-sm text-ink">
            <span>页面进程已退出，标签和最后地址仍保留。</span>
            <button
              type="button"
              disabled={!userCanControl}
              className="rounded border border-line px-3 py-1.5 disabled:opacity-40"
              onClick={() => {
                if (!userCanControl) return;
                void host
                  .recoverTab(sessionId, activeTab.tabId, bounds())
                  .then(refresh)
                  .catch((cause) => setError(String(cause)));
              }}
            >
              恢复页面
            </button>
          </div>
        )}
        {!activeTab && (
          <div className="flex h-full items-center justify-center text-sm text-ink-muted">
            输入地址或新建标签页开始浏览
          </div>
        )}
      </div>
      {picking && (
        <div role="status" className="px-3 py-2 text-xs text-brand">
          正在拾取：移动鼠标框选元素，单击加入会话，Esc 取消
        </div>
      )}
      {evidenceUrl && (
        <div className=" right-4 top-20 z-20 max-w-[80%] rounded-lg border border-line bg-base p-2 shadow-floating">
          <div className="mb-2 flex justify-end gap-2">
            <button
              type="button"
              className="text-xs"
              onClick={() => setEvidenceUrl(null)}
            >
              关闭
            </button>
          </div>
          <img
            aria-label="浏览器截图证据"
            src={evidenceUrl}
            className="max-h-96 max-w-full object-contain"
          />
        </div>
      )}
      {dataOpen && (
        <div
          role="dialog"
          aria-label="浏览器数据管理"
          className=" inset-x-6 top-16 z-20 max-h-[70vh] overflow-y-auto rounded-lg border border-line bg-base p-4 shadow-floating"
        >
          <div className="sticky top-0 z-10 flex items-start justify-between gap-3 bg-base pb-2">
            <div>
              <h2 className="text-sm font-medium">浏览器数据管理</h2>
              <p className="mt-1 text-xs text-ink-muted">
                支持缓存、站点、会话、工作区和全部浏览器数据分层管理；清理前必须确认实际范围。
              </p>
            </div>
            <button
              type="button"
              aria-label="关闭数据管理"
              className="shrink-0 rounded border border-line px-2 py-1 text-xs hover:bg-hover"
              onClick={() => setDataOpen(false)}
            >
              关闭
            </button>
          </div>
          <div aria-label="数据分区列表" className="mt-3 space-y-1 text-xs">
            {catalog
              .filter((entry) => entry.sessionId === sessionId)
              .map((entry) => (
                <div
                  key={entry.partitionId}
                  className="flex justify-between gap-3"
                >
                  <span>
                    {entry.lifecycle} · {entry.activeTabCount} 个活动标签
                  </span>
                  <span>
                    {entry.occupancy.bytes === null
                      ? `占用未知：${entry.occupancy.reason ?? "无法读取"}`
                      : `${entry.occupancy.bytes} 字节（${entry.occupancy.status === "actual" ? "实际" : "估算"}）`}
                  </span>
                </div>
              ))}
          </div>
          {preview && (
            <p className="mt-2 text-xs text-ink-muted">
              本次会话影响：{preview.affected.join("、")}
              ；不包含会话正文、项目或工作流文件。
            </p>
          )}
          {permissions.length > 0 && (
            <div className="mt-3 space-y-1 text-xs" aria-label="站点权限列表">
              {permissions.map((permission) => (
                <div
                  key={`${permission.origin}:${permission.permissionKind}`}
                  className="flex items-center gap-2"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {permission.origin} · {permission.permissionKind} ·{" "}
                    {permission.decision === "allow" ? "已允许" : "已拒绝"}
                  </span>
                  <button
                    type="button"
                    className="rounded border border-line px-2 py-1"
                    onClick={() => {
                      const operation =
                        permission.decision === "allow"
                          ? host
                              .revokePermission(
                                sessionId,
                                permission.origin,
                                permission.permissionKind,
                              )
                              .then(() => null)
                          : host
                              .decidePermission(
                                sessionId,
                                permission.origin,
                                permission.permissionKind,
                                true,
                              )
                              .then((value) => value);
                      void operation
                        .then((updated) => {
                          setPermissions((current) =>
                            updated
                              ? current.map((item) =>
                                  item.origin === updated.origin &&
                                  item.permissionKind === updated.permissionKind
                                    ? updated
                                    : item,
                                )
                              : current.filter(
                                  (item) =>
                                    item.origin !== permission.origin ||
                                    item.permissionKind !==
                                      permission.permissionKind,
                                ),
                          );
                        })
                        .catch((cause) => setError(String(cause)));
                    }}
                  >
                    {permission.decision === "allow" ? "撤销" : "允许"}
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="mt-3 flex items-center gap-2 text-xs">
            <label>
              自由视口宽{" "}
              <input
                aria-label="自由视口宽"
                type="number"
                value={viewportWidth}
                onChange={(event) =>
                  setViewportWidth(Number(event.target.value))
                }
                className="w-20 rounded border border-line bg-surface px-1"
              />
            </label>
            <label>
              高{" "}
              <input
                aria-label="自由视口高"
                type="number"
                value={viewportHeight}
                onChange={(event) =>
                  setViewportHeight(Number(event.target.value))
                }
                className="w-20 rounded border border-line bg-surface px-1"
              />
            </label>
            <button
              type="button"
              className="rounded border border-line px-2 py-1"
              disabled={!activeTab}
              onClick={() =>
                activeTab &&
                void host
                  .setViewport(
                    sessionId,
                    activeTab.tabId,
                    viewportWidth,
                    viewportHeight,
                  )
                  .catch((cause) => setError(String(cause)))
              }
            >
              应用
            </button>
            <button
              type="button"
              className="rounded border border-line px-2 py-1"
              disabled={!activeTab}
              onClick={() =>
                activeTab &&
                void host
                  .clearViewport(sessionId, activeTab.tabId)
                  .catch((cause) => setError(String(cause)))
              }
            >
              跟随容器
            </button>
          </div>
          <label className="mt-3 flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={restoreEnabled}
              onChange={(event) => {
                const enabled = event.target.checked;
                setRestoreEnabled(enabled);
                window.localStorage.setItem(
                  `aaw-browser-restore:${sessionId}:enabled`,
                  String(enabled),
                );
              }}
            />
            重启后恢复合法标签 URL
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded border border-line px-3 py-1 text-xs"
              onClick={() => setConfirmCleanup("cache")}
            >
              清除当前会话缓存
            </button>
            <button
              type="button"
              className="rounded border border-line px-3 py-1 text-xs"
              disabled={!activeTab}
              onClick={() => setConfirmCleanup("site")}
            >
              清除当前站点
            </button>
            <button
              type="button"
              className="rounded border border-line px-3 py-1 text-xs text-danger-ink"
              onClick={() => setConfirmCleanup("session")}
            >
              清除当前会话数据
            </button>
            <button
              type="button"
              className="rounded border border-line px-3 py-1 text-xs text-danger-ink"
              onClick={() => setConfirmCleanup("workspace")}
            >
              清除当前工作区
            </button>
            <button
              type="button"
              className="rounded border border-line px-3 py-1 text-xs text-danger-ink"
              onClick={() => setConfirmCleanup("all")}
            >
              清除全部浏览器数据
            </button>
            {confirmCleanup && (
              <div
                role="alert"
                className="w-full rounded border border-line bg-surface p-3 text-xs"
              >
                确认清理“{confirmCleanup}”范围？{preview?.affected.join("、")}
                。已完成的子项不会因取消而回滚。
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    className="rounded border border-line px-2 py-1"
                    onClick={() => setConfirmCleanup(null)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="rounded border border-line px-2 py-1 text-danger-ink"
                    onClick={() => void executeCleanup()}
                  >
                    确认清理
                  </button>
                  {activeCleanupTask && (
                    <button
                      type="button"
                      className="rounded border border-line px-2 py-1"
                      onClick={() => void host.cancelCleanup(activeCleanupTask)}
                    >
                      取消剩余子项
                    </button>
                  )}
                </div>
              </div>
            )}
            {cleanupResult && (
              <section
                aria-label="清理结果"
                className="w-full rounded border border-line bg-surface p-3 text-xs"
              >
                <div className="flex items-center justify-between gap-3">
                  <span>清理结果（{cleanupResult.scope}）</span>
                  <strong>{cleanupResult.result.status}</strong>
                </div>
                <ul className="mt-2 space-y-1">
                  {cleanupResult.result.items.map((item) => (
                    <li
                      key={item.itemId}
                      className="flex justify-between gap-3"
                    >
                      <code>{item.itemId}</code>
                      <span>{item.status}</span>
                    </li>
                  ))}
                </ul>
                {(cleanupResult.result.status !== "completed" ||
                  cleanupResult.result.items.some(
                    (item) => item.status !== "completed",
                  )) && (
                  <button
                    type="button"
                    className="mt-2 rounded border border-line px-2 py-1 hover:bg-hover"
                    onClick={() => void executeCleanup(cleanupResult.scope)}
                  >
                    重试该范围清理
                  </button>
                )}
              </section>
            )}
            <button
              type="button"
              className="rounded px-3 py-1 text-xs"
              onClick={() => setDataOpen(false)}
            >
              关闭
            </button>
          </div>
        </div>
      )}
      {downloads.length > 0 && (
        <section
          aria-label="下载列表"
          className=" inset-x-4 top-20 z-20 rounded-lg border border-line bg-base p-3 text-xs shadow-floating"
        >
          <h2 className="font-medium">下载</h2>
          <div className="mt-2 max-h-40 space-y-2 overflow-auto">
            {downloads.map((download) => (
              <div
                key={download.downloadId}
                className="flex items-center gap-2"
              >
                <span className="min-w-0 flex-1 truncate">
                  {download.fileName} · {download.origin}
                </span>
                <span>
                  {download.status}
                  {download.totalBytes
                    ? ` · ${download.bytesReceived ?? 0}/${download.totalBytes}`
                    : ""}
                </span>
                {download.status === "pending" && (
                  <>
                    <button
                      type="button"
                      className="rounded border border-line px-2 py-1"
                      onClick={() =>
                        void host
                          .decideDownload(sessionId, download.downloadId, false)
                          .catch((cause) => setError(String(cause)))
                      }
                    >
                      拒绝
                    </button>
                    <button
                      type="button"
                      className="rounded border border-line px-2 py-1"
                      onClick={() =>
                        void host
                          .decideDownload(sessionId, download.downloadId, true)
                          .catch((cause) => setError(String(cause)))
                      }
                    >
                      允许
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
      {dialogs.map((dialog) => (
        <div
          key={dialog.dialogId}
          role="dialog"
          aria-label="页面对话框"
          className=" inset-x-4 bottom-10 z-30 rounded-lg border border-line bg-base p-4 shadow-floating"
        >
          <h2 className="text-sm font-medium">页面{dialog.dialogType}对话框</h2>
          <p className="mt-1 text-xs text-ink-muted">
            {dialog.origin} · {dialog.tabId}
          </p>
          <p className="mt-2 whitespace-pre-wrap text-xs">{dialog.message}</p>
          {dialog.dialogType === "prompt" && (
            <input
              aria-label="对话框输入"
              className="mt-3 w-full rounded border border-line bg-surface px-2 py-1 text-xs"
              value={dialogInput}
              onChange={(event) => setDialogInput(event.target.value)}
            />
          )}
          <div className="mt-3 flex justify-end gap-2">
            {dialog.dialogType !== "alert" && (
              <button
                type="button"
                className="rounded border border-line px-3 py-1 text-xs"
                onClick={() => {
                  void host
                    .decideDialog(
                      sessionId,
                      dialog.tabId,
                      dialog.dialogId,
                      false,
                    )
                    .then(() =>
                      setDialogs((current) =>
                        current.filter(
                          (item) => item.dialogId !== dialog.dialogId,
                        ),
                      ),
                    )
                    .catch((cause) => setError(String(cause)));
                }}
              >
                取消
              </button>
            )}
            <button
              type="button"
              className="rounded bg-ink px-3 py-1 text-xs text-foreground-inverse"
              onClick={() => {
                void host
                  .decideDialog(
                    sessionId,
                    dialog.tabId,
                    dialog.dialogId,
                    true,
                    dialog.dialogType === "prompt" ? dialogInput : undefined,
                  )
                  .then(() =>
                    setDialogs((current) =>
                      current.filter(
                        (item) => item.dialogId !== dialog.dialogId,
                      ),
                    ),
                  )
                  .catch((cause) => setError(String(cause)));
              }}
            >
              确定
            </button>
          </div>
        </div>
      ))}
      {approvals
        .filter((approval) => approval.status === "pending")
        .map((approval) => (
          <div
            key={approval.approvalId}
            role="dialog"
            aria-label="浏览器高风险操作审批"
            className=" inset-x-4 bottom-10 z-20 rounded-lg border border-line bg-base p-4 shadow-floating"
          >
            <h2 className="text-sm font-medium">
              {approval.action === "control"
                ? "允许 Agent 控制此页面？"
                : approval.action === "submit"
                  ? "允许 Agent 提交此表单？"
                  : approval.action.startsWith("upload:")
                    ? "允许 Agent 上传指定文件？"
                    : "允许 Agent 执行此受限操作？"}
            </h2>
            <p className="mt-1 text-xs text-ink-muted">
              动作：{approval.action}；标签：{approval.tabId}
              ；仅限当前页面代次。
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                className="rounded border border-line px-3 py-1 text-xs"
                onClick={() => {
                  void host
                    .decideApproval(approval.approvalId, false)
                    .then(() =>
                      setApprovals((current) =>
                        current.filter(
                          (item) => item.approvalId !== approval.approvalId,
                        ),
                      ),
                    )
                    .catch((cause) => setError(String(cause)));
                }}
              >
                拒绝
              </button>
              <button
                type="button"
                className="rounded bg-ink px-3 py-1 text-xs text-foreground-inverse"
                onClick={() => {
                  void host
                    .decideApproval(approval.approvalId, true)
                    .then(() =>
                      setApprovals((current) =>
                        current.filter(
                          (item) => item.approvalId !== approval.approvalId,
                        ),
                      ),
                    )
                    .catch((cause) => setError(String(cause)));
                }}
              >
                批准一次
              </button>
            </div>
          </div>
        ))}
      <footer className="flex min-h-6 items-center justify-between border-t border-line px-3 text-2xs text-ink-muted">
        <span>
          {agentActive
            ? "Agent 正在操作"
            : activeTab
              ? "用户可控制"
              : "未打开页面"}
        </span>
        <span>
          {navigation.loading
            ? "加载中"
            : activeTab?.lifecycle === "crashed"
              ? "页面已崩溃"
              : "就绪"}
        </span>
      </footer>
    </section>
  );
}
