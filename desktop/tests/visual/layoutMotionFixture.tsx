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
import { bindSecondaryWindowAppearance } from "../../src/plugins/workbench/appearance/windowAppearance.ts";
import { useWorkbenchUiValue } from "../../src/plugins/workbench/ui/bindings/layoutView.ts";
import "../../src/shared/styles/index.css";

const project = "D:/layout-motion";
const directory = `${project}/docs`;
const markdown = "# 文件视图示例\n\nAlpha alpha alpha\n\n## 第一节\n\n### 小节\n\n## 第二节";
const { Wrapper, workbench } = createGitWorkbench();
const params = new URLSearchParams(location.search);
if (params.has("appearance"))
  bindSecondaryWindowAppearance(document.documentElement);
if (params.has("draggable-tabs")) {
  for (const file of ["第一份.md", "第二份.md", "第三份.md"])
    workbench.panels.getState().openTab(project, documentTab(`${directory}/${file}`, false));
}
if (params.has("new-tab"))
  workbench.panels.getState().openNewTab(project);
if (params.has("overflow-tabs")) {
  for (let index = 1; index <= 12; index++) {
    const label = String(index).padStart(2, "0");
    workbench.panels.getState().openTab(
      project,
      documentTab(`${directory}/交接记录-${label}-桌面发布说明.md`, false),
    );
  }
}
for (const settings of workbenchSettings) workbench.register("settings", settings);
const deepPath = ["docs", "平台治理与升级说明", "客户端开发交接", "双主题外观验证", "其他演练记录"];
panelService.directory = (path) => {
  if (params.has("virtual-tree")) {
    if (path === project) {
      return Promise.resolve({
        entries: [{ path: directory, name: "docs", directory: true, symlink: false }],
        truncated: false,
      });
    }
    if (path === directory) {
      return Promise.resolve({
        entries: [
          { path: `${directory}/发布检查`, name: "发布检查", directory: true, symlink: false },
          { path: `${directory}/README.md`, name: "README.md", directory: false, symlink: false },
        ],
        truncated: false,
      });
    }
    return Promise.resolve({
      entries: Array.from({ length: 150 }, (_, index) => {
        const name = `发布检查项-${String(index + 1).padStart(3, "0")}.md`;
        return { path: `${path}/${name}`, name, directory: false, symlink: false };
      }),
      truncated: false,
    });
  }
  const depth = path === project ? 0 : path.slice(project.length + 1).split("/").length;
  const name = params.has("deep-path") ? deepPath[depth] : undefined;
  const sourceName = params.has("code-content") ? "release.ts" : "README.md";
  return Promise.resolve({
    entries: name ? [
      { path: `${path}/${name}`, name, directory: true, symlink: false },
      { path: `${path}/记录.txt`, name: "记录.txt", directory: false, symlink: false },
    ] : [{ path: `${path}/${sourceName}`, name: sourceName, directory: false, symlink: false }],
    truncated: false,
  });
};
panelService.preview = (path) => {
  const content = path.endsWith(".ts")
    ? 'const target = "release";\nconst fallback = "release";\nconst retry = 3;'
    : markdown;
  return Promise.resolve({
    kind: "text",
    content,
    bytes: new TextEncoder().encode(content).length,
    mime: "text/plain",
  });
};
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
