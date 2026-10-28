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
import { useEffect, useRef, useState, type RefObject } from "react";

import { useWorkspaceStore } from "../../stores/workspaceStore.ts";
import { useWorkbenchUiStore } from "../../stores/workbenchUiStore.ts";
import {
  btnSecondary,
  tabActiveClass,
  tabInactiveClass,
} from "../controls.tsx";
import { basenameOf, formatLastOpened } from "../workspaces/workspaceText.ts";
import { addProjectViaDialog } from "./addProjectFlow.ts";
import { startNewSession } from "./sessionStart.ts";
import { ConnectionBadge } from "./ConnectionBadge.tsx";

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
}: {
  readonly path: string;
  readonly lastOpenedAt: string | null;
}) {
  const onClose = useWorkbenchUiStore((state) => state.closeAddPanel);

  return (
    <li>
      <button
        type="button"
        title={path}
        onClick={() => {
          void startNewSession(path);
          onClose();
        }}
        className="flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left transition-colors hover:border-line hover:bg-raised/60"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-ink">
            {basenameOf(path)}
          </span>
          {lastOpenedAt !== null && (
            <span className="block truncate text-xs text-ink-ghost">
              {formatLastOpened(lastOpenedAt)}
            </span>
          )}
        </span>
        <ConnectionBadge path={path} />
      </button>
    </li>
  );
}

export function AddProjectPanel({ onClose, triggerRef }: AddProjectPanelProps) {
  const [tab, setTab] = useState<AddPanelTab>("new-session");
  const [isDialogUnavailable, setIsDialogUnavailable] = useState(false);
  const recentWorkspaces = useWorkspaceStore((state) => state.recentWorkspaces);
  const favoritePaths = useWorkspaceStore((state) => state.favoritePaths);
  const containerRef = useRef<HTMLDivElement | null>(null);

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
    ...favoritePaths.map((path) => ({
      path,
      lastOpenedAt: lastOpenedByPath.get(path) ?? null,
    })),
    ...recentWorkspaces
      .filter((entry) => !favoritePaths.includes(entry.path))
      .map((entry) => ({
        path: entry.path,
        lastOpenedAt: entry.lastOpenedAt,
      })),
  ];

  async function handleAddProject(): Promise<void> {
    const path = await addProjectViaDialog();
    if (path !== null) {
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
      className="absolute top-full right-0 left-0 z-40 mt-1 overflow-hidden rounded-lg border border-line-strong bg-surface shadow-xl"
    >
      <div
        role="tablist"
        aria-label="面板视图"
        className="flex gap-1 border-b border-line px-2 py-1.5"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "new-session"}
          onClick={() => {
            setTab("new-session");
          }}
          className={`rounded-md px-2.5 py-1 text-sm transition-colors ${
            tab === "new-session" ? tabActiveClass : tabInactiveClass
          }`}
        >
          新建会话
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "add-project"}
          onClick={() => {
            setTab("add-project");
          }}
          className={`rounded-md px-2.5 py-1 text-sm transition-colors ${
            tab === "add-project" ? tabActiveClass : tabInactiveClass
          }`}
        >
          添加项目
        </button>
      </div>

      {tab === "new-session" ? (
        <div className="p-1.5">
          {knownProjects.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-ink-ghost">
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
                />
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2 p-2">
          {/* 常规操作用 secondary 描边：添加项目是入口动作而非主操作 */}
          <button
            type="button"
            onClick={() => void handleAddProject()}
            className={`${btnSecondary} px-3 py-2 text-sm`}
          >
            添加项目…
          </button>
          {isDialogUnavailable && (
            <p className="text-xs text-warn-ink">
              目录选择不可用或已取消；可重试，或从「新建会话」列表选择已有项目。
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default AddProjectPanel;
