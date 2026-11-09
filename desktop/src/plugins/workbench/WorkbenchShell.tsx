import { useWorkbenchUiValue } from "./layoutView.ts";
import { useContext, useEffect, useState, type ReactNode } from "react";
import { useWorkbenchEntries, WorkbenchContext } from "./react.ts";
import { ColumnResizer } from "../../shared/ui/controls/ColumnResizer.tsx";
import { SidebarToggle } from "./ui/SidebarToggle.tsx";
import { SidebarFooter } from "./ui/SidebarFooter.tsx";
import { UpdateEntry } from "./ui/UpdateEntry.tsx";
import {
  LEFT_WIDTH_VAR,
  LEFT_DEFAULT_PX,
  LEFT_MIN_PX,
} from "./ui/columnWidths.ts";

/**
 * 主体：项目树列（可整体隐藏）+ 内容区。
 * 功能页覆盖层激活时呈全屏语义：树列隐藏，内容区自身只渲染该页 +
 * 顶栏「← 返回」。
 */
export function WorkbenchShell({ children }: { readonly children: ReactNode }) {
  const Sidebar = useWorkbenchEntries("sidebar")[0]?.View;
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

  const hideSidebar = sidebarCollapsed || overlay !== null;
  return (
    <div
      className="grid h-full min-h-0"
      style={{
        // 展开态：栏间距由 ColumnResizer 自身（10px 热区）承担，不叠加
        // gap——可抓取面积与视觉分隔一致，看得见的线就是能拖的地方；
        // 收起态：树列整体隐藏（拖宽热区一并隐藏），内容区自动占满
        gridTemplateColumns: hideSidebar
          ? `0px 0px minmax(0, 1fr)`
          : `min(var(${LEFT_WIDTH_VAR}, ${LEFT_DEFAULT_PX}px), ${sidebarMaximum}px) auto minmax(0, 1fr)`,
      }}
    >
      <div
        hidden={hideSidebar}
        className="col-start-1 row-start-1 h-full min-h-0 overflow-hidden"
      >
        <aside
          aria-label="项目树"
          className="flex h-full min-h-0 flex-col overflow-hidden bg-sidebar"
        >
          <div
            className="@container/update-header flex h-12 shrink-0 items-center gap-1 px-2"
            data-tauri-drag-region=""
          >
            <SidebarToggle collapsed={false} />
            <div className="ml-auto flex shrink-0 items-center">
              <UpdateEntry />
            </div>
          </div>
          {Sidebar ? <Sidebar /> : <div className="flex-1" />}
          <SidebarFooter />
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
