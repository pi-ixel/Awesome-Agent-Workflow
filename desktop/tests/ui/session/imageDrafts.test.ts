import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, it } from "vitest";
import {
  loadImageDrafts,
  saveImageDrafts,
} from "../../../src/ui/session/imageDrafts.ts";

beforeEach(() => {
  localStorage.clear();
  globalThis.indexedDB = new IDBFactory();
});
it("restores scoped image drafts and persists removal", async () => {
  const image = {
    name: "example.png",
    block: { type: "image", mimeType: "image/png", data: "abc" },
  };
  await saveImageDrafts({
    "agent-a/project/session": [image],
    "agent-b/project/session": [],
  });
  expect(await loadImageDrafts()).toEqual({
    "agent-a/project/session": [image],
  });
  await saveImageDrafts({ "agent-a/project/session": [] });
  expect(await loadImageDrafts()).toEqual({});
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
  expect((await loadImageDrafts()).old).toHaveLength(1);
  expect(localStorage.getItem("aaw-desktop/image-drafts.v1")).toBeNull();
  await saveImageDrafts({ first: [image], second: [] });
  expect((await loadImageDrafts()).first?.[0]?.block).toEqual(image.block);
  await saveImageDrafts({ second: [image] });
  expect((await loadImageDrafts()).first).toBeUndefined();
});
