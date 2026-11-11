import { version as buildVersion } from "../../../../package.json";

export interface DesktopReleaseNote {
  readonly version: string;
  readonly publishedAt: string;
  readonly notes: string;
}

const limit = 5;
const pageSize = 100;
const stableVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const cacheKey = "aaw-desktop.release-history.v1";
const bundledFiles = import.meta.glob<string>(
  "../../../../release-notes/*.md",
  {
    eager: true,
    query: "?raw",
    import: "default",
  },
);

function compareVersions(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true });
}

function splitNotes(markdown: string) {
  const text = markdown.trim().replaceAll("\r\n", "\n");
  const header =
    /^# AAW Desktop [\d.]+\n+发布日期：(\d{4}-\d{2}-\d{2})\n+/.exec(text);
  return {
    date: header?.[1],
    notes: header ? text.slice(header[0].length) : text,
  };
}

function bundledHistory(): DesktopReleaseNote[] {
  return Object.entries(bundledFiles)
    .flatMap(([path, markdown]) => {
      const version = path.split("/").at(-1)?.slice(0, -3);
      // Earlier notes include unpublished builds. The five releases at launch start at 0.1.23.
      if (
        !version ||
        !stableVersion.test(version) ||
        compareVersions(version, "0.1.23") < 0 ||
        compareVersions(version, buildVersion) > 0
      )
        return [];
      const { date, notes } = splitNotes(markdown);
      return date ? [{ version, publishedAt: date, notes }] : [];
    })
    .sort(
      (a, b) =>
        b.publishedAt.localeCompare(a.publishedAt) ||
        compareVersions(b.version, a.version),
    )
    .slice(0, limit);
}

function isReleaseNote(value: unknown): value is DesktopReleaseNote {
  if (!value || typeof value !== "object") return false;
  const note = value as Partial<DesktopReleaseNote>;
  return (
    typeof note.version === "string" &&
    stableVersion.test(note.version) &&
    typeof note.publishedAt === "string" &&
    Number.isFinite(Date.parse(note.publishedAt)) &&
    typeof note.notes === "string"
  );
}

export function readReleaseHistory(): DesktopReleaseNote[] {
  try {
    const cached: unknown = JSON.parse(
      localStorage.getItem(cacheKey) ?? "null",
    );
    if (Array.isArray(cached) && cached.length && cached.every(isReleaseNote))
      return cached.slice(0, limit);
  } catch {
    // Local storage can be unavailable.
  }
  return bundledHistory();
}

export async function fetchReleaseHistory(): Promise<DesktopReleaseNote[]> {
  const signal = AbortSignal.timeout(10_000);
  const releases: DesktopReleaseNote[] = [];
  for (let page = 1; ; page++) {
    const url = new URL(
      "https://api.github.com/repos/pi-ixel/Awesome-Agent-Workflow/releases",
    );
    url.search = new URLSearchParams({
      per_page: String(pageSize),
      page: String(page),
    }).toString();
    const response = await fetch(url, { signal });
    if (!response.ok)
      throw new Error(`GitHub Releases HTTP ${response.status}`);
    const items: unknown = await response.json();
    if (!Array.isArray(items)) throw new Error("Invalid GitHub release list");
    for (const item of items as unknown[]) {
      if (!item || typeof item !== "object") continue;
      const release = item as Record<string, unknown>;
      if (
        release.draft !== false ||
        release.prerelease !== false ||
        typeof release.tag_name !== "string" ||
        !release.tag_name.startsWith("desktop-v")
      )
        continue;
      const note = {
        version: release.tag_name.slice("desktop-v".length),
        publishedAt: release.published_at,
        notes:
          typeof release.body === "string"
            ? splitNotes(release.body).notes
            : "",
      };
      if (isReleaseNote(note)) releases.push(note);
    }
    if (items.length < pageSize) break;
  }

  const latest = releases
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, limit);
  if (!latest.length) throw new Error("No published Desktop releases");
  try {
    localStorage.setItem(cacheKey, JSON.stringify(latest));
  } catch {
    // Keep showing the fetched notes if the cache cannot be written.
  }
  return latest;
}
