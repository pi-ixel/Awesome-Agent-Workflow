import {
  confirmMarkdownNavigation,
  dirtyMarkdownDocuments,
} from "../../stores/markdownDocumentStore.ts";
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
 * 流程：内容区先切到独立的可编辑草稿，连接在后台队列中建立；连接完成
 * 只在用户仍停留于这份草稿时接管视图。
 *
 * 连接失败保留草稿，显示原因并允许重试；旧会话继续后台运行。
 */
import { useWorkspaceStore } from "../../stores/workspaceStore.ts";
import { useWorkbenchUiStore } from "../../stores/workbenchUiStore.ts";
import { beginDraftWorkspace, openRealWorkspace } from "../realRuntime.ts";
import { enqueueSessionOpen } from "./sessionEntry.ts";

/** 结构化结果：失败时 reason 直接面向用户展示。 */
export type StartSessionResult = { ok: true } | { ok: false; reason: string };

/**
 * 在指定项目里新建一条会话（空对话，可直接发送第一条消息）。
 * 失败（连接建立不起来）返回 ok=false 与用户可读原因，调用方负责展示。
 */
export function startNewSession(path: string): Promise<StartSessionResult> {
  if (
    pathKey(useWorkbenchUiStore.getState().contextPath ?? "") !==
      pathKey(path) &&
    dirtyMarkdownDocuments().length
  )
    return confirmMarkdownNavigation().then((allowed) =>
      allowed ? startNewSession(path) : { ok: false, reason: "已取消切换" },
    );
  // 页面选择与连接准备解耦，等待队列/握手期间也只显示目标草稿。
  useWorkbenchUiStore.getState().openSessionView(path);
  const draft = beginDraftWorkspace(path);
  useWorkspaceStore.getState().openWorkspace(path);
  return enqueueSessionOpen(async (isLatest) => {
    if (!isLatest() || !draft.isCurrent())
      return { ok: false, reason: "已切换到其他页面" };
    try {
      let activated = false;
      const opened = await openRealWorkspace(path, {
        forceNew: true,
        draft: true,
        shouldFocus: () => {
          const current = isLatest() && draft.isCurrent();
          if (current) activated = true;
          return current;
        },
      });
      if (opened !== null)
        return activated && isLatest()
          ? { ok: true }
          : { ok: false, reason: "已切换到其他页面" };
      const error = useWorkspaceStore.getState().lastConnectError;
      const reason =
        error && pathKey(error.path) === pathKey(path)
          ? error.message
          : "连接 agent 失败，请检查设置后重试";
      draft.fail(reason);
      return { ok: false, reason };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      draft.fail(reason);
      return { ok: false, reason };
    }
  });
}
