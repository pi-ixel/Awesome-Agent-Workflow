/**
 * 运行日志视图：读取 logStore 镜像（真相源是 core/logger 的环形缓冲）。
 *
 * 能力：级别过滤（选中级别及以上）、通道关键字过滤、全局日志级别调整、
 * 清空缓冲；列表按写入序展示并自动滚动到底部。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import type { DiagnosticsService } from "../../../contracts/diagnostics.ts";
import type { LogLevel } from "../../../shared/diagnosticEvents/logger.ts";
import { Listbox } from "../../../shared/ui/controls";

/** 级别排序（数值越高越严重），供「及以上」过滤使用。 */
const levelSequence: readonly LogLevel[] = ["debug", "info", "warn", "error"];

const levelTone: Readonly<Record<LogLevel, string>> = {
  debug: "text-ink-faint",
  info: "text-accent-ink",
  warn: "text-warn-ink",
  error: "text-danger-ink",
};

/** 过滤选项：全部 或 某一级别（含更严重级别）。 */
type LevelFilter = "all" | LogLevel;

function LogView({ logs }: { logs: DiagnosticsService["logs"] }) {
  const entries = useStore(logs, (state) => state.entries);
  const globalLevel = useStore(logs, (state) => state.level);
  const setGlobalLevel = useStore(logs, (state) => state.setLevel);
  const clear = useStore(logs, (state) => state.clear);

  const [levelFilter, setLevelFilter] = useState<LevelFilter>("all");
  const [channelFilter, setChannelFilter] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => {
    const keyword = channelFilter.trim().toLowerCase();
    const minIndex =
      levelFilter === "all" ? -1 : levelSequence.indexOf(levelFilter);
    return entries.filter((entry) => {
      if (minIndex >= 0 && levelSequence.indexOf(entry.level) < minIndex) {
        return false;
      }
      if (
        keyword.length > 0 &&
        !entry.channel.toLowerCase().includes(keyword)
      ) {
        return false;
      }
      return true;
    });
  }, [entries, levelFilter, channelFilter]);

  // 新日志到达时保持视口贴底
  useEffect(() => {
    const list = listRef.current;
    if (list !== null) {
      list.scrollTop = list.scrollHeight;
    }
  }, [filtered.length]);

  return (
    <div className="rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <span className="flex items-center gap-2 text-xs text-ink-mute">
          级别
          <Listbox
            label="日志级别过滤"
            value={levelFilter}
            options={[
              { value: "all", label: "全部" },
              ...levelSequence.map((level) => ({
                value: level,
                label: `${level} 及以上`,
              })),
            ]}
            onChange={(next) => {
              setLevelFilter(next as LevelFilter);
            }}
          />
        </span>
        <label className="flex items-center gap-2 text-xs text-ink-mute">
          通道
          <input
            aria-label="日志通道过滤"
            type="text"
            value={channelFilter}
            placeholder="如 acp / aaw / store"
            onChange={(event) => {
              setChannelFilter(event.target.value);
            }}
            className="w-36 rounded-md border border-line-strong bg-base px-2 py-1 text-xs text-ink placeholder:text-ink-ghost focus:border-ink-faint focus:outline-none"
          />
        </label>
        <span className="flex items-center gap-2 text-xs text-ink-mute">
          全局级别
          <Listbox
            label="全局日志级别"
            value={globalLevel}
            options={levelSequence.map((level) => ({
              value: level,
              label: level,
            }))}
            onChange={(next) => {
              setGlobalLevel(next as LogLevel);
            }}
          />
        </span>
        <span className="ml-auto text-xs text-ink-faint">
          {`显示 ${filtered.length} / ${entries.length} 条`}
        </span>
        <button
          type="button"
          onClick={clear}
          className="rounded-md border border-line-strong px-2.5 py-1 text-xs text-ink-soft transition-colors hover:border-ink-faint hover:text-ink"
        >
          清空
        </button>
      </div>
      <div
        ref={listRef}
        className="max-h-96 overflow-y-auto px-4 py-3 font-mono text-xs leading-relaxed"
        data-testid="log-list"
      >
        {filtered.length === 0 ? (
          <p className="text-ink-ghost">
            暂无日志。全局级别高于 debug 时低级别日志不会进入缓冲。
          </p>
        ) : (
          <ul className="space-y-1">
            {filtered.map((entry) => (
              <li key={entry.seq} className="flex gap-2">
                <span className="shrink-0 text-ink-ghost">
                  {entry.timestamp.slice(11, 23)}
                </span>
                <span
                  className={`w-12 shrink-0 ${levelTone[entry.level] ?? ""}`}
                >
                  {entry.level}
                </span>
                <span className="w-20 shrink-0 truncate text-ink-faint">
                  [{entry.channel}]
                </span>
                <span className="min-w-0 break-all text-ink-soft">
                  {entry.message}
                  {Object.keys(entry.context).length > 0
                    ? ` ${JSON.stringify(entry.context)}`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default LogView;
