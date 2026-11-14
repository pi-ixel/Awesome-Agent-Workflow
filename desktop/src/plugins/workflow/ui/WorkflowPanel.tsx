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
import { DraftPage } from "./DraftPage.tsx";
import { RunManager } from "./RunManager.tsx";
import { describeError, serviceExitText, type ErrorText } from "../status/errorText.ts";
import { useEffect, useRef, useState } from "react";
import type { WorkflowDraft, WorkflowExecutors, WorkflowDraftEditor, WorkflowFileTransfer, RunSummary, WorkflowLaunchRequest, WorkflowService } from "../types.ts";
import { AiEditSheet } from "./AiEditSheet.tsx";
import { draftPrompt } from "../editing/draftSessions.ts";
import { errorLine } from "../status/errorText.ts";
import { WorkflowLibrary } from "./WorkflowLibrary.tsx";
import { WorkflowDetailView } from "./WorkflowDetailView.tsx";
import { RunView } from "./RunView.tsx";
import "./workflowPanel.css";

type Route =
  | { readonly kind: "library"; readonly hint?: string }
  | { readonly kind: "workflow"; readonly id: string; readonly launch: { readonly entry?: string } | null }
  | { readonly kind: "run"; readonly runId: string }
  | { readonly kind: "runs" }
  | { readonly kind: "draft"; readonly draftId: string };

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

export function WorkflowPanel({ service, project, pickFiles, transfer, editor, executors, onOpenSession, onOpenProjectRun, onOpenFile, onWiden, onFullView }: {
  service: WorkflowService;
  /** 面板所属项目（跨项目总览用来区分当前项目）。 */
  project?: string;
  /** 打开别的项目的运行：切到那个项目再打开。 */
  onOpenProjectRun?: (project: string, runId: string) => void;
  /** 宿主文件选择器（启动表单的附件）。 */
  pickFiles?: () => Promise<readonly string[]>;
  /** 工作流文件的导入导出（ADR 036）。 */
  transfer?: WorkflowFileTransfer;
  /** AI 编辑工作流的会话（ADR 036）。 */
  editor?: WorkflowDraftEditor;
  /** 按角色指定 Agent 和模型（ADR 036）。 */
  executors?: WorkflowExecutors;
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
  const [error, setError] = useState<ErrorText | null>(null);
  const [names, setNames] = useState<Readonly<Record<string, string>>>({});
  // AI 编辑（ADR 036）：未保存的草稿，以及正在填写的要求（先说要求，再建草稿）。
  const [drafts, setDrafts] = useState<readonly WorkflowDraft[]>([]);
  const [aiRequest, setAiRequest] = useState<{ readonly kind: "new" } | { readonly kind: "edit"; readonly id: string; readonly name: string; readonly preset: boolean } | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState("");
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
      } else if (event.type === "focus-launch") {
        const request = service.takeLaunchRequest();
        if (request) setRoute(routeOfLaunch(request));
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
  const submitAiRequest = async (text: string) => {
    if (!aiRequest || !editor) return;
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

  // 已归档的运行也能打开查看，所以在全部运行里找。
  const run = route.kind === "run" ? service.allRuns().find((item) => item.runId === route.runId) : undefined;
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
          data-hint={workflowId in names ? undefined : "这个工作流已不在库里"}
          onClick={() => openWorkflow(workflowId)}
        >{workflowName}</button>
      </>}
      {route.kind === "run" && <>
        <span aria-hidden="true">›</span>
        <span className="workflow-crumb-current" aria-current="page" data-hint={run?.title}>{run?.title ?? "运行"}</span>
      </>}
      {route.kind === "runs" && <>
        <span aria-hidden="true">›</span>
        <span className="workflow-crumb-current" aria-current="page">全部运行</span>
      </>}
      {route.kind === "draft" && <>
        <span aria-hidden="true">›</span>
        <span className="workflow-crumb-current" aria-current="page">编辑草稿</span>
      </>}
    </nav>
    {error && <div className="workflow-banner tone-danger" role="alert">
      <i aria-hidden="true" />
      <div className="workflow-banner-body">
        <span>{error.title}</span>
        {error.hint && <span className="workflow-banner-hint">{error.hint}</span>}
        {(error.code || error.detail) && <details>
          <summary>技术详情</summary>
          {error.code && <code>{error.code}</code>}
          {error.detail && <div className="workflow-failure-detail">{error.detail}</div>}
        </details>}
      </div>
      <button onClick={() => {
        setError(null);
        void refreshAndLand();
      }}>重试</button>
    </div>}
    {aiRequest && <AiEditSheet
      key={aiRequest.kind === "edit" ? aiRequest.id : "new"}
      title={aiRequest.kind === "new" ? "让 AI 新建工作流" : `让 AI 修改「${aiRequest.name}」`}
      intro={aiRequest.kind === "new"
        ? "说说这个工作流要做什么。AI 会在一份草稿里写出来，编辑会话在中间打开，之后在会话里继续说；你看过结果再决定保存。"
        : aiRequest.preset
          ? "预置工作流不能直接改：会先复制一份「我的」，AI 改的是副本的草稿。之后在中间的会话里继续说；你看过改动再决定保存。"
          : "说说要怎么改。AI 改的是一份草稿，原工作流不受影响；编辑会话在中间打开，之后在会话里继续说，你看过改动再决定保存。"}
      placeholder={aiRequest.kind === "new" ? "例如：先写设计、再评审，评审通过后由我确认，再开始实现" : "例如：在设计评审之后加一个人工确认"}
      busy={aiBusy}
      error={aiError}
      onSubmit={(text) => void submitAiRequest(text)}
      onCancel={() => setAiRequest(null)}
    />}
    {route.kind === "library" && <div className="workflow-scroll">
      <WorkflowLibrary
        service={service}
        runs={runs}
        version={libraryVersion}
        hint={route.hint}
        transfer={transfer}
        onOpenWorkflow={(id) => openWorkflow(id)}
        onLaunch={(id) => openWorkflow(id, {})}
        onOpenRun={(runId) => go({ kind: "run", runId })}
        onOpenAllRuns={() => go({ kind: "runs" })}
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
      <section className="workflow-library" aria-label="全部运行">
        <h3>全部运行</h3>
        <RunManager service={service} runs={service.allRuns()} onOpenRun={(runId) => go({ kind: "run", runId })} project={project} onOpenProjectRun={onOpenProjectRun} />
      </section>
    </div>}
    {route.kind === "workflow" && <div className="workflow-scroll">
      <WorkflowDetailView
        key={route.id}
        service={service}
        id={route.id}
        runs={runs}
        launch={route.launch}
        pickFiles={pickFiles}
        transfer={transfer}
        executors={executors}
        draft={draftOf(route.id)}
        onAiEdit={editor ? (preset) => requestEdit(route.id, preset) : undefined}
        onOpenDraft={(draftId) => go({ kind: "draft", draftId })}
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
