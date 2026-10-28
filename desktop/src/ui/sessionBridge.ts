/**
 * 会话视图装配桥（ui 层组装模块）：把一条 AcpSession 的事件流同时接到
 * 三个消费方——
 *
 * - 会话视图（sessionStore.handleEvent，经 stores/sessionStore 的
 *   attachSession）；
 * - 工作流状态面板的会话事件自动刷新（aawStatusStore.handleSessionEvent，
 *   内部节流）；
 * - 运行时状态（runtimeStatusStore：runtime/usage 快照与轮内状态信号），
 *   轮次起止由本桥订阅 sessionStore.isAgentRunning 驱动——store 之间不互相
 *   import（约定 §2.4），跨 store 的联动集中在这条组装层完成。
 *
 * 返回的解挂函数同时撤销全部订阅与下行通道绑定。
 */
import type { AcpSession } from "../acp/session.ts";
import { attachSession, useSessionStore } from "../stores/sessionStore.ts";
import { useAawStatusStore } from "../stores/aawStatusStore.ts";
import { useRuntimeStatusStore } from "../stores/runtimeStatusStore.ts";
import { useApprovalStore } from "../stores/approvalStore.ts";

export function attachSessionViews(
  acp: AcpSession,
  sessionStore = useSessionStore,
  approvalStore = useApprovalStore,
  statusStore = useRuntimeStatusStore,
  isForeground = () => true,
): () => void {
  const detachSessionView = attachSession(acp, sessionStore);
  const runtimeStatus = statusStore.getState();
  const syncAwaitingUser = (): void => {
    sessionStore
      .getState()
      .setAwaitingUser(
        approvalStore
          .getState()
          .pending.some((item) => item.sessionId === acp.sessionId),
      );
  };
  const unsubscribeApproval = approvalStore.subscribe(syncAwaitingUser);
  const unsubscribeAaw = acp.onEvent((event) => {
    if (isForeground()) useAawStatusStore.getState().handleSessionEvent(event);
    statusStore.getState().handleSessionEvent(event);
  });
  // 轮次生命周期：isAgentRunning 翻转即 begin/endTurn（取消/失败同样落到
  // false，状态机的收尾不依赖正常返回路径）
  let wasRunning = sessionStore.getState().isAgentRunning;
  const unsubscribeTurn = sessionStore.subscribe((state) => {
    if (state.isAgentRunning === wasRunning) {
      return;
    }
    wasRunning = state.isAgentRunning;
    if (state.isAgentRunning) {
      statusStore.getState().beginTurn();
      syncAwaitingUser();
    } else {
      statusStore.getState().endTurn();
    }
  });
  if (wasRunning) {
    runtimeStatus.beginTurn();
    syncAwaitingUser();
  }
  return () => {
    unsubscribeApproval();
    unsubscribeTurn();
    unsubscribeAaw();
    detachSessionView();
    statusStore.getState().reset();
  };
}
