/**
 * workflow 插件的 workbench 挂载。
 *
 * 入口分工（ADR 038）：模板在左侧「工作流」功能区，运行在右侧 AAW 标签页，
 * 发起只在会话里。
 *
 * - 侧栏 "workflow"：左侧导航的功能区——侧栏选分类，中间（WorkArea）是工作流
 *   库、详情与 AI 草稿；
 * - panelId "aaw"：launcher（新标签页入口）+ View（AAW 面板：运行管理、运行、
 *   发起页）；
 * - `projectExtension` 服务（ADR 037）：项目界面的通用扩展位——会话输入框的
 *   工作流斜杠命令、空会话的工作流入口、会话状态卡里的运行、节点会话顶部的
 *   回指条、项目树上的工作流按钮；`workflowUi` 只供插件内部用（通知打开运行）；
 * - 工作区作用域：订阅 workbench 导航的 contextPath，把当前项目路径经
 *   `service.bindWorkspace` 绑定为引擎请求作用域（list/snapshot 的 cwd）；
 * - 侧栏会话分组：一次运行的节点会话收进一组（ADR 027）；
 * - 节点会话打开：面板「打开会话」经 project.sessions.openSessionFromEntry
 *   进中央 SessionView，与用户点侧栏会话条目同一条路径。
 */
import type { AgentSwitchGuard } from "../../agents/service.ts";
import { createDraftEditor } from "../editing/draftSessions.ts";
import type { Context } from "cordis";
import type { WorkflowEvent } from "../engine/protocol.ts";
import { createStore } from "zustand/vanilla";
import type { WorkbenchContributions } from "../../workbench/types.ts";
import type { WorkbenchService } from "../../workbench/service.ts";
import type { PanelViewProps } from "../../workbench/types.ts";
import { openRunFromNotification } from "../status/notifications.ts";
import { errorLine } from "../status/errorText.ts";
import { pathKey, projectFolderPath } from "../../../shared/panelPaths.ts";
import { WorkflowIcon } from "../../../shared/ui/icons.tsx";
import type { ProjectActivities, ProjectActivity, ProjectExtension, ProjectQuickAction, ProjectService } from "../../project/service.ts";
import type { WorkflowDraftEditor, WorkflowEntry, WorkflowFileTransfer,
  RunSessionLink,
  RunSessionLinks,
  WorkflowEntryCommand,
  WorkflowProjectStatus,
  WorkflowRunBrief,
  WorkflowService,
  WorkflowSummary,
  WorkflowView,
} from "../types.ts";
import { WorkflowPanel } from "./WorkflowPanel.tsx";
import { SplitStorageContext } from "./SplitPane.tsx";
import { WorkflowSidebar } from "./WorkflowSidebar.tsx";
import { WorkflowWorkspace } from "./WorkflowWorkspace.tsx";
import { createTemplateNavigation } from "./templateNavigation.ts";
import { WorkflowSessionBanner } from "./WorkflowSessionBanner.tsx";
import { AWAITING_CONFIRM_CHIP, BLOCKED_CHIP, STOPPING_CHIP, linkActivity, runSessionGroups } from "./sessionGroups.ts";
import { ACTIVITY_WORD, needsYou, sessionStatusOf } from "../status/nodeActivity.ts";
import type { SessionLookup } from "../status/snapshot.ts";

const panelId = "aaw";
const sidebarId = "workflow";
/** 等第一步的任务进到会话的上限：超过就不再显示「正在启动工作流」。 */
const TASK_HANDOVER_MS = 120_000;

