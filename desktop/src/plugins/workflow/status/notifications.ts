import type { HostNotifications, HostStorage, DesktopWindowHost } from "../../host/types.ts";
import type { WorkbenchService } from "../../workbench/service.ts";
import { projectOverviewPageId } from "../../project/service.ts";
import { pathKey } from "../../../shared/panelPaths.ts";
import type { WorkflowEvent } from "../engine/protocol.ts";
import { deriveCanvasSnapshot } from "./snapshot.ts";

interface NotificationDeps {
  readonly client: {
    subscribe(listener: (event: WorkflowEvent) => void): () => void;
    request(method: string, params: Record<string, unknown>): Promise<unknown>;
  };
  readonly notifications: HostNotifications;
  readonly window: Pick<DesktopWindowHost, "isFocused" | "showAndFocus">;
  readonly storage: HostStorage;
  readonly openRun: (project: string, runId: string) => void;
  readonly openSession: (project: string, sessionId: string) => Promise<void>;
  readonly warn: (message: string) => void;
}

type Notice = { kind: "reply" | "confirm" | "failed" | "completed"; site?: string; ordinal?: number };
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const storageKey = (runId: string) => `aaw-workflow/notification-state/${encodeURIComponent(runId)}`;
const noticeKey = (notice: Notice) => notice.kind === "reply" ? `reply:${notice.site}:${notice.ordinal}` : notice.kind;
/** 等你回复按节点各一条；确认、失败、完成按运行共用一条，新的替换旧的。 */
const noticeTag = (runId: string, notice: Notice) =>
  notice.kind === "reply" ? `workflow:${runId}:${noticeKey(notice)}` : `workflow:${runId}:run`;

/** 导航守卫允许切换后，才在目标项目打开运行。 */
export function openRunFromNotification(
  workbench: Pick<WorkbenchService, "navigation" | "navigationGuard">,
  openRun: (project: string, runId: string) => void,
  project: string,
  runId: string,
): void {
  const open = () => {
    workbench.navigation.getState().openView(projectOverviewPageId, project);
    if (pathKey(workbench.navigation.getState().contextPath ?? "") === pathKey(project)) openRun(project, runId);
  };
  if (workbench.navigationGuard.guard(open)) open();
}

