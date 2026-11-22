import { SegmentedControl } from "../../../shared/ui/controls/SegmentedControl.tsx";
import { useWorkspaceValue } from "./bindings/workspaceView.ts";
import { useProject, useProjectNavigation } from "./bindings/projectView.tsx";
/**
 * 【+】弹出面板：树段头【+】与图标窄栏「新建会话」共用的落点，绝对定位
 * 小面板，点外部 / Esc 关闭。
 *
 * 两个 tab：
 * - 「新建会话」（默认）：列出已知项目（收藏 + 最近），点击任一项目 →
 *   关面板 → 直接在该项目里开始一条空对话（未连接先连接，见
 *   sessionStart）。AAW 入口向导不在这里强加：会话内想走 AAW 流程时
 *   从 AAW 面板拉起来。行尾只在项目**有连接状态**时显示徽标（未连接
 *   不渲染）。
 * - 「添加项目」：系统目录对话框，添加成功后关面板并选中新项目进总览
 *   （见 addProjectFlow；进项目只到总览，连接是总览里显式的一步）。
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

import { ActionButton } from "../../../shared/ui/controls.tsx";
import { NavigationRow } from "../../../shared/ui/NavigationRow.tsx";
import { SidebarItemTitle } from "../../../shared/ui/SidebarItemTitle.tsx";
import { basenameOf, formatLastOpened } from "../../../shared/workspaceText.ts";

type AddPanelTab = "new-session" | "add-project";

const ADD_PANEL_LABEL = "新建会话面板";

interface AddProjectPanelProps {
  /** 点外部 / Esc / 完成动作后的关闭回调。 */
  readonly onClose: () => void;
  /** 【+】触发按钮的 ref：外部点击判定把它排除在外，
   *  否则「点触发按钮收起」会先被 onClose 关掉再被 toggle 打开。 */
  readonly triggerRef: RefObject<HTMLElement | null>;
}

/** 已知项目（收藏 + 最近）的一行：名称 + 最近打开时间 + 连接徽标。 */
function KnownProjectRow({
  path,
  lastOpenedAt,
  onClose,
}: {
  readonly path: string;
  readonly lastOpenedAt: string | null;
  readonly onClose: () => void;
}) {
  const projectService = useProject();
  return (
    <li>
      <NavigationRow
        data-hint={path}
        onClick={() => {
          void projectService?.sessions.startNewSession(path);
          onClose();
        }}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <SidebarItemTitle>{basenameOf(path)}</SidebarItemTitle>
          {lastOpenedAt !== null && (
            <span className="truncate text-ui-caption text-ink-mute">
              {formatLastOpened(lastOpenedAt)}
            </span>
          )}
        </span>
      </NavigationRow>
    </li>
  );
}

export function AddProjectPanel({ onClose, triggerRef }: AddProjectPanelProps) {
  const projectNav = useProjectNavigation();
  const addProject = projectNav?.addProject;
  const addRemoteProject = projectNav?.addRemoteProject;
  const [tab, setTab] = useState<AddPanelTab>("new-session");
  const [isDialogUnavailable, setIsDialogUnavailable] = useState(false);
  const recentWorkspaces = useWorkspaceValue((state) => state.recentWorkspaces);
  const pinnedPaths = useWorkspaceValue((state) => state.pinnedPaths);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const active = document.activeElement;
    opener.current =
      active instanceof HTMLElement && active !== document.body
        ? active
        : triggerRef.current;
    containerRef.current
      ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?.focus({ preventScroll: true });
  }, [triggerRef]);

  // 点外部 / Esc 关闭（与顶栏待办下拉同一收口模式）；触发按钮不视为外部
  useEffect(() => {
    function isOutside(node: Node): boolean {
      const container = containerRef.current;
      if (container !== null && container.contains(node)) {
        return false;
      }
      const trigger = triggerRef.current;
      return trigger === null || !trigger.contains(node);
    }
    function handlePointerDown(event: PointerEvent): void {
      if (isOutside(event.target as Node)) {
        onClose();
      }
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        // preventDefault 标记 Esc 已被浮层消费（SessionView 的全局停止让位）
        event.preventDefault();
        if (containerRef.current?.contains(document.activeElement)) {
          const previous = opener.current;
          (previous?.isConnected ? previous : triggerRef.current)?.focus({
            preventScroll: true,
          });
        }
        onClose();
      }
    }
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, triggerRef]);

  const lastOpenedByPath = new Map(
    recentWorkspaces.map((entry) => [entry.path, entry.lastOpenedAt] as const),
  );
  const knownProjects = [
    ...pinnedPaths.map((path) => ({
      path,
      lastOpenedAt: lastOpenedByPath.get(path) ?? null,
    })),
    ...recentWorkspaces
      .filter((entry) => !pinnedPaths.includes(entry.path))
      .map((entry) => ({
        path: entry.path,
        lastOpenedAt: entry.lastOpenedAt,
      })),
  ];

  async function handleAddProject(): Promise<void> {
    const path = await addProject?.();
    if (path) {
      // 添加成功：addProjectFlow 已选中并进总览，这里收口关面板
      setIsDialogUnavailable(false);
      onClose();
      return;
    }
    // 取消与环境不支持都返回 null；提示用户重试或从列表选择
    setIsDialogUnavailable(true);
  }

  return (
    <div
      ref={containerRef}
      aria-label={ADD_PANEL_LABEL}
      className="absolute top-full right-0 left-0 z-40 mt-1 overflow-hidden rounded-lg border border-line-strong bg-surface shadow-floating"
    >
      <div className="border-b border-line px-2 py-1.5">
        <SegmentedControl
          tabs
          groupLabel="面板视图"
          value={tab}
          onChange={setTab}
          options={[
            { value: "new-session", label: "新建会话" },
            { value: "add-project", label: "添加项目" },
          ]}
        />
      </div>

      {tab === "new-session" ? (
        <div className="p-1.5">
          {knownProjects.length === 0 ? (
            <p className="px-2 py-3 text-center text-ui-xs text-ink-ghost">
              暂无已知项目；先在「添加项目」中选择目录。
            </p>
          ) : (
            <ul
              aria-label="选择项目开始新会话"
              className="flex flex-col gap-0.5"
            >
              {knownProjects.map((entry) => (
                <KnownProjectRow
                  key={entry.path}
                  path={entry.path}
                  lastOpenedAt={entry.lastOpenedAt}
                  onClose={onClose}
                />
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2 p-2">
          {/* 常规操作用 secondary 描边：添加项目是入口动作而非主操作 */}
          <ActionButton
            tone="secondary"
            type="button"
            onClick={() => void handleAddProject()}
            className="px-3 py-2 text-ui-sm"
          >
            添加项目…
          </ActionButton>
          {addRemoteProject && (
            <ActionButton
              tone="secondary"
              type="button"
              onClick={() => {
                onClose();
                addRemoteProject();
              }}
              className="px-3 py-2 text-ui-sm"
            >
              添加远程项目（SSH）…
            </ActionButton>
          )}
          {isDialogUnavailable && (
            <p className="text-ui-xs text-warn-ink">
              目录选择不可用或已取消；可重试，或从「新建会话」列表选择已有项目。
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default AddProjectPanel;
