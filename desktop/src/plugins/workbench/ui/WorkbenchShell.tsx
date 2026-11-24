import { useWorkbenchUiValue } from "./bindings/layoutView.ts";
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useWorkbenchEntries, WorkbenchContext } from "./bindings/react.ts";
import { useLayoutMotion } from "../../../shared/ui/controls/useLayoutMotion.ts";
import { ColumnResizer } from "../../../shared/ui/controls/ColumnResizer.tsx";
import { EdgeDrawer } from "../../../shared/ui/controls/EdgeDrawer.tsx";
import { SidebarToggle } from "./SidebarToggle.tsx";
import { SidebarFooter } from "./SidebarFooter.tsx";
import { HeaderIndicators } from "./HeaderIndicators.tsx";
import { ActivityRail } from "./ActivityRail.tsx";
import {
  LEFT_WIDTH_VAR,
  LEFT_DEFAULT_PX,
  LEFT_MIN_PX,
} from "./columnWidths.ts";

const activityRailWidth = "2.75rem";
const fullBrandName = "Awesome Agent WorkSpace";
const fullWordmarkClass = "font-brand text-sm font-normal italic";

function SidebarWordmark() {
  const slot = useRef<HTMLSpanElement>(null);
  const measurement = useRef<HTMLSpanElement>(null);
  const [hasRoom, setHasRoom] = useState(false);

  useLayoutEffect(() => {
    const container = slot.current;
    const text = measurement.current;
    if (!container || !text) return;
    const measure = () => {
      setHasRoom(
        text.getBoundingClientRect().width <=
          container.getBoundingClientRect().width,
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(text);
    return () => observer.disconnect();
  }, []);

  return (
    <span
      ref={slot}
      className="relative min-w-0 flex-1 overflow-hidden whitespace-nowrap"
    >
      <span
        ref={measurement}
        aria-hidden="true"
        className={`pointer-events-none invisible absolute w-max ${fullWordmarkClass}`}
      >
        {fullBrandName}
      </span>
      <span
        data-testid="workbench-wordmark"
        data-hint={hasRoom ? undefined : fullBrandName}
        className={hasRoom ? fullWordmarkClass : "text-sm font-semibold"}
      >
        {hasRoom ? fullBrandName : "AAW"}
      </span>
    </span>
  );
}

/**
 * 主体：项目树列（可整体隐藏）+ 内容区。
 * 设置以模态覆盖工作区，其余功能页继续使用全屏覆盖语义。
 */
export function WorkbenchShell({ children }: { readonly children: ReactNode }) {
  const sidebars = [...useWorkbenchEntries("sidebar")].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0),
  );
  const sidebarId = useWorkbenchUiValue((state) => state.sidebarId);
  const project = useWorkbenchUiValue((state) => state.contextPath);
  const sidebar = sidebars.find((entry) => entry.id === sidebarId)
    ?? sidebars.find((entry) => entry.default)
    ?? sidebars[0];
  const Footer = useWorkbenchEntries("sidebarFooters")[0]?.View;
  const railActions = useWorkbenchEntries("activityRailActions");
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
          ? `${activityRailWidth} 0px 0px minmax(0, 1fr)`
          : `${activityRailWidth} ${sidebarWidth} 4px minmax(0, 1fr)`,
      }}
    >
      <ActivityRail
        entries={sidebars}
        selected={sidebar?.id}
        expanded={!hideSidebar}
        actions={railActions.map(({ id, View }) => <View key={id} />)}
        account={Footer ? <Footer Footer={SidebarFooter} /> : <SidebarFooter />}
      />
      <div id="workbench-sidebar" className="relative col-span-2 col-start-1 row-start-1 h-full min-h-0 overflow-hidden bg-sidebar">
        <EdgeDrawer
          side="left"
          open={!hideSidebar}
          visible={!hideSidebar || moving}
          sliding={moving}
          aria-label={sidebar?.panelLabel ?? sidebar?.label ?? "侧边栏"}
          style={{ width: `calc(${activityRailWidth} + ${sidebarWidth})` }}
          className="h-full min-h-0 flex-col overflow-hidden bg-sidebar"
        >
          <div
            className="@container/sidebar-header flex h-12 shrink-0 items-center gap-1 pr-2"
            style={{ paddingInlineStart: `calc(${activityRailWidth} + 0.875rem)` }}
            data-tauri-drag-region=""
          >
            <SidebarWordmark />
            <SidebarToggle collapsed={false} />
            <div className="order-1 ml-auto flex shrink-0 items-center">
              <HeaderIndicators />
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col" style={{ marginInlineStart: activityRailWidth }}>
            {sidebars.map(({ id, View, keepMounted }) => {
              const selected = id === sidebar?.id;
              return selected || keepMounted ? (
                <div key={id} hidden={!selected} className={selected ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
                  <View project={project} />
                </div>
              ) : null;
            })}
            {!sidebar && <div className="flex-1" />}
            {overlays.map(
              ({ id, scope, View }) => scope === "sidebar" && <View key={id} />,
            )}
          </div>
        </EdgeDrawer>
      </div>
      <div aria-hidden="true" className="pointer-events-none relative z-20 col-span-2 col-start-1 row-start-1 min-w-0">
        <span data-testid="sidebar-header-seam" className="absolute top-12 right-0 h-px bg-border/50" style={{ left: activityRailWidth }} />
      </div>
      <div hidden={hideSidebar} className="col-start-3 row-start-1 h-full">
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
        style={{ gridColumn: 4, gridRow: 1 }}
        className="flex min-h-0 min-w-0 flex-col"
      >
        {children}
      </main>
    </div>
  );
}
