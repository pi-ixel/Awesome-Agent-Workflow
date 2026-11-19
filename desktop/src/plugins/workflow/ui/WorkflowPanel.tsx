/**
 * 右侧 AAW 标签页（ADR 038）：只管运行，作为会话的补充。模板在左侧「工作流」
 * 功能区；发起只从会话进来。
 *
 * - **运行管理**（RunManager）：搜索、筛选、跨项目、改标题、归档、删除；
 * - **运行**（RunView）：一次运行的画布与节点检视器；
 * - **发起**（LaunchPage）：从「/」菜单、空会话或「再次运行」进来的启动表单。
 *
 * 打开时去哪一层：侧栏分组「打开」或会话里的入口指定了运行 → 运行；会话里
 * 请求启动 → 发起页；否则本项目最近一次运行还没顺利结束（进行中、中断、失败）
 * 就先看它，否则进运行管理。
 */
import { RunManager } from "./RunManager.tsx";
import { describeError, serviceExitText, type ErrorText } from "../status/errorText.ts";
import { useEffect, useState } from "react";
import type { RunManagerFilters, RunSummary, WorkflowLaunchRequest, WorkflowPanelRequest, WorkflowService } from "../types.ts";
import { RunView } from "./RunView.tsx";
import { LaunchPage } from "./LaunchPage.tsx";
import "./workflowPanel.css";
import { secondaryButton } from "./buttons.ts";
import { Callout } from "../../../shared/ui/Callout.tsx";
import { Breadcrumb } from "../../../shared/ui/Breadcrumb.tsx";
import { DEFAULT_RUN_FILTERS } from "./runSearch.ts";

type Route =
  | { readonly kind: "runs" }
  | { readonly kind: "run"; readonly runId: string }
  | { readonly kind: "launch"; readonly workflowId: string; readonly entry?: string };

/** 发起总要指定工作流（「/」菜单的起点、「再次运行」）；没指定就回运行管理。 */
function launchRoute({ workflowId, entry }: WorkflowLaunchRequest): Route {
  return workflowId ? { kind: "launch", workflowId, entry } : { kind: "runs" };
}

function routeOfPanelRequest(request: WorkflowPanelRequest): { route: Route; filters?: RunManagerFilters } {
  if (request.kind === "run") return { route: { kind: "run", runId: request.runId }, filters: request.returnFilters };
  return { route: launchRoute(request.launch) };
}

function initialRoute(service: WorkflowService, project?: string): { route: Route; filters?: RunManagerFilters } {
  const focused = service.takeFocusRun();
  if (focused !== "") return { route: { kind: "run", runId: focused } };
  const request = service.takePanelRequest(project);
  if (request) return routeOfPanelRequest(request);
  return { route: landingRoute(service.runs()) };
}

/** 没有指定去处时：最近一次运行没顺利结束就看它，否则进运行管理。 */
function landingRoute(runs: readonly RunSummary[]): Route {
  const latest = runs[0];
  return latest && latest.status !== "completed" ? { kind: "run", runId: latest.runId } : { kind: "runs" };
}

