/**
 * AAW 面板有工作流库和运行管理两个入口，模板详情和运行各自沿面包屑返回。
 *
 * - **工作流库**（WorkflowLibrary）：预置的与我的工作流；
 * - **工作流**（WorkflowDetailView）：流程图、源码、本项目的运行；启动表单在这里展开；
 * - **运行**（RunView）：一次运行的画布与节点检视器。
 *
 * 打开时去哪一层：侧栏分组「打开」或会话里的入口指定了运行 → 运行；外部
 * 请求启动 → 对应工作流的启动表单；否则本项目最近一次运行还没顺利结束
 * （进行中、中断、失败）就先看它，顺利结束了就进工作流库。
 */
import { DraftPage } from "./DraftPage.tsx";
import { RunManager } from "./RunManager.tsx";
import { describeError, serviceExitText, type ErrorText } from "../status/errorText.ts";
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import type { WorkflowDraft, WorkflowDraftEditor, WorkflowFileTransfer, RunManagerFilters, RunSummary, WorkflowLaunchRequest, WorkflowPanelRequest, WorkflowService } from "../types.ts";
import { AiComposeDialog } from "./AiComposeDialog.tsx";
import { draftPrompt } from "../editing/draftSessions.ts";
import { errorLine } from "../status/errorText.ts";
import { WorkflowLibrary, type LibraryTab } from "./WorkflowLibrary.tsx";
import { WorkflowDetailView } from "./WorkflowDetailView.tsx";
import { RunView } from "./RunView.tsx";
import "./workflowPanel.css";
import { ActionButton } from "../../../shared/ui/controls.tsx";

import { Callout } from "../../../shared/ui/Callout.tsx";
import { Breadcrumb } from "../../../shared/ui/Breadcrumb.tsx";
import { SegmentedControl } from "../../../shared/ui/controls/SegmentedControl.tsx";
import { DEFAULT_RUN_FILTERS } from "./runSearch.ts";
import { attentionOf } from "./runList.ts";

type WorkflowRoute = { readonly kind: "workflow"; readonly id: string; readonly launch: { readonly entry?: string } | null };
type RunsRoute = { readonly kind: "runs"; readonly filters?: RunManagerFilters };
type Route =
  | { readonly kind: "library"; readonly hint?: string }
  | WorkflowRoute
  | { readonly kind: "run"; readonly runId: string; readonly back?: WorkflowRoute | RunsRoute }
  | RunsRoute
  | { readonly kind: "draft"; readonly draftId: string };
/** 让 AI 新建 / 修改：弹窗里先说要求。 */
type ComposeTarget = { readonly kind: "new" } | { readonly kind: "edit"; readonly id: string; readonly name: string; readonly preset: boolean };

function routeOfLaunch({ workflowId, entry }: WorkflowLaunchRequest): Route {
  return workflowId
    ? { kind: "workflow", id: workflowId, launch: { entry } }
    : { kind: "library", hint: "选一个工作流，点「运行」开始。" };
}

function routeOfPanelRequest(request: WorkflowPanelRequest): Route {
  if (request.kind === "run") return { kind: "run", runId: request.runId, back: { kind: "runs", filters: request.returnFilters } };
  if (request.kind === "detail") return { kind: "workflow", id: request.workflowId, launch: null };
  return routeOfLaunch(request.launch);
}

function initialRoute(service: WorkflowService, project?: string): Route {
  const focused = service.takeFocusRun();
  if (focused !== "") return { kind: "run", runId: focused };
  const request = service.takePanelRequest(project);
  if (request) return routeOfPanelRequest(request);
  return landingRoute(service.runs());
}

/** 没有指定去处时：最近一次运行没顺利结束就看它，否则进工作流库。 */
function landingRoute(runs: readonly RunSummary[]): Route {
  const latest = runs[0];
  return latest && latest.status !== "completed" ? { kind: "run", runId: latest.runId } : { kind: "library" };
}

