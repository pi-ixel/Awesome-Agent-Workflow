import type { AcpSessionPort } from "../../acpRuntime/types.ts";
import type { AcpSessionEvent } from "../../acpRuntime/events.ts";
import type { ReadonlySnapshot } from "../../../shared/state/readonlySnapshot.ts";
import type { ProjectFormState } from "../interactions/form.ts";
/**
 * 项目会话视图投影：把一条 AcpSessionPort 的事件流同时接到
 * 三个消费方——
 *
 * - 会话视图（经 attachSession 订阅 sessionStore.handleEvent）；
 * - 装配层订阅的附加事件消费者；
 * - 运行时状态（runtimeStatusStore：runtime/usage 快照与轮内状态信号），
 *   轮次起止由本桥订阅 sessionStore.isAgentRunning 驱动——store 之间不互相
 *   import（约定 §2.4），跨 store 的联动集中在这条组装层完成。
 *
 * 返回的解挂函数同时撤销全部订阅与下行通道绑定。
 */
import { attachSession } from "./sessionStore.ts";
import type { Logger } from "../../../shared/logging/logger.ts";
import type { ProjectForegroundStores } from "./foreground.ts";

export function attachSessionViews(
  acp: AcpSessionPort,
  sessionStore: ProjectForegroundStores["session"],
  approvalStore: ProjectForegroundStores["approval"],
  statusStore: ProjectForegroundStores["runtime"],
  onEvent?: (event: AcpSessionEvent) => void,
  forms?: ReadonlySnapshot<ProjectFormState>,
  logger?: Logger,
): () => void {
  const detachSessionView = attachSession(acp, sessionStore, logger);
  const runtimeStatus = statusStore.getState();
  const syncAwaitingUser = (): void => {
    sessionStore
      .getState()
      .setAwaitingUser(
        approvalStore
          .getState()
          .pending.some(
            (item) => !item.stale && item.sessionId === acp.sessionId,
          ) ||
          forms
            ?.getState()
            .pending.some(
              (item) =>
                item.owner === approvalStore &&
                !item.stale &&
                (item.context?.sessionId ?? item.form.sessionId) ===
                  acp.sessionId,
            ) === true,
      );
  };
  const unsubscribeForms = forms?.subscribe(syncAwaitingUser);
  const unsubscribeApproval = approvalStore.subscribe(syncAwaitingUser);
  const unsubscribeEvents = acp.onEvent((event) => {
    onEvent?.(event);
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
    unsubscribeForms?.();
    unsubscribeApproval();
    unsubscribeTurn();
    unsubscribeEvents();
    detachSessionView();
    statusStore.getState().reset();
  };
}