export function WorkflowPanel({ service, project, pickFiles, onOpenSession, onOpenProjectRun, onOpenFile, onOpenWorkflow, onRunStarted }: {
  service: WorkflowService;
  /** 面板所属项目（跨项目总览用来区分当前项目）。 */
  project?: string;
  /** 打开别的项目的运行：切到那个项目再打开。 */
  onOpenProjectRun?: (project: string, runId: string, filters: RunManagerFilters) => void;
  /** 宿主文件选择器（启动表单的附件）。 */
  pickFiles?: () => Promise<readonly string[]>;
  /** 节点会话 → 中央 SessionView（project.sessions.openSessionFromEntry）。 */
  onOpenSession?: (sessionId: string) => void;
  /** 结果里的文件路径 → 工作台打开文件。 */
  onOpenFile?: (path: string) => void;
  /** 到左侧「工作流」功能区看这个工作流。 */
  onOpenWorkflow?: (id: string) => void;
  /** 刚发起了一次运行（工作台据此把第一个节点会话打开到中间）。 */
  onRunStarted?: (runId: string) => void;
}) {
  const [initial] = useState(() => initialRoute(service, project));
  // touched：用户自己点过导航后，刷新回来的列表不再改去处。
  const [{ route }, setNav] = useState<{ route: Route; touched: boolean }>({ route: initial.route, touched: false });
  const setRoute = (next: Route) => setNav((current) => ({ ...current, route: next }));
  const [runFilters, setRunFilters] = useState(initial.filters ?? DEFAULT_RUN_FILTERS);
  const [error, setError] = useState<ErrorText | null>(null);
  // 运行列表变化时重画（运行管理每次从服务取最新列表）。
  const [, setVersion] = useState(0);
  const go = (next: Route) => setNav({ route: next, touched: true });
  const apply = ({ route: next, filters }: { route: Route; filters?: RunManagerFilters }) => {
    if (filters) setRunFilters(filters);
    setRoute(next);
  };

  // 刷新运行列表；用户还没自己导航过时，按最新列表决定落在哪一层。
  const refreshAndLand = (isLive: () => boolean = () => true) => {
    return service.refresh()
      .then(() => {
        if (!isLive()) return;
        const list = service.runs();
        setNav((current) => (current.route.kind !== "runs" || current.touched ? current : { ...current, route: landingRoute(list) }));
      })
      .catch((cause: unknown) => {
        if (isLive()) setError(describeError(cause));
      });
  };

  useEffect(() => {
    let live = true;
    void refreshAndLand(() => live);
    const unsubscribe = service.subscribe((event) => {
      if (!live) return;
      if (event.type === "focus-run") {
        const focused = service.takeFocusRun();
        if (focused !== "") setRoute({ kind: "run", runId: focused });
      } else if (event.type === "focus-workflow-panel") {
        const request = service.takePanelRequest(project);
        if (request) apply(routeOfPanelRequest(request));
      } else if (event.type === "service-exit") {
        setError(serviceExitText(event.code, event.stderrTail, "重试"));
      }
      setVersion((v) => v + 1);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [service, project]);

  const crumbs = route.kind === "runs" ? null : [
    { key: "runs", label: "运行管理", onSelect: () => go({ kind: "runs" }) },
    { key: route.kind, label: route.kind === "run" ? "运行详情" : "启动工作流", current: true },
  ];

  return <section className="workflow-panel" aria-label="AAW 工作流">
    {crumbs && <Breadcrumb className="workflow-crumbs" items={crumbs} />}
    {error && <Callout tone="danger" className="workflow-callout" title={error.title}
      details={error.code || error.detail ? [error.code, error.detail].filter(Boolean).join("\n") : undefined}
      actions={<button type="button" className={secondaryButton} onClick={() => {
        setError(null);
        void refreshAndLand();
      }}>重试</button>}>{error.hint}</Callout>}
    {route.kind === "runs" && <div className="workflow-scroll">
      <section className="workflow-library workflow-runs-page" aria-label="运行管理">
        <RunManager service={service} runs={service.allRuns()} onOpenRun={(runId) => go({ kind: "run", runId })}
          filters={runFilters} onFiltersChange={setRunFilters} project={project}
          onOpenProjectRun={onOpenProjectRun ? (target, runId) => onOpenProjectRun(target, runId, runFilters) : undefined} />
      </section>
    </div>}
    {route.kind === "launch" && <div className="workflow-scroll">
      <LaunchPage
        key={`${route.workflowId}:${route.entry ?? ""}`}
        service={service}
        id={route.workflowId}
        entry={route.entry}
        pickFiles={pickFiles}
        onStarted={(runId) => { go({ kind: "run", runId }); onRunStarted?.(runId); }}
        onCancel={() => go({ kind: "runs" })}
        onOpenWorkflow={onOpenWorkflow}
      />
    </div>}
    {route.kind === "run" && <RunView
      key={route.runId}
      service={service}
      runId={route.runId}
      onLaunch={(request) => go(launchRoute(request))}
      onOpenWorkflow={onOpenWorkflow}
      onOpenSession={onOpenSession}
      onOpenFile={onOpenFile}
    />}
  </section>;
}
