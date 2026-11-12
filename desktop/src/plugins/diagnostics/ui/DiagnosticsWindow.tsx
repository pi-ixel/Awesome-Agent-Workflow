import { StorageView } from "./StorageView.tsx";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  DiagnosticRecord,
  DiagnosticsReader,
  DiagnosticsSnapshot,
  DiagnosticsStatus,
  ResourceSnapshot,
} from "../types.ts";
import logo from "../../../shared/assets/aaw-logo.png";
import { CopyButton } from "../../../shared/ui/CopyButton.tsx";
import { ConnectionReport, type ProbeFeedback } from "./ConnectionReport.tsx";
import { ResourceReport } from "./ResourceReport.tsx";

const buttonClass =
  "rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-sm text-ink hover:bg-raised disabled:opacity-50";
const inputClass =
  "rounded-lg border border-line-strong bg-surface px-2 py-1.5 text-sm text-ink";
const pressFeedback =
  "[&_button:enabled:active]:translate-y-px [&_button:enabled:active]:brightness-90 [&_summary:active]:brightness-90 [&_button:focus-visible]:outline-2 [&_button:focus-visible]:outline-offset-2 [&_button:focus-visible]:outline-accent-ink";
const PROBE_FEEDBACK_TIMEOUT_MS = 15_000;

