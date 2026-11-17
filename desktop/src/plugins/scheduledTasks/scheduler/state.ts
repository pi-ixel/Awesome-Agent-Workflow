import { createStore } from "zustand/vanilla";
import type { TaskSchedule } from "./schedule.ts";
import { isValidSchedule, nextOccurrence } from "./schedule.ts";

export interface TaskInput {
  readonly name: string;
  readonly prompt: string;
  readonly project: string;
  readonly agent: string;
  readonly model?: string;
  readonly effort?: string;
  readonly schedule: TaskSchedule;
  readonly notifications: "all" | "failures" | "off";
}

export interface ScheduledTask extends TaskInput {
  readonly id: string;
  readonly enabled: boolean;
  readonly deleted: boolean;
  readonly cursor: number;
}

export interface RunSession {
  readonly sessionId: string;
  readonly agentKey: string;
  readonly workspacePath: string;
}

export type RunStatus = "running" | "waiting" | "success" | "failed" | "missed" | "skipped" | "interrupted";

export interface TaskRun {
  readonly id: string;
  readonly taskId: string;
  readonly at: number;
  readonly status: RunStatus;
  readonly session?: RunSession;
  readonly error?: string;
}

export interface TaskData {
  readonly tasks: readonly ScheduledTask[];
  readonly runs: readonly TaskRun[];
}

export interface SchedulerDeps {
  readonly read: () => TaskData;
  readonly write: (data: TaskData) => Promise<void>;
  readonly eligible: () => boolean;
  readonly run: (task: ScheduledTask, observe: (state: Pick<TaskRun, "session" | "status">) => Promise<void>) => Promise<void>;
  readonly notify: (task: ScheduledTask, run: TaskRun) => void;
  readonly now?: () => number;
}

const activeRun = (status: RunStatus) => status === "running" || status === "waiting";

function validateData(data: TaskData): void {
  const validTasks = data.tasks.every((task) => task &&
    [task.id, task.name, task.prompt, task.project, task.agent].every((value) => typeof value === "string" && value.length > 0) &&
    typeof task.enabled === "boolean" && typeof task.deleted === "boolean" && Number.isFinite(task.cursor) &&
    ["all", "failures", "off"].includes(task.notifications) && task.schedule && isValidSchedule(task.schedule));
  const validRuns = data.runs.every((run) => run && typeof run.id === "string" && typeof run.taskId === "string" &&
    Number.isFinite(run.at) && ["running", "waiting", "success", "failed", "missed", "skipped", "interrupted"].includes(run.status) &&
    (!run.session || [run.session.sessionId, run.session.agentKey, run.session.workspacePath].every((value) => typeof value === "string" && value.length > 0)));
  if (!validTasks || !validRuns || new Set(data.tasks.map((task) => task.id)).size !== data.tasks.length ||
    new Set(data.runs.map((run) => run.id)).size !== data.runs.length) throw new Error("定时任务记录损坏，请检查存储中的任务配置");
}

