import { pathKey } from "../../core/panelPaths.ts";
/**
 * 「新建会话」与「打开会话」的共享入口（workbench 组装层）。
 *
 * 会话是骨架，AAW 是挂在骨架上的增强：新建会话的落点是一条**空对话**
 * ——直接和 agent 说话，不要求先声明 SR / AR / dev 入口、先填变量、先过
 * prompt 预览。想看 AAW 的引导流程时，再从会话内或【+】面板显式发起
 * （见 wizardSubmit）。
 *
 * 两个动词必须分开，因为它们的结果不同：
 * - `startNewSession`：**新建**。跳过历史恢复（forceNew），落一条空对话；
 * - `openSessionFromEntry`（sessionEntry）：**打开**指定历史会话。
 *
 * 从前只有一个动词（连上后自动恢复「最近一个」），于是树上的「＋ 新会话」
 * 在项目有历史时实际打开的是旧对话——标签在说谎。现在按语义拆开：想继续
 * 上次的对话就点树上那条会话行，点「＋ 新会话」就得到一条新的。
 *
 * 流程：内容区**先**切到会话视图（乐观，「正在连接 agent…」加载态就是
 * 即时回响）→ 连接在后台串行队列里建立（forceNew 跳过历史恢复）。
 *
 * 连接失败时不硬留会话视图（空会话比不上去修路径），回滚落在项目总览：
 * 那里有失败横幅与「去设置工具路径」，用户能直接看到原因并动手改。
 */
import { useWorkspaceStore } from "../../stores/workspaceStore.ts";
import { useWorkbenchUiStore } from "../../stores/workbenchUiStore.ts";
import { openRealWorkspace } from "../realRuntime.ts";
import { enqueueSessionOpen } from "./sessionEntry.ts";

/** 结构化结果：失败时 reason 直接面向用户展示。 */
export type StartSessionResult = { ok: true } | { ok: false; reason: string };

/**
 * 在指定项目里新建一条会话（空对话，可直接发送第一条消息）。
 * 失败（连接建立不起来）返回 ok=false 与用户可读原因，调用方负责展示。
 */
export function startNewSession(path: string): Promise<StartSessionResult> {
  // 乐观反馈：点击立即落到会话视图（连接加载态即时回响）
  useWorkbenchUiStore.getState().openSessionView(path);
  return enqueueSessionOpen(async () => {
    const workspace = useWorkspaceStore.getState();
    if (pathKey(workspace.activePath ?? "") !== pathKey(path)) {
      workspace.selectWorkspace(path);
      // forceNew：本条入口的语义是「新建」，不能落进上次那个对话
      const opened = await openRealWorkspace(path, { forceNew: true });
      useWorkspaceStore.getState().openWorkspace(path);
      if (opened === null) {
        const error = useWorkspaceStore.getState().lastConnectError;
        const detail =
          error !== null && error.path === path ? `：${error.message}` : "";
        // 回滚落在总览：失败横幅与「去设置工具路径」都在那儿，原因看得见
        useWorkbenchUiStore.getState().openProjectOverview(path);
        return {
          ok: false,
          reason: `连接 agent 失败${detail || "，请在设置中检查 agent 可执行路径"}`,
        };
      }
    } else {
      // 项目已连接：当前运行时可能正停在某个历史会话上，新建要另开一条
      const opened = await openRealWorkspace(path, { forceNew: true });
      if (opened === null)
        return { ok: false, reason: "连接 agent 失败，请检查设置" };
    }
    return { ok: true };
  });
}