export function DiagnosticsWindow({
  reader,
}: {
  readonly reader: DiagnosticsReader;
}) {
  const [records, setRecords] = useState<DiagnosticRecord[]>([]);
  const [tab, setTab] = useState("logs");
  const [level, setLevel] = useState("");
  const [channel, setChannel] = useState("");
  const [text, setText] = useState("");
  const [since, setSince] = useState("");
  const [status, setStatus] = useState<DiagnosticsStatus | null>(null);
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null);
  const [resources, setResources] = useState<ResourceSnapshot | null>(null);
  const [readError, setReadError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportFeedback, setExportFeedback] = useState<{
    text: string;
    error?: boolean;
  }>();
  const [probeFeedback, setProbeFeedback] = useState(
    new Map<string, ProbeFeedback>(),
  );
  const [raw, setRaw] = useState<{
    id: number;
    text: string;
    error: string;
    loading: boolean;
  } | null>(null);
  async function showRaw(id: number) {
    setRaw({ id, text: "", error: "", loading: true });
    try {
      const text = await reader.raw(id);
      setRaw((current) =>
        current?.id === id ? { id, text, error: "", loading: false } : current,
      );
    } catch (error) {
      setRaw((current) =>
        current?.id === id
          ? { id, text: "", error: String(error), loading: false }
          : current,
      );
    }
  }
  const [hover, setHover] = useState<{
    row: DiagnosticRecord;
    left: number;
    top: number;
    width: number;
  } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const keepDetails = () => clearTimeout(hoverTimer.current);
  const hideDetails = () => {
    keepDetails();
    hoverTimer.current = setTimeout(() => setHover(null), 180);
  };
  const showDetails = (row: DiagnosticRecord, element: HTMLElement) => {
    keepDetails();
    const rect = element.getBoundingClientRect();
    const width = Math.min(720, window.innerWidth - 32);
    setHover({
      row,
      width,
      left: Math.max(16, Math.min(rect.left, window.innerWidth - width - 16)),
      top: Math.max(
        16,
        Math.min(
          rect.bottom + 4,
          window.innerHeight - Math.min(360, window.innerHeight - 32) - 16,
        ),
      ),
    });
  };
  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState("");
  const [hasOlder, setHasOlder] = useState(true);
  const inspecting = useRef(false);
  useEffect(() => {
    inspecting.current = hover !== null;
  }, [hover]);
  const list = useRef<HTMLDivElement>(null);
  const followTail = useRef(true);
  useLayoutEffect(() => {
    const viewport = list.current;
    if (viewport && followTail.current && !inspecting.current) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [records, tab]);
  const generation = useRef(0);
  const query = {
    level,
    channel,
    text,
    since: since ? new Date(since).getTime() : undefined,
  };
  const queryKey = JSON.stringify(query);

  useEffect(() => {
    if (!reader.isNative()) {
      return;
    }
    let stopped = false;
    let busy = false;
    const syncProbeFeedback = (state?: DiagnosticsSnapshot | null) => {
      const connections = state?.data.connections;
      const now = Date.now();
      setProbeFeedback((previous) => {
        let next: Map<string, ProbeFeedback> | undefined;
        for (const [id, feedback] of previous) {
          const connection = connections?.find((item) => item.id === id);
          if (
            (connections && !connection) ||
            (connection?.probe && connection.probe.at >= feedback.startedAt)
          ) {
            (next ??= new Map(previous)).delete(id);
          } else if (
            feedback.pending &&
            now - feedback.startedAt >= PROBE_FEEDBACK_TIMEOUT_MS
          ) {
            (next ??= new Map(previous)).set(id, {
              ...feedback,
              pending: false,
              text: "暂未收到测速结果",
            });
          }
        }
        return next ?? previous;
      });
    };
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        const next = await reader.status();
        if (stopped) return;
        const state = await reader.snapshot();
        if (stopped) return;
        setSnapshot(state);
        syncProbeFeedback(state);
        const resourceState = await reader.resources().catch(() => null);
        if (!stopped) {
          setStatus(next);
          setResources(resourceState);
          if (state)
            document.documentElement.classList.toggle(
              "theme-warm",
              state.data.theme === "warm",
            );
        }
      } catch (e) {
        if (!stopped) setReadError(String(e));
      } finally {
        busy = false;
      }
    };
    void poll();
    const timer = setInterval(() => {
      syncProbeFeedback();
      void poll();
    }, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [reader]);

  useEffect(() => {
    if (!reader.isNative()) return;
    let stopped = false;
    let busy = false;
    let cursor: number | undefined;
    generation.current++;
    const filters = JSON.parse(queryKey) as Record<string, unknown>;
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        const checkpoint = await reader.status();
        if (stopped) return;
        const rows = await reader.query({ ...filters, after: cursor });
        if (stopped) return;
        const first = cursor === undefined;
        if (first) setHasOlder(true);
        if (first) {
          setRecords(rows);
        } else if (rows.length) {
          const following = followTail.current;
          setRecords((old) => {
            const added = rows.filter((row) => row.id > (old.at(-1)?.id ?? 0));
            const limit = following ? Math.max(2000, old.length) : 5000;
            return added.length ? [...old, ...added].slice(-limit) : old;
          });
        }
        cursor = Math.max(checkpoint.latestId, rows.at(-1)?.id ?? 0);
        setReadError("");
      } catch (e) {
        if (!stopped) setReadError(String(e));
      } finally {
        busy = false;
      }
    };
    const initial = setTimeout(() => {
      void refresh();
    }, 200);
    const timer = setInterval(() => {
      void refresh();
    }, 1000);
    return () => {
      stopped = true;
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [queryKey, reader]);

  async function older() {
    const expected = generation.current;
    const oldest = records[0];
    if (!oldest) return;
    followTail.current = false;
    setLoadingOlder(true);
    setOlderError("");
    try {
      const rows = await reader.query({ ...query, before: oldest.id });
      if (expected !== generation.current) return;
      setRecords((old) => {
        const remaining = 5000 - old.length;
        return remaining > 0 && rows.length
          ? [...rows.slice(-remaining), ...old]
          : old;
      });
      setHasOlder(rows.length === 500);
    } catch (e) {
      if (expected === generation.current) setOlderError(String(e));
    } finally {
      setLoadingOlder(false);
    }
  }
  async function exportLogs() {
    setExporting(true);
    setExportFeedback(undefined);
    try {
      const count = await reader.export(query);
      setExportFeedback({
        text: count === null ? "已取消导出" : `已导出 ${count} 条匹配日志`,
      });
    } catch (e) {
      setExportFeedback({ text: `导出失败：${String(e)}`, error: true });
    } finally {
      setExporting(false);
    }
  }
  async function probeConnection(id: string) {
    const startedAt = Date.now();
    setProbeFeedback((previous) =>
      new Map(previous).set(id, {
        startedAt,
        pending: true,
        text: "正在提交测速…",
      }),
    );
    function update(pending: boolean, text: string) {
      setProbeFeedback((previous) => {
        const current = previous.get(id);
        if (current?.startedAt !== startedAt || !current.pending)
          return previous;
        return new Map(previous).set(id, { startedAt, pending, text });
      });
    }
    try {
      await reader.probeConnection(id);
      update(true, "等待测速结果…");
    } catch (e) {
      update(false, `无法提交测速：${String(e)}`);
    }
  }
  const globalError = !reader.isNative()
    ? "诊断历史需要 Desktop 原生服务，请在桌面客户端打开。"
    : readError || status?.error;
  return (
    <main
      className={`flex h-screen flex-col gap-3 bg-base p-5 text-ink ${pressFeedback}`}
    >
      <header className="flex flex-wrap items-center gap-3">
        <img src={logo} alt="" className="size-9" />
        <div className="mr-auto">
          <h1 className="text-lg font-semibold">AAW Desktop 诊断</h1>
          <p className="text-xs text-ink-mute">
            {tab === "storage"
              ? "本地数据占用、保存状态与分类清理"
              : "关闭此窗口不影响采集 · ACP 原文包含消息、工具参数及图片数据"}
          </p>
        </div>
        {tab === "logs" && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {exportFeedback && (
              <span
                role={exportFeedback.error ? "alert" : "status"}
                className={`text-xs ${exportFeedback.error ? "text-danger-ink" : "text-ink-soft"}`}
              >
                {exportFeedback.text}
              </span>
            )}
            <button
              className={buttonClass}
              disabled={exporting || !reader.isNative()}
              aria-busy={exporting}
              onClick={() => {
                void exportLogs();
              }}
            >
              {exporting ? "正在导出…" : "导出匹配日志"}
            </button>
          </div>
        )}
      </header>
      <nav aria-label="诊断视图" className="flex gap-2">
        {[
          ["logs", "日志"],
          ["resources", "资源与连接"],
          ["storage", "存储"],
        ].map(([id, name]) => (
          <button
            key={id}
            className={`${buttonClass} aria-pressed:border-accent-ink aria-pressed:bg-raised aria-pressed:font-semibold`}
            aria-pressed={tab === id}
            onClick={() => {
              setHover(null);
              setTab(id!);
            }}
          >
            {name}
          </button>
        ))}
      </nav>
      {globalError ? (
        <p role="alert" className="text-sm text-danger-ink">
          {globalError}
        </p>
      ) : null}
      {status?.droppedBatches ? (
        <p className="text-sm text-warn-ink">
          写入队列曾拥塞，累计 {status.droppedBatches}{" "}
          次写入请求被拒。部分请求可能已重试成功。
        </p>
      ) : null}
      {tab === "storage" ? (
        <StorageView request={reader.storage} />
      ) : tab === "logs" ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="日志级别"
              className={inputClass}
              value={level}
              onChange={(e) => {
                setLevel(e.target.value);
                followTail.current = true;
              }}
            >
              <option value="">全部级别</option>
              {["debug", "info", "warn", "error"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
            <input
              aria-label="模块"
              placeholder="模块，如 host、acp"
              className={inputClass}
              value={channel}
              onChange={(e) => {
                setChannel(e.target.value);
                followTail.current = true;
              }}
            />
            <input
              aria-label="关键词"
              placeholder="搜索消息、详情或关联 ID"
              className={inputClass}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                followTail.current = true;
              }}
            />
            <input
              aria-label="起始时间"
              type="datetime-local"
              className={inputClass}
              value={since}
              onChange={(e) => {
                setSince(e.target.value);
                followTail.current = true;
              }}
            />
            <span className="text-xs text-ink-mute">
              当前显示 {records.length} 条
            </span>
          </div>
          <div
            ref={list}
            className="min-h-0 flex-1 overflow-auto rounded-xl border border-line bg-surface"
            aria-label="日志列表"
            onScroll={(event) => {
              const { scrollHeight, scrollTop, clientHeight } =
                event.currentTarget;
              followTail.current = scrollHeight - scrollTop - clientHeight <= 2;
              setHover(null);
            }}
          >
            <button
              className={`${buttonClass} m-2`}
              aria-busy={loadingOlder}
              disabled={
                !records.length ||
                loadingOlder ||
                !hasOlder ||
                records.length >= 5000
              }
              onClick={() => {
                void older();
              }}
            >
              {loadingOlder
                ? "正在加载…"
                : !hasOlder
                  ? "没有更早的记录"
                  : records.length >= 5000
                    ? "已达到显示上限"
                    : "加载更早记录"}
            </button>
            {olderError && (
              <span role="alert" className="text-xs text-danger-ink">
                加载失败：{olderError}
              </span>
            )}
            <table className="w-full table-fixed text-left text-xs">
              <thead className="sticky top-0 bg-surface">
                <tr>
                  <th className="w-40 p-2">时间</th>
                  <th className="w-16">级别</th>
                  <th className="w-32">模块 / 来源</th>
                  <th className="w-1/4">消息</th>
                  <th>详情</th>
                </tr>
              </thead>
              <tbody>
                {records.map((row) => (
                  <tr
                    key={row.id}
                    className="border-t border-line hover:bg-hover"
                  >
                    <td className="p-2 align-top">
                      {new Date(row.at).toLocaleString()}
                    </td>
                    <td
                      className={
                        row.level === "error"
                          ? "text-danger-ink"
                          : "text-ink-soft"
                      }
                    >
                      {row.level}
                    </td>
                    <td
                      className="truncate whitespace-nowrap"
                      title={`${row.channel} / ${row.source}`}
                    >
                      {row.channel}
                      {" / "}
                      <span className="text-ink-mute">{row.source}</span>
                    </td>
                    <td
                      className="truncate whitespace-nowrap p-2"
                      title={row.message}
                    >
                      {row.message}
                      {typeof row.context.durationMs === "number"
                        ? ` · ${row.context.durationMs}ms`
                        : ""}
                      {row.hasRaw ? (
                        <button
                          className="ml-2 rounded px-1 underline hover:bg-raised"
                          onClick={() => {
                            void showRaw(row.id);
                          }}
                        >
                          查看原文
                        </button>
                      ) : null}
                    </td>
                    <td className="p-2">
                      <div
                        tabIndex={0}
                        aria-label={`详情：${row.message}`}
                        className="truncate whitespace-nowrap font-mono text-ink-soft outline-offset-2"
                        onMouseEnter={(event) =>
                          showDetails(row, event.currentTarget)
                        }
                        onMouseLeave={hideDetails}
                        onFocus={(event) =>
                          showDetails(row, event.currentTarget)
                        }
                        onBlur={hideDetails}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") setHover(null);
                        }}
                      >
                        {JSON.stringify(row.context)}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!records.length ? (
              <p className="p-6 text-sm text-ink-mute">
                暂无匹配日志。可在主窗口执行操作，或调整筛选条件。
              </p>
            ) : null}
          </div>
        </>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <p className="mb-3 text-xs text-ink-mute">
            每 2 秒自动更新
            {snapshot
              ? " · " + new Date(snapshot.at).toLocaleTimeString() + " 更新"
              : " · 等待主窗口快照"}
          </p>
          {snapshot && status && status.now - snapshot.at > 10000 ? (
            <p className="text-warn-ink">
              主窗口状态更新延迟，以下为最近一次快照。
            </p>
          ) : null}
          <>
            <ResourceReport
              resources={resources}
              connections={snapshot?.data.connections ?? []}
              now={status?.now}
              jsHeapBytes={
                snapshot?.data.memorySamplingSupported
                  ? snapshot.data.memory?.at(-1)?.bytes
                  : undefined
              }
            >
              <ConnectionReport
                runtime={snapshot?.data.runtime ?? []}
                connections={snapshot?.data.connections ?? []}
                probeFeedback={probeFeedback}
                probe={(id) => {
                  void probeConnection(id);
                }}
              />
            </ResourceReport>
          </>
        </div>
      )}
      {raw
        ? createPortal(
            <aside
              role="dialog"
              aria-label="ACP 原始报文"
              className={`fixed inset-8 z-[60] flex flex-col gap-3 rounded-lg border border-line bg-surface p-4 text-ink shadow-lg ${pressFeedback}`}
              onKeyDown={(event) => {
                if (event.key === "Escape") setRaw(null);
              }}
            >
              <div className="flex gap-3">
                <h2 className="mr-auto font-medium">ACP 原始报文 · {raw.id}</h2>
                {raw.loading || raw.error ? (
                  <button className={buttonClass} disabled>
                    复制原文
                  </button>
                ) : (
                  <CopyButton
                    key={raw.id}
                    label="复制原文"
                    getText={() => raw.text}
                  />
                )}
                <button className={buttonClass} onClick={() => setRaw(null)}>
                  关闭原文
                </button>
              </div>
              {raw.error ? (
                <p role="alert">{raw.error}</p>
              ) : raw.loading ? (
                <p>正在读取原文…</p>
              ) : (
                <pre className="min-h-0 flex-1 select-text overflow-auto whitespace-pre-wrap break-all text-xs">
                  {raw.text}
                </pre>
              )}
            </aside>,
            document.body,
          )
        : null}
      {hover
        ? createPortal(
            <aside
              role="dialog"
              aria-label="原始日志详情"
              className={`fixed z-50 flex max-h-[min(360px,calc(100vh-32px))] flex-col rounded-lg border border-line-strong bg-surface p-3 text-ink shadow-lg ${pressFeedback}`}
              style={{ left: hover.left, top: hover.top, width: hover.width }}
              onMouseEnter={keepDetails}
              onMouseLeave={hideDetails}
              onFocus={keepDetails}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget))
                  hideDetails();
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") setHover(null);
              }}
            >
              <div className="mb-2 flex items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate">
                  {hover.row.message} · {hover.row.source} · {hover.row.runId}
                </span>
                {typeof hover.row.context.operationId === "string" ? (
                  <button
                    className={buttonClass}
                    onClick={() => {
                      setText(String(hover.row.context.operationId));
                      followTail.current = true;
                      setHover(null);
                    }}
                  >
                    关联操作
                  </button>
                ) : null}
                <CopyButton
                  key={hover.row.id}
                  getText={() => JSON.stringify(hover.row.context, null, 2)}
                />
                <button className={buttonClass} onClick={() => setHover(null)}>
                  关闭
                </button>
              </div>
              <pre className="min-h-0 select-text overflow-auto whitespace-pre-wrap break-all text-xs">
                {JSON.stringify(hover.row.context, null, 2)}
              </pre>
            </aside>,
            document.body,
          )
        : null}
    </main>
  );
}
