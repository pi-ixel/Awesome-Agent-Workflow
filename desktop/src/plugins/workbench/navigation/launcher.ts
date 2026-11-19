import type { WorkbenchService } from "../service.ts";

/** Resolve a trusted launcher route against the live contribution registry. */
export async function openLauncherPanel(workbench: WorkbenchService, target: string): Promise<void> {
  const entry = workbench.getSnapshot().panels.find((panel) => panel.id === target && panel.launcher);
  if (!entry) throw new Error("此功能当前不可用。");
  if (workbench.navigationGuard.pending()) throw new Error("请先处理主窗口中尚未完成的操作。");
  const project = entry.launcher?.prepareGlobalOpen
    ? await entry.launcher.prepareGlobalOpen() : workbench.navigation.getState().contextPath;
  if (!project) return;
  if (!workbench.getSnapshot().panels.includes(entry) || !workbench.navigationGuard.isActive()) return;
  const navigation = workbench.navigation.getState();
  if (navigation.contextPath !== project) return;
  navigation.closeOverlay();
  if (entry.launcher?.open) entry.launcher.open(project);
  else workbench.panels.getState().openTab(project, { id: target, kind: target });
}
