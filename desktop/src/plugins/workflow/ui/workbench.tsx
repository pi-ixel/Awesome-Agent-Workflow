/**
 * workflow 插件的 workbench 挂载。
 *
 * - panelId "aaw"：launcher（新标签页入口）+ View（AAW 面板）；
 * - `projectExtension` 服务（ADR 037）：项目界面的通用扩展位——会话输入框的
 *   工作流斜杠命令、空会话的工作流入口、会话状态卡与项目总览里的运行、节点
 *   会话顶部的回指条、项目树上的工作流按钮；`workflowUi` 只供插件内部用
 *   （通知打开运行）；
 * - 工作区作用域：订阅 workbench 导航的 contextPath，把当前项目路径经
 *   `service.bindWorkspace` 绑定为引擎请求作用域（list/snapshot 的 cwd）；
 * - 侧栏会话分组：一次运行的节点会话收进一组（ADR 027）；
 * - 节点会话打开：面板「打开会话」经 project.sessions.openSessionFromEntry
 *   进中央 SessionView，与用户点侧栏会话条目同一条路径。
 */
import type { AgentSwitchGuard } from "../../agents/service.ts";
import { createDraftEditor } from "../editing/draftSessions.ts";
import type { Context } from "cordis";
import { createStore } from "zustand/vanilla";
import type { WorkbenchContributions } from "../../workbench/types.ts";
import type { WorkbenchService } from "../../workbench/service.ts";
import type { PanelViewProps } from "../../workbench/types.ts";
import { openRunFromNotification } from "../status/notifications.ts";
import { errorLine } from "../status/errorText.ts";
import { pathKey } from "../../../shared/panelPaths.ts";
import { WorkflowIcon } from "../../../shared/ui/icons.tsx";
import type { ProjectActivities, ProjectExtension, ProjectQuickAction, ProjectService } from "../../project/service.ts";
import { prepareProjectLauncher } from "../../project/service.ts";
import type { WorkflowDraftEditor, WorkflowFileTransfer,
  RunSessionLinks,
  WorkflowEntryCommand,
  WorkflowLaunchRequest,
  WorkflowProjectStatus,
  WorkflowRunBrief,
  WorkflowService,
  WorkflowSummary,
  WorkflowView,
} from "../types.ts";
import { WorkflowPanel } from "./WorkflowPanel.tsx";
import { SplitStorageContext } from "./SplitPane.tsx";
import { WorkflowSidebar } from "./WorkflowSidebar.tsx";
import { TextLink } from "../../../shared/ui/TextLink.tsx";
import { WorkflowOverview } from "./WorkflowOverview.tsx";
import { WorkflowSessionBanner } from "./WorkflowSessionBanner.tsx";
import { AWAITING_CONFIRM_CHIP, AWAITING_INPUT_CHIP, runSessionGroups } from "./sessionGroups.ts";

const panelId = "aaw";

/** 进行中与等你确认的运行 → 会话区 / 总览用的简报（等你处理的排前面）。 */
export function runBriefs(runs: readonly RunSessionLinks[]): WorkflowRunBrief[] {
  return runs
    .filter((run) => !run.archived && (run.active || run.status === "waiting"))
    .map((run) => {
      if (!run.active) {
        const last = run.links.flatMap((link) => link.nodes).at(-1);
        return {
          runId: run.runId,
          title: run.title || run.workflowName || "工作流",
          workflowName: run.workflowName,
          waiting: true,
          label: AWAITING_CONFIRM_CHIP,
          step: last?.label ?? null,
        };
      }
      const running = run.links.flatMap((link) => link.nodes.filter((node) => node.status === "running"));
      const waiting = running.find((node) => node.awaitingInput);
      return {
        runId: run.runId,
        title: run.title || run.workflowName || "工作流",
        workflowName: run.workflowName,
        waiting: waiting !== undefined,
        label: waiting ? AWAITING_INPUT_CHIP : "运行中",
        step: (waiting ?? running[0])?.label ?? null,
      };
    })
    .sort((a, b) => Number(b.waiting) - Number(a.waiting));
}

/** 工作流库 → 斜杠命令：每个可用工作流的每个起点一条。 */
export function entryCommands(
  workflows: readonly WorkflowSummary[],
  launch: (request: WorkflowLaunchRequest) => void,
): WorkflowEntryCommand[] {
  return workflows.flatMap((workflow) => {
    const meta = workflow.meta;
    if (meta === null) return [];
    return meta.entries.map((entry) => ({
      id: `workflow:${workflow.id}:${entry.id}`,
      label: meta.entries.length > 1 ? `${meta.name}：${entry.label}` : meta.name,
      description: entry.description || meta.description || "启动这个工作流",
      run: () => launch({ workflowId: workflow.id, entry: entry.id }),
    }));
  });
}

