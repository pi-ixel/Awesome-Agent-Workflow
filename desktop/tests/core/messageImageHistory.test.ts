import { expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  readMessageImages,
  saveMessageImages,
  restoreMessageImages,
} from "../../src/core/messageImageHistory.ts";
import type { UserMessageItem } from "../../src/stores/sessionStore.ts";
const image = { type: "image", mimeType: "image/png", data: "YWJj" };
const user = (
  id: string,
  text: string,
  attachments?: unknown[],
): UserMessageItem => ({ kind: "user", id, text, createdAt: "", attachments });
it("restores missing images without replacing replay attachments", () => {
  const saved = [user("a", "这是啥", [image])];
  expect(restoreMessageImages([user("replay", "这是啥")], saved)[0]).toEqual(
    user("replay", "这是啥", [image]),
  );
  const replay = [
    user("replay", "这是啥", [{ type: "image", data: "remote" }]),
  ];
  expect(restoreMessageImages(replay, saved)).toEqual(replay);
});
it("does not guess repeated prompts in partial history", () => {
  const saved = [
    user("a", "这是啥", [image]),
    user("b", "这是啥", [{ ...image, data: "other" }]),
  ];
  const replay = [user("r", "这是啥")];
  expect(restoreMessageImages(replay, saved)).toEqual(replay);
  expect(
    restoreMessageImages([user("r1", "这是啥"), user("r2", "这是啥")], saved),
  ).toEqual([
    user("r1", "这是啥", [image]),
    user("r2", "这是啥", [{ ...image, data: "other" }]),
  ]);
});
it("isolates sessions and preserves images when replay omits them", async () => {
  globalThis.indexedDB = new IDBFactory();
  await saveMessageImages("agent/a", [user("a", "图片", [image])]);
  await saveMessageImages("agent/a", [user("r", "图片")]);
  expect(await readMessageImages("agent/a")).toEqual([
    { text: "图片", attachments: [image] },
  ]);
  expect(await readMessageImages("agent/b")).toEqual([]);
});