/** 监听全应用引擎事件；工作流不依赖当前打开的项目或面板。 */
export function attachWorkflowNotifications(deps: NotificationDeps): () => Promise<void> {
  if (!deps.notifications.isAvailable()) return () => Promise.resolve();
  let disposed = false;
  let sequence = 1_000_000_000 + Math.floor(Math.random() * 100_000_000);
  const pending = new Map<string, number>();
  const state = new Map<string, Set<string>>();
  const states = (runId: string): Set<string> => {
    let seen = state.get(runId);
    if (!seen) {
      try {
        const stored: unknown = JSON.parse(deps.storage.getItem(storageKey(runId)) ?? "[]");
        seen = new Set(Array.isArray(stored) ? stored.filter((v): v is string => typeof v === "string") : []);
      } catch { seen = new Set(); }
      state.set(runId, seen);
    }
    return seen;
  };
  const save = (runId: string) => {
    try { deps.storage.setItem(storageKey(runId), JSON.stringify([...states(runId)])); }
    catch { /* 不让通知存储影响工作流。 */ }
  };
  const ready = deps.notifications.listen(({ actionId, extra }) => {
    if (disposed || actionId !== "tap" || extra?.source !== "workflow" ||
      typeof extra.project !== "string" || typeof extra.runId !== "string") return;
    const { project, runId } = extra;
    const sessionId = typeof extra.sessionId === "string" ? extra.sessionId : "";
    void (async () => {
      // 点击可能来自通知中心里的旧通知，也可能是外部打开的链接：先由引擎确认运行属于该项目。
      const snapshot = deriveCanvasSnapshot(await deps.client.request("snapshot", { cwd: project, runId }));
      if (disposed || !snapshot.run) return;
      await deps.window.showAndFocus();
      if (disposed) return;
      if (extra.kind === "reply" && sessionId) await deps.openSession(project, sessionId);
      else deps.openRun(project, runId);
    })().catch(() => deps.warn("无法打开工作流通知对应的位置"));
  });
  void ready.catch(() => deps.warn("系统通知监听不可用"));

  const notify = (project: string, runId: string, notice: Notice): void => {
    const key = noticeKey(notice);
    const seen = states(runId);
    if (seen.has(key)) return;
    seen.add(key);
    save(runId);
    const tokenKey = `${runId}\0${key}`;
    const token = (pending.get(tokenKey) ?? 0) + 1;
    pending.set(tokenKey, token);
    void (async () => {
      await ready;
      if (disposed || await deps.window.isFocused()) return;
      if (!await deps.notifications.ensurePermission() || disposed || await deps.window.isFocused()) return;
      const raw = await deps.client.request("snapshot", { cwd: project, runId });
      if (disposed || pending.get(tokenKey) !== token) return;
      const snapshot = deriveCanvasSnapshot(raw);
      if (!snapshot.run) return;
      let sessionId = "";
      if (notice.kind === "reply") {
        const node = snapshot.nodes.find((item) => item.siteId === notice.site && item.ordinal === notice.ordinal && item.awaitingInput && item.mark === undefined);
        if (!node || !snapshot.active) return;
        sessionId = snapshot.actors.find((actor) => actor.siteId === node.actorSiteId)?.sessionId ?? "";
        if (!sessionId) return;
      } else if (notice.kind === "confirm" && snapshot.run.status !== "waiting") return;
      else if (notice.kind === "completed" && snapshot.run.status !== "completed") return;
      else if (notice.kind === "failed" && (snapshot.active || (snapshot.run.status !== "failed" && !snapshot.run.failure))) return;
      if (disposed || pending.get(tokenKey) !== token || await deps.window.isFocused()) return;
      const title = notice.kind === "reply" ? "工作流等你回复" : notice.kind === "confirm" ? "工作流等你确认" : notice.kind === "failed" ? "工作流运行失败" : "工作流运行完成";
      await deps.notifications.send({ id: ++sequence, tag: noticeTag(runId, notice), title, body: `${snapshot.run.title || snapshot.run.name || "工作流"} · 点击查看`, extra: { source: "workflow", kind: notice.kind, project, runId, ...(sessionId ? { sessionId } : {}) } });
    })().catch(() => deps.warn("工作流系统通知不可用"));
  };

  const remove = (runId: string, notice: Notice) => {
    void deps.notifications.remove(noticeTag(runId, notice)).catch(() => deps.warn("系统通知删除失败"));
  };

  const unsubscribe = deps.client.subscribe((event) => {
    if (disposed || typeof event.runId !== "string" || !event.runId || typeof event.project !== "string" || !event.project) return;
    const { runId, project } = event as WorkflowEvent & { project: string };
    if (event.type === "run-starting") {
      const seen = states(runId);
      for (const key of ["confirm", "failed", "completed"]) seen.delete(key);
      save(runId);
      // 运行重新开始：之前的确认、失败提醒已经过时。
      remove(runId, { kind: "confirm" });
      return;
    }
    if (event.type === "engine-event") {
      const action = record(event.event);
      if (typeof action?.siteId !== "string" || typeof action.ordinal !== "number") return;
      const notice: Notice = { kind: "reply", site: action.siteId, ordinal: action.ordinal };
      if (action.status === "input_round_completed") {
        const key = noticeKey(notice);
        states(runId).delete(key);
        pending.delete(`${runId}\0${key}`);
        save(runId);
        remove(runId, notice);
      } else if (action.status === "awaiting_input") notify(project, runId, notice);
      return;
    }
    if (event.type === "run-error") { if (event.cancelled !== true) notify(project, runId, { kind: "failed" }); return; }
    if (event.type === "run-settled") {
      void deps.client.request("snapshot", { cwd: project, runId }).then((raw) => {
        if (disposed) return;
        const status = deriveCanvasSnapshot(raw).run?.status;
        if (status === "waiting") notify(project, runId, { kind: "confirm" });
        else if (status === "failed") notify(project, runId, { kind: "failed" });
        else if (status === "completed") notify(project, runId, { kind: "completed" });
      }).catch(() => deps.warn("无法读取工作流通知状态"));
    }
  });
  return async () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    const release = await ready.catch(() => undefined);
    await release?.();
  };
}
