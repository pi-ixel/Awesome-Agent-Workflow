import type { DraftImage } from "../../../../contracts/composer.ts";
export function imageLimitError(images: readonly DraftImage[]): string | null {
  if (images.length > 5) return "每条消息最多添加 5 张图片";
  const sizes = images.map(({ block }) =>
    block.type === "image" && typeof block.data === "string"
      ? Math.floor((block.data.length * 3) / 4) -
        (block.data.endsWith("==") ? 2 : block.data.endsWith("=") ? 1 : 0)
      : 0,
  );
  if (sizes.some((size) => size > 10 * 1024 * 1024))
    return "单张图片不能超过 10 MB";
  if (sizes.reduce((a, b) => a + b, 0) > 20 * 1024 * 1024)
    return "图片总大小不能超过 20 MB";
  return null;
}

export async function readImageFiles(files: File[]): Promise<DraftImage[]> {
  if (files.length > 5) throw new Error("每条消息最多添加 5 张图片");
  if (files.some((file) => !/^image\/(png|jpeg|webp|gif)$/.test(file.type)))
    throw new Error("仅支持 PNG、JPEG、WebP、GIF 图片");
  if (files.some((file) => file.size > 10 * 1024 * 1024))
    throw new Error("单张图片不能超过 10 MB");
  if (files.reduce((sum, file) => sum + file.size, 0) > 20 * 1024 * 1024)
    throw new Error("图片总大小不能超过 20 MB");
  return Promise.all(
    files.map(async (file) => ({
      name: file.name || "截图",
      block: {
        type: "image",
        mimeType: file.type,
        data: await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error("图片读取失败，请重试"));
          reader.onload = () =>
            resolve(
              typeof reader.result === "string"
                ? (reader.result.split(",")[1] ?? "")
                : "",
            );
          reader.readAsDataURL(file);
        }),
      },
    })),
  );
}
