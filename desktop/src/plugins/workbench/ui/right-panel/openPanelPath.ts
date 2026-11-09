import type { DocumentsService } from "../../../../contracts/documents.ts";

import { pathKey } from "../../../../shared/panelPaths.ts";
import type { WorkbenchLayout } from "../../../../contracts/workbench.ts";

/** 文件点击的项目在调用时捕获，异步 stat 完成后仍须匹配当前项目。 */
export async function openPanelPath(
  layout: WorkbenchLayout | undefined,
  documents: DocumentsService,
  project: string,
  path: string,
  line?: number,
): Promise<void> {
  if (!layout?.navigationGuard.isActive()) throw new Error("工作台尚未就绪");
  const entry = await documents.stat(path);
  if (
    !documents.isActive() ||
    !layout.navigationGuard.isActive() ||
    pathKey(layout.navigation.getState().contextPath ?? "") !== pathKey(project)
  )
    throw new Error("项目已切换，请在文件所属项目中重新打开");
  const panel = layout.panels.getState();
  if (entry.directory) panel.openDirectory(project, entry.path);
  else panel.openFile(project, entry.path, line);
}
