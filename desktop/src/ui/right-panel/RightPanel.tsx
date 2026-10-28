import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  emptyPanel,
  useRightPanelStore,
  type PanelTool,
} from "../../stores/rightPanelStore.ts";
import { useWorkbenchUiStore } from "../../stores/workbenchUiStore.ts";
import { panelError, panelService } from "../../core/panelService.ts";
import { insidePath, pathKey, pathName } from "../../core/panelPaths.ts";
import { ScopedErrorBoundary } from "../ErrorBoundary.tsx";
import { FileTree } from "./FileTree.tsx";
import { FilePreview } from "./FilePreview.tsx";
import { GitDiffView, GitPanel } from "./GitPanel.tsx";
import { AawPanel } from "./AawPanel.tsx";

const tools: readonly [PanelTool, string][] = [
  ["aaw", "AAW"],
  ["files", "文件"],
  ["git", "Git"],
];
export function PanelButtons({ project }: { project: string }) {
  const panel = useRightPanelStore(
    (state) => state.projects[pathKey(project)] ?? emptyPanel,
  );
  return (
    <div className="flex shrink-0 gap-1" aria-label="项目工具入口">
      {tools.map(([id, label]) => (
        <button
          key={id}
          type="button"
          aria-label={`打开${label}面板`}
          aria-pressed={panel.open && panel.active === id}
          className={`rounded border border-line px-2 py-1 text-xs ${panel.open && panel.active === id ? "bg-info-bg text-info-ink" : "hover:bg-raised"}`}
          onClick={() => {
            const store = useRightPanelStore.getState();
            if (panel.open && panel.active === id) store.collapse(project);
            else store.tool(project, id);
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** 内容区的子节点位置保持固定，右栏开关仅改变布局，不重挂聊天输入框。 */
export function PanelWorkspace({
  children,
  project,
  enabled,
}: {
  children: ReactNode;
  project: string | null;
  enabled: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(1200);
  const [drag, setDrag] = useState<{
    project: string;
    x: number;
    initial: number;
    width: number;
  } | null>(null);
  const dragRef = useRef(drag);
  const panel = useRightPanelStore((state) =>
    project ? (state.projects[pathKey(project)] ?? emptyPanel) : emptyPanel,
  );
  const wizardRequest = useWorkbenchUiStore((state) => state.aawWizardRequest);
  useEffect(() => {
    if (!enabled || !project || !wizardRequest || wizardRequest.handled) return;
    if (
      pathKey(wizardRequest.project) !== pathKey(project) ||
      pathKey(useWorkbenchUiStore.getState().contextPath ?? "") !==
        pathKey(project)
    )
      return;
    // UI 组装层把原有 slash 请求送到项目工具栏；两个 store 保持独立。
    const panel = useRightPanelStore.getState();
    panel.aawSegment(project, "launch");
    panel.tool(project, "aaw");
  }, [enabled, project, wizardRequest]);
  // Git 审查需要同时容纳两侧代码和目录树，打开时优先分配宽工作区。
  const width =
    drag?.project === project
      ? drag.width
      : panel.active === "git"
        ? (panel.gitWidth ??
          Math.min(2400, Math.max(panel.width, available - 360)))
        : panel.width;
  const maxWidth =
    panel.active === "git"
      ? Math.min(2400, Math.max(300, available - 320))
      : 800;
  const clampWidth = (value: number) =>
    Math.min(maxWidth, Math.max(300, value));
  // 拖动结束后再切布局，避免中途卸载捕获指针的分隔条而丢失宽度。
  const overlay =
    drag?.project === project
      ? false
      : available < width + (panel.active === "git" ? 320 : 480);
  const open = enabled && project !== null && panel.open;
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setAvailable(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!open || !project) return;
    const close = (event: KeyboardEvent): void => {
      if (event.key === "Escape")
        useRightPanelStore.getState().collapse(project);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open, project]);
  return (
    <div ref={ref} className="relative flex h-full min-h-0 min-w-0">
      <div className="min-h-0 min-w-0 flex-1">{children}</div>
      {open && overlay && (
        <button
          aria-label="关闭右栏遮罩"
          className="absolute inset-0 z-20 bg-black/25"
          onClick={() => useRightPanelStore.getState().collapse(project)}
        />
      )}
      {project && enabled && (
        <aside
          hidden={!open}
          aria-label="项目右侧工具栏"
          className={`${open ? "flex" : "hidden"} ${overlay ? "absolute inset-y-0 right-0 z-30 shadow-xl" : "relative"} min-h-0 shrink-0 border-l border-line bg-surface`}
          style={{
            width: `${Math.min(width, Math.max(280, available - (overlay ? 12 : 0)))}px`,
          }}
        >
          {!overlay && (
            <div
              role="separator"
              tabIndex={0}
              aria-label="调整右栏宽度"
              aria-orientation="vertical"
              aria-valuemin={300}
              aria-valuemax={maxWidth}
              aria-valuenow={width}
              className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-sky-500/30"
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                  event.preventDefault();
                  useRightPanelStore
                    .getState()
                    .width(
                      project,
                      clampWidth(
                        width + (event.key === "ArrowLeft" ? 20 : -20),
                      ),
                    );
                }
              }}
              onDoubleClick={() =>
                useRightPanelStore.getState().width(project, 420)
              }
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                dragRef.current = {
                  project,
                  x: event.clientX,
                  initial: width,
                  width,
                };
                setDrag(dragRef.current);
              }}
              onPointerMove={(event) => {
                const current = dragRef.current;
                if (current)
                  setDrag({
                    ...current,
                    width: clampWidth(
                      current.initial + current.x - event.clientX,
                    ),
                  });
              }}
              onPointerUp={(event) => {
                const current = dragRef.current;
                if (current)
                  useRightPanelStore
                    .getState()
                    .width(
                      current.project,
                      clampWidth(current.initial + current.x - event.clientX),
                    );
                dragRef.current = null;
                setDrag(null);
              }}
              onPointerCancel={() => {
                dragRef.current = null;
                setDrag(null);
              }}
            />
          )}
          <ScopedErrorBoundary scope="项目工具栏" resetKey={project}>
            <ProjectPanel
              key={pathKey(project)}
              project={project}
              visible={open}
            />
          </ScopedErrorBoundary>
        </aside>
      )}
    </div>
  );
}

function ProjectPanel({
  project,
  visible,
}: {
  project: string;
  visible: boolean;
}) {
  const panel = useRightPanelStore(
    (state) => state.projects[pathKey(project)] ?? emptyPanel,
  );
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current += 1;
    },
    [],
  );
  const openPath = useCallback(
    (path: string, line?: number): void => {
      const generation = ++request.current;
      void panelService
        .stat(path)
        .then((entry) => {
          if (
            generation !== request.current ||
            pathKey(useWorkbenchUiStore.getState().contextPath ?? "") !==
              pathKey(project)
          )
            return;
          setError(null);
          const store = useRightPanelStore.getState();
          if (entry.directory) store.openDirectory(project, entry.path);
          else store.openFile(project, entry.path, line);
        })
        .catch((cause: unknown) => {
          if (generation === request.current) setError(panelError(cause));
        });
    },
    [project],
  );
  const active = panel.tabs.find((tab) => tab.id === panel.active);
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-line p-2 text-xs">
        {tools.map(([id, label]) => (
          <button
            key={id}
            aria-pressed={panel.active === id}
            className={`rounded px-3 py-1 ${panel.active === id ? "bg-info-bg text-info-ink" : "hover:bg-raised"}`}
            onClick={() => useRightPanelStore.getState().tool(project, id)}
          >
            {label}
          </button>
        ))}
        <span className="flex-1" />
        <button
          aria-label="收起右侧工具栏"
          onClick={() => useRightPanelStore.getState().collapse(project)}
          className="rounded px-2 py-1 hover:bg-raised"
        >
          ✕
        </button>
      </div>
      {panel.tabs.length > 0 && (
        <div
          role="tablist"
          aria-label="内容标签"
          className="flex shrink-0 gap-1 overflow-x-auto border-b border-line p-1 text-xs"
        >
          {panel.tabs.map((tab) => (
            <div
              key={tab.id}
              className={`flex shrink-0 items-center rounded border border-line ${panel.active === tab.id ? "bg-info-bg" : ""}`}
            >
              <button
                role="tab"
                aria-selected={panel.active === tab.id}
                title={tab.path}
                className="max-w-44 truncate px-2 py-1.5"
                onClick={() =>
                  useRightPanelStore.getState().activate(project, tab.id)
                }
              >
                {tab.kind === "diff"
                  ? `Diff · ${tab.change.source === "staged" ? "已暂存" : "工作区"} · `
                  : ""}
                {pathName(tab.path)}
              </button>
              <button
                aria-label={`关闭 ${pathName(tab.path)}`}
                className="px-1.5"
                onClick={() =>
                  useRightPanelStore.getState().closeTab(project, tab.id)
                }
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="break-words p-2 text-xs text-danger-ink">
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        <AawPanel
          project={project}
          visible={visible && panel.active === "aaw"}
        />
        {visible && panel.active === "files" && (
          <FileTree
            key={project}
            root={project}
            onOpen={(entry) => openPath(entry.path)}
          />
        )}
        {visible && panel.active === "git" && (
          <GitPanel key={project} project={project} />
        )}
        {visible && active?.kind === "file" && (
          <FilePreview
            key={`${active.id}:${active.line ?? 0}`}
            path={active.path}
            line={active.line}
            project={project}
            onOpen={openPath}
          />
        )}
        {visible && active?.kind === "directory" && (
          <FileTree
            key={active.id}
            root={active.path}
            external={!insidePath(project, active.path)}
            onOpen={(entry) => openPath(entry.path)}
          />
        )}
        {visible && active?.kind === "diff" && (
          <GitDiffView
            key={active.id}
            project={project}
            repoRoot={active.repoRoot}
            change={active.change}
            onFile={openPath}
          />
        )}
      </div>
    </div>
  );
}
