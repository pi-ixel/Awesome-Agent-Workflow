/**
 * AAW 面板外壳：工作流库 → 工作流 → 运行 三层，顶部面包屑表达从属。
 *
 * - **工作流库**（WorkflowLibrary）：进行中的运行、预置的与我的工作流；
 * - **工作流**（WorkflowDetailView）：流程图、源码、本项目的运行；启动表单在这里展开；
 * - **运行**（RunView）：一次运行的画布与节点检视器。
 *
 * 打开时去哪一层：侧栏分组「打开」或会话里的入口指定了运行 → 运行；外部
 * 请求启动 → 对应工作流的启动表单；否则本项目最近一次运行还没顺利结束
 * （进行中、中断、失败）就先看它，顺利结束了就进工作流库。
 */
import { useEffect, useRef, useState } from "react";
import type { RunSummary, WorkflowLaunchRequest, WorkflowService } from "../types.ts";
import { WorkflowLibrary } from "./WorkflowLibrary.tsx";
import { WorkflowDetailView } from "./WorkflowDetailView.tsx";
import { RunView } from "./RunView.tsx";
import "./workflowPanel.css";

type Route =
  | { readonly kind: "library"; readonly hint?: string }
  | { readonly kind: "workflow"; readonly id: string; readonly launch: { readonly entry?: string } | null }
  | { readonly kind: "run"; readonly runId: string };

function routeOfLaunch(request: WorkflowLaunchRequest): Route {
  return request.workflowId
    ? { kind: "workflow", id: request.workflowId, launch: { entry: request.entry } }
    : { kind: "library", hint: "选一个工作流，点「运行」开始。" };
}

function initialRoute(service: WorkflowService): Route {
  const focused = service.takeFocusRun();
  if (focused !== "") return { kind: "run", runId: focused };
  const launch = service.takeLaunchRequest();
  if (launch) return routeOfLaunch(launch);
  return landingRoute(service.runs());
}

/** 没有指定去处时：最近一次运行没顺利结束就看它，否则进工作流库。 */
function landingRoute(runs: readonly RunSummary[]): Route {
  const latest = runs[0];
  return latest && latest.status !== "completed" ? { kind: "run", runId: latest.runId } : { kind: "library" };
}

export function WorkflowPanel({ service, pickFiles, onOpenSession, onOpenFile, onWiden, onFullView }: {
  service: WorkflowService;
  /** 宿主文件选择器（启动表单的附件）。 */
  pickFiles?: () => Promise<readonly string[]>;
  /** 节点会话 → 中央 SessionView（project.sessions.openSessionFromEntry）。 */
  onOpenSession?: (sessionId: string) => void;
  /** 结果里的文件路径 → 工作台打开文件。 */
  onOpenFile?: (path: string) => void;
  /** 窄屏提示的两个出口（工作台右栏拉宽 / 进入完整视图）。 */
  onWiden?: () => void;
  onFullView?: () => void;
}) {
  const [route, setRoute] = useState<Route>(() => initialRoute(service));
  const [runs, setRuns] = useState<readonly RunSummary[]>(() => service.runs());
  const [libraryVersion, setLibraryVersion] = useState(0);
  const [error, setError] = useState("");
  const [names, setNames] = useState<Readonly<Record<string, string>>>({});
  // 用户自己点过导航后，刷新回来的列表不再改去处。
  const touched = useRef(false);
  const go = (next: Route) => {
    touched.current = true;
    setRoute(next);
  };

  // 刷新运行列表；用户还没自己导航过时，按最新列表决定落在哪一层。
  const refreshAndLand = (isLive: () => boolean = () => true) => {
    return service.refresh()
      .then(() => {
        if (!isLive()) return;
        const list = service.runs();
        setRuns(list);
        setRoute((current) => (current.kind !== "library" || current.hint || touched.current ? current : landingRoute(list)));
      })
      .catch((cause: unknown) => {
        if (isLive()) setError(cause instanceof Error ? cause.message : String(cause));
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
      } else if (event.type === "focus-launch") {
        const request = service.takeLaunchRequest();
        if (request) setRoute(routeOfLaunch(request));
      } else if (event.type === "service-exit") {
        setError(`工作流服务已退出（code=${typeof event.code === "number" ? event.code : "未知"}）；点「重试」重启服务。`);
      }
      setRuns(service.runs());
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [service]);

  // 面包屑上的工作流名称：从库里取（运行记录里也带着启动时的名称）。
  useEffect(() => {
    let live = true;
    service.workflows()
      .then((list) => {
        if (!live) return;
        setNames(Object.fromEntries(list.map((item) => [item.id, item.meta?.name ?? item.id])));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [service, libraryVersion]);

  const run = route.kind === "run" ? runs.find((item) => item.runId === route.runId) : undefined;
  const workflowId = route.kind === "workflow" ? route.id : run?.workflowId ?? "";
  const workflowName = names[workflowId] ?? run?.name ?? workflowId;
  const openWorkflow = (id: string, launch: { entry?: string } | null = null) => go({ kind: "workflow", id, launch });

  return <section className="workflow-panel" aria-label="AAW 工作流">
    <nav className="workflow-crumbs" aria-label="位置">
      <button type="button" aria-current={route.kind === "library" ? "page" : undefined} onClick={() => go({ kind: "library" })}>工作流库</button>
      {workflowId !== "" && <>
        <span aria-hidden="true">›</span>
        <button
          type="button"
          aria-current={route.kind === "workflow" ? "page" : undefined}
          disabled={!(workflowId in names)}
          title={workflowId in names ? undefined : "这个工作流已不在库里"}
          onClick={() => openWorkflow(workflowId)}
        >{workflowName}</button>
      </>}
      {route.kind === "run" && <>
        <span aria-hidden="true">›</span>
        <span className="workflow-crumb-current" aria-current="page" title={run?.title}>{run?.title ?? "运行"}</span>
      </>}
    </nav>
    {error !== "" && <div className="workflow-banner tone-danger" role="alert">
      <i aria-hidden="true" />
      <div className="workflow-banner-body"><span>{error}</span></div>
      <button onClick={() => {
        setError("");
        void refreshAndLand();
      }}>重试</button>
    </div>}
    {route.kind === "library" && <div className="workflow-scroll">
      <WorkflowLibrary
        service={service}
        runs={runs}
        version={libraryVersion}
        hint={route.hint}
        onOpenWorkflow={(id) => openWorkflow(id)}
        onLaunch={(id) => openWorkflow(id, {})}
        onOpenRun={(runId) => go({ kind: "run", runId })}
      />
    </div>}
    {route.kind === "workflow" && <div className="workflow-scroll">
      <WorkflowDetailView
        key={route.id}
        service={service}
        id={route.id}
        runs={runs}
        launch={route.launch}
        pickFiles={pickFiles}
        onLaunch={(entry) => openWorkflow(route.id, { entry })}
        onCloseLaunch={() => openWorkflow(route.id)}
        onStarted={(runId) => go({ kind: "run", runId })}
        onOpenRun={(runId) => go({ kind: "run", runId })}
        onCopied={(id) => {
          setLibraryVersion((v) => v + 1);
          openWorkflow(id);
        }}
        onDeleted={() => {
          setLibraryVersion((v) => v + 1);
          go({ kind: "library" });
        }}
      />
    </div>}
    {route.kind === "run" && <RunView
      key={route.runId}
      service={service}
      runId={route.runId}
      onLaunch={(request) => go(routeOfLaunch(request))}
      onOpenSession={onOpenSession}
      onOpenFile={onOpenFile}
      onWiden={onWiden}
      onFullView={onFullView}
    />}
  </section>;
}
