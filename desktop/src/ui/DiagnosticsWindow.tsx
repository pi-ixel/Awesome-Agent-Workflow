import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import type { DiagnosticsStatus } from "../core/diagnosticsBridge.ts";
import logo from "../assets/aaw-logo.png";
import { PerfReport } from "./PerfHud.tsx";

export interface DiagnosticRecord {
  id: number;
  at: number;
  runId: string;
  source: string;
  level: string;
  channel: string;
  message: string;
  context: Record<string, unknown>;
}
interface Snapshot {
  at: number;
  data: {
    runtime: {
      sessionId?: string | null;
      workspacePath?: string;
      isActive?: boolean;
      listOnly?: boolean;
      agentCrashed?: string | null;
      busyReason?: string | null;
      [key: string]: unknown;
    }[];
    memory: { at: number; bytes: number }[];
    memorySamplingSupported: boolean;
    storage?: { bytes: number; projects: number };
    theme: string;
  };
}
const buttonClass =
  "rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-sm text-ink hover:bg-raised disabled:opacity-50";
const inputClass =
  "rounded-lg border border-line-strong bg-surface px-2 py-1.5 text-sm text-ink";

export function DiagnosticsWindow() {
  const [records, setRecords] = useState<DiagnosticRecord[]>([]);
  const [tab, setTab] = useState("logs");
  const [level, setLevel] = useState("");
  const [channel, setChannel] = useState("");
  const [text, setText] = useState("");
  const [operation, setOperation] = useState("");
  const [since, setSince] = useState("");
  const [paused, setPaused] = useState(false);
  const [status, setStatus] = useState<
    (DiagnosticsStatus & { latestId: number }) | null
  >(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [readError, setReadError] = useState("");
  const [error, setError] = useState(() =>
    isTauri() ? "" : "诊断历史需要 Desktop 原生服务，请在桌面客户端打开。",
  );
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<DiagnosticRecord | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlder, setHasOlder] = useState(true);
  const list = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const query = {
    level,
    channel: tab === "traffic" ? "acp" : channel,
    text,
    operation,
    since: since ? new Date(since).getTime() : undefined,
  };
  const queryKey = JSON.stringify(query);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    let stopped = false;
    let busy = false;
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        const next = await invoke<DiagnosticsStatus & { latestId: number }>(
          "diagnostics_status",
        );
        const state = await invoke<Snapshot | null>("diagnostics_snapshot");
        if (!stopped) {
          setStatus(next);
          setSnapshot(state);
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
      void poll();
    }, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let stopped = false;
    let busy = false;
    let cursor: number | undefined;
    generation.current++;
    const filters = JSON.parse(queryKey) as Record<string, unknown>;
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        const checkpoint = await invoke<
          DiagnosticsStatus & { latestId: number }
        >("diagnostics_status");
        const rows = await invoke<DiagnosticRecord[]>("diagnostics_query", {
          query: { ...filters, after: cursor },
        });
        if (stopped) return;
        const first = cursor === undefined;
        if (first) setHasOlder(true);
        setRecords((old) =>
          first
            ? rows
            : [
                ...old,
                ...rows.filter((row) => row.id > (old.at(-1)?.id ?? 0)),
              ].slice(-2000),
        );
        cursor = Math.max(checkpoint.latestId, rows.at(-1)?.id ?? 0);
        setReadError("");
        if (!paused)
          requestAnimationFrame(() => {
            if (list.current)
              list.current.scrollTop = list.current.scrollHeight;
          });
      } catch (e) {
        if (!stopped) setReadError(String(e));
      } finally {
        busy = false;
      }
    };
    // Pausing freezes the displayed snapshot only; native collection continues.
    const initial = paused
      ? undefined
      : setTimeout(() => {
          void refresh();
        }, 200);
    const timer = paused
      ? undefined
      : setInterval(() => {
          void refresh();
        }, 1000);
    return () => {
      stopped = true;
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [queryKey, paused]);

  async function older() {
    const expected = generation.current;
    setLoadingOlder(true);
    try {
      const rows = await invoke<DiagnosticRecord[]>("diagnostics_query", {
        query: { ...query, before: records[0]?.id },
      });
      if (expected !== generation.current) return;
      setRecords((old) => [...rows, ...old].slice(0, 5000));
      setHasOlder(rows.length === 500);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingOlder(false);
    }
  }
  async function exportLogs() {
    setError("");
    setNotice("");
    try {
      const path = await save({
        defaultPath: `aaw-diagnostics-${Date.now()}.jsonl`,
        filters: [{ name: "JSON Lines", extensions: ["jsonl"] }],
      });
      if (!path) return;
      const count = await invoke<number>("diagnostics_export", { path, query });
      setNotice(`已导出 ${count} 条匹配日志`);
    } catch (e) {
      setError(String(e));
    }
  }
  async function toggleDebug() {
    try {
      await invoke("diagnostics_debug", {
        enabled: !(status && status.debugUntil > status.now),
      });
      setStatus(await invoke("diagnostics_status"));
    } catch (e) {
      setError(String(e));
    }
  }
  const debug = status && status.debugUntil > status.now;
  return (
    <main className="flex h-screen flex-col gap-3 bg-base p-5 text-ink">
      <header className="flex flex-wrap items-center gap-3">
        <img src={logo} alt="" className="size-9" />
        <div className="mr-auto">
          <h1 className="text-lg font-semibold">AAW Desktop 诊断</h1>
          <p className="text-xs text-ink-mute">
            关闭此窗口不影响采集 · 保留 7 天 / 最多 100MB
          </p>
        </div>
        <button
          className={buttonClass}
          onClick={() => {
            void toggleDebug();
          }}
        >
          {debug
            ? `关闭详细日志（剩余 ${Math.ceil((status.debugUntil - status.now) / 60000)} 分钟）`
            : "详细日志 · 30 分钟"}
        </button>
        <button
          className={buttonClass}
          onClick={() => {
            void exportLogs();
          }}
        >
          导出匹配日志
        </button>
      </header>
      <nav aria-label="诊断视图" className="flex gap-2">
        {[
          ["logs", "运行日志"],
          ["traffic", "ACP 事件"],
          ["perf", "性能"],
          ["runtime", "运行时"],
        ].map(([id, name]) => (
          <button
            key={id}
            className={`${buttonClass} ${tab === id ? "bg-raised font-semibold" : ""}`}
            aria-pressed={tab === id}
            onClick={() => setTab(id!)}
          >
            {name}
          </button>
        ))}
      </nav>
      {error || readError || status?.error ? (
        <p role="alert" className="text-sm text-danger-ink">
          {error || readError || status?.error}
        </p>
      ) : null}
      {status?.droppedBatches ? (
        <p className="text-sm text-warn-ink">
          写入队列拥塞，累计 {status.droppedBatches} 批日志未保存。
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-ok-ink">
          {notice}
        </p>
      ) : null}
      {tab === "logs" || tab === "traffic" ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="日志级别"
              className={inputClass}
              value={level}
              onChange={(e) => {
                setLevel(e.target.value);
                setPaused(false);
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
              disabled={tab === "traffic"}
              onChange={(e) => {
                setChannel(e.target.value);
                setPaused(false);
              }}
            />
            <input
              aria-label="关键词"
              placeholder="搜索消息或错误"
              className={inputClass}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setPaused(false);
              }}
            />
            <input
              aria-label="操作关联标识"
              placeholder="操作关联标识"
              className={inputClass}
              value={operation}
              onChange={(e) => {
                setOperation(e.target.value);
                setPaused(false);
              }}
            />
            <input
              aria-label="起始时间"
              type="datetime-local"
              className={inputClass}
              value={since}
              onChange={(e) => {
                setSince(e.target.value);
                setPaused(false);
              }}
            />
            <button className={buttonClass} onClick={() => setPaused(!paused)}>
              {paused ? "恢复实时跟随" : "暂停跟随"}
            </button>
            <span className="text-xs text-ink-mute">
              当前显示 {records.length} 条
              {paused ? " · 已暂停画面，后台持续记录" : ""}
            </span>
          </div>
          <div
            ref={list}
            className="min-h-0 flex-1 overflow-auto rounded-lg border border-line"
            aria-label="日志列表"
          >
            <button
              className={`${buttonClass} m-2`}
              disabled={
                !paused || loadingOlder || !hasOlder || records.length >= 5000
              }
              onClick={() => {
                void older();
              }}
            >
              加载更早记录（先暂停跟随）
            </button>
            <table className="w-full table-fixed text-left text-xs">
              <thead className="sticky top-0 bg-surface">
                <tr>
                  <th className="w-40 p-2">时间</th>
                  <th className="w-16">级别</th>
                  <th className="w-32">模块 / 来源</th>
                  <th>消息 · 点击查看详情</th>
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
                    <td className="break-all">
                      {row.channel}
                      <br />
                      <span className="text-ink-mute">{row.source}</span>
                    </td>
                    <td>
                      <button
                        className="w-full whitespace-pre-wrap break-words p-2 text-left"
                        onClick={() => setSelected(row)}
                      >
                        {row.message}
                        {typeof row.context.durationMs === "number"
                          ? ` · ${row.context.durationMs}ms`
                          : ""}
                      </button>
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
        <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-line p-4">
          <p className="mb-3 text-sm text-ink-mute">
            来自主窗口，每 2 秒刷新。
            {snapshot
              ? `最近采样：${new Date(snapshot.at).toLocaleTimeString()}`
              : "等待主窗口快照…"}
          </p>
          {snapshot && status && status.now - snapshot.at > 10000 ? (
            <p className="text-warn-ink">
              主窗口状态更新延迟，以下为最近一次快照。
            </p>
          ) : null}
          {tab === "perf" ? (
            <PerfReport
              samples={snapshot?.data.memory ?? []}
              supported={snapshot?.data.memorySamplingSupported ?? false}
              storage={snapshot?.data.storage ?? { bytes: 0, projects: 0 }}
            />
          ) : (
            <>
              <h2 className="font-medium">主窗口会话运行状态</h2>
              <table className="mt-3 w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-line">
                    <th className="p-2">会话</th>
                    <th>项目</th>
                    <th>角色</th>
                    <th>运行状态</th>
                    <th>详情</th>
                  </tr>
                </thead>
                <tbody>
                  {(snapshot?.data.runtime ?? []).map((row, index) => (
                    <tr key={index} className="border-b border-line">
                      <td className="p-2 font-mono text-xs">
                        {String(row.sessionId ?? "未绑定")}
                      </td>
                      <td className="break-all text-xs">
                        {String(row.workspacePath ?? "")}
                      </td>
                      <td>
                        {row.isActive ? "当前" : row.listOnly ? "预热" : "后台"}
                      </td>
                      <td
                        className={
                          row.agentCrashed
                            ? "text-danger-ink"
                            : row.busyReason
                              ? "text-warn-ink"
                              : "text-ok-ink"
                        }
                      >
                        {String(row.agentCrashed ?? row.busyReason ?? "空闲")}
                      </td>
                      <td>
                        <details>
                          <summary className="cursor-pointer">展开</summary>
                          <pre className="max-w-sm whitespace-pre-wrap break-all text-xs">
                            {JSON.stringify(row, null, 2)}
                          </pre>
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {snapshot && snapshot.data.runtime.length === 0 ? (
                <p className="mt-3 text-sm text-ink-mute">
                  当前没有打开的会话。
                </p>
              ) : null}
            </>
          )}
        </div>
      )}
      {selected ? (
        <aside
          className="max-h-64 shrink-0 overflow-auto rounded-lg border border-line bg-surface p-3"
          aria-label="日志详情"
        >
          <div className="flex items-center justify-between">
            <strong className="text-sm">{selected.message}</strong>
            <button className={buttonClass} onClick={() => setSelected(null)}>
              关闭详情
            </button>
          </div>
          <p className="my-2 text-xs text-ink-mute">
            启动 {selected.runId} · 来源 {selected.source}
          </p>
          {typeof selected.context.operationId === "string" ? (
            <button
              className={buttonClass}
              onClick={() => {
                setOperation(String(selected.context.operationId));
                setPaused(false);
              }}
            >
              查看关联操作
            </button>
          ) : null}
          <pre className="mt-2 whitespace-pre-wrap break-all text-xs">
            {JSON.stringify(selected.context, null, 2)}
          </pre>
        </aside>
      ) : null}
    </main>
  );
}
