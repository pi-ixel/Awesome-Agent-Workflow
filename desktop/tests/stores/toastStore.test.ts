/**
 * toast store：入队 / 业务键去重替换 / 手动 dismiss / 栈上限 5。
 */
import { beforeEach, describe, expect, it } from "vitest";

import { createToastStore } from "../../src/plugins/workbench/toastStore.ts";

let store: ReturnType<typeof createToastStore>["store"];
beforeEach(() => {
  store = createToastStore().store;
});

describe("toastStore", () => {
  it("push 入队并给默认变体与时长", () => {
    store.getState().push({ message: "已复制" });
    const [item] = store.getState().items;
    expect(item?.message).toBe("已复制");
    expect(item?.variant).toBe("info");
    expect(item?.durationMs).toBe(3000);
    expect(item?.dedupeKey).toBeNull();
  });

  it("同 dedupeKey 的新条目替换旧条目（不堆叠）", () => {
    const { push } = store.getState();
    push({ message: "复制中…", dedupeKey: "copy" });
    push({ message: "已复制", variant: "ok", dedupeKey: "copy" });
    const items = store.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.message).toBe("已复制");
  });

  it("无键条目各自独立；dismiss 按 id 移除", () => {
    const { push, dismiss } = store.getState();
    push({ message: "a" });
    push({ message: "b" });
    expect(store.getState().items).toHaveLength(2);
    dismiss(store.getState().items[0]!.id);
    expect(store.getState().items.map((i) => i.message)).toEqual(["b"]);
  });

  it("栈上限 5：新条目顶掉最旧的", () => {
    for (let i = 0; i < 7; i++) {
      store.getState().push({ message: `t${i}` });
    }
    const messages = store.getState().items.map((item) => item.message);
    expect(messages).toEqual(["t2", "t3", "t4", "t5", "t6"]);
  });
});
