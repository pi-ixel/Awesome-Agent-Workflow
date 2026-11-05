import { expect, it } from "vitest";
import {
  readImageFiles,
  imageLimitError,
} from "../../../src/ui/session/imageFiles.ts";
it("rejects oversized and unsupported files before reading", async () => {
  await expect(
    readImageFiles([
      new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.png", {
        type: "image/png",
      }),
    ]),
  ).rejects.toThrow("单张图片");
  await expect(
    readImageFiles([new File(["text"], "file.txt", { type: "text/plain" })]),
  ).rejects.toThrow("仅支持");
});
it("checks the total size across existing and new attachments", () => {
  const image = {
    name: "image",
    block: {
      type: "image",
      mimeType: "image/png",
      data: "a".repeat((8 * 1024 * 1024 * 4) / 3),
    },
  };
  expect(imageLimitError([image, image])).toBeNull();
  expect(imageLimitError([image, image, image])).toContain("总大小");
});
