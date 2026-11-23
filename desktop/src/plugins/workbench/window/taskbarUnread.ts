import type { Logger } from "../../../shared/logging/logger.ts";
import type { WorkbenchService } from "../service.ts";
import type { WorkbenchSnapshot } from "../types.ts";

/** 复用导航入口的未读来源，合并同一次 Agent 切换引起的多次更新。 */
export function observeTaskbarUnread(
  workbench: Pick<WorkbenchService, "getSnapshot" | "subscribe">,
  write: (count: number) => Promise<void>,
  logger: Pick<Logger, "warn">,
): () => void {
  let entries: WorkbenchSnapshot["sidebar"] | undefined;
  let stopSources: (() => void)[] = [];
  let disposed = false;
  let scheduled = false;
  let desired = 0;
  let lastAttempt: number | undefined;
  let writing = false;

  async function publish() {
    if (writing || desired === lastAttempt) return;
    writing = true;
    lastAttempt = desired;
    try {
      await write(lastAttempt);
    } catch (error) {
      logger.warn("更新任务栏未读徽标失败", { error: String(error) });
    } finally {
      writing = false;
      if (desired !== lastAttempt) void publish();
    }
  }

  function schedule() {
    if (disposed || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (disposed) return;
      desired = entries?.reduce((sum, entry) => sum + (entry.unread?.getCount() ?? 0), 0) ?? 0;
      void publish();
    });
  }

  function refreshSources() {
    const sidebar = workbench.getSnapshot().sidebar;
    if (entries === sidebar) return;
    for (const stop of stopSources) stop();
    entries = sidebar;
    stopSources = sidebar.flatMap(({ unread }) => unread ? [unread.subscribe(schedule)] : []);
    schedule();
  }

  const stopWorkbench = workbench.subscribe(refreshSources);
  refreshSources();
  return () => {
    if (disposed) return;
    disposed = true;
    stopWorkbench();
    for (const stop of stopSources) stop();
    desired = 0;
    void publish();
  };
}