/** 进行中与等你确认的运行 → 会话区 / 总览用的简报（等你处理的排前面）。 */
export function runBriefs(runs: readonly RunSessionLinks[], session?: SessionLookup): WorkflowRunBrief[] {
  return runs
    .filter((run) => !run.archived && (run.active || run.status === "waiting" || run.status === "blocked"))
    .map((run) => {
      if (!run.active) {
        const last = run.links.flatMap((link) => link.nodes).at(-1);
        return {
          runId: run.runId,
          title: run.title || run.workflowName || "工作流",
          workflowName: run.workflowName,
          waiting: true,
          label: run.status === "blocked" ? BLOCKED_CHIP : AWAITING_CONFIRM_CHIP,
          step: last?.label ?? null,
        };
      }
      const running = run.links.flatMap((link) => link.nodes.filter((node) => node.status === "running"));
      // 说法与会话一致（ADR 040）：要你去会话里做点什么的节点排前面。
      const attention = run.stopping === true ? undefined : run.links.flatMap((link) => {
        const activity = linkActivity(link, true, session);
        const node = link.nodes.find((item) => item.status === "running");
        return needsYou(activity) && node ? [{ node, activity: activity! }] : [];
      })[0];
      return {
        runId: run.runId,
        title: run.title || run.workflowName || "工作流",
        workflowName: run.workflowName,
        waiting: attention !== undefined,
        label: run.stopping === true ? STOPPING_CHIP : attention ? ACTIVITY_WORD[attention.activity] : "运行中",
        step: (attention?.node ?? running[0])?.label ?? null,
      };
    })
    .sort((a, b) => Number(b.waiting) - Number(a.waiting));
}

function ownNodeState(
  latest: RunSessionLink["nodes"][number] | undefined,
  active: boolean,
): { word: string; tone: NonNullable<ProjectActivity["tone"]> } {
  if (!latest) return { word: "未开始", tone: "wait" };
  if (latest.status === "running") return active ? { word: "运行中", tone: "running" } : { word: "已中断", tone: "wait" };
  if (latest.status === "failed") return { word: "失败", tone: "alert" };
  if (latest.status === "skipped") return { word: "已跳过", tone: "done" };
  return { word: "已完成", tone: "done" };
}

/** 这次运行里各步骤的状态色调序列（用于状态浮层的迷你流程图胶囊条）。 */
function runStepTones(
  run: RunSessionLinks,
  session?: SessionLookup,
): NonNullable<ProjectActivity["steps"]> {
  const tones: NonNullable<ProjectActivity["tone"]>[] = [];
  const stopping = run.active && run.stopping === true;
  for (const link of run.links) {
    const activity = stopping ? null : linkActivity(link, run.active, session);
    const waiting = needsYou(activity);
    const working = activity === "working";
    for (let i = 0; i < link.nodes.length; i++) {
      const node = link.nodes[i]!;
      const isLatest = i === link.nodes.length - 1;
      if (isLatest && activity) {
        tones.push(stopping || activity === "interrupted" ? "wait" : waiting ? "alert" : working ? "running" : "wait");
      } else {
        tones.push(ownNodeState(node, run.active && !stopping).tone);
      }
    }
  }
  return tones;
}

/** 节点会话 → 右上角会话状态胶囊的活动描述（含已结束运行，方便回看与直达运行面板）。 */
function sessionActivitiesOf(
  runs: readonly RunSessionLinks[],
  session?: SessionLookup,
): Record<string, ProjectActivity> {
  const bySession: Record<string, ProjectActivity> = {};
  for (const run of runs) {
    if (run.archived) continue;
    const stopping = run.active && run.stopping === true;
    const steps = runStepTones(run, session);
    for (const link of run.links) {
      if (link.sessionId in bySession) continue;
      const latest = link.nodes[link.nodes.length - 1];
      const activity = stopping ? null : linkActivity(link, run.active, session);
      const waiting = needsYou(activity);
      const working = activity === "working";
      const own = activity ? null : ownNodeState(latest, run.active);
      const word = stopping ? STOPPING_CHIP : activity ? ACTIVITY_WORD[activity] : own!.word;
      const tone: NonNullable<ProjectActivity["tone"]> =
        stopping || activity === "interrupted" ? "wait" : waiting ? "alert" : working ? "running" : own?.tone ?? "wait";
      const stepName = latest
        ? (latest.ordinal > 1 ? `${latest.label} · 第 ${latest.ordinal} 轮` : latest.label)
        : (link.actorName || run.workflowName || "工作流");
      bySession[link.sessionId] = {
        id: run.runId,
        title: stepName,
        label: word,
        attention: waiting || latest?.status === "failed",
        tone,
        ...(steps.length > 0 ? { steps } : {}),
        detail: run.title || run.workflowName,
        summary: `${stepName} · ${word}`,
        openLabel: `查看工作流运行：${run.title}`,
        sessionIds: [link.sessionId],
      };
    }
  }
  return bySession;
}

