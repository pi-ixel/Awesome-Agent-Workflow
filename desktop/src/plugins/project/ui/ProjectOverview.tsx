import { EmptyState } from "../../../shared/ui/EmptyState.tsx";
import { useSessionValue } from "./bindings/conversationView.ts";
import { useWorkspaceValue } from "./bindings/workspaceView.ts";
import { useProject, useProjectNavigation } from "./bindings/projectView.tsx";
/**
 * 项目总览（内容区的项目视图）：回答两个问题——这个项目现在能不能干活
 * （连接态），以及干到哪了（AAW 工作流状态）。
 *
 * 结构（自上而下）：
 * - 项目状态行：右侧连接态与主行动按钮；
 * - 工作流：工作流插件提供的区块（进行中的运行、启动工作流的入口）；
 *   没有装配工作流插件时不显示。
 *
 * 主行动按钮不叫「连接 iCode」：用户的心智是「在这个项目里开始一条
 * 会话」，不是「建立 ACP 长连接」；agent 是谁、连没连上由行尾连接徽标与
 * 设置页承载，界面文案不点名具体 agent（后续要接更多 agent）。
 * 唯一主动作是「新建会话」（startNewSession，forceNew 跳过历史恢复），
 * 已连接也一样——连接是它的内部步骤，不做「只连接不进入」的中间态按钮。
 * **会话的入口不在总览**：会话挂在树上（项目 → 会话），进哪条对话由
 * 树上的会话行承担；总览这一级是「管理 + 发起」，不放「进入会话」——
 * 会话是工作流那一层的概念（一个工作流甚至可能横跨多条会话），项目级
 * 的「进入会话」说不清要进哪条。
 *
 * 未选择项目时显示带行动入口的引导空态（添加项目主按钮）。项目名 /
 * 路径 / 「关闭项目」按钮在内容区顶部的上下文条（ContextBar 的
 * OverviewBar）。
 */
import type { ComponentType } from "react";

import { ActionButton, Badge, Spinner } from "../../../shared/ui/controls.tsx";

/** 项目状态行：连接态与连接动作。 */
function ProjectStatusRow({ path }: { readonly path: string }) {
  const projectService = useProject();
  const activePath = useWorkspaceValue((state) => state.activePath);
  const isConnecting = useSessionValue((state) => state.isConnecting);

  const isConnectingThis = isConnecting && activePath === path;

  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <span aria-hidden={true} className="flex-1" />

      {isConnectingThis ? (
        <Badge tone="info">
          <Spinner className="ui-icon-12 shrink-0" />
          <span className="text-ui-sm">正在连接 agent 并恢复会话…</span>
        </Badge>
      ) : (
        <>
          {/* 唯一主动作：新建会话（连接是它的内部步骤，不单独成按钮——
              让用户去判断「连接」和「进入会话」先点哪个是界面在推卸责任）。
              已连接同样只留它：会话入口在树上，总览只管发起 */}
          <ActionButton
            tone="primary"
            type="button"
            onClick={() => {
              void projectService?.sessions.startNewSession(path);
            }}
            disabled={isConnecting}
            className="shrink-0 px-3 py-1.5 text-ui-sm"
          >
            新建会话
          </ActionButton>
        </>
      )}
    </div>
  );
}

/** 未选择项目时的空态引导：主行动入口（添加项目）+ 一行价值说明。 */
function ProjectSetup() {
  const projectNav = useProjectNavigation();
  const addProject = projectNav?.addProject;
  const addRemoteProject = projectNav?.addRemoteProject;
  const handleAddProject = (): void => {
    if (addRemoteProject?.()) {
      return;
    }
    void addProject?.();
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col items-center justify-center text-center">
      <EmptyState
        title="从左侧选择或新建一个项目目录，开始与 agent 对话。"
        description="添加后自动检查项目环境。"
        action={
          <ActionButton tone="primary" type="button" onClick={handleAddProject} className="px-4 py-2 text-ui-base">
            添加项目
          </ActionButton>
        }
      />
    </div>
  );
}

/** 项目总览：path 为 null 时呈引导空态。 */
function ProjectOverview({
  path,
  ExtensionOverview,
}: {
  readonly path: string | null;
  /** 扩展在项目总览里的区块（如工作流）。 */
  readonly ExtensionOverview?: ComponentType<{ readonly project: string }>;
}) {
  if (path === null) {
    return <ProjectSetup />;
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
      <section
        aria-label="项目状态"
        className="flex flex-col gap-3 rounded-popover border border-line bg-surface p-5"
      >
        <ProjectStatusRow path={path} />
      </section>
      {ExtensionOverview && <ExtensionOverview project={path} />}
    </div>
  );
}

export default ProjectOverview;
