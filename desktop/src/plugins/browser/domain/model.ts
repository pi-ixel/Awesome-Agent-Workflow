export { browserObservationUrl } from "../../../shared/urlPrivacy.ts";

export function normalizeBrowserNavigationTarget(input: string): {
  url?: string;
  error?: "NAVIGATION_DENIED" | "INVALID_URL";
} {
  const value = input.trim();
  if (value === "about:blank") return { url: value };
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { error: "NAVIGATION_DENIED" };
    }
    return { url: value };
  } catch {
    return { error: "INVALID_URL" };
  }
}

export function changeBrowserPageZoom(
  pageZoom: number,
  direction: "in" | "out" | "reset",
): number {
  return direction === "reset"
    ? 1
    : Math.min(3, Math.max(0.25, pageZoom + (direction === "in" ? 0.1 : -0.1)));
}

export function calculateBrowserBounds(
  rect: { x: number; y: number; width: number; height: number },
  devicePixelRatio: number,
): { x: number; y: number; width: number; height: number } {
  if (
    !Number.isFinite(devicePixelRatio) ||
    devicePixelRatio <= 0 ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height)
  ) {
    throw new Error("INVALID_BOUNDS");
  }
  return {
    x: Math.round(rect.x * devicePixelRatio),
    y: Math.round(rect.y * devicePixelRatio),
    width: Math.round(rect.width * devicePixelRatio),
    height: Math.round(rect.height * devicePixelRatio),
  };
}

export function createBrowserRestorePlan(urls: readonly string[]): string[] {
  const result: string[] = [];
  for (const value of urls) {
    const target = normalizeBrowserNavigationTarget(value);
    if (target.url && !result.includes(target.url)) result.push(target.url);
  }
  return result;
}
