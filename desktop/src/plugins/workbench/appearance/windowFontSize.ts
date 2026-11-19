import { normalizeUiFontSizePx } from "../config.ts";
import type { WorkbenchAppearance } from "../types.ts";

const channelName = "aaw-desktop.ui-font-size";

export function publishWorkbenchFontSize(
  appearance: WorkbenchAppearance,
): () => void {
  if (typeof BroadcastChannel !== "function") return () => {};
  const channel = new BroadcastChannel(channelName);
  const publish = () =>
    channel.postMessage(appearance.getSnapshot().uiFontSize);
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

export function bindSecondaryWindowFontSize(
  root: HTMLElement,
  savedSize: unknown,
): () => void {
  const setSize = (size: unknown) =>
    root.style.setProperty(
      "--ui-font-size",
      `${normalizeUiFontSizePx(size)}px`,
    );
  setSize(savedSize);
  if (typeof BroadcastChannel !== "function") return () => {};
  const channel = new BroadcastChannel(channelName);
  channel.onmessage = ({ data }) => {
    if (typeof data === "number") setSize(data);
  };
  channel.postMessage("request");
  return () => channel.close();
}
