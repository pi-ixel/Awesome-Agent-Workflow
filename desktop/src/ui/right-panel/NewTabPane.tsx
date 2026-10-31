/**
 * 新标签页起始页（ZCode launcher 页 AnimatedSidePanePanel.tsx:851-917 +
 * SidePaneLauncherRow PluginUiLauncherItems.tsx:207-273 的 desktop 子集）：
 *
 * - 布局：顶部对齐滚动、左对齐标题；≥576px（容器查询随右栏宽而非视口）
 *   两列网格，列距 32px 行距 4px；
 * - 行：整行一个 button，尾部「打开」胶囊 aria-hidden 仅视觉
 *   （PluginUiLauncherItems.tsx:205 注释同款，避免按钮嵌套按钮）；
 * - 条目可用性对齐 animatedSidePanePanelModel.ts:11-43 的条件收敛模式：
 *   files / aaw 常显；git 仅在无 git tab 时显示；终端保持底部面板形态，
 *   已开时该行隐藏（不产生 tab、占位保留）。
 *   范围裁剪：浏览器 / 辅助对话 / 插件区（ZCode :872-913）不实现。
 */
import type { ComponentType } from "react";
import {
  useRightPanelStore,
  type PanelTool,
} from "../../stores/rightPanelStore.ts";
import { useWorkbenchUiStore } from "../../stores/workbenchUiStore.ts";
import {
  FileDiffIcon,
  SquareTerminalIcon,
  WorkflowIcon,
  type IconProps,
} from "../icons.tsx";
import { FolderOpenIcon } from "./file-tree/icons.tsx";
import { pathKey } from "../../core/panelPaths.ts";

interface NewTabEntry {
  readonly id: string;
  readonly icon: ComponentType<IconProps>;
  readonly label: string;
  readonly description: string;
  readonly visible: boolean;
  readonly onOpen: () => void;
}

export function NewTabPane({
  project,
}: {
  readonly project: string;
  /** 预留：起始页未来的文件快捷入口（当前四行均不消费）。 */
  readonly openPath?: (path: string, line?: number) => void;
}) {
  const panel = useRightPanelStore(
    (state) => state.projects[pathKey(project)] ?? undefined,
  );
  const isTerminalOpen = useWorkbenchUiStore(
    (state) => state.isTerminalOpen,
  );
  const tabs = panel?.tabs ?? [];
  const hasTab = (id: PanelTool): boolean =>
    tabs.some((tab) => tab.id === id);
  /** 已存在→仅激活（占位保留）；不存在→tool 上开（激活 tab 为占位时原位替换）。 */
  const openFromNewTab = (tool: PanelTool): void => {
    const store = useRightPanelStore.getState();
    if (hasTab(tool)) store.activate(project, tool);
    else store.tool(project, tool);
  };
  const entries: readonly NewTabEntry[] = [
    {
      id: "files",
      icon: FolderOpenIcon,
      label: "文件",
      description: "从目录中选择一个文件",
      visible: true,
      onOpen: () => openFromNewTab("files"),
    },
    {
      id: "aaw",
      icon: WorkflowIcon,
      label: "AAW 工作流",
      description: "查看进度与启动工作流",
      visible: true,
      onOpen: () => openFromNewTab("aaw"),
    },
    {
      id: "git",
      icon: FileDiffIcon,
      label: "审查",
      description: "审查工作区更改",
      visible: !hasTab("git"),
      onOpen: () => openFromNewTab("git"),
    },
    {
      id: "terminal",
      icon: SquareTerminalIcon,
      label: "终端",
      description: "在底部打开终端面板",
      visible: !isTerminalOpen,
      onOpen: () => useWorkbenchUiStore.getState().toggleTerminal(),
    },
  ];
  return (
    <div className="@container/new-tab flex h-full min-h-0 flex-col bg-base">
      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          <h2 className="pl-2 text-ui-xl font-semibold text-ink">新标签页</h2>
          <div className="grid min-w-0 grid-cols-1 gap-x-8 gap-y-1 @min-[36rem]/new-tab:grid-cols-2">
            {entries
              .filter((entry) => entry.visible)
              .map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  data-new-tab-item={entry.id}
                  className="flex w-full min-w-0 items-center gap-3 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/50"
                  onClick={entry.onOpen}
                >
                  <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-surface">
                    <entry.icon className="size-6 text-ink-subtle" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ui-base font-semibold text-ink">
                      {entry.label}
                    </span>
                    <span
                      className="mt-0.5 block truncate text-ui-sm text-ink-subtle"
                      title={entry.description}
                    >
                      {entry.description}
                    </span>
                  </span>
                  <span
                    aria-hidden="true"
                    className="flex h-6 shrink-0 items-center gap-1 rounded-full bg-raised px-2 text-ui-base leading-relaxed text-ink"
                  >
                    打开
                  </span>
                </button>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}
