import type { WorkbenchLayout } from "../../../contracts/workbench.ts";
/**
 * 「添加项目」流程（workbench 组装层）：系统目录对话框（pickDirectory）
 * → 选中该项目 → 内容区切到项目总览 → 跑一次首次健康检查。
 *
 * 返回选中的路径；取消或环境不支持返回 null（调用方提示重试或从列表
 * 选择）。项目总览空态与【+】面板的「添加项目」tab 共用本流程。
 *
 * 首次检查只在这一刻发生：新项目从未检查过，这一次结论是「能不能干活」
 * 的底账。之后进总览**不再自动重查**——检查通过的工具不会自己坏掉，反复
 * 重查是浪费；有疑虑时总览里有手动「重新检查」按钮。
 *
 * 「进项目」与「进会话」是两类入口，行为分别统一（见 ProjectTree 顶部
 * 说明）：本流程属于「进项目」——只选中并落到总览，连接是总览里显式的
 * 一步（先看到健康检查结论，再决定连不连）。自动连接留给会话入口
 * （sessionEntry 的 openSessionFromEntry、向导发送时的 wizardSubmit）。
 */
import { settingsPathsOverride } from "./workspaces/settingsLinks.ts";
import type { ProjectService } from "../../../contracts/project.ts";

/** 打开系统目录对话框添加项目；成功即选中并进总览，返回路径或 null。 */
export async function addProjectViaDialog(
  project: Pick<
    ProjectService,
    "isActive" | "pickDirectory" | "registerProject" | "preloadSessionList" | "workspace"
  >,
  layout: WorkbenchLayout | undefined,
  readSkillSource?: () => string,
): Promise<string | null> {
  if (!layout?.navigationGuard.isActive() || !project.isActive()) return null;
  const path = await project.pickDirectory();
  if (path === null) {
    return null;
  }
  if (!(await layout.navigationGuard.confirm()) || !project.isActive()) return null;
  project.registerProject(path);
  layout.navigation.getState().openProjectOverview(path);
  // 模型 a：添加即获取会话列表并保留待用连接（与启动/展开共用去重）——
  // 侧栏该项目节点展开即有会话可点
  void project.preloadSessionList(path);
  // 首次健康检查（唯一一次自动检查；之后靠总览里的手动「重新检查」）
  const workspace = project.workspace.getState();
  void workspace.runHealthChecks(
    undefined,
    settingsPathsOverride(workspace.toolPaths, readSkillSource?.() ?? ""),
  );
  return path;
}
