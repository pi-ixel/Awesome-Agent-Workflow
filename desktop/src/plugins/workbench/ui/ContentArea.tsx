import { useWorkbenchUiValue } from "./bindings/layoutView.ts";
/**
 * 内容区根据页面注册渲染标题、基底视图和覆盖层。
 * 基底视图留在 PanelWorkspace 中，开合右栏时保留视图节点。
 */
import { ContextBar } from "./ContextBar.tsx";
import { PanelWorkspace } from "./right-panel/RightPanel.tsx";
import { FullViewHost } from "./right-panel/FullViewHost.tsx";

import { useWorkbenchEntries } from "./bindings/react.ts";
import { useWorkbenchBasePage } from "./bindings/pages.ts";

/** 内容区视图分支（无 tab UI，纯状态驱动）。 */
function ContentArea() {
  const basePage = useWorkbenchBasePage();
  const overlay = useWorkbenchUiValue((state) => state.overlay);
  const contextPath = useWorkbenchUiValue((state) => state.contextPath);
  const openDock = useWorkbenchUiValue((state) => state.openDock);
  const closeDock = useWorkbenchUiValue((state) => state.closeDock);
  const pages = useWorkbenchEntries("pages");
  const sidebarId = useWorkbenchUiValue((state) => state.sidebarId);
  const WorkArea = useWorkbenchEntries("sidebar").find((entry) => entry.id === sidebarId)?.WorkArea;
  const docks = useWorkbenchEntries("docks");
  const Page = basePage?.View;
  const Overlay = pages.find((entry) => entry.id === overlay)?.View;
  const workspaceVisible = overlay === null || overlay === "settings";
  const page = Page ? <Page project={contextPath} /> : null;

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-base">
      <ContextBar />
      <div
        hidden={!workspaceVisible || WorkArea !== undefined}
        className="min-h-0 flex-1 overflow-hidden"
      >
        <PanelWorkspace project={contextPath} enabled={workspaceVisible && WorkArea === undefined}>
          {basePage?.fullView ? (
            <FullViewHost project={contextPath}>{page}</FullViewHost>
          ) : (
            page
          )}
        </PanelWorkspace>
      </div>
      {WorkArea && workspaceVisible && (
        <div className="min-h-0 flex-1 overflow-auto"><WorkArea project={contextPath} /></div>
      )}
      {/* 底部面板常驻挂载，插件根据 visible 控制展示。 */}
      {docks.map(({ id, View }) => (
        <View
          key={id}
          project={contextPath}
          visible={workspaceVisible && WorkArea === undefined && openDock === id}
          close={() => closeDock(id)}
        />
      ))}
      {Overlay &&
        (overlay === "settings" ? (
          <Overlay project={contextPath} />
        ) : (
          <div className="min-h-0 flex-1 overflow-hidden">
            <Overlay project={contextPath} />
          </div>
        ))}
    </div>
  );
}

export default ContentArea;
