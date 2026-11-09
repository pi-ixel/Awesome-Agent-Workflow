import type { ContentBlock } from "../../runtime/acpBase/protocol/types.ts";
/**
 * 输入框预填通道：把一段文本送进 ChatInput 的草稿（聚焦可编辑，不自动
 * 发送——用户过目后自己按 Enter）。
 *
 * 消费方：用户消息的「再次发送」、空会话的推荐入口 chips。生产/消费
 * 跨组件树，这里用 window 自定义事件做单向总线（一次性投递，无需订阅
 * 状态，也避免「effect 里同步 setState」的级联渲染）。
 */

const PREFILL_EVENT = "aaw:composer-prefill";

/** 预填输入框（ChatInput 监听事件落草稿并聚焦）。 */
export function prefillComposer(
  text: string,
  attachments: readonly ContentBlock[] = [],
): void {
  const trimmed = text.trim();
  if (trimmed.length === 0 && attachments.length === 0) {
    return;
  }
  window.dispatchEvent(
    new CustomEvent(PREFILL_EVENT, { detail: { text: trimmed, attachments } }),
  );
}

/** ChatInput 侧的监听口（effect 内挂/卸）。 */
export function onComposerPrefill(
  listener: (text: string, attachments?: readonly ContentBlock[]) => void,
): () => void {
  const handler = (event: Event): void => {
    const detail = (
      event as CustomEvent<{
        readonly text: string;
        readonly attachments?: readonly ContentBlock[];
      }>
    ).detail;
    if (detail !== undefined && typeof detail.text === "string") {
      listener(detail.text, detail.attachments);
    }
  };
  window.addEventListener(PREFILL_EVENT, handler);
  return () => {
    window.removeEventListener(PREFILL_EVENT, handler);
  };
}
