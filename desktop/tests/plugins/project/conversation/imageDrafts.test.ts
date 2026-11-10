import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, it } from "vitest";
import { createImageDraftStorage } from "../../../../src/plugins/project/composer/imageDrafts.ts";
import { webviewStorage } from "../../../../src/plugins/host/storage/storage.ts";

let drafts: ReturnType<typeof createImageDraftStorage>;

beforeEach(() => {
  localStorage.clear();
  globalThis.indexedDB = new IDBFactory();
  drafts = createImageDraftStorage(webviewStorage);
});
it("restores scoped image drafts and persists removal", async () => {
  const image = {
    name: "example.png",
    block: { type: "image", mimeType: "image/png", data: "abc" },
  };
  await drafts.save({
    "agent-a/project/session": [image],
    "agent-b/project/session": [],
  });
  expect(await drafts.load()).toEqual({
    "agent-a/project/session": [image],
  });
  await drafts.save({ "agent-a/project/session": [] });
  expect(await drafts.load()).toEqual({});
});

it("migrates legacy drafts once and persists a large image outside localStorage", async () => {
  const image = {
    name: "large.png",
    block: {
      type: "image",
      mimeType: "image/png",
      data: "a".repeat(8 * 1024 * 1024),
    },
  };
  localStorage.setItem(
    "aaw-desktop/image-drafts.v1",
    JSON.stringify({
      old: [{ ...image, block: { ...image.block, data: "abc" } }],
    }),
  );
  expect((await drafts.load()).old).toHaveLength(1);
  expect(localStorage.getItem("aaw-desktop/image-drafts.v1")).toBeNull();
  await drafts.save({ first: [image], second: [] });
  expect((await drafts.load()).first?.[0]?.block).toEqual(image.block);
  await drafts.save({ second: [image] });
  expect((await drafts.load()).first).toBeUndefined();
});