export function WorkflowPanel({ service, project, pickFiles, transfer, editor, onOpenSession, onOpenProjectRun, onOpenFile }: {
  service: WorkflowService;
  /** 面板所属项目（跨项目总览用来区分当前项目）。 */
  project?: string;
  /** 打开别的项目的运行：切到那个项目再打开。 */
  onOpenProjectRun?: (project: string, runId: string, filters: RunManagerFilters) => void;
  /** 宿主文件选择器（启动表单的附件）。 */
  pickFiles?: () => Promise<readonly string[]>;
  /** 工作流文件的导入导出（ADR 036）。 */
  transfer?: WorkflowFileTransfer;
  /** AI 编辑工作流的会话（ADR 036）。 */
  editor?: WorkflowDraftEditor;
  /** 节点会话 → 中央 SessionView（project.sessions.openSessionFromEntry）。 */
  onOpenSession?: (sessionId: string) => void;
  /** 结果里的文件路径 → 工作台打开文件。 */
  onOpenFile?: (path: string) => void;
  /** 窄屏提示的两个出口（工作台右栏拉宽 / 进入完整视图）。 */
}) {
  const [route, setRoute] = useState<Route>(() => initialRoute(service, project));
  const panelRef = useRef<HTMLElement>(null);
  const restoreBreadcrumbFocus = useRef(false);
  useLayoutEffect(() => {
    if (!restoreBreadcrumbFocus.current) return;
    restoreBreadcrumbFocus.current = false;
    panelRef.current?.querySelector<HTMLElement>(
      '.workflow-root-nav [aria-selected="true"], .workflow-crumbs button',
    )?.focus();
  }, [route]);
  // 库页的页签存在这里（不随 WorkflowLibrary 卸载丢失）：进详情再返回还在原页签。
  const [libraryTab, setLibraryTab] = useState<LibraryTab>("presets");
  const [runFilters, setRunFilters] = useState(DEFAULT_RUN_FILTERS);
  const [runs, setRuns] = useState<readonly RunSummary[]>(() => service.runs());
  const [libraryVersion, setLibraryVersion] = useState(0);
  const [error, setError] = useState<ErrorText | null>(null);
  const [names, setNames] = useState<Readonly<Record<string, string>>>({});
  // AI 编辑（ADR 036）：未保存的草稿，以及正在填写的要求（先说要求，再建草稿）。
  const [drafts, setDrafts] = useState<readonly WorkflowDraft[]>([]);
  const [aiRequest, setAiRequest] = useState<ComposeTarget | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState("");
  // 用户自己点过导航后，刷新回来的列表不再改去处。
  const touched = useRef(false);
  const go = (next: Route) => {
    touched.current = true;
    if (next.kind === "runs" && next.filters) setRunFilters(next.filters);
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
        if (request) setRoute(routeOfPanelRequest(request));
      } else if (event.type === "library-changed") {
        // 导入、复制、删除、信任脚本之后重新读取工作流库。
        setLibraryVersion((v) => v + 1);
      } else if (event.type === "service-exit") {
        setError(serviceExitText(event.code, event.stderrTail, "重试"));
      }
      setRuns(service.runs());
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [service, project]);

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

  useEffect(() => {
    if (!editor) return;
    let live = true;
    service.drafts().then((list) => { if (live) setDrafts(list); }).catch(() => {});
    return () => { live = false; };
  }, [service, editor, libraryVersion, route]);

  const draftOf = (id: string) => drafts.find((draft) => draft.base === id);
  /** 让 AI 修改：这个工作流已有草稿就回到它，否则先问要怎么改。 */
  const requestEdit = (id: string, preset: boolean) => {
    const existing = preset ? undefined : draftOf(id);
    if (existing) { go({ kind: "draft", draftId: existing.draftId }); return; }
    setAiError("");
    setAiRequest({ kind: "edit", id, preset, name: names[id] ?? id });
  };
  const requestNew = () => {
    setAiError("");
    setAiRequest({ kind: "new" });
  };
  const submitAiRequest = async (aiRequest: ComposeTarget, text: string) => {
    if (!editor) return;
    setAiBusy(true);
    setAiError("");
    try {
      const base = aiRequest.kind === "edit" ? (aiRequest.preset ? await service.copyWorkflow(aiRequest.id) : aiRequest.id) : undefined;
      const draft = await service.createDraft(base ? { base } : {});
      const title = aiRequest.kind === "edit" ? `编辑工作流：${aiRequest.name}` : "新建工作流";
      // 编辑会话还开着就把要求发进去，否则开一个新会话。
      if (!editor.has(draft.draftId) || !editor.send(draft.draftId, text)) {
        await editor.start(draft, title, draftPrompt(aiRequest.kind === "new" ? "new" : draft.changes > 0 ? "continue" : "edit", text));
      }
      setAiRequest(null);
      setLibraryVersion((v) => v + 1);
      go({ kind: "draft", draftId: draft.draftId });
    } catch (cause) {
      setAiError(errorLine(cause));
    } finally {
      setAiBusy(false);
    }
  };
  const discardDraft = async (draftId: string) => {
    await editor?.end(draftId);
    await service.discardDraft(draftId);
    setLibraryVersion((v) => v + 1);
  };

  const openWorkflow = (id: string, launch: { entry?: string } | null = null) => go({ kind: "workflow", id, launch });
  const openWorkflowRun = (id: string, runId: string) =>
    go({ kind: "run", runId, back: { kind: "workflow", id, launch: null } });
  const back = route.kind === "run" ? route.back ?? { kind: "runs" as const } : { kind: "library" as const };
  const backLabel = back.kind === "workflow" ? names[back.id] ?? back.id : back.kind === "runs" ? "运行管理" : "工作流库";
  const crumbs = [
    { key: back.kind, label: backLabel, onSelect: (event: MouseEvent<HTMLButtonElement>) => {
      restoreBreadcrumbFocus.current = event.detail === 0;
      go(back);
    } },
    { key: route.kind, label: route.kind === "run" ? "运行详情" : route.kind === "draft" ? "编辑草稿" : "模板详情", current: true },
  ];

  const root = route.kind === "library" || route.kind === "runs" ? route.kind : null;

  return <section ref={panelRef} className="workflow-panel" aria-label="AAW 工作流">
    {root ? <div className="workflow-root-nav">
      <SegmentedControl<"library" | "runs">
        tabs
        groupLabel="工作流面板"
        value={root}
        options={[
          { value: "library", label: "工作流库" },
          { value: "runs", label: "运行管理", dot: attentionOf(runs).length > 0 },
        ]}
        onChange={(kind) => go({ kind })}
      />
    </div> : <Breadcrumb className="workflow-crumbs" label="工作流路径" items={crumbs} />}
    {error && <Callout tone="danger" className="workflow-callout" title={error.title}
      details={error.code || error.detail ? [error.code, error.detail].filter(Boolean).join("\n") : undefined}
      actions={<ActionButton type="button" tone="secondary" size="compact" onClick={() => {
        setError(null);
        void refreshAndLand();
      }}>重试</ActionButton>}>{error.hint}</Callout>}
    {aiRequest && <AiComposeDialog
      key={aiRequest.kind === "edit" ? aiRequest.id : "new"}
      title={aiRequest.kind === "new" ? "用 AI 新建工作流" : `用 AI 修改「${aiRequest.name}」`}
      placeholder={aiRequest.kind === "new" ? "描述你想要的工作流，例如：先写设计、再评审，评审通过后由我确认，再开始实现" : "描述要怎么改，例如：在设计评审之后加一个人工确认"}
      busy={aiBusy}
      error={aiError}
      onSubmit={(text) => void submitAiRequest(aiRequest, text)}
      onCancel={() => setAiRequest(null)}
    />}
    {route.kind === "library" && <div className="workflow-scroll">
      <WorkflowLibrary
        service={service}
        version={libraryVersion}
        hint={route.hint}
        transfer={transfer}
        tab={libraryTab}
        onTabChange={setLibraryTab}
        onOpenWorkflow={(id) => openWorkflow(id)}
        onLaunch={(id) => openWorkflow(id, {})}
        drafts={editor ? drafts : undefined}
        onNewWithAi={editor ? requestNew : undefined}
        onOpenDraft={(draftId) => go({ kind: "draft", draftId })}
        onDiscardDraft={discardDraft}
      />
    </div>}
    {route.kind === "draft" && <div className="workflow-scroll">
      <DraftPage
        key={route.draftId}
        service={service}
        editor={editor}
        draftId={route.draftId}
        onSaved={(id) => { setLibraryVersion((v) => v + 1); openWorkflow(id); }}
        onDiscarded={() => { setLibraryVersion((v) => v + 1); go({ kind: "library" }); }}
      />
    </div>}
    {route.kind === "runs" && <div className="workflow-scroll">
      <section className="workflow-library workflow-runs-page" aria-label="运行管理">
        <RunManager service={service} runs={service.allRuns()} onOpenRun={(runId) => go({ kind: "run", runId })}
          filters={runFilters} onFiltersChange={setRunFilters} project={project}
          onOpenProjectRun={onOpenProjectRun ? (target, runId) => onOpenProjectRun(target, runId, runFilters) : undefined} />
      </section>
    </div>}
    {route.kind === "workflow" && <div className="workflow-scroll">
      <WorkflowDetailView
        key={route.id}
        service={service}
        id={route.id}
        launch={route.launch}
        pickFiles={pickFiles}
        transfer={transfer}
        draft={draftOf(route.id)}
        onAiEdit={editor ? (preset) => requestEdit(route.id, preset) : undefined}
        onOpenDraft={(draftId) => go({ kind: "draft", draftId })}
        onLaunch={(entry) => openWorkflow(route.id, { entry })}
        onCloseLaunch={() => openWorkflow(route.id)}
        onStarted={(runId) => openWorkflowRun(route.id, runId)}
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
    />}
  </section>;
}