export function createWorkflowWorkbench(
  workflow: WorkflowService,
  workbench: WorkbenchService,
  project: ProjectService,
  pickFiles?: () => Promise<readonly string[]>,
  transfer?: WorkflowFileTransfer,
  editor?: WorkflowDraftEditor,
  /** 面板里分屏尺寸等界面偏好的存储（宿主存储）。 */
  layoutStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void },
  /** 全局入口（启动器）打开本面板前，先把项目上下文准备好。 */
  prepareGlobalOpen?: () => Promise<string | null>,
) {
  let disposed = false;
  const active = () => !disposed && workflow.isActive() && workbench.navigationGuard.isActive();
  const isCurrentProject = (key: string) =>
    active() && key === pathKey(workbench.navigation.getState().contextPath ?? "");

  function show(projectPath: string, onOpen?: () => void): void {
    const key = pathKey(projectPath);
    if (!isCurrentProject(key)) return;
    const resume = () => show(projectPath, onOpen);
    const panel = workbench.panels.getState();
    const previous = panel.projects[key];
    if (previous?.active !== panelId && !workbench.navigationGuard.guard(resume)) return;
    panel.tool(projectPath, panelId);
    onOpen?.();
  }

  /** 节点会话 → 中央 SessionView：走 openSessionFromEntry（所属工作区即
   * 当前面板绑定的项目路径；会话未收养时如实静默——列表里没有条目）。 */
  function openNodeSession(sessionId: string, projectPath?: string): void {
    if (!active()) return;
    const path = projectPath ?? workbench.navigation.getState().contextPath;
    if (!path) return;
    void (async () => {
      // 完整视图会盖住中间的会话：打开会话时退回普通布局，会话才看得见。
      workbench.panels.getState().fullViewExit(path);
      await project.sessions.openSessionFromEntry(path, sessionId);
    })().catch((error: unknown) => {
      workbench.showToast({ message: error instanceof Error ? error.message : String(error), variant: "warn" });
    });
  }

  /** 节点结果里的文件 → 工作台打开（相对路径按当前项目解析）。 */
  function openResultFile(projectPath: string, path: string): void {
    if (!active()) return;
    const absolute = /^(?:[A-Za-z]:[\\/]|[\\/])/.test(path);
    const target = absolute ? path : `${projectPath.replace(/[\\/]+$/, "")}/${path.replace(/^\.[\\/]/, "")}`;
    workbench.openPath(projectPath, target).then((opened) => {
      if (!opened) workbench.showToast({ message: `无法打开 ${path}`, variant: "warn" });
    }).catch((cause: unknown) => {
      workbench.showToast({ message: `无法打开 ${path}：${cause instanceof Error ? cause.message : String(cause)}`, variant: "warn" });
    });
  }

  function openRun(projectPath: string, runId: string): void {
    show(projectPath, () => workflow.focusRun(runId));
  }

  function openLaunch(projectPath: string, request: WorkflowLaunchRequest = {}): void {
    show(projectPath, () => workflow.requestPanel({ kind: "launch", launch: request }));
  }

  // ------------------------------------------------------------ workflowUi
  const status = createStore<WorkflowProjectStatus>(() => ({ workspacePath: null, runs: [] }));
  const entries = createStore<readonly WorkflowEntryCommand[]>(() => []);
  // 项目界面的通用扩展位用的同一份状态（ADR 037）。
  const activities = createStore<ProjectActivities>(() => ({ workspacePath: null, items: [] }));
  const quickAction = createStore<ProjectQuickAction | null>(() => ({ label: "启动工作流", run: (path) => openLaunch(path) }));
  const publishStatus = () => {
    const { workspace, runs } = workflow.sessionLinks();
    const briefs = runBriefs(runs);
    status.setState({ workspacePath: workspace, runs: briefs }, true);
    activities.setState({
      workspacePath: workspace,
      items: briefs.map((run) => ({
        id: run.runId,
        title: run.title,
        label: run.label,
        attention: run.waiting,
        detail: `${run.workflowName}${run.step ? ` · ${run.step}` : ""}`,
        summary: `${run.title} · ${run.label}${run.step ? ` · ${run.step}` : ""}`,
        openLabel: `查看工作流运行：${run.title}`,
      })),
    }, true);
    const lead = briefs[0];
    quickAction.setState(
      lead
        ? { label: lead.waiting ? "回复进行中的工作流" : "查看进行中的工作流", run: (path) => openRun(path, lead.runId) }
        : { label: "启动工作流", run: (path) => openLaunch(path) },
      true,
    );
  };
  let entriesSeq = 0;
  const loadEntries = () => {
    const seq = ++entriesSeq;
    workflow.workflows()
      .then((list) => {
        if (disposed || seq !== entriesSeq) return;
        entries.setState(entryCommands(list, (request) => {
          const path = workbench.navigation.getState().contextPath;
          if (path) openLaunch(path, request);
        }), true);
      })
      .catch(() => {});
  };
  const view: WorkflowView = {
    status,
    entries,
    openLaunch,
    openRun,
    Overview: function Overview({ project: projectPath }) {
      return <WorkflowOverview
        service={workflow}
        project={projectPath}
        onOpenRun={(runId) => openRun(projectPath, runId)}
        onLaunch={() => openLaunch(projectPath)}
        onBrowse={() => openLaunch(projectPath, {})}
      />;
    },
    SessionBanner: function SessionBanner({ project: projectPath, sessionId }) {
      return <WorkflowSessionBanner
        service={workflow}
        project={projectPath}
        sessionId={sessionId}
        onOpenRun={(runId) => openRun(projectPath, runId)}
      />;
    },
  };

  const sidebar: WorkbenchContributions["sidebar"] = {
    id: "workflow",
    label: "工作流",
    order: 10,
    Icon: WorkflowIcon,
    View: function WorkflowSidebarView({ project: projectPath }) {
      if (projectPath === null) {
        return (
          <div className="flex items-start gap-2 px-4 py-2 text-ui-sm text-ink-mute">
            <span>请先选择项目</span>
            <TextLink onClick={() => workbench.navigation.getState().openSidebar(null)}>选择项目</TextLink>
          </div>
        );
      }
      return (
        <WorkflowSidebar
          key={pathKey(projectPath)}
          project={projectPath}
          service={workflow}
          onOpenWorkflow={(workflowId) =>
            show(projectPath, () => workflow.requestPanel({ kind: "detail", workflowId }))
          }
          onOpenRun={(runId) => openRun(projectPath, runId)}
        />
      );
    },
  };

  const panel: WorkbenchContributions["panels"] = {
    id: panelId,
    keepMounted: true,
    launcher: {
      label: "AAW 工作流",
      description: "工作流库、发起与查看运行",
      searchHint: "aaw workflow",
      Icon: WorkflowIcon,
      open: (projectPath) => show(projectPath),
      prepareGlobalOpen,
    },
    View: function WorkflowPanelView({ visible, project: projectPath }: PanelViewProps) {
      return (
        <section aria-label={visible ? "AAW 面板" : undefined} hidden={!visible} className="workflow-panel-view">
          <SplitStorageContext.Provider value={layoutStorage ?? null}>
          <WorkflowPanel
            service={workflow}
            project={projectPath}
            onOpenProjectRun={(target, runId, returnFilters) => openRunFromNotification(
              workbench,
              (path, id) => show(path, () => workflow.requestPanel({ kind: "run", project: path, runId: id, returnFilters })),
              target,
              runId,
            )}
            pickFiles={pickFiles}
            transfer={transfer}
            editor={editor}
            onOpenSession={openNodeSession}
            onOpenFile={(path) => openResultFile(projectPath, path)}
          />
          </SplitStorageContext.Provider>
        </section>
      );
    },
  };
  const extension: ProjectExtension = {
    activityTitle: "AAW 工作流",
    activities,
    openActivity: openRun,
    slashGroup: "工作流入口",
    slashEntries: entries,
    quickAction,
    // 打开右侧 AAW 面板并落在工作流库（与总览区块的「工作流库」按钮同一条链路）。
    treeAction: { label: "工作流", hint: "打开工作流", Icon: WorkflowIcon, run: (path) => openLaunch(path, {}) },
    Overview: view.Overview,
    SessionBanner: view.SessionBanner,
  };
  return {
    sidebar,
    panel,
    view,
    extension,
    openRun,
    openNodeSession,
    publishStatus,
    loadEntries,
    dispose() {
      disposed = true;
    },
  };
}