/**
 * 输入框里的一段话怎么交给起点（ADR 039）：整段文字填进第一段文字输入（必填的
 * 优先），文字里 `@` 引用的文件填进文件输入；起点什么都不要时这段话当运行标题。
 * 还缺别的必填项就交给引擎报错，原因回到输入框下方。
 */
export function entryInputsOf(entry: WorkflowEntry, text: string): { readonly inputs: Record<string, unknown>; readonly title?: string } {
  if (entry.inputs.length === 0) return { inputs: {}, title: text };
  const texts = entry.inputs.filter((input) => input.kind === "text");
  const target = texts.find((input) => input.required) ?? texts[0];
  const files = [...text.matchAll(/(?:^|\s)@(\S+)/g)].map((match) => match[1]!);
  const inputs: Record<string, unknown> = {};
  if (target) inputs[target.name] = text;
  for (const input of entry.inputs) if (input.kind === "files" && files.length > 0) inputs[input.name] = files;
  return { inputs };
}

/** 选中起点后输入框里的提示：工作流写了就用它，否则按起点要的输入生成。 */
export function entryHint(entry: WorkflowEntry): string {
  if (entry.hint) return entry.hint;
  if (entry.inputs.length === 0) return "给这次运行起个标题，Enter 开始运行";
  const parts = entry.inputs.map((input) => (input.kind === "files" ? `用 @ 引用${input.label}` : input.label));
  return `${parts.join("，")}，Enter 开始运行`;
}

/**
 * 工作流库 → 斜杠命令：每个可用工作流的每个起点一条。都是「发送对象」：选中后
 * 在输入框里写，Enter 即发起（ADR 039）；没有发起表单。
 */
export function entryCommands(
  workflows: readonly WorkflowSummary[],
  submit: (workflowId: string, entry: WorkflowEntry) => NonNullable<WorkflowEntryCommand["submit"]>,
): WorkflowEntryCommand[] {
  return workflows.flatMap((workflow) => {
    const meta = workflow.meta;
    if (meta === null) return [];
    return meta.entries.map((entry) => ({
      id: `workflow:${workflow.id}:${entry.id}`,
      label: meta.entries.length > 1 ? `${meta.name}：${entry.label}` : meta.name,
      description: entry.description || meta.description || "启动这个工作流",
      Icon: WorkflowIcon,
      submit: submit(workflow.id, entry),
      placeholder: entryHint(entry),
      pendingLabel: "正在启动工作流…",
    }));
  });
}

