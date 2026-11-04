import {
  confirmMarkdownNavigation,
  dirtyMarkdownDocuments,
} from "../../stores/markdownDocumentStore.ts";
/**
 * 入口向导的项目上下文发送（ui 层组装模块）：
 * 向导生成的首条 prompt 挂在向导所属项目上发送——该项目未连接时先
 * 经 openRealWorkspace 自动建立连接（等待完成），已连接直接发送；
 * 发送走 sessionStore 既有通路，被接受后内容区切到会话视图看流。
 *
 * 失败反馈（P0-2）：返回结构化结果——连接失败时 reason 带具体原因与
 * 「检查设置」指引；发送被拒时 reason 取 sessionStore 的 lastError 或
 * 固定文案。向导据此在表单内直接展示，不再只把错误写进不可见的消息流。
 */
import { useSessionStore } from "../../stores/sessionStore.ts";
import { useWorkspaceStore } from "../../stores/workspaceStore.ts";
import { useWorkbenchUiStore } from "../../stores/workbenchUiStore.ts";
import { openRealWorkspace } from "../realRuntime.ts";

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
  prompt: string,
): Promise<WizardSubmitResult> {
  if (dirtyMarkdownDocuments().length && !(await confirmMarkdownNavigation()))
    return { ok: false, reason: "已取消切换" };
  const ui = useWorkbenchUiStore.getState();
  const path = ui.contextPath;
  if (path === null) {
    return { ok: false, reason: "尚未选择项目，请先在左侧选择或添加项目" };
  }
  const workspace = useWorkspaceStore.getState();
  if (workspace.activePath !== path) {
    workspace.selectWorkspace(path);
    await openRealWorkspace(path);
    // 连接建立后再落 activePath（RealSessionRuntime 对同路径幂等）
    useWorkspaceStore.getState().openWorkspace(path);
    if (!useSessionStore.getState().isBound) {
      // 连接失败：原因取连接失败的回填（含修复指引），无回填用固定文案
      const error = useWorkspaceStore.getState().lastConnectError;
      const detail =
        error !== null && error.path === path ? `：${error.message}` : "";
      return {
        ok: false,
        reason: `连接 agent 失败${detail || "，请在设置中检查 agent 可执行路径"}`,
      };
    }
  }
  useSessionStore.getState().sendPrompt(prompt);
  // sendPrompt 同步落笔：绑定存在即开始运行（已接受）；
  // 无绑定只落错误提示（未接受），向导保留表单
  const accepted = useSessionStore.getState().isAgentRunning;
  if (!accepted) {
    const reason =
      useSessionStore.getState().lastError ?? SEND_REJECTED_FALLBACK;
    return { ok: false, reason };
  }
  // 发送成功后切到会话视图看流
  useWorkbenchUiStore.getState().openSessionView(path);
  return { ok: true };
}
