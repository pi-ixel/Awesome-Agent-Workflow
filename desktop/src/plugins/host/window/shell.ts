import { isTauriEnv } from "../adapters/host.ts";

export async function openExternal(url: string): Promise<void> {
  const { protocol } = new URL(url);
  if (protocol !== "http:" && protocol !== "https:")
    throw new Error("仅支持打开 HTTP 和 HTTPS 链接");
  if (isTauriEnv()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
