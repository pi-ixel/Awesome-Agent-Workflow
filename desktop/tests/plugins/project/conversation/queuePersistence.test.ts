import { beforeEach, expect, it } from "vitest";
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
