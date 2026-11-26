import { useEffect, useRef, useState, type RefObject } from "react";
import { SegmentedControl } from "../../../shared/ui/controls/SegmentedControl.tsx";
import { ActionButton } from "../../../shared/ui/controls.tsx";
import { ModalShell } from "../../../shared/ui/ModalShell.tsx";
import { IconButton } from "../../../shared/ui/IconButton.tsx";
import { NavigationRow } from "../../../shared/ui/NavigationRow.tsx";
import { SidebarItemTitle } from "../../../shared/ui/SidebarItemTitle.tsx";
import { FolderGlyph, GlobeIcon, XIcon } from "../../../shared/ui/icons.tsx";
import { isRemoteProjectPath } from "../../../shared/panelPaths.ts";
import {
  formatLastOpened,
  formatWorkspacePathLabel,
} from "../../../shared/workspaceText.ts";
import { useProjectName, useWorkspaceValue } from "./bindings/workspaceView.ts";
import { useProject, useProjectNavigation } from "./bindings/projectView.tsx";

type AddPanelTab = "new-session" | "add-project";

const ADD_PANEL_LABEL = "新建会话面板";

interface AddProjectPanelProps {
  /** 点外部 / Esc / 完成动作后的关闭回调。 */
  readonly onClose: () => void;
  /** 保留兼容：原下拉触发按钮 ref（弹窗形态下由 ModalShell 统一管理焦点）。 */
  readonly triggerRef?: RefObject<HTMLElement | null>;
}

/** 已知项目（收藏 + 最近）的一行：图标 + 名称 + 最近打开时间。 */
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
  const remote = isRemoteProjectPath(path);
  const displayName = useProjectName(path);
  return (
    <li>
      <NavigationRow
        data-hint={formatWorkspacePathLabel(path)}
        onClick={() => {
          void projectService?.sessions.startNewSession(path);
          onClose();
        }}
        className="px-3 py-2"
      >
        {remote ? (
          <GlobeIcon className="ui-icon-16 shrink-0 text-ink-mute" />
        ) : (
          <FolderGlyph className="ui-icon-16 shrink-0 text-ink-mute" />
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <SidebarItemTitle>{displayName}</SidebarItemTitle>
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

/**
 * 左上角「新建会话」按钮弹窗：与「创建项目」弹窗保持一致的视觉样式。
 * 区分「在现有项目中新建会话」和「新建项目」。
 */
export function AddProjectPanel({ onClose }: AddProjectPanelProps) {
  const projectNav = useProjectNavigation();
  const addProject = projectNav?.addProject;
  const embeddedAddProjectNode = projectNav?.renderAddProjectForm?.(onClose) ?? null;
  const [tab, setTab] = useState<AddPanelTab>("new-session");
  const [isDialogUnavailable, setIsDialogUnavailable] = useState(false);
  const tabsContainerRef = useRef<HTMLDivElement | null>(null);
  const recentWorkspaces = useWorkspaceValue((state) => state.recentWorkspaces);
  const pinnedPaths = useWorkspaceValue((state) => state.pinnedPaths);

  useEffect(() => {
    tabsContainerRef.current
      ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?.focus({ preventScroll: true });
  }, []);

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
      setIsDialogUnavailable(false);
      onClose();
      return;
    }
    setIsDialogUnavailable(true);
  }

  return (
    <ModalShell onDismiss={onClose} label={ADD_PANEL_LABEL} size="default">
      {/* 顶部标题栏：与创建项目弹窗视觉一致 */}
      <div className="flex items-center justify-between px-5 pt-4 pb-3">
        <h2 className="text-ui-lg font-semibold text-ink">
          {tab === "new-session" ? "新建会话" : "新建项目"}
        </h2>
        <IconButton aria-label="关闭" onClick={onClose}>
          <XIcon className="ui-icon-16" />
        </IconButton>
      </div>

      {/* 主体内容 */}
      <div className="flex flex-col gap-4 px-5 pb-5">
        <div ref={tabsContainerRef}>
          <SegmentedControl
            tabs
            groupLabel="面板视图"
            value={tab}
            onChange={setTab}
            options={[
              { value: "new-session", label: "新建会话" },
              { value: "add-project", label: "新建项目" },
            ]}
          />
        </div>

        {tab === "new-session" ? (
          <div className="max-h-[320px] min-h-[168px] overflow-y-auto rounded-popover border border-line-strong bg-raised/30 p-1.5">
            {knownProjects.length === 0 ? (
              <div className="flex min-h-[156px] flex-col items-center justify-center gap-2 px-4 text-center">
                <p className="text-ui-sm text-ink-mute">
                  暂无已有项目，请先新建一个项目。
                </p>
                <ActionButton
                  tone="secondary"
                  type="button"
                  onClick={() => setTab("add-project")}
                  className="px-3.5 py-1.5 text-ui-xs"
                >
                  去新建项目
                </ActionButton>
              </div>
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
        ) : embeddedAddProjectNode !== null ? (
          embeddedAddProjectNode
        ) : (
          <div className="flex min-h-[168px] flex-col items-center justify-center gap-3 rounded-popover border border-line-strong bg-raised/30 px-5 py-6 text-center">
            <FolderGlyph className="ui-icon-20 text-ink-mute" />
            <ActionButton
              tone="primary"
              type="button"
              onClick={() => void handleAddProject()}
              className="inline-flex items-center gap-1.5 rounded-pill px-4 py-1.5 text-ui-sm"
            >
              <FolderGlyph className="ui-icon-14 shrink-0" />
              <span>选择本地文件夹…</span>
            </ActionButton>
            {isDialogUnavailable && (
              <p className="text-ui-xs text-warn-ink">
                目录选择不可用或已取消；可重试，或从「新建会话」列表选择已有项目。
              </p>
            )}
          </div>
        )}
      </div>
    </ModalShell>
  );
}

export default AddProjectPanel;
