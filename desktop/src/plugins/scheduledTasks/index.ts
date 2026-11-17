import type { Context } from "cordis";
import type {} from "../account/service.ts";
import type {} from "./service.ts";
import { createElement, useState } from "react";
import { flushNativeConfiguration, nativeConfigurationStatus } from "../host/service.ts";
import { ClockIcon } from "../../shared/ui/icons.tsx";
import { ToggleSwitch } from "../../shared/ui/controls.tsx";
import { SettingCard, SettingRow } from "../../shared/ui/SettingsPageParts.tsx";
import { createScheduler, type TaskData, type TaskRun } from "./scheduler/state.ts";
import { TaskSidebar, TaskWorkspace } from "./ui/TaskViews.tsx";

export const name = "scheduledTasks";
export const inject = ["host", "project", "agents", "account", "workbench"];

const storageKey = "aaw-desktop/scheduled-tasks.v1";
const trayKey = "aaw-desktop/close-to-tray.v1";
const section = "scheduled-tasks";

export async function apply(ctx: Context) {
  const { host, project, agents, account, workbench } = ctx;
  let disposed = false;
  let sequence = 1_500_000_000;
  let closeToTray = (host.storage.getItem(trayKey) ?? "true") === "true";
  let ownershipError = "";
  try {
    if (host.isNative() && !host.window.claimScheduledTasks) throw new Error("缺少定时任务宿主接口");
    if (!await (host.window.claimScheduledTasks?.() ?? Promise.resolve(!host.isNative())))
      ownershipError = "定时任务已由另一个 AAW Desktop 窗口管理";
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    ownershipError = `无法初始化定时任务，请确认 Desktop 原生程序已更新并重启。${reason}`;
  }
  const scheduler = createScheduler({
    read: () => {
      if (ownershipError) throw new Error(ownershipError);
      if (host.isNative() && nativeConfigurationStatus.getState().error)
        throw new Error(`无法读取定时任务配置。${nativeConfigurationStatus.getState().error}`);
      const raw = host.storage.getItem(storageKey);
      if (!raw) return { tasks: [], runs: [] };
      const data = JSON.parse(raw) as TaskData;
      if (!Array.isArray(data.tasks) || !Array.isArray(data.runs)) throw new Error("定时任务记录损坏");
      project.sessions.excludeSessionsFromCatalog(data.runs.flatMap((run: TaskRun) => run.session ? [run.session] : []));
      return { ...data, tasks: data.tasks.map((task: TaskData["tasks"][number]) => ({ ...task, schedule: { ...task.schedule, timeZone: "local" } })) };
    },
    write: async (data) => {
      host.storage.setItem(storageKey, JSON.stringify(data));
      await flushNativeConfiguration();
      const error = nativeConfigurationStatus.getState().error;
      if (error) throw new Error(error);
    },
    eligible: () => account.state.getState().currentUser !== null && !host.exitGate.isExiting(),
    run: (task, observe) => project.sessions.runBackgroundPrompt(
      { workspacePath: task.project, agentId: task.agent, title: task.name, text: task.prompt, model: task.model, effort: task.effort },
      (session, waiting) => {
        project.sessions.excludeSessionsFromCatalog([session]);
        return observe({ session, status: waiting ? "waiting" : "running" });
      },
    ),
    notify: (task, run) => {
      if (!host.notifications.isAvailable()) return;
      void (async () => {
        if (!await host.notifications.ensurePermission() || disposed) return;
        await host.notifications.send({
          id: ++sequence,
          title: run.status === "success" ? "定时任务已完成" : "定时任务执行失败",
          body: task.name,
          extra: { scheduledTask: task.id, scheduledRun: run.id },
        });
      })().catch(() => {});
    },
  });
  const { dispose, ...service } = scheduler;
  ctx.provide("scheduledTasks", service);
  const openRun = async ({ session }: TaskRun) => {
    if (!session) return;
    if (workbench.navigationGuard.pending() && !await workbench.navigationGuard.confirm()) return;
    await project.sessions.openSessionFromEntry(session.workspacePath, session.sessionId, session.agentKey)
      .catch(async () => {
        const selected = agents.selectionKey(project.projects.workspace.getState().toolPaths);
        if (selected !== session.agentKey) throw new Error("请切换到运行此任务的 Agent，再打开会话");
        await project.sessions.openSessionFromEntry(session.workspacePath, session.sessionId);
      });
    workbench.navigation.getState().openSidebar(null);
  };
  ctx.effect(() => workbench.register("sidebar", {
    id: section,
    label: "定时任务",
    order: 20,
    Icon: ClockIcon,
    View: () => createElement(TaskSidebar, { scheduler }),
    WorkArea: () => createElement(TaskWorkspace, { scheduler, project, agents, openRun }),
  }));
  const setCloseToTray = host.window.setCloseToTray?.bind(host.window);
  if (setCloseToTray) {
    ctx.effect(() => workbench.register("settings", {
      id: "scheduled-tasks", order: 30, label: "定时任务", Icon: ClockIcon,
      View: function TraySettings() {
        const [enabled, setEnabled] = useState(closeToTray);
        const [saving, setSaving] = useState(false);
        const [error, setError] = useState("");
        const label = "关闭窗口时留在托盘";
        return createElement(SettingCard, { label: "系统托盘", children:
          createElement(SettingRow, {
            label,
            desc: "开启后，点击窗口右上角的 × 会收进系统托盘，定时任务继续运行。右键托盘图标可完全退出。",
            footer: error ? createElement("p", { role: "alert", className: "text-ui-caption text-danger-ink" }, error) : undefined,
            footerAlign: "start",
          }, createElement(ToggleSwitch, {
              appearance: "neutral", label, checked: enabled, disabled: saving,
              onChange: (value) => {
                setSaving(true);
                setError("");
                void setCloseToTray(value).then(async () => {
                  host.storage.setItem(trayKey, String(value));
                  await flushNativeConfiguration();
                  const writeError = nativeConfigurationStatus.getState().error;
                  if (writeError) {
                    host.storage.setItem(trayKey, String(closeToTray));
                    await setCloseToTray(closeToTray);
                    throw new Error(writeError);
                  }
                  closeToTray = value;
                  setEnabled(value);
                }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setSaving(false));
              },
          })),
        });
      },
    }));
    if (closeToTray) void setCloseToTray(true).catch(() => { closeToTray = false; });
  }
  ctx.effect(() => {
    const tick = () => { void scheduler.tick().catch(() => {}); };
    tick();
    const startBrowserTimer = () => {
      const timer = window.setInterval(tick, 5_000);
      return () => window.clearInterval(timer);
    };
    const timer = host.isNative() && host.window.listenForScheduledTasksTick
      ? host.window.listenForScheduledTasksTick(tick)
      : Promise.resolve(startBrowserTimer());
    void timer.catch(() => scheduler.store.setState({ error: "无法启动定时任务计时器" }));
    const registration = host.notifications.isAvailable()
      ? host.notifications.listen(({ actionId, extra }) => {
          const id = extra?.scheduledTask;
          if (actionId !== "tap" || typeof id !== "string") return;
          void host.window.showAndFocus().then(() => {
            if (disposed) return;
            scheduler.store.setState({ selected: id });
            workbench.navigation.getState().openSidebar(section);
            if (typeof extra?.scheduledRun === "string") {
              const runId = extra.scheduledRun;
              window.requestAnimationFrame(() => document.getElementById(`scheduled-run-${runId}`)?.scrollIntoView({ block: "nearest" }));
            }
          }).catch(() => {});
        })
      : undefined;
    void registration?.catch(() => {});
    return () => {
      disposed = true;
      void timer.then((stop) => stop()).catch(() => {});
      dispose();
      void registration?.then((unlisten) => unlisten()).catch(() => {});
    };
  }, "scheduledTasks:resources");
}