/**
 * 切换 Agent 的闸（ADR 037）：节点会话与普通会话同池，切换前先停下进行中的
 * 运行（运行中或停在确认关卡，不含已归档）。
 */
export function workflowSwitchGuard(workflow: Pick<WorkflowService, "runsAcrossProjects" | "stop">): AgentSwitchGuard {
  return {
    activeWork: () =>
      workflow
        .runsAcrossProjects()
        .then((runs) =>
          runs
            .filter((run) => run.archivedAt == null && (run.status === "running" || run.status === "waiting"))
            .map((run) => ({ id: run.runId, title: run.title })),
        ),
    describe: (work) => {
      const names = work.map((item) => item.title.trim() || item.id.slice(0, 8));
      const titles = names.length <= 3 ? names.join("、") : `${names.slice(0, 3).join("、")} 等`;
      return `有 ${work.length} 个工作流正在运行（${titles}），切换会先停止它们；之后可在工作流面板重跑。`;
    },
    stopAll: (work) => Promise.all(work.map((item) => workflow.stop(item.id))).then(() => undefined),
  };
}

export const name = "workflow-workbench";
export const inject = ["workflow", "workbench", "project", "host"];

export function apply(ctx: Context): void {
  const { workflow, workbench, project, host } = ctx;
  const draftEditor = createDraftEditor({
    project,
    currentProject: () => workbench.navigation.getState().contextPath ?? null,
  });
  ctx.effect(() => project.sessions.registerSessionTools(draftEditor.sessionTools), "workflow:draft-tools");
  const ui = createWorkflowWorkbench(workflow, workbench, project, () => host.dialogs.pickFiles("选择附件"), {
    async saveText(defaultName, text) {
      const path = await host.dialogs.saveFile({ defaultPath: defaultName, filters: [{ name: "AAW 工作流", extensions: ["json"] }] });
      if (!path) return false;
      await host.skills.writeTextFile(path, text);
      return true;
    },
    async openText() {
      const [path] = await host.dialogs.pickFiles("选择要导入的工作流文件");
      return path ? host.archives.readTextFile(path) : null;
    },
  }, draftEditor, host.storage, () => prepareProjectLauncher(project, workbench, host, true));
  ctx.effect(() => () => ui.dispose(), "workflow:resources");
  ctx.effect(() => {
    // 工作区作用域：只在当前项目路径真的变化时重绑引擎请求作用域（run
    // 列表）——导航的其他变化（打开会话、切页面）不是作用域变化。
    let boundPath = workbench.navigation.getState().contextPath;
    let unbind = workflow.bindWorkspace(boundPath);
    const unsubscribe = workbench.navigation.subscribe(() => {
      const next = workbench.navigation.getState().contextPath;
      if (next === boundPath) return;
      boundPath = next;
      unbind();
      unbind = workflow.bindWorkspace(next);
    });
    return () => {
      unsubscribe();
      unbind();
    };
  }, "workflow:workspace-scope");
  ctx.effect(() => workbench.register("panels", ui.panel));
  ctx.effect(() => workbench.register("sidebar", ui.sidebar));
  ctx.effect(() => {
    // 侧栏会话分组与会话区状态：运行列表刷新（含引擎事件触发的刷新）后整体重发；
    // 切项目时清掉旧项目的分组。工作流库变化时重读斜杠命令。
    // 其他项目的节点会话同样分组：打开运行时先切到那个项目。
    const publisher = project.sessions.registerSessionGroups();
    const archiveRun = (runId: string, path?: string) => {
      workflow.archiveRun(runId, true, path).catch((cause: unknown) => {
        workbench.showToast({ message: `归档失败：${errorLine(cause)}`, variant: "warn" });
      });
    };
    let published = new Set<string>();
    const publish = () => {
      const { workspace, runs } = workflow.sessionLinks();
      const next = new Set<string>();
      if (workspace !== null) {
        publisher.publish(workspace, runSessionGroups(runs, (runId) => ui.openRun(workspace, runId), (sessionId) => ui.openNodeSession(sessionId, workspace), (runId) => archiveRun(runId)));
        next.add(workspace);
      }
      for (const other of workflow.otherSessionLinks()) {
        if (workspace !== null && pathKey(other.project) === pathKey(workspace)) continue;
        const path = other.project;
        publisher.publish(path, runSessionGroups(other.runs, (runId) => openRunFromNotification(workbench, ui.openRun, path, runId), (sessionId) => ui.openNodeSession(sessionId, path), (runId) => archiveRun(runId, path)));
        next.add(path);
      }
      for (const path of published) if (!next.has(path)) publisher.publish(path, []);
      published = next;
      ui.publishStatus();
    };
    publish();
    ui.loadEntries();
    const unsubscribe = workflow.subscribe((event) => {
      if (event.type === "runs-changed") publish();
      else if (event.type === "library-changed") ui.loadEntries();
    });
    return () => {
      unsubscribe();
      publisher.dispose();
    };
  }, "workflow:session-groups");
  ctx.provide("workflowUi", ui.view);
  ctx.provide("projectExtension", ui.extension);
  ctx.provide("agentSwitchGuard", workflowSwitchGuard(workflow));
}
