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
  const docks = useWorkbenchEntries("docks");
  const Page = basePage?.View;
  const Overlay = pages.find((entry) => entry.id === overlay)?.View;
  const page = Page ? <Page project={contextPath} /> : null;

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-base">
      <div
        className={
          overlay === "settings"
            ? "absolute left-64 right-1 top-1 z-10 max-[880px]:left-52"
            : undefined
        }
      >
        <ContextBar />
      </div>
      <div hidden={overlay !== null} className="min-h-0 flex-1 overflow-hidden">
        <PanelWorkspace project={contextPath} enabled={overlay === null}>
          {basePage?.fullView ? (
            <FullViewHost project={contextPath}>{page}</FullViewHost>
          ) : page}
        </PanelWorkspace>
      </div>
      {/* 底部面板常驻挂载，插件根据 visible 控制展示。 */}
      {docks.map(({ id, View }) => (
        <View
          key={id}
          project={contextPath}
          visible={overlay === null && openDock === id}
          close={() => closeDock(id)}
        />
      ))}
      {Overlay && (
        <div className="min-h-0 flex-1 overflow-hidden">
          <Overlay project={contextPath} />
        </div>
      )}
    </div>
  );
}

export default ContentArea;
