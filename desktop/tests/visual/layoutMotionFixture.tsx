import { createRoot } from "react-dom/client";
import { createGitWorkbench } from "../helpers/gitWorkbench.tsx";
import { WorkbenchShell } from "../../src/plugins/workbench/ui/WorkbenchShell.tsx";
import { PanelWorkspace } from "../../src/plugins/workbench/ui/right-panel/RightPanel.tsx";
import { FullViewHost } from "../../src/plugins/workbench/ui/right-panel/FullViewHost.tsx";
import { SessionStatusOverlay } from "../../src/plugins/project/conversation/ui/SessionStatusOverlay.tsx";
import { documentTab } from "../../src/plugins/documents/ui/documentTabs.tsx";
import { panelService } from "../../src/plugins/host/filesystem/panelService.ts";
import SettingsPage from "../../src/plugins/workbench/ui/SettingsPage.tsx";
import { workbenchSettings } from "../../src/plugins/workbench/ui/settingsContributions.tsx";
import { useWorkbenchUiValue } from "../../src/plugins/workbench/ui/bindings/layoutView.ts";
import "../../src/shared/styles/index.css";

const project = "D:/layout-motion";
const directory = `${project}/docs`;
const markdown = "# 文件视图示例\n\nAlpha alpha alpha\n\n## 第一节\n\n### 小节\n\n## 第二节";
const { Wrapper, workbench } = createGitWorkbench();
for (const settings of workbenchSettings) workbench.register("settings", settings);
panelService.directory = (path) => Promise.resolve({
  entries: [{ path: `${path}/README.md`, name: "README.md", directory: false, symlink: false }],
  truncated: false,
});
panelService.preview = () => Promise.resolve({
  kind: "text",
  content: markdown,
  bytes: new TextEncoder().encode(markdown).length,
  mime: "text/plain",
});
panelService.watch = () => Promise.resolve(() => {});
const gitState = { loading: true };
const queryGit = () => ({
  getSnapshot: () => gitState,
  subscribe: () => () => {},
  refresh: () => Promise.resolve(),
  invalidate: () => {},
});

export function SettingsOverlay() {
  const overlay = useWorkbenchUiValue((state) => state.overlay);
  return overlay === "settings" ? <SettingsPage /> : null;
}

createRoot(document.getElementById("root")!).render(
  <Wrapper>
    <div className="h-screen">
      <WorkbenchShell>
        <div className="flex gap-2">
          <button onClick={() => workbench.navigation.getState().toggleSidebarCollapsed()}>切换项目栏</button>
          <button onClick={() => workbench.panels.getState().tool(project, "files")}>打开文件栏</button>
          <button onClick={() => workbench.panels.getState().openTab(project, documentTab(directory, true))}>打开目录标签</button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <PanelWorkspace project={project} enabled>
            <FullViewHost project={project}>
              <div className="flex h-full flex-col">
                <SessionStatusOverlay project={project} queryGit={queryGit} enabled>
                  <p>对话消息</p>
                </SessionStatusOverlay>
                <div data-composer-dock=""><textarea aria-label="草稿" data-composer="" defaultValue="保留草稿" /></div>
              </div>
            </FullViewHost>
          </PanelWorkspace>
        </div>
      </WorkbenchShell>
    </div>
    <SettingsOverlay />
  </Wrapper>,
);
