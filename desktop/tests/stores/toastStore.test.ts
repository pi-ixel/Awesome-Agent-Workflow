/**
 * toast store：入队 / 业务键去重替换 / 手动 dismiss / 栈上限 5。
 */
import { beforeEach, describe, expect, it } from "vitest";

import { createToastStore } from "../../src/plugins/workbench/feedback/toastStore.ts";

let store: ReturnType<typeof createToastStore>;
beforeEach(() => {
  store = createToastStore();
});

describe("toastStore", () => {
  it("push 入队并给默认变体与时长", () => {
    store.push({ message: "已复制" });
    const [item] = store.view.getState().items;
    expect(item?.message).toBe("已复制");
    expect(item?.variant).toBe("info");
    expect(item?.durationMs).toBe(3000);
    expect(item?.dedupeKey).toBeNull();
  });

  it("同 dedupeKey 的新条目替换旧条目（不堆叠）", () => {
    const { push } = store;
    push({ message: "复制中…", dedupeKey: "copy" });
    push({ message: "已复制", variant: "ok", dedupeKey: "copy" });
    const items = store.view.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.message).toBe("已复制");
  });

  it("无键条目各自独立；dismiss 按 id 移除", () => {
    const { push, dismiss } = store;
    push({ message: "a" });
    push({ message: "b" });
    expect(store.view.getState().items).toHaveLength(2);
    dismiss(store.view.getState().items[0]!.id);
    expect(store.view.getState().items.map((i) => i.message)).toEqual(["b"]);
  });

  it("栈上限 5：新条目顶掉最旧的", () => {
    for (let i = 0; i < 7; i++) {
      store.push({ message: `t${i}` });
    }
    const messages = store.view.getState().items.map((item) => item.message);
    expect(messages).toEqual(["t2", "t3", "t4", "t5", "t6"]);
  });
});
