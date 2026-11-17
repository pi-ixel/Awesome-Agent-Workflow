import { createRoot } from "react-dom/client";
import { createGitWorkbench } from "../helpers/gitWorkbench.tsx";
import { WorkbenchShell } from "../../src/plugins/workbench/ui/WorkbenchShell.tsx";
import { PanelWorkspace } from "../../src/plugins/workbench/ui/right-panel/RightPanel.tsx";
import { FullViewHost } from "../../src/plugins/workbench/ui/right-panel/FullViewHost.tsx";
import { SessionStatusOverlay } from "../../src/plugins/project/conversation/ui/SessionStatusOverlay.tsx";
import "../../src/shared/styles/index.css";

const project = "D:/layout-motion";
const { Wrapper, workbench } = createGitWorkbench();
const gitState = { loading: true };
const queryGit = () => ({
  getSnapshot: () => gitState,
  subscribe: () => () => {},
  refresh: () => Promise.resolve(),
  invalidate: () => {},
});

createRoot(document.getElementById("root")!).render(
  <Wrapper>
    <div className="h-screen">
      <WorkbenchShell>
        <div className="flex gap-2">
          <button onClick={() => workbench.navigation.getState().toggleSidebarCollapsed()}>切换项目栏</button>
          <button onClick={() => workbench.panels.getState().tool(project, "files")}>打开文件栏</button>
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
  </Wrapper>,
);
