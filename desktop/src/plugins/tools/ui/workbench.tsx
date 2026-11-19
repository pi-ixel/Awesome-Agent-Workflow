import type { Context } from "cordis";
import { useStore } from "zustand";
import { WrenchIcon } from "../../../shared/ui/icons.tsx";
import { pathKey } from "../../../shared/panelPaths.ts";
import type { PanelViewProps } from "../../workbench/types.ts";
import { ToolsPanel } from "./ToolsPanel.tsx";
import { ToolsPanelSurface } from "./surface.tsx";
import { ToolPreviewTab } from "./ToolPreviewTab.tsx";
import { createWorkshop } from "./workshop.ts";
import { prepareProjectLauncher } from "../../project/service.ts";

export const name = "tools-ui";
export const inject = ["tools", "workbench", "host", "project", "account", "configuration"];

/**
 * 工坊级设置（独立记录，整条独占）：目前只有自定义项目根目录。
 * projectsParent 是用户选的绝对路径；不存在/为空表示用默认位置。
 */
const workshopSettingsKey = "aaw-desktop.tools-workshop.v1";
const projectsParentField = "projectsParent";

/** 预览标签的 kind：`tool-preview:<目录>`，同一个项目只开一个标签。 */
const previewKind = "tool-preview";

export function previewTabId(dir: string): string {
  return `${previewKind}:${pathKey(dir)}`;
}

export function apply(ctx: Context): void {
  const { workbench, tools, host, project, account } = ctx;

  /**
   * 自定义项目根目录的持久化：读出来是合法路径才算设置过；写入 undefined
   * 会把字段从记录里清掉（JSON 序列化丢弃 undefined），回到默认位置。
   */
  const settingsScope = ctx.configuration.register(workshopSettingsKey);
  const rootSettings = {
    read: () => {
      try {
        const value = settingsScope.read()?.[projectsParentField];
        return typeof value === "string" && value.trim() ? value : undefined;
      } catch { return undefined; }
    },
    write: (value: string | undefined) => {
      try {
        settingsScope.update({ [projectsParentField]: value });
      } catch { /* 写不进去只是本次不记住，不影响本次会话内的行为 */ }
    },
  };

  /**
   * 工坊状态挂在插件上而不是面板上。
   *
   * 新建工具会把主内容区切到会话页（`startNewSession` 里的 `openView`），
   * 面板随即卸载；状态若留在组件里，AI 写完后既没人校验也没有回灌，用户
   * 回到面板只看到空卡片。放在 `apply()` 这一刻创建，生命周期跟插件走。
   */
  const workshop = createWorkshop({
    tools,
    project,
    host,
    owner: () => account.state.getState().currentUser?.id,
    settings: rootSettings,
  });
  ctx.effect(() => () => {
    workshop.dispose();
    settingsScope.dispose();
  }, "tools:workshop");

  /**
   * 换账号要连工坊状态一起换。
   *
   * `ToolsPanel` 用 `key={user.id}` 重挂了，但工坊是插件级单例：不重置的话，
   * 新账号进来会看到上一个账号的项目还展开着（含「已安装」结论），点「确认
   * 安装」就把那个目录里的工具写进新账号的配置——跨账号串数据。
   */
  ctx.effect(() => account.state.subscribe((next, previous) => {
    if ((next.currentUser?.id ?? "") === (previous.currentUser?.id ?? "")) return;
    workshop.dismiss();
    void workshop.refreshProjects();
  }), "tools:account");

  /**
   * 常驻挂载（keepMounted）+ hidden 切换可见性。
   *
   * 面板内部的页签状态（「已安装」/「开发工具」）存在组件 useState 里：
   * 以前失活即卸载——切到别的 session、开一个预览标签再回来，页签都会
   * 悄悄重置回「已安装」，用户正在看的开发列表直接消失。和工作流面板
   * 同一策略：留在 DOM 里只切 hidden，状态就不会丢。
   */
  function ToolsView({ visible, project: panelProject }: PanelViewProps) {
    const user = useStore(account.state).currentUser;
    // 换账号后目录与安装记录都换了一层，用 key 让面板重新挂载、重新拉列表。
    return (
      <ToolsPanelSurface visible={visible}>
        <ToolsPanel
          key={user?.id ?? "anonymous"}
          service={tools}
          host={host}
          project={project}
          workshop={workshop}
          visible={visible}
          onPreviewProject={(dir, name) => {
            // 预览开成右栏的另一个标签：会话留在中间，工具在右边，来回切都不用
            // 离开当前项目。
            workbench.panels.getState().openTab(panelProject, {
              id: previewTabId(dir),
              kind: previewKind,
              data: { dir, ...(name ? { name } : {}) },
            });
          }}
        />
      </ToolsPanelSurface>
    );
  }

  ctx.effect(() => workbench.register("panels", {
    id: "tools",
    keepMounted: true,
    launcher: {
      label: "工具",
      description: "打开和管理个人工具",
      searchHint: "tools plugins",
      Icon: WrenchIcon,
      order: 30,
      prepareGlobalOpen: () => prepareProjectLauncher(ctx.project, workbench, host, false),
    },
    View: ToolsView,
  }), "tools:panel");

  /**
   * 工具预览标签：可以和工具列表、文件、终端并排存在。
   *
   * `data.dir` 会跟着布局一起落盘，所以重启后标签还在，内容重新从磁盘读
   * ——项目可能已经被改过了，读快照反而会骗人。
   */
  ctx.effect(() => workbench.register("panels", {
    id: previewKind,
    present(tab) {
      const name = typeof tab.data?.name === "string" ? tab.data.name : undefined;
      const dir = typeof tab.data?.dir === "string" ? tab.data.dir : tab.id;
      return {
        title: name ?? dir.split(/[\\/]/).filter(Boolean).pop() ?? "工具预览",
        typeLabel: "工具预览",
        searchHint: "tool preview 预览",
        icon: <WrenchIcon className="ui-icon-14 shrink-0" />,
      };
    },
    key: ({ tab }) => (typeof tab?.data?.dir === "string" ? tab.data.dir : tab?.id ?? ""),
    View: ({ tab }) => {
      const dir = typeof tab?.data?.dir === "string" ? tab.data.dir : undefined;
      return dir
        ? <ToolPreviewTab dir={dir} host={host} project={project} tools={tools} />
        : <p className="build-hint p-3">这个预览标签缺少项目路径，关掉重新打开。</p>;
    },
  }), "tools:preview");
}
