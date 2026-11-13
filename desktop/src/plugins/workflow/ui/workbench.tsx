/**
 * workflow 插件的 workbench 挂载。
 *
 * - panelId "aaw"：launcher（新标签页入口）+ View（AAW 面板）；
 * - `workflowUi` 服务（WorkflowView）：会话输入框的工作流斜杠命令、空会话的
 *   工作流入口、会话状态卡与项目总览里的运行、节点会话顶部的回指条；
 * - 工作区作用域：订阅 workbench 导航的 contextPath，把当前项目路径经
 *   `service.bindWorkspace` 绑定为引擎请求作用域（list/snapshot 的 cwd）；
 * - 侧栏会话分组：一次运行的节点会话收进一组（ADR 027）；
 * - 节点会话打开：面板「打开会话」经 project.sessions.openSessionFromEntry
 *   进中央 SessionView，与用户点侧栏会话条目同一条路径。
 */
import { readWorkflowExecutors, writeWorkflowExecutors } from "../status/executors.ts";
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
import type { ProjectService } from "../../project/service.ts";
import type { WorkflowExecutors, WorkflowDraftEditor, WorkflowFileTransfer,
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
import { WorkflowOverview } from "./WorkflowOverview.tsx";
import { WorkflowSessionBanner } from "./WorkflowSessionBanner.tsx";
import { AWAITING_CONFIRM_CHIP, AWAITING_INPUT_CHIP, runSessionGroups } from "./sessionGroups.ts";
import { configurationDigest, readSessionOwner } from "../sessionHost/sessionOwner.ts";

const panelId = "aaw";
/** 右栏默认比例（与工作台 panelLayout 的默认值一致；跨插件不引其内部模块）。 */
const DEFAULT_PANEL_RATIO = 0.45;

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
  sessionOwnerKey?: (path: string, sessionId: string) => Promise<string | undefined>,
  transfer?: WorkflowFileTransfer,
  editor?: WorkflowDraftEditor,
  executors?: WorkflowExecutors,
) {
  let disposed = false;
  const active = () => !disposed && workflow.isActive() && workbench.navigationGuard.isActive();
  const isCurrentProject = (key: string) =>
    active() && key === pathKey(workbench.navigation.getState().contextPath ?? "");

  function show(projectPath: string): void {
    const key = pathKey(projectPath);
    if (!isCurrentProject(key)) return;
    const resume = () => show(projectPath);
    const panel = workbench.panels.getState();
    const previous = panel.projects[key];
    if (previous?.active !== panelId && !workbench.navigationGuard.guard(resume)) return;
    panel.tool(projectPath, panelId);
  }

  /** 节点会话 → 中央 SessionView：走 openSessionFromEntry（所属工作区即
   * 当前面板绑定的项目路径；会话未收养时如实静默——列表里没有条目）。 */
  function openNodeSession(sessionId: string, projectPath?: string): void {
    if (!active()) return;
    const path = projectPath ?? workbench.navigation.getState().contextPath;
    if (!path) return;
    void (async () => {
      const owner = await sessionOwnerKey?.(path, sessionId);
      if (active()) await project.sessions.openSessionFromEntry(path, sessionId, owner);
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

  /** 窄屏提示「拉宽」：在当前比例上加一档（与原型同步长，上限 0.62）。 */
  function widen(projectPath: string): void {
    if (!active()) return;
    const panels = workbench.panels.getState();
    const ratio = panels.projects[pathKey(projectPath)]?.sizeRatio ?? DEFAULT_PANEL_RATIO;
    panels.resize(projectPath, Math.min(0.62, ratio + 0.1));
  }

  function openRun(projectPath: string, runId: string): void {
    if (!active()) return;
    show(projectPath);
    workflow.focusRun(runId);
  }

  function openLaunch(projectPath: string, request: WorkflowLaunchRequest = {}): void {
    if (!active()) return;
    show(projectPath);
    workflow.requestLaunch(request);
  }

  // ------------------------------------------------------------ workflowUi
  const status = createStore<WorkflowProjectStatus>(() => ({ workspacePath: null, runs: [] }));
  const entries = createStore<readonly WorkflowEntryCommand[]>(() => []);
  const publishStatus = () => {
    const { workspace, runs } = workflow.sessionLinks();
    status.setState({ workspacePath: workspace, runs: runBriefs(runs) }, true);
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

  const panel: WorkbenchContributions["panels"] = {
    id: panelId,
    keepMounted: true,
    launcher: {
      label: "AAW 工作流",
      description: "工作流库、发起与查看运行",
      searchHint: "aaw workflow",
      Icon: WorkflowIcon,
      open: (projectPath) => show(projectPath),
    },
    View: function WorkflowPanelView({ visible, project: projectPath }: PanelViewProps) {
      return (
        <section aria-label={visible ? "AAW 面板" : undefined} hidden={!visible} className="workflow-panel-view">
          <WorkflowPanel
            service={workflow}
            project={projectPath}
            onOpenProjectRun={(target, runId) => openRunFromNotification(workbench, openRun, target, runId)}
            pickFiles={pickFiles}
            transfer={transfer}
            editor={editor}
            executors={executors}
            onOpenSession={openNodeSession}
            onOpenFile={(path) => openResultFile(projectPath, path)}
            onWiden={() => widen(projectPath)}
            onFullView={() => workbench.panels.getState().fullViewOpen(projectPath, "side-pane")}
          />
        </section>
      );
    },
  };
  return {
    panel,
    view,
    openRun,
    openNodeSession,
    publishStatus,
    loadEntries,
    dispose() {
      disposed = true;
    },
  };
}

export const name = "workflow-workbench";
export const inject = ["workflow", "workbench", "project", "host", "agents", "acpRuntime"];

export function apply(ctx: Context): void {
  const { workflow, workbench, project, host, agents, acpRuntime } = ctx;
  const ui = createWorkflowWorkbench(workflow, workbench, project, () => host.dialogs.pickFiles("选择附件"), async (path, sessionId) => {
    const owner = readSessionOwner(host.storage, path, sessionId);
    if (!owner || !agents.resolve(owner.agentId)) throw new Error("无法找到节点会话所属的 Agent，请检查运行状态。");
    const agentKey = agents.selectionKey(project.projects.workspace.getState().toolPaths, owner.agentId);
    if (await configurationDigest(agentKey) !== owner.configuration) throw new Error("节点会话所属的 Agent 配置已更改，请恢复原配置后打开。");
    return agents.selectedId === owner.agentId ? undefined : agentKey;
  }, {
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
  }, createDraftEditor({
    project,
    agents,
    protocol: acpRuntime.protocol,
    currentProject: () => workbench.navigation.getState().contextPath ?? null,
  }), {
    agents() {
      const state = agents.configuration.getState();
      const all = [
        ...agents.listBuiltins().map((adapter) => ({ id: adapter.id, name: adapter.displayName })),
        ...state.discoveredAgents.map((item) => ({ id: item.id, name: item.name })),
        ...state.agents.map((item) => ({ id: item.id, name: item.name })),
      ];
      const seen = new Set<string>();
      return all.filter((item) => !seen.has(item.id) && seen.add(item.id) && agents.resolve(item.id) !== null);
    },
    defaultName: () => agents.resolve()?.displayName ?? "当前 Agent",
    read: (workflowId) => readWorkflowExecutors(host.storage, workflowId),
    write: (workflowId, plan) => writeWorkflowExecutors(host.storage, workflowId, plan),
  });
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
}
