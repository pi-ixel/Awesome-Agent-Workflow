import { expect, it, vi } from "vitest";
import { createScheduler, type ScheduledTask, type TaskData } from "../../../src/plugins/scheduledTasks/scheduler/state.ts";

const at = Date.parse("2026-11-17T01:00Z");
const task: ScheduledTask = {
  name: "日报", prompt: "整理进度", project: "D:/p", agent: "agent",
  schedule: { kind: "daily", time: "09:00", timeZone: "Asia/Shanghai" },
  notifications: "failures", id: "task", enabled: true, deleted: false, cursor: at - 5000,
};

it("persists the claim before dispatch and skips overlapping scheduled and manual runs", async () => {
  let clock = at - 1000;
  let saved: TaskData = { tasks: [task], runs: [] };
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const run = vi.fn(() => {
    expect(saved.runs[0]?.status).toBe("running");
    return pending;
  });
  const scheduler = createScheduler({
    read: () => saved,
    write: (data) => { saved = data; return Promise.resolve(); },
    eligible: () => true, run, notify: vi.fn(), now: () => clock,
  });
  clock = at;
  await Promise.all([scheduler.tick(), scheduler.tick()]);
  await scheduler.runNow("task");
  expect(run).toHaveBeenCalledOnce();
  expect(saved.runs.map((item) => item.status)).toEqual(["skipped", "running"]);
  expect(saved.runs[0]).toMatchObject({ unread: true, agentId: task.agent });
  expect(saved.runs[1]?.unread).toBeUndefined();
  await scheduler.openRunDetails(saved.runs[0]!.id);
  expect(saved.runs[0]?.unread).toBeUndefined();
  finish();
  await vi.waitFor(() => expect(saved.runs[1]?.status).toBe("success"));
  expect(saved.runs[1]).toMatchObject({ unread: true, agentId: task.agent });
  scheduler.dispose();
});

it("does not restart an interrupted run or replay a missed occurrence", async () => {
  const session = { workspacePath: task.project, agentKey: "key", sessionId: "chat" };
  let saved: TaskData = { tasks: [task], runs: [{ id: "previous", taskId: "task", at: at - 6000, status: "waiting", session }] };
  const run = vi.fn(() => Promise.resolve());
  const scheduler = createScheduler({
    read: () => saved, write: (data) => { saved = data; return Promise.resolve(); },
    eligible: () => true, run, notify: vi.fn(), now: () => at + 60_000,
  });
  await scheduler.tick();
  expect(run).not.toHaveBeenCalled();
  expect(saved.runs[0]?.status).toBe("missed");
  expect(saved.runs[0]?.unread).toBe(true);
  expect(saved.runs[1]).toMatchObject({ status: "interrupted", session, unread: true });
  scheduler.dispose();
});

it("keeps a completed outcome when notification delivery fails", async () => {
  let saved: TaskData = { tasks: [{ ...task, notifications: "all" }], runs: [] };
  const run = vi.fn(async () => {});
  const scheduler = createScheduler({
    read: () => saved, write: (data) => { saved = data; return Promise.resolve(); },
    eligible: () => true, run, notify: () => { throw new Error("notifications unavailable"); }, now: () => at,
  });
  await scheduler.runNow(task.id);
  await vi.waitFor(() => expect(saved.runs[0]?.status).toBe("success"));
  const completedId = saved.runs[0]!.id;
  await scheduler.tick();
  expect(saved.runs.find((item) => item.id === completedId)?.status).toBe("success");
  expect(run).toHaveBeenCalledOnce();
  scheduler.dispose();
});

it("retries saving a completed result without sending the prompt again", async () => {
  let saved: TaskData = { tasks: [task], runs: [] };
  let unavailable = true;
  const run = vi.fn(async () => {});
  const scheduler = createScheduler({
    read: () => saved,
    write: (data) => {
      if (unavailable && data.runs.some((item) => item.status === "success")) return Promise.reject(new Error("disk full"));
      saved = data;
      return Promise.resolve();
    },
    eligible: () => true, run, notify: vi.fn(), now: () => at,
  });
  await scheduler.runNow(task.id);
  await vi.waitFor(() => expect(scheduler.store.getState().error).toBe("disk full"));
  expect(saved.runs[0]?.status).toBe("running");
  unavailable = false;
  await scheduler.tick();
  expect(saved.runs.find((item) => item.status === "success")).toBeDefined();
  expect(run).toHaveBeenCalledOnce();
  scheduler.dispose();
});