export function createScheduler(deps: SchedulerDeps) {
  const now = deps.now ?? Date.now;
  let initial: TaskData = { tasks: [], runs: [] };
  let loadError = "";
  try {
    const data = deps.read();
    validateData(data);
    initial = data;
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }
  const store = createStore(() => ({
    ...initial,
    error: loadError,
    selected: null as string | null,
    editing: undefined as string | null | undefined,
    clock: now(),
  }));
  let queue: Promise<unknown> = Promise.resolve();
  let lastPoll = now();
  let paused = Boolean(loadError);
  let disposed = false;
  const settlements = new Map<string, { task: ScheduledTask; outcome: Partial<TaskRun> }>();

  function serial<T>(action: () => Promise<T>): Promise<T> {
    const operation = queue.then(action);
    queue = operation.catch((error: unknown) => {
      if (!disposed) store.setState({ error: error instanceof Error ? error.message : String(error) });
    });
    return operation;
  }

  function assertAvailable() {
    if (disposed || paused) throw new Error(loadError || "定时任务记录当前不可用");
  }

  async function persist(data: TaskData) {
    await deps.write({ tasks: data.tasks, runs: data.runs });
    if (!disposed) store.setState({ tasks: data.tasks, runs: data.runs, error: "" });
  }

  const recover = serial(async () => {
    if (!initial.runs.some((item) => activeRun(item.status))) return;
    await persist({
      tasks: initial.tasks,
      runs: initial.runs.map((run) => activeRun(run.status) ? { ...run, status: "interrupted" } : run),
    });
  });
  void recover.catch(() => { paused = true; });

  function updateRun(id: string, patch: Partial<TaskRun>): Promise<TaskRun | undefined> {
    return serial(() => persistRun(id, patch));
  }

  async function persistRun(id: string, patch: Partial<TaskRun>): Promise<TaskRun | undefined> {
    if (disposed) return;
    const data = store.getState();
    const current = data.runs.find((run) => run.id === id);
    if (!current) return;
    const updated = { ...current, ...patch };
    await persist({ tasks: data.tasks, runs: data.runs.map((run) => run.id === id ? updated : run) });
    return updated;
  }

  async function settle(id: string, task: ScheduledTask, outcome: Partial<TaskRun>) {
    const result = await persistRun(id, outcome);
    settlements.delete(id);
    if (result && (task.notifications === "all" || (result.status === "failed" && task.notifications === "failures")))
      deps.notify(task, result);
  }

  async function execute(task: ScheduledTask, run: TaskRun) {
    let outcome: Partial<TaskRun> = { status: "success" };
    try {
      await deps.run(task, async (value) => { await updateRun(run.id, value); });
    } catch (error) {
      outcome = { status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
    // Persistence and notification failures must not rewrite the Agent's outcome.
    settlements.set(run.id, { task, outcome });
    await serial(() => settle(run.id, task, outcome));
  }

  async function begin(task: ScheduledTask, at: number, status: RunStatus, cursor = task.cursor) {
    const data = store.getState();
    const busy = data.runs.some((run) => run.taskId === task.id && activeRun(run.status));
    const run: TaskRun = { id: crypto.randomUUID(), taskId: task.id, at, status: busy && status === "running" ? "skipped" : status };
    await persist({
      tasks: data.tasks.map((item) => item.id === task.id ? { ...item, cursor } : item),
      runs: [run, ...data.runs],
    });
    if (!disposed && run.status === "running") {
      if (deps.eligible()) void execute(task, run).catch(() => {});
      else void updateRun(run.id, { status: "interrupted" }).catch(() => {});
    }
  }

  function tick(): Promise<void> {
    return serial(async () => {
      if (disposed || paused || !deps.eligible()) return;
      for (const [id, { task, outcome }] of settlements) await settle(id, task, outcome);
      const current = now();
      store.setState({ clock: current });
      const last = lastPoll;
      lastPoll = current;
      for (const task of store.getState().tasks) {
        if (!task.enabled || task.deleted) continue;
        let occurrence = nextOccurrence(task.schedule, task.cursor);
        while (occurrence && occurrence.at <= current) {
          const missed = occurrence.missingTime || occurrence.at <= last || current - last > 30_000;
          await begin(task, occurrence.at, missed ? "missed" : "running", occurrence.at);
          occurrence = nextOccurrence(task.schedule, occurrence.at);
        }
      }
    });
  }

  return {
    store,
    tick,
    save(input: TaskInput, id?: string) {
      return serial(async () => {
        assertAvailable();
        if (!input.name.trim() || !input.prompt.trim() || !input.project || !input.agent || !isValidSchedule(input.schedule)) {
          throw new Error("请填写任务名称、指令、项目、Agent 和有效时间");
        }
        if (input.schedule.kind === "once" && !nextOccurrence(input.schedule, now()))
          throw new Error("一次性任务需选择未来的时间");
        const data = store.getState();
        const existing = data.tasks.find((task) => task.id === id && !task.deleted);
        const task = {
          ...input, id: existing?.id ?? crypto.randomUUID(), enabled: existing?.enabled ?? true,
          deleted: false, cursor: Math.max(existing?.cursor ?? 0, now()),
        };
        await persist({ ...data, tasks: existing ? data.tasks.map((item) => item.id === task.id ? task : item) : [...data.tasks, task] });
        store.setState({ selected: task.id, editing: undefined });
      });
    },
    change(id: string, change: { enabled: boolean } | { deleted: true }) {
      return serial(async () => {
        assertAvailable();
        const data = store.getState();
        await persist({
          ...data,
          tasks: data.tasks.map((task) => task.id === id ? {
            ...task, ...change, cursor: Math.max(task.cursor, now()),
          } : task),
        });
      });
    },
    runNow(id: string) {
      return serial(async () => {
        if (disposed || paused || !deps.eligible()) throw new Error("桌面任务目前无法运行");
        const task = store.getState().tasks.find((item) => item.id === id && !item.deleted);
        if (task) await begin(task, now(), "running");
      });
    },
    dispose: () => { disposed = true; },
  };
}

export type Scheduler = ReturnType<typeof createScheduler>;
