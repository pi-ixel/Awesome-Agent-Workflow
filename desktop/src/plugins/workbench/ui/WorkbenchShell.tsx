import { useWorkbenchUiValue } from "./bindings/layoutView.ts";
import { useContext, useEffect, useState, type ReactNode } from "react";
import { useWorkbenchEntries, WorkbenchContext } from "./bindings/react.ts";
import { useLayoutMotion } from "../../../shared/ui/controls/useLayoutMotion.ts";
import { ColumnResizer } from "../../../shared/ui/controls/ColumnResizer.tsx";
import { SidebarToggle } from "./SidebarToggle.tsx";
import { SidebarFooter } from "./SidebarFooter.tsx";
import { HeaderIndicators } from "./HeaderIndicators.tsx";
import {
  LEFT_WIDTH_VAR,
  LEFT_DEFAULT_PX,
  LEFT_MIN_PX,
} from "./columnWidths.ts";

/**
 * 主体：项目树列（可整体隐藏）+ 内容区。
 * 设置以模态覆盖工作区，其余功能页继续使用全屏覆盖语义。
 */
export function WorkbenchShell({ children }: { readonly children: ReactNode }) {
  const sidebar = useWorkbenchEntries("sidebar")[0];
  const Sidebar = sidebar?.View;
  const Footer = useWorkbenchEntries("sidebarFooters")[0]?.View;
  const overlays = useWorkbenchEntries("overlays");
  const saveWidth = useContext(WorkbenchContext)?.saveSidebarWidth;
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const resize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const sidebarMaximum = Math.max(LEFT_MIN_PX, viewportWidth * 0.5);
  const sidebarCollapsed = useWorkbenchUiValue(
    (state) => state.sidebarCollapsed,
  );
  const overlay = useWorkbenchUiValue((state) => state.overlay);

  const hideSidebar =
    sidebarCollapsed || (overlay !== null && overlay !== "settings");
  const moving = useLayoutMotion(sidebarCollapsed, {
    enabled: overlay === null || overlay === "settings",
    // Keep the marker while dependent status-card transitions finish.
    duration: 400,
  });
  const sidebarWidth = `min(var(${LEFT_WIDTH_VAR}, ${LEFT_DEFAULT_PX}px), ${sidebarMaximum}px)`;
  return (
    <div
      data-layout-moving={moving || undefined}
      className="grid h-full min-h-0 data-[layout-moving=true]:motion-safe:transition-[grid-template-columns] data-[layout-moving=true]:duration-200 data-[layout-moving=true]:ease-out"
      style={{
        // 展开态：栏间距由 ColumnResizer 自身（10px 热区）承担，不叠加
        // gap——可抓取面积与视觉分隔一致，看得见的线就是能拖的地方；
        // 收起态：树列整体隐藏（拖宽热区一并隐藏），内容区自动占满
        gridTemplateColumns: hideSidebar
          ? `0px 0px minmax(0, 1fr)`
          : `${sidebarWidth} 4px minmax(0, 1fr)`,
      }}
    >
      <div
        hidden={hideSidebar && !moving}
        inert={hideSidebar}
        className="col-start-1 row-start-1 h-full min-h-0 overflow-hidden"
      >
        <aside
          aria-label={sidebar?.label ?? "侧边栏"}
          style={{ width: sidebarWidth }}
          className="flex h-full min-h-0 flex-col overflow-hidden bg-sidebar"
        >
          <div
            className="@container/sidebar-header flex h-12 shrink-0 items-center gap-1 px-2"
            data-tauri-drag-region=""
          >
            <SidebarToggle collapsed={false} />
            <div className="order-1 ml-auto flex shrink-0 items-center">
              <HeaderIndicators />
            </div>
          </div>
          {Sidebar ? <Sidebar /> : <div className="flex-1" />}
          {overlays.map(
            ({ id, scope, View }) => scope === "sidebar" && <View key={id} />,
          )}
          {Footer ? <Footer Footer={SidebarFooter} /> : <SidebarFooter />}
        </aside>
      </div>
      <div hidden={hideSidebar} className="col-start-2 row-start-1 h-full">
        <ColumnResizer
          cssVarName={LEFT_WIDTH_VAR}
          onCommitWidth={saveWidth}
          defaultWidthPx={LEFT_DEFAULT_PX}
          minPx={LEFT_MIN_PX}
          maxPx={sidebarMaximum}
          growDirection="end"
          label="调整左栏宽度"
        />
      </div>
      <main
        style={{ gridColumn: 3, gridRow: 1 }}
        className="flex min-h-0 min-w-0 flex-col"
      >
        {children}
      </main>
    </div>
  );
}