it("never sends when persisting the initial run claim fails", async () => {
  const run = vi.fn(async () => {});
  const scheduler = createScheduler({
    read: () => ({ tasks: [task], runs: [] }), write: () => Promise.reject(new Error("disk full")),
    eligible: () => true, run, notify: vi.fn(), now: () => at,
  });
  await expect(scheduler.runNow(task.id)).rejects.toThrow("disk full");
  expect(run).not.toHaveBeenCalled();
  scheduler.dispose();
});

it("does not replay an occurrence after the clock moves backwards and the task is reenabled", async () => {
  let clock = at - 1000;
  let saved: TaskData = { tasks: [task], runs: [] };
  const run = vi.fn(async () => {});
  const scheduler = createScheduler({
    read: () => saved, write: (data) => { saved = data; return Promise.resolve(); },
    eligible: () => true, run, notify: vi.fn(), now: () => clock,
  });
  clock = at;
  await scheduler.tick();
  await vi.waitFor(() => expect(saved.runs[0]?.status).toBe("success"));
  clock = at - 1000;
  await scheduler.change(task.id, { enabled: false });
  await scheduler.change(task.id, { enabled: true });
  await scheduler.tick();
  clock = at;
  await scheduler.tick();
  expect(run).toHaveBeenCalledOnce();
  expect(saved.runs).toHaveLength(1);
  scheduler.dispose();
});

it("marks sleep gaps missed and resumes at the next scheduled occurrence", async () => {
  let clock = at - 1000;
  let saved: TaskData = { tasks: [task], runs: [] };
  const run = vi.fn(async () => {});
  const scheduler = createScheduler({
    read: () => saved, write: (data) => { saved = data; return Promise.resolve(); },
    eligible: () => true, run, notify: vi.fn(), now: () => clock,
  });
  clock = at + 60_000;
  await scheduler.tick();
  expect(saved.runs[0]?.status).toBe("missed");
  expect(run).not.toHaveBeenCalled();
  clock = at + 86_400_000 - 1000;
  await scheduler.tick();
  clock += 1000;
  await scheduler.tick();
  await vi.waitFor(() => expect(saved.runs[0]?.status).toBe("success"));
  expect(run).toHaveBeenCalledOnce();
  scheduler.dispose();
});

it("keeps a deleted task's running session and result accessible", async () => {
  let saved: TaskData = { tasks: [task], runs: [] };
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const session = { workspacePath: task.project, agentKey: "agent", sessionId: "approval-session" };
  const scheduler = createScheduler({
    read: () => saved, write: (data) => { saved = data; return Promise.resolve(); }, eligible: () => true,
    run: async (_, observe) => { await observe({ session, status: "waiting" }); await pending; },
    notify: vi.fn(), now: () => at,
  });
  await scheduler.runNow(task.id);
  await vi.waitFor(() => expect(saved.runs[0]?.status).toBe("waiting"));
  await scheduler.change(task.id, { deleted: true });
  finish();
  await vi.waitFor(() => expect(saved.runs[0]?.status).toBe("success"));
  expect(saved.tasks[0]?.deleted).toBe(true);
  expect(saved.runs[0]?.session).toEqual(session);
  scheduler.dispose();
});

it("does not dispatch after shutdown while a claim is being saved", async () => {
  let save!: () => void;
  const writing = new Promise<void>((resolve) => { save = resolve; });
  const write = vi.fn(() => writing);
  const run = vi.fn(async () => {});
  const scheduler = createScheduler({
    read: () => ({ tasks: [task], runs: [] }), write,
    eligible: () => true, run, notify: vi.fn(), now: () => at,
  });
  const launching = scheduler.runNow(task.id);
  await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
  scheduler.dispose();
  save();
  await launching;
  expect(run).not.toHaveBeenCalled();
});

it("blocks corrupted persisted schedules without overwriting the original records", async () => {
  const write = vi.fn(async () => {});
  const run = vi.fn(async () => {});
  const scheduler = createScheduler({
    read: () => ({ tasks: [{ ...task, cursor: Number.NaN }], runs: [] }), write,
    eligible: () => true, run, notify: vi.fn(), now: () => at,
  });
  await scheduler.tick();
  await expect(scheduler.save(task)).rejects.toThrow("定时任务记录损坏");
  expect(write).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
  expect(scheduler.store.getState().tasks).toEqual([]);
  scheduler.dispose();
});
