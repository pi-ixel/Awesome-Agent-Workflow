import { IconButton } from "../../../shared/ui/IconButton.tsx";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useStore } from "zustand";
import { useRegisteredSnapshot } from "../../../shared/state/useRegisteredSnapshot.ts";
import { btnPrimary, btnSecondary, focusVisibleRing, Listbox, rowSelectedClass } from "../../../shared/ui/controls.tsx";
import { ClockIcon, PlusIcon, XIcon, ChevronDownIcon } from "../../../shared/ui/icons.tsx";
import { ModalShell } from "../../../shared/ui/ModalShell.tsx";
import { ConfirmationDialog } from "../../../shared/ui/ConfirmationDialog.tsx";
import { TreeBranch, treeChevronClass } from "../../../shared/ui/TreeMotion.tsx";
import { SidebarCreateButton } from "../../../shared/ui/SidebarCreateButton.tsx";
import { SidebarItemTitle } from "../../../shared/ui/SidebarItemTitle.tsx";
import type { AgentsService } from "../../agents/service.ts";
import type { ProjectService } from "../../project/service.ts";
import { nextOccurrence, type TaskSchedule } from "../scheduler/schedule.ts";
import type { Scheduler, ScheduledTask, TaskInput, TaskRun } from "../scheduler/state.ts";

const timing = { once: "一次", daily: "每天", weekly: "每周" };
const status = {
  running: "运行中", waiting: "等待确认", success: "成功", failed: "失败",
  missed: "已错过", skipped: "已跳过", interrupted: "已中断",
};
const inlineField = `min-h-8 min-w-0 max-w-full rounded-md border border-transparent bg-transparent px-2 text-right text-ui-sm text-ink-soft hover:bg-surface-hover ${focusVisibleRing}`;
const action = `${btnSecondary} min-h-8 px-3 text-ui-sm`;
const primary = `${btnPrimary} min-h-8 px-3 text-ui-sm`;

function formatDate(at: number) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(at);
}

export function TaskSidebar({ scheduler }: { readonly scheduler: Scheduler }) {
  const { tasks, selected } = useStore(scheduler.store);
  const visible = tasks.filter((task) => !task.deleted);
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-2 px-2 py-2" aria-label="定时任务列表">
      <SidebarCreateButton label="新建任务" Icon={PlusIcon} onClick={() => scheduler.store.setState({ editing: null })} />
      {!visible.length && <p className="px-2 py-1 text-ui-sm text-ink-mute">没有已安排的任务</p>}
      <ul className="min-h-0 overflow-y-auto">
        {visible.map((task) => (
          <li key={task.id}>
            <button
              type="button"
              className={`flex min-h-8 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-hover ${focusVisibleRing} ${selected === task.id ? rowSelectedClass : ""}`}
              aria-current={selected === task.id || undefined}
              onClick={() => scheduler.store.setState({ selected: task.id })}
            >
              <SidebarItemTitle>{task.name}</SidebarItemTitle>
              <span className="shrink-0 text-ui-sm text-ink-mute">{task.enabled ? timing[task.schedule.kind] : "已暂停"}</span>
            </button>
          </li>
        ))}
      </ul>
      {tasks.some((task) => task.deleted) && (
        <button type="button" className={action} onClick={() => scheduler.store.setState({ selected: "deleted" })}>已删除任务的记录</button>
      )}
    </section>
  );
}

