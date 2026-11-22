import { useRegisteredSnapshot } from "../../../../shared/state/useRegisteredSnapshot.ts";
import { useConversation } from "../../ui/bindings/conversationView.ts";
import type { AssistantMessageItem, ThoughtItem } from "../types.ts";

/** 仅活跃条目订阅正文，已封口条目及其所在回合保持引用稳定。 */
export function useStreamingItem<
  Item extends AssistantMessageItem | ThoughtItem,
>(item: Item): Item {
  const session = useConversation()?.session;
  return useRegisteredSnapshot(
    item.isStreaming ? session : undefined,
    (state) => {
      if (state?.historyPreview) return item;
      const last = state?.items.at(-1);
      const tail =
        last?.id === item.id
          ? last
          : state?.items.find(({ id }) => id === item.id);
      return tail?.kind === item.kind && tail.isStreaming
        ? (tail as Item)
        : item;
    },
  );
}
