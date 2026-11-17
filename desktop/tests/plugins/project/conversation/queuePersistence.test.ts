import { beforeEach, expect, it, vi } from "vitest";
import {
  readPromptQueue,
  writePromptQueue,
} from "../../../../src/plugins/project/conversation/queuePersistence.ts";
import { createSessionStore } from "../../../../src/plugins/project/conversation/sessionStore.ts";

beforeEach(() => localStorage.clear());

it("恢复旧格式并为重复消息生成不同且可持久化的标识", () => {
  localStorage.setItem(
    "aaw-desktop/prompt-queue.v1/scope",
    JSON.stringify([
      "same",
      "same",
      {
        text: "image",
        attachments: [{ type: "image", mimeType: "image/png", data: "abc" }],
      },
    ]),
  );
  const restored = readPromptQueue("scope");
  const ids = restored.map((item) =>
    typeof item === "string" ? undefined : item.id,
  );
  expect(new Set(ids).size).toBe(3);
  expect(ids.every(Boolean)).toBe(true);
  void writePromptQueue("scope", restored);
  expect(readPromptQueue("scope")).toEqual(restored);
});

it("拖动期间消息已经出队时不移动其他消息", () => {
  const store = createSessionStore();
  store.setState({
    queuedPrompts: [
      { id: "a", text: "same", attachments: [] },
      { id: "b", text: "same", attachments: [] },
    ],
  });
  store.getState().removeQueuedPromptById("a");
  expect(store.getState().moveQueuedPrompt("a", "b", "after")).toBe(false);
  expect(store.getState().queuedPrompts).toEqual([
    { id: "b", text: "same", attachments: [] },
  ]);
});

it("保留引导请求的投递状态和附件，拒绝无法识别的状态", () => {
  localStorage.setItem(
    "aaw-desktop/prompt-queue.v1/scope",
    JSON.stringify([
      { id: "pending", text: "补充", attachments: [{ type: "image", mimeType: "image/png", data: "abc" }], steerDelivery: "pending" },
      { id: "unknown", text: "检查", attachments: [], steerDelivery: "unknown" },
      { id: "invalid", text: "无效", attachments: [], steerDelivery: "sent" },
    ]),
  );
  const queue = readPromptQueue("scope");
  expect(queue).toHaveLength(2);
  expect(queue[0]).toMatchObject({ id: "pending", steerDelivery: "pending", attachments: [{ data: "abc" }] });
  expect(queue[1]).toMatchObject({ id: "unknown", steerDelivery: "unknown" });
  void writePromptQueue("scope", queue);
  expect(readPromptQueue("scope")).toEqual(queue);
});

it.each(["pending", "unknown"] as const)("%s 引导消息不会被普通队列自动发送", (steerDelivery) => {
  const store = createSessionStore();
  const prompt = vi.fn();
  store.getState().bindSession({ prompt, cancel: () => {} });
  store.setState({
    queuedPrompts: [{ id: "steer", text: "补充", attachments: [], steerDelivery }],
    queuePaused: true,
  });
  store.getState().resumeQueue();
  expect(prompt).not.toHaveBeenCalled();
  expect(store.getState().queuePaused).toBe(true);
  expect(store.getState().queuedPrompts).toHaveLength(1);
});
