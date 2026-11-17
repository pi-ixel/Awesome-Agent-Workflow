import type { UserMessageItem } from "../../../../src/plugins/project/types.ts";
import { expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  createMessageImageHistory,
  restoreMessageImages,
} from "../../../../src/plugins/project/conversation/messageImageHistory.ts";
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
  const images = createMessageImageHistory();
  await images.save("agent/a", [user("a", "图片", [image])]);
  await images.save("agent/a", [user("r", "图片")]);
  expect(await images.read("agent/a")).toEqual([
    { text: "图片", attachments: [image] },
  ]);
  expect(await images.read("agent/b")).toEqual([]);
});

it("drains attachment writes on disposal and ignores writes from the old owner", async () => {
  globalThis.indexedDB = new IDBFactory();
  const old = createMessageImageHistory();
  const written = old.save("scope", [user("a", "image", [image])]);
  await old.dispose();
  await written;
  await old.save("scope", [user("a", "stale", [{ ...image, data: "old" }])]);
  expect(await old.read("scope")).toEqual([]);
  const current = createMessageImageHistory();
  expect(await current.read("scope")).toEqual([
    { text: "image", attachments: [image] },
  ]);
});

it("persists a per-message image fallback marker across storage owners", async () => {
  globalThis.indexedDB = new IDBFactory();
  const first = createMessageImageHistory();
  await first.save("codeagent/session", [
    {
      ...user("a", "", [image]),
      imageFallbackText: "请查看图片。 [id: unique]",
    },
  ]);
  await first.dispose();
  const second = createMessageImageHistory();
  expect(await second.read("codeagent/session")).toEqual([
    {
      text: "",
      attachments: [image],
      imageFallbackText: "请查看图片。 [id: unique]",
    },
  ]);
  expect(await second.read("other/session")).toEqual([]);
  await second.dispose();
});

it("only hides an exact unique persisted marker and restores its image", () => {
  const marker = "请查看图片。\n[AAW 图片请求 123]";
  const saved = [{ text: "", attachments: [image], imageFallbackText: marker }];
  const restored = restoreMessageImages(
    [user("r", marker)],
    saved,
  )[0] as UserMessageItem;
  expect(restored.text).toBe("");
  expect(restored.attachments).toEqual([image]);
  expect(restored.imageFallbackText).toBe(marker);
  const duplicate = [user("r1", marker), user("r2", marker)];
  expect(restoreMessageImages(duplicate, saved)).toEqual(duplicate);
  expect(
    restoreMessageImages(
      [user("r", marker)],
      [{ text: "", attachments: [image] }],
    ),
  ).toEqual([user("r", marker)]);
});