export function TaskWorkspace({ scheduler, project, agents, openRun }: {
  readonly scheduler: Scheduler;
  readonly project: ProjectService;
  readonly agents: AgentsService;
  readonly openRun: (run: TaskRun) => Promise<void>;
}) {
  const { tasks, runs, error, selected, editing, clock } = useStore(scheduler.store);
  const [viewError, setViewError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState("");
  const task = tasks.find((item) => item.id === selected);
  const next = task?.enabled && !task.deleted ? nextOccurrence(task.schedule, Math.max(clock, task.cursor)) : null;
  const history = runs.filter((run) => selected === "deleted" ? tasks.some((item) => item.id === run.taskId && item.deleted) : run.taskId === selected);
  const invoke = (promise: Promise<void>) => {
    setViewError("");
    void promise.catch((cause: unknown) => setViewError(cause instanceof Error ? cause.message : String(cause)));
  };
  return (
    <section aria-label="定时任务" className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-5 p-6">
      {error || viewError ? <p role="alert" className="text-ui-sm text-danger-ink">{viewError || error}</p> : null}
      {!task && selected !== "deleted" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 py-12 text-center">
          <ClockIcon className="ui-icon-32 text-ink-mute" />
          <h1 className="text-ui-xl font-semibold">定时任务</h1>
          <p className="text-ui-sm text-ink-mute">在本机为项目安排 Agent 指令。Desktop 运行期间会按时触发。</p>
          <button type="button" className={primary} onClick={() => scheduler.store.setState({ editing: null })}>新建任务</button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="break-words text-ui-xl font-semibold">{task?.name ?? "已删除任务的运行记录"}</h1>
              {task && <p className="mt-1 break-all text-ui-sm text-ink-mute">{task.project} · {agents.resolve(task.agent)?.displayName ?? task.agent}</p>}
            </div>
            {task && !task.deleted && (
              <div className="flex flex-wrap gap-2">
                <button type="button" className={primary} onClick={() => invoke(scheduler.runNow(task.id))}>立即运行</button>
                <button type="button" className={action} onClick={() => invoke(scheduler.change(task.id, { enabled: !task.enabled }))}>{task.enabled ? "暂停" : "启用"}</button>
                <button type="button" className={action} onClick={() => scheduler.store.setState({ editing: task.id })}>编辑</button>
                <button type="button" className={action} onClick={() => setConfirmDelete(task.id)}>删除</button>
              </div>
            )}
          </div>
          {task && (
            <>
              <p className="whitespace-pre-wrap break-words rounded-xl border border-line bg-surface p-3 text-ui-base">{task.prompt}</p>
              <p className="text-ui-sm text-ink-mute">{timing[task.schedule.kind]} · {task.schedule.time} · {next ? `下次运行 ${formatDate(next.at)}` : "暂无下次运行"}</p>
            </>
          )}
          <div>
            <h2 className="mb-2 text-ui-base font-semibold">运行记录</h2>
            {!history.length && <p className="text-ui-sm text-ink-mute">暂无运行记录</p>}
            <ul className="divide-y divide-line rounded-xl border border-line">
              {history.map((run) => (
                <li key={run.id} id={`scheduled-run-${run.id}`} className="flex flex-wrap items-center justify-between gap-2 p-3">
                  <div className="min-w-0">
                    <p className="text-ui-sm">{status[run.status]} · {formatDate(run.at)}</p>
                    {run.error && <p className="mt-1 break-words text-ui-caption text-danger-ink">{run.error}</p>}
                  </div>
                  {run.session && <button type="button" className={action} onClick={() => invoke(openRun(run))}>打开会话</button>}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
      {editing !== undefined && (
        <TaskEditor
          key={editing ?? "new"}
          task={tasks.find((item) => item.id === editing)}
          scheduler={scheduler} project={project} agents={agents}
        />
      )}
      {confirmDelete && (
        <ConfirmationDialog
          label="删除定时任务"
          title="删除定时任务"
          confirmLabel="删除任务"
          onCancel={() => setConfirmDelete("")}
          onConfirm={() => {
            invoke(scheduler.change(confirmDelete, { deleted: true }));
            setConfirmDelete("");
          }}
        >
          <p>删除后不再触发，已有运行和会话仍可查看。</p>
        </ConfirmationDialog>
      )}
    </section>
  );
}

function TaskSettingRow({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-4 px-4 py-1.5 text-ui-sm">
      <span className="shrink-0 text-ink-soft">{label}</span>
      <div className="min-w-0 max-w-[72%]">{children}</div>
    </div>
  );
}

function TaskEditor({ task, scheduler, project, agents }: {
  readonly task?: ScheduledTask;
  readonly scheduler: Scheduler;
  readonly project: ProjectService;
  readonly agents: AgentsService;
}) {
  const workspace = useRegisteredSnapshot(project.projects.workspace, (state) => state);
  const configuration = useRegisteredSnapshot(agents.configuration, (state) => state);
  const paths = Array.from(new Set([workspace?.activePath, workspace?.selectedPath,
    ...(workspace?.pinnedPaths ?? []), ...(workspace?.recentWorkspaces.map((entry) => entry.path) ?? [])]
    .filter((path): path is string => Boolean(path))));
  const [schedule, setSchedule] = useState<TaskSchedule>(task ? { ...task.schedule, timeZone: "local" } : {
    kind: "daily", time: "09:00", timeZone: "local",
  });
  const [path, setPath] = useState(task?.project ?? workspace?.activePath ?? paths[0] ?? "");
  const agentId = configuration?.activeAgentId ?? agents.selectedId;
  const [model, setModel] = useState(task?.model ?? "");
  const [effort, setEffort] = useState(task?.effort ?? "");
  const [notifications, setNotifications] = useState<TaskInput["notifications"]>(task?.notifications ?? "failures");
  type AgentOptions = Awaited<ReturnType<ProjectService["sessions"]["backgroundPromptOptions"]>>;
  const [loadedOptions, setLoadedOptions] = useState<{ key: string; value?: AgentOptions; error?: string }>();
  const optionsKey = JSON.stringify([path, agentId]);
  const options = loadedOptions?.key === optionsKey ? loadedOptions.value : undefined;
  const optionsError = loadedOptions?.key === optionsKey ? loadedOptions.error : undefined;
  const checking = Boolean(path && !options && !optionsError);
  useEffect(() => {
    if (!path) return;
    let active = true;
    void project.sessions.backgroundPromptOptions(path, agentId).then((value) => {
      if (!active) return;
      setLoadedOptions({ key: optionsKey, value });
      const sameBinding = task?.project === path && task.agent === agentId;
      setModel(sameBinding && value.models.some((item) => item.value === task?.model) ? (task.model ?? "") : "");
      setEffort(sameBinding && value.efforts.some((item) => item.value === task?.effort) ? (task.effort ?? "") : "");
    }).catch((cause: unknown) => {
      if (active) setLoadedOptions({ key: optionsKey, error: cause instanceof Error ? cause.message : String(cause) });
    });
    return () => { active = false; };
  }, [path, agentId, optionsKey, project, task]);
  const times = Array.from(new Set([...Array.from({ length: 96 }, (_, index) =>
    `${String(Math.floor(index / 4)).padStart(2, "0")}:${String(index % 4 * 15).padStart(2, "0")}`), schedule.time])).sort();
  const [advanced, setAdvanced] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const close = () => { if (!saving) scheduler.store.setState({ editing: undefined }); };
  const label = task ? "编辑定时任务" : "新建定时任务";
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const value = (key: string) => {
      const fieldValue = data.get(key);
      return typeof fieldValue === "string" ? fieldValue.trim() : "";
    };
    setSaving(true);
    setError("");
    void scheduler.save({
      name: value("task-title"), prompt: value("prompt"), project: path, agent: agentId,
      model: model || undefined, effort: effort || undefined, schedule,
      notifications,
    }, task?.id).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setSaving(false));
  };
  return (
    <ModalShell label={label} size="form" onDismiss={close}>
      <form onSubmit={submit} autoComplete="off" className="flex min-h-0 flex-col">
        <header className="flex shrink-0 items-center justify-between px-6 pt-5 pb-3">
          <h2 className="text-ui-lg font-semibold">{label}</h2>
          <IconButton iconSize="dialog" type="button" aria-label="关闭" disabled={saving} onClick={close}
            className={`flex items-center justify-center rounded-full text-ink-mute hover:bg-surface-hover hover:text-ink ${focusVisibleRing}`}>
            <XIcon className="ui-icon-16" />
          </IconButton>
        </header>
        <div className="min-h-0 overflow-y-auto px-5 py-2 [scrollbar-gutter:stable]">
          <div className="grid gap-3">
            <label className="grid gap-1.5 text-ui-sm text-ink-soft">
              任务名称
              <input name="task-title" autoComplete="off" required defaultValue={task?.name}
                className={`min-h-11 w-full rounded-xl border border-line bg-surface px-4 text-ui-base text-ink ${focusVisibleRing}`} />
            </label>
            <label className="grid gap-1.5 text-ui-sm text-ink-soft">
              任务描述
              <textarea placeholder="描述希望 Agent 定时完成的任务…" name="prompt" autoComplete="off" rows={3} required defaultValue={task?.prompt}
                className={`w-full resize-y rounded-xl border border-line bg-surface px-4 py-3 text-ui-base leading-relaxed text-ink placeholder:text-ink-mute ${focusVisibleRing}`} />
            </label>
          </div>
          <div className="mt-4 divide-y divide-line rounded-2xl border border-line">
            <TaskSettingRow label="重复">
              <Listbox label="重复" appearance="quiet" value={schedule.kind}
                options={Object.entries(timing).map(([value, label]) => ({ value, label }))}
                onChange={(kind) => {
                  const { time, timeZone } = schedule;
                  if (kind === "once") setSchedule({ kind, time, timeZone, date: "" });
                  else if (kind === "weekly") setSchedule({ kind, time, timeZone, weekdays: [1] });
                  else setSchedule({ kind: "daily", time, timeZone });
                }} />
            </TaskSettingRow>
            <TaskSettingRow label="时间">
              <Listbox label="时间" appearance="quiet" showSelectionMark value={schedule.time}
                options={times.map((value) => ({ value, label: value }))}
                onChange={(time) => setSchedule({ ...schedule, time })} />
            </TaskSettingRow>
            {schedule.kind === "once" && <TaskSettingRow label="日期">
              <input aria-label="日期" type="date" className={inlineField} required value={schedule.date}
                onChange={(event) => setSchedule({ ...schedule, date: event.currentTarget.value })} />
            </TaskSettingRow>}
            {schedule.kind === "weekly" && <TaskSettingRow label="星期">
              <div role="group" aria-label="星期" className="flex flex-wrap justify-end gap-1">
                {["日", "一", "二", "三", "四", "五", "六"].map((day, index) => (
                  <label key={day} className="cursor-pointer">
                    <input type="checkbox" aria-label={`星期${day}`} className="peer sr-only"
                      checked={schedule.weekdays.includes(index)}
                      onChange={(event) => setSchedule({ ...schedule, weekdays: event.currentTarget.checked
                        ? [...schedule.weekdays, index] : schedule.weekdays.filter((value) => value !== index) })} />
                    <span className="grid min-h-8 min-w-8 place-items-center rounded-full text-ink-soft hover:bg-surface-hover peer-checked:bg-ink peer-checked:text-foreground-inverse peer-focus-visible:ring-2 peer-focus-visible:ring-focus-ring">{day}</span>
                  </label>
                ))}
              </div>
            </TaskSettingRow>}
          </div>
          <div className="mt-3 rounded-2xl border border-line">
            <TaskSettingRow label="项目">
              <Listbox label="项目" appearance="quiet" className="max-w-full py-1 text-ui-sm" value={path || null} disabled={checking} placeholder="选择项目"
                options={Array.from(new Set([...paths, ...(task ? [task.project] : [])])).map((value) => ({ value, label: value }))}
                onChange={(value) => { setPath(value); setModel(""); setEffort(""); }} />
            </TaskSettingRow>
          </div>
          <button type="button" aria-expanded={advanced} aria-controls="task-advanced" onClick={() => setAdvanced(!advanced)}
            className={`my-3 flex min-h-8 items-center gap-1.5 rounded-lg px-1 text-ui-sm text-ink-mute hover:text-ink ${focusVisibleRing}`}>
            高级 <ChevronDownIcon className={`ui-icon-14 ${treeChevronClass} ${advanced ? "rotate-180" : ""}`} />
          </button>
          <TreeBranch id="task-advanced" open={advanced}>
            <div className="flex flex-col gap-3 pb-1">
              <div className="rounded-2xl border border-line">
                <TaskSettingRow label="运行结果通知">
                  <Listbox label="运行结果通知" appearance="quiet" value={notifications}
                    options={[{ value: "all", label: "所有运行" }, { value: "failures", label: "仅失败" }, { value: "off", label: "关闭" }]}
                    onChange={(value) => setNotifications(value as TaskInput["notifications"])} />
                </TaskSettingRow>
              </div>
              <div className="divide-y divide-line rounded-2xl border border-line">
                <TaskSettingRow label="模型">
                  <Listbox label="模型" disabled={checking || Boolean(optionsError)} triggerLabel={checking ? "正在读取…" : undefined} appearance="quiet" className="max-w-full py-1 text-ui-sm" value={model} onChange={setModel}
                    options={[{ value: "", label: "Agent 默认值" },
                      ...(model && !options?.models.some(({ value }) => value === model) ? [{ value: model, label: model }] : []),
                      ...(options?.models ?? [])]} />
                </TaskSettingRow>
                {(options?.efforts.length || effort) ? <TaskSettingRow label="强度">
                  <Listbox label="强度" appearance="quiet" value={effort} onChange={setEffort}
                    options={[{ value: "", label: "Agent 默认值" },
                      ...(effort && !options?.efforts.some(({ value }) => value === effort) ? [{ value: effort, label: effort }] : []),
                      ...(options?.efforts ?? [])]} />
                </TaskSettingRow> : null}
              </div>
              {optionsError && <p role="alert" className="px-1 text-ui-sm text-danger-ink">模型选项读取失败：{optionsError}</p>}
            </div>
          </TreeBranch>
        </div>
        <footer className="flex shrink-0 flex-col gap-3 px-6 pt-3 pb-5">
          {error && <p role="alert" className="text-ui-sm text-danger-ink">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className={`${btnSecondary} min-h-9 rounded-full! px-5 text-ui-sm`} onClick={close} disabled={saving}>取消</button>
            <button type="submit" className={`${btnPrimary} min-h-9 rounded-full! px-5 text-ui-sm`} disabled={saving || checking || Boolean(optionsError) || !path}>{task ? "保存" : "创建"}</button>
          </div>
        </footer>
      </form>
    </ModalShell>
  );
}
