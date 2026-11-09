import type { WorkflowService } from "../../../contracts/workflow.ts";
import type { WorkbenchLayout } from "../../../contracts/workbench.ts";
/**
 * 入口向导的项目上下文发送（ui 层组装模块）：
 * 向导生成的首条 prompt 挂在向导所属项目上发送——该项目未连接时先
 * 先通过项目服务建立连接；发送被接受后，内容区切到会话视图。
 *
 * 失败反馈（P0-2）：返回结构化结果——连接失败时 reason 带具体原因与
 * 「检查设置」指引；发送被拒时 reason 取 sessionStore 的 lastError 或
 * 固定文案。向导据此在表单内直接展示，不再只把错误写进不可见的消息流。
 */
import type { ProjectService } from "../../../contracts/project.ts";

/** 向导提交的结构化结果：ok=false 时 reason 直接面向用户展示。 */
export type WizardSubmitResult = { ok: true } | { ok: false; reason: string };

/** 发送被拒（绑定缺失等）时的兜底文案（sessionStore 无 lastError 时）。 */
const SEND_REJECTED_FALLBACK =
  "消息未能发送：会话尚未就绪，请重新打开项目后重试";

/**
 * 发送向导生成的首条 prompt（挂在当前向导的项目上下文）。
 * 失败时返回 ok=false 与用户可读的 reason（向导保留表单供重试）。
 */
export async function submitWizardPrompt(
  project: Pick<ProjectService, "workspace" | "openSession" | "foreground">,
  workflow: WorkflowService | undefined,
  layout: WorkbenchLayout | undefined,
  prompt: string,
): Promise<WizardSubmitResult> {
  if (!workflow?.isActive()) return { ok: false, reason: "工作流服务尚未就绪" };
  if (!layout?.navigationGuard.isActive())
    return { ok: false, reason: "工作台尚未就绪" };
  if (
    layout.navigationGuard.pending() &&
    !(await layout.navigationGuard.confirm())
  )
    return { ok: false, reason: "已取消切换" };
  if (!workflow.isActive() || !layout.navigationGuard.isActive())
    return { ok: false, reason: "工作流服务已关闭" };
  const ui = layout.navigation.getState();
  const path = ui.contextPath;
  if (path === null) {
    return { ok: false, reason: "尚未选择项目，请先在左侧选择或添加项目" };
  }
  const workspace = project.workspace.getState();
  const { session } = project.foreground;
  if (workspace.activePath !== path) {
    workspace.selectWorkspace(path);
    await project.openSession(path);
    if (!workflow.isActive() || !layout.navigationGuard.isActive())
      return { ok: false, reason: "工作流服务已关闭" };
    // 连接建立后再落 activePath（RealSessionRuntime 对同路径幂等）
    project.workspace.getState().openWorkspace(path);
    if (!session.getState().isBound) {
      // 连接失败：原因取连接失败的回填（含修复指引），无回填用固定文案
      const error = project.workspace.getState().lastConnectError;
      const detail =
        error !== null && error.path === path ? `：${error.message}` : "";
      return {
        ok: false,
        reason: `连接 agent 失败${detail || "，请在设置中检查 agent 可执行路径"}`,
      };
    }
  }
  const owner = session.getState();
  if (!owner.agentKey || layout.navigation.getState().contextPath !== path)
    return { ok: false, reason: SEND_REJECTED_FALLBACK };
  try {
    const accepted = workflow.submit(
      {
        workspacePath: path,
        agentKey: owner.agentKey,
        sessionId: owner.activeSessionId,
      },
      prompt,
    );
    if (!accepted)
      return {
        ok: false,
        reason: session.getState().lastError ?? SEND_REJECTED_FALLBACK,
      };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  // sendPrompt 同步落笔：绑定存在即开始运行（已接受）；
  // 无绑定只落错误提示（未接受），向导保留表单
  const accepted = session.getState().isAgentRunning;
  if (!accepted) {
    const reason = session.getState().lastError ?? SEND_REJECTED_FALLBACK;
    return { ok: false, reason };
  }
  // 发送成功后切到会话视图看流
  layout.navigation.getState().openSessionView(path);
  return { ok: true };
}
