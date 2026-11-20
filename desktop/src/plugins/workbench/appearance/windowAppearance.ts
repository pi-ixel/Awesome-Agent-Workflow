import { normalizeUiFontSizePx } from "../config.ts";
import type { WorkbenchAppearance } from "../types.ts";
import { applyWindowAppearance } from "./appearance.ts";

const channelName = "aaw-desktop.appearance";

export function publishWorkbenchAppearance(
  appearance: WorkbenchAppearance,
): () => void {
  if (typeof BroadcastChannel !== "function") return () => {};
  const channel = new BroadcastChannel(channelName);
  const publish = () => {
    const { theme, uiFontSize } = appearance.getSnapshot();
    channel.postMessage({ theme, uiFontSize });
  };
  channel.onmessage = ({ data }) => {
    if (data === "request") publish();
  };
  const unsubscribe = appearance.subscribe(publish);
  publish();
  return () => {
    unsubscribe();
    channel.close();
  };
}

export function bindSecondaryWindowAppearance(
  root: HTMLElement,
  saved?: { theme?: unknown; uiFontSize?: unknown } | null,
): () => void {
  applyWindowAppearance(root, {
    theme: saved?.theme === "warm" ? "warm" : "dark",
    uiFontSize: normalizeUiFontSizePx(saved?.uiFontSize),
  });
  if (typeof BroadcastChannel !== "function") return () => {};
  const channel = new BroadcastChannel(channelName);
  channel.onmessage = ({ data }: MessageEvent<unknown>) => {
    if (
      data !== null && typeof data === "object" &&
      "theme" in data && "uiFontSize" in data &&
      (data.theme === "warm" || data.theme === "dark") &&
      typeof data.uiFontSize === "number"
    )
      applyWindowAppearance(root, {
        theme: data.theme,
        uiFontSize: normalizeUiFontSizePx(data.uiFontSize),
      });
  };
  channel.postMessage("request");
  return () => channel.close();
}
