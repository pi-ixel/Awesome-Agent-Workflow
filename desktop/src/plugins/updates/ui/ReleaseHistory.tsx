import { Disclosure } from "../../../shared/ui/Disclosure.tsx";
import { useRef, useState } from "react";
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
    <Disclosure
      layout="row"
      className="border-t border-line px-4"
      onOpenChange={(open) => {
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
      summary="详细更新日志"
    >
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
            <Disclosure
              layout="row"
              key={release.version}
              defaultOpen={index === 0}
              summary={
                <>
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
                </>
              }
            >
              <div className="pb-3 pl-5 [overflow-wrap:anywhere] [&_h1]:text-ui-lg [&_h2]:text-sm [&_h3]:text-sm">
                <MarkdownView
                  text={release.notes.trim() || "此版本暂无详细更新说明。"}
                  onOpenExternal={openExternal}
                />
              </div>
            </Disclosure>
          ))}
        </div>
      )}
    </Disclosure>
  );
}
