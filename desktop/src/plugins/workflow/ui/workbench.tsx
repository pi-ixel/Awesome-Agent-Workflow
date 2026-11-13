/**
 * workflow 插件的 workbench 挂载（ADR 024 §5 ④）。
 *
 * 骨架对齐远端 0.1.21 的旧 workflow workbench（publicOrigin/main：
 * WorkbenchContributions 的 panels 注册 + navigationGuard 守卫的打开路径 +
 * Fiber 释放时撤销注册），面板内容替换为引擎画布（WorkflowPanel）。
 *
 * - panelId "aaw"：launcher（新标签页入口）+ View（AAW 面板）；
 * - `workflow:resources` effect：Fiber 释放时撤销面板注册并解除作用域绑定；
 * - 工作区作用域：订阅 workbench 导航的 contextPath，把当前项目路径经
 *   `service.bindWorkspace` 绑定为引擎请求作用域（list/snapshot 的 cwd）；
 * - 节点会话打开（ADR 024 §9 开放问题 1 收口）：面板「打开会话」经
 *   project.sessions.openSessionFromEntry 进中央 SessionView——与用户点
 *   侧栏会话条目同一条路径（乐观 UI + 导航守卫 + 串行队列）。
 */
import type { Context } from "cordis";
import type { WorkbenchContributions } from "../../workbench/types.ts";
import type { WorkbenchService } from "../../workbench/service.ts";
import type { PanelViewProps } from "../../workbench/types.ts";
import { pathKey } from "../../../shared/panelPaths.ts";
import { WorkflowIcon } from "../../../shared/ui/icons.tsx";
import type { ProjectService } from "../../project/service.ts";
import type { WorkflowService } from "../types.ts";
import { attachAawScriptSource } from "../health/scriptSource.ts";
import { WorkflowPanel } from "./WorkflowPanel.tsx";

const panelId = "aaw";

export function createWorkflowWorkbench(
  workflow: WorkflowService,
  workbench: WorkbenchService,
  project: ProjectService,
) {
  let disposed = false;
  const active = () => !disposed && workflow.isActive() && workbench.navigationGuard.isActive();
  const isCurrentProject = (key: string) =>
    active() && key === pathKey(workbench.navigation.getState().contextPath ?? "");

  function show(projectPath: string): void {
    const key = pathKey(projectPath);
    if (!isCurrentProject(key)) return;
    const resume = () => show(projectPath);
    const panel = workbench.panels.getState();
    const previous = panel.projects[key];
    if (previous?.active !== panelId && !workbench.navigationGuard.guard(resume)) return;
    panel.tool(projectPath, panelId);
  }

  /** 节点会话 → 中央 SessionView：走 openSessionFromEntry（所属工作区即
   * 当前面板绑定的项目路径；会话未收养时如实静默——列表里没有条目）。 */
  function openNodeSession(sessionId: string): void {
    if (!active()) return;
    const path = workbench.navigation.getState().contextPath;
    if (!path) return;
    void project.sessions.openSessionFromEntry(path, sessionId);
  }

  const panel: WorkbenchContributions["panels"] = {
    id: panelId,
    keepMounted: true,
    launcher: {
      label: "AAW 工作流",
      description: "查看进度与启动工作流",
      searchHint: "aaw workflow",
      Icon: WorkflowIcon,
      open: (projectPath) => show(projectPath),
    },
    View: function WorkflowPanelView({ visible }: PanelViewProps) {
      return (
        <section aria-label={visible ? "AAW 面板" : undefined} hidden={!visible} className="workflow-panel-view">
          <WorkflowPanel service={workflow} onOpenSession={openNodeSession} />
        </section>
      );
    },
  };
  return {
    panel,
    dispose() {
      disposed = true;
    },
  };
}

export const name = "workflow-workbench";
export const inject = ["workflow", "workbench", "project"];

export function apply(ctx: Context): void {
  const { workflow, workbench, project } = ctx;
  const ui = createWorkflowWorkbench(workflow, workbench, project);
  ctx.effect(() => () => ui.dispose(), "workflow:resources");
  ctx.effect(() => {
    // 工作区作用域：只在当前项目路径真的变化时重绑引擎请求作用域（run
    // 列表）——导航的其他变化（打开会话、切页面）不是作用域变化。
    let boundPath = workbench.navigation.getState().contextPath;
    let unbind = workflow.bindWorkspace(boundPath);
    const unsubscribe = workbench.navigation.subscribe(() => {
      const next = workbench.navigation.getState().contextPath;
      if (next === boundPath) return;
      boundPath = next;
      unbind();
      unbind = workflow.bindWorkspace(next);
    });
    return () => {
      unsubscribe();
      unbind();
    };
  }, "workflow:workspace-scope");
  ctx.effect(() => workbench.register("panels", ui.panel));
  ctx.effect(() => {
    // 工作流脚本来源（可选依赖 workflow -.-> skills）：skills 来源目录
    // 即 aaw.py 的来源，工作区健康检查在用户未显式配置脚本路径时回退
    // 推导（旧 workbench 的 workflowSkillSource 语义移植；消费点在
    // index.ts 的健康检查注册，槽位见 health/scriptSource.ts）。
    const skills = ctx.inject(["skills"], function workflowSkillSource(scoped) {
      scoped.effect(() => {
        attachAawScriptSource(scoped.skills.source);
        return () => attachAawScriptSource(undefined);
      });
    });
    return async () => {
      await skills.dispose();
    };
  }, "workflow:script-source");
}