export function createWorkflowWorkbench(
  workflow: WorkflowService,
  workbench: WorkbenchService,
  project: ProjectService,
  transfer?: WorkflowFileTransfer,
  editor?: WorkflowDraftEditor,
  /** 面板里分屏尺寸等界面偏好的存储（宿主存储）。 */
  layoutStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void },
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
      await project.sessions.openSessionFromEntry(projectFolderPath(path), sessionId);
    })().catch((error: unknown) => {
      workbench.showToast({ message: error instanceof Error ? error.message : String(error), variant: "warn" });
    });
  }

  /** 节点结果里的文件 → 工作台打开（相对路径按当前项目解析）。 */
  function openResultFile(projectPath: string, path: string): void {
    if (!active()) return;
    const absolute = /^(?:[A-Za-z]:[\\/]|[\\/])/.test(path);
    const root = projectFolderPath(projectPath);
    const target = absolute ? path : `${root.replace(/[\\/]+$/, "")}/${path.replace(/^\.[\\/]/, "")}`;
    workbench.openPath(projectPath, target).then((opened) => {
      if (!opened) workbench.showToast({ message: `无法打开 ${path}`, variant: "warn" });
    }).catch((cause: unknown) => {
      workbench.showToast({ message: `无法打开 ${path}：${cause instanceof Error ? cause.message : String(cause)}`, variant: "warn" });
    });
  }

  function openRun(projectPath: string, runId: string): void {
    show(projectPath, () => workflow.focusRun(runId));
  }

  /**
   * 再次运行（ADR 039）：在这个项目里新开一个会话，输入框里放好这次运行的起点和
   * 上次的需求，用户过目后 Enter。没有发起表单。
   */
  function runAgain(projectPath: string, runId: string): void {
    if (!active()) return;
    const run = workflow.allRuns().find((item) => item.runId === runId);
    if (!run?.workflowId || !run.entry) return;
    const target = `workflow:${run.workflowId}:${run.entry}`;
    const text = run.requirement || run.title || run.name;
    void project.sessions.startNewSession(projectPath).then((started) => {
      if (!started.ok) {
        workbench.showToast({ message: started.reason, variant: "warn" });
        return;
      }
      if (!project.drafts.composer.prefill(text, [], { target }))
        workbench.showToast({ message: "这个工作流已不在库里，没法再次运行", variant: "warn" });
    });
  }

  // ------------------------------------------------------------ 功能区（模板）
  const templates = createTemplateNavigation();
  /** 运行页「查看工作流」、发起页「查看工作流」→ 左侧功能区里的这个工作流。 */
  function openWorkflow(id: string): void {
    if (!active()) return;
    templates.setState({ route: { kind: "workflow", id }, compose: null });
    workbench.navigation.getState().openSidebar(sidebarId);
  }

  // ------------------------------------------------------------ workflowUi
  const status = createStore<WorkflowProjectStatus>(() => ({ workspacePath: null, runs: [] }));
  const entries = createStore<readonly WorkflowEntryCommand[]>(() => []);
  // 项目界面的通用扩展位用的同一份状态（ADR 037）。
  const activities = createStore<ProjectActivities>(() => ({ workspacePath: null, items: [] }));
  // 空会话的快捷动作只给进行中的运行；发起走「/」菜单（ADR 038）。
  const quickAction = createStore<ProjectQuickAction | null>(() => null);
  /** 会话的实时状态（ADR 040）：侧栏、状态卡的说法与会话一致。 */
  const sessionLookup = (): SessionLookup | undefined => {
    const state = workflow.sessionActivity?.getState();
    return state === undefined ? undefined : (sessionId) => sessionStatusOf(state, sessionId);
  };
  const publishStatus = () => {
    const { workspace, runs } = workflow.sessionLinks();
    const lookup = sessionLookup();
    const briefs = runBriefs(runs, lookup);
    const sessionsOf = new Map(runs.map((run) => [run.runId, run.links.map((link) => link.sessionId)]));
    const stepsOf = new Map(runs.map((run) => [run.runId, runStepTones(run, lookup)]));
    const bySession = sessionActivitiesOf(runs, lookup);
    status.setState({ workspacePath: workspace, runs: briefs }, true);
    activities.setState({
      workspacePath: workspace,
      items: briefs.map((run) => {
        const steps = stepsOf.get(run.runId);
        return {
          id: run.runId,
          title: run.title,
          label: run.label,
          attention: run.waiting,
          tone: run.waiting ? "alert" : "running",
          ...(steps && steps.length > 0 ? { steps } : {}),
          detail: `${run.workflowName}${run.step ? ` · ${run.step}` : ""}`,
          summary: `${run.title} · ${run.label}${run.step ? ` · ${run.step}` : ""}`,
          openLabel: `查看工作流运行：${run.title}`,
          sessionIds: sessionsOf.get(run.runId) ?? [],
        };
      }),
      ...(Object.keys(bySession).length > 0 ? { bySession } : {}),
    }, true);
    const lead = briefs[0];
    quickAction.setState(
      lead
        ? { label: lead.waiting ? "回复进行中的工作流" : "查看进行中的工作流", run: (path) => openRun(path, lead.runId) }
        : null,
      true,
    );
  };
  // 在会话里发起（ADR 039）：先做启动前检查；不通过就把原因交还给输入框，草稿
  // 保留。只有提醒时先说一次，再发送一次才开始（同表单上的「仍然开始」）。
  const warned = new Set<string>();
  const startFromSession = (workflowId: string, entry: WorkflowEntry): NonNullable<WorkflowEntryCommand["submit"]> =>
    async ({ session, text }) => {
      if (!active()) throw new Error("工作流服务还没准备好");
      const request = { workflowId, entry: entry.id, ...entryInputsOf(entry, text), entrySession: session.sessionId };
      const report = await workflow.preflight(request).catch((cause: unknown) => { throw new Error(errorLine(cause)); });
      const failed = report.items.find((item) => item.status === "fail");
      if (failed) throw new Error(`没能开始：${failed.label}，${errorLine(failed.message)}${failed.hint ? `。${failed.hint}` : ""}`);
      const warnings = report.items.filter((item) => item.status === "warn");
      const key = `${workflowId}:${entry.id}`;
      if (warnings.length > 0 && !warned.has(key)) {
        warned.add(key);
        throw new Error(`${warnings.map((item) => `${item.label}：${errorLine(item.message)}`).join("；")}。再发送一次仍然开始。`);
      }
      warned.delete(key);
      // 先订阅再启动：第一步的任务可能很快就进到会话。
      const handover = taskHandover(session.workspacePath, session.sessionId);
      let runId: string;
      try {
        ({ runId } = await workflow.start(request, {
          ...(report.revision ? { revision: report.revision } : {}),
          ...(report.configuration ? { configuration: report.configuration } : {}),
          acceptedWarnings: warnings.map((item) => item.id),
        }));
      } catch (cause) {
        handover.cancel();
        throw new Error(errorLine(cause), { cause });
      }
      // 第一步就在这个会话里跑；右侧打开这次运行。任务进到会话（或运行出错）时这次发送才算完成。
      openRun(session.workspacePath, runId);
      await handover.wait(runId);
    };
  /**
   * 等第一步的任务进到会话（ADR 039）：进到发起的会话里就完成；兜底开在了新会话里
   * 就把它打开到中间；第一步之前运行就出错了，把原因交还给输入框。等太久不再拦着
   * 用户，运行在右侧照常可看。
   */
  function taskHandover(projectPath: string, sessionId: string) {
    const seen: WorkflowEvent[] = [];
    let settle: ((event: WorkflowEvent) => void) | null = null;
    const stop = workflow.subscribe((event) => {
      if (event.type !== "session-task-sent" && event.type !== "run-error" && event.type !== "run-settled") return;
      if (settle) settle(event);
      else seen.push(event);
    });
    return {
      cancel: stop,
      wait: (runId: string) => new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(() => resolve()), TASK_HANDOVER_MS);
        const finish = (then: () => void) => {
          clearTimeout(timer);
          settle = null;
          stop();
          then();
        };
        settle = (event) => {
          if (event.runId !== runId) return;
          if (event.type === "session-task-sent") {
            const target = typeof event.sessionId === "string" ? event.sessionId : sessionId;
            finish(() => {
              if (target !== sessionId) openNodeSession(target, projectPath);
              resolve();
            });
          } else if (event.type === "run-error") {
            finish(() => reject(new Error(errorLine(event.message ?? "WORKFLOW_RUN_FAILED"))));
          } else {
            finish(() => resolve());
          }
        };
        for (const event of seen.splice(0)) settle?.(event);
      }),
    };
  }

  let entriesSeq = 0;
  const loadEntries = () => {
    const seq = ++entriesSeq;
    workflow.workflows()
      .then((list) => {
        if (disposed || seq !== entriesSeq) return;
        entries.setState(entryCommands(list, startFromSession), true);
      })
      .catch(() => {});
  };
  const view: WorkflowView = {
    status,
    entries,
    openRun,
    SessionBanner: function SessionBanner({ project: projectPath, sessionId }) {
      return <WorkflowSessionBanner
        service={workflow}
        project={projectPath}
        sessionId={sessionId}
        onOpenRun={(runId) => openRun(projectPath, runId)}
      />;
    },
  };

  // 工作流是应用级的：功能区不要求先选项目（ADR 038）。
  const sidebar: WorkbenchContributions["sidebar"] = {
    id: sidebarId,
    label: "工作流",
    order: 10,
    Icon: WorkflowIcon,
    View: function WorkflowSidebarView() {
      return <WorkflowSidebar service={workflow} navigation={templates} canCompose={editor !== undefined} />;
    },
    WorkArea: function WorkflowWorkArea() {
      return <SplitStorageContext.Provider value={layoutStorage ?? null}>
        <WorkflowWorkspace service={workflow} navigation={templates} transfer={transfer} editor={editor} />
      </SplitStorageContext.Provider>;
    },
  };

  const panel: WorkbenchContributions["panels"] = {
    id: panelId,
    keepMounted: true,
    launcher: {
      label: "AAW 工作流",
      description: "查看与管理工作流运行",
      searchHint: "aaw workflow",
      Icon: WorkflowIcon,
      open: (projectPath) => show(projectPath),
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
            onOpenSession={openNodeSession}
            onOpenFile={(path) => openResultFile(projectPath, path)}
            onOpenWorkflow={openWorkflow}
            onRunAgain={(runId) => runAgain(projectPath, runId)}
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
    // 打开右侧 AAW 标签页：这个项目的运行。
    treeAction: { label: "工作流", hint: "查看工作流运行", Icon: WorkflowIcon, run: (path) => show(path) },
    SessionBanner: view.SessionBanner,
  };
  return {
    sidebar,
    panel,
    view,
    extension,
    openRun,
    openWorkflow,
    openNodeSession,
    publishStatus,
    sessionLookup,
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
  const ui = createWorkflowWorkbench(workflow, workbench, project, {
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
  }, draftEditor, host.storage);
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
    // 切项目时继续使用各项目已确认的分组。工作流库变化时重读斜杠命令。
    // 其他项目的节点会话同样分组：打开运行时先切到那个项目。
    const publisher = project.sessions.registerSessionGroups();
    const archiveRun = (runId: string, path?: string) => {
      workflow.archiveRun(runId, true, path).catch((cause: unknown) => {
        workbench.showToast({ message: `归档失败：${errorLine(cause)}`, variant: "warn" });
      });
    };
    let published = new Map<string, { path: string; runs: ReturnType<WorkflowService["sessionLinks"]>["runs"] }>();
    const publish = (refreshActivity = false) => {
      const { workspace, runs } = workflow.sessionLinks();
      const next = new Map<string, { path: string; runs: typeof runs }>();
      const publishProject = (path: string, projectRuns: typeof runs) => {
        const key = pathKey(path);
        next.set(key, { path, runs: projectRuns });
        if (!refreshActivity && published.get(key)?.runs === projectRuns) return;
        publisher.publish(path, runSessionGroups(
          projectRuns,
          (runId) => {
            if (pathKey(workbench.navigation.getState().contextPath ?? "") === key)
              ui.openRun(path, runId);
            else
              openRunFromNotification(workbench, ui.openRun, path, runId);
          },
          (sessionId) => ui.openNodeSession(sessionId, path),
          (runId) => archiveRun(runId, path),
          ui.sessionLookup(),
        ));
      };
      const currentRoot = workspace === null ? null : projectFolderPath(workspace);
      if (currentRoot !== null) publishProject(currentRoot, runs);
      for (const other of workflow.otherSessionLinks()) {
        if (currentRoot !== null && pathKey(other.project) === pathKey(currentRoot)) continue;
        publishProject(other.project, other.runs);
      }
      for (const [key, { path }] of published) if (!next.has(key)) publisher.publish(path, []);
      published = next;
      ui.publishStatus();
    };
    publish();
    ui.loadEntries();
    const unsubscribe = workflow.subscribe((event) => {
      if (event.type === "runs-changed") publish();
      else if (event.type === "library-changed") ui.loadEntries();
      else if (event.type === "session-task-sent") {
        // 用户当前正在看同一次工作流运行里的前序步骤会话时，自动跟随切到新推进的活跃步骤。
        const nextSessionId = typeof event.sessionId === "string" ? event.sessionId : "";
        const runId = typeof event.runId === "string" ? event.runId : "";
        if (!nextSessionId || !runId) return;
        const activeSessionId = project.conversation.foreground.session.getState().activeSessionId;
        if (!activeSessionId || activeSessionId === nextSessionId) return;
        const { workspace, runs } = workflow.sessionLinks();
        const run = runs.find((item) => item.runId === runId);
        if (workspace && run && run.links.some((link) => link.sessionId === activeSessionId)) {
          ui.openNodeSession(nextSessionId, workspace);
        }
      }
    });
    // 会话状态一变（工作中、你打断了、出错……）就按同一份重发（ADR 040）。
    const unsubscribeSessions = workflow.sessionActivity?.subscribe(() => publish(true)) ?? (() => {});
    return () => {
      unsubscribe();
      unsubscribeSessions();
      publisher.dispose();
    };
  }, "workflow:session-groups");
  ctx.provide("workflowUi", ui.view);
  ctx.provide("projectExtension", ui.extension);
  ctx.provide("agentSwitchGuard", workflowSwitchGuard(workflow));
}
