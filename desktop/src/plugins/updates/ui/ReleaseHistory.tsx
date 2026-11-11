import { useRef, useState } from "react";
import { ChevronDownIcon } from "../../../shared/ui/icons.tsx";
import { MarkdownView } from "../../../shared/ui/MarkdownView.tsx";
import type { UpdatesService } from "../service.ts";
import {
  fetchReleaseHistory,
  readReleaseHistory,
} from "../updater/releaseHistory.ts";

export function ReleaseHistory({
  currentVersion,
  openExternal,
}: {
  readonly currentVersion?: string;
  readonly openExternal: UpdatesService["openExternal"];
}) {
  const [releases, setReleases] = useState(readReleaseHistory);
  const [status, setStatus] = useState<
    "idle" | "loading" | "ready" | "offline"
  >("idle");
  const [expanded, setExpanded] = useState(false);
  const requested = useRef(false);

  return (
    <details
      className="group/history border-t border-line px-4"
      onToggle={(event) => {
        const open = event.currentTarget.open;
        setExpanded(open);
        if (!open || requested.current) return;
        requested.current = true;
        setStatus("loading");
        void fetchReleaseHistory().then(
          (history) => {
            setReleases(history);
            setStatus("ready");
          },
          () => {
            requested.current = false;
            setStatus("offline");
          },
        );
      }}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-3 text-ui-base font-medium [&::-webkit-details-marker]:hidden">
        详细更新日志
        <ChevronDownIcon className="size-4 shrink-0 text-ink-mute group-open/history:rotate-180" />
      </summary>
      {status === "loading" && (
        <p role="status" className="mb-2 text-ui-caption text-ink-mute">
          正在获取更新日志…
        </p>
      )}
      {status === "offline" && (
        <p role="status" className="mb-2 text-ui-caption text-ink-mute">
          {releases.length
            ? "暂时无法获取在线日志，正在显示本地记录。"
            : "暂时无法获取更新日志。"}
        </p>
      )}
      {expanded && (
        <div className="divide-y divide-line pb-2">
          {releases.map((release, index) => (
            <details
              key={release.version}
              open={index === 0}
              className="group/release"
            >
              <summary className="flex cursor-pointer list-none items-center gap-2 py-2 text-sm [&::-webkit-details-marker]:hidden">
                <ChevronDownIcon className="size-3 shrink-0 -rotate-90 text-ink-mute group-open/release:rotate-0" />
                <span className="font-medium">v{release.version}</span>
                {release.version === currentVersion && (
                  <span className="text-ui-caption text-ink-mute">
                    当前版本
                  </span>
                )}
                <time
                  dateTime={release.publishedAt}
                  className="ml-auto text-ui-caption text-ink-mute"
                >
                  {release.publishedAt.slice(0, 10)}
                </time>
              </summary>
              <div className="pb-3 pl-5 [overflow-wrap:anywhere] [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm">
                <MarkdownView
                  text={release.notes.trim() || "此版本暂无详细更新说明。"}
                  onOpenExternal={openExternal}
                />
              </div>
            </details>
          ))}
        </div>
      )}
    </details>
  );
}
