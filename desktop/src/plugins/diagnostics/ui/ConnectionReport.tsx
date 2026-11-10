import type {
  AcpConnectionDiagnostic,
  AcpProbeResult,
} from "../../acpConnection/types.ts";
import { CopyButton } from "../../../shared/ui/CopyButton.tsx";
import {
  matchRuntime,
  runtimeStatus,
  type RuntimeRow,
} from "./sessionPresentation.ts";

const button =
  "rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs text-ink transition-colors hover:bg-raised disabled:opacity-50";
const stateText = {
  initializing: "初始化中",
  ready: "就绪",
  failed: "故障",
  closing: "关闭中",
};
const stateColor = {
  initializing: "text-warn-ink bg-warn-bg",
  ready: "text-ok-ink bg-ok-bg",
  failed: "text-danger-ink bg-danger-bg",
  closing: "text-ink-mute bg-raised",
};
function probeText(probe: AcpProbeResult | null): string {
  if (!probe) return "尚未测试";
  return {
    success: `${probe.durationMs ?? "—"} ms`,
    busy: "连接忙碌，未测试",
    unsupported: "不支持测速",
    "no-project": "暂无可测试项目",
    unavailable: "连接不可用",
    error: `测试失败：${probe.message ?? "未知错误"}`,
  }[probe.status];
}
function RuntimeDetails({ row }: { row: RuntimeRow }) {
  return (
    <div className="mt-2 space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ink-soft">
        <span>{row.isActive ? "当前" : row.listOnly ? "预热" : "后台"}</span>
        <span
          className={
            row.agentCrashed
              ? "text-danger-ink"
              : row.busyReason || row.busy || Number(row.pendingApprovals) > 0
                ? "text-warn-ink"
                : "text-ink-mute"
          }
        >
          {String(runtimeStatus(row))}
        </span>
        {typeof row.turnState === "string" && <span>阶段 {row.turnState}</span>}
        {typeof row.queuedPrompts === "number" && (
          <span>排队 {row.queuedPrompts}</span>
        )}
        {typeof row.pendingApprovals === "number" && (
          <span>待审批 {row.pendingApprovals}</span>
        )}
      </div>
      <details>
        <summary className="cursor-pointer text-ink-mute hover:text-ink">
          运行详情
        </summary>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-base p-3 text-xs">
          {JSON.stringify(row, null, 2)}
        </pre>
      </details>
    </div>
  );
}
export interface ProbeFeedback {
  readonly startedAt: number;
  readonly pending: boolean;
  readonly text: string;
}

export function ConnectionReport({
  connections,
  probe,
  runtime = [],
  probeFeedback,
}: {
  readonly connections: readonly AcpConnectionDiagnostic[];
  readonly probe: (id: string) => void;
  readonly runtime?: readonly RuntimeRow[];
  readonly probeFeedback?: ReadonlyMap<string, ProbeFeedback>;
}) {
  const { matched, unmatched } = matchRuntime(connections, runtime);
  const pendingCount = connections.filter(
    (item) => probeFeedback?.get(item.id)?.pending,
  ).length;
  return (
    <section className="min-w-0 overflow-hidden rounded-xl border border-line bg-surface">
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold">
          ACP 连接{" "}
          <span className="ml-2 font-normal text-ink-mute">
            {connections.length}
          </span>
        </h2>
        <button
          className={button}
          disabled={!connections.length || pendingCount > 0}
          aria-busy={pendingCount > 0}
          onClick={() => connections.forEach((item) => probe(item.id))}
        >
          {pendingCount > 0 ? `测试中 · ${pendingCount} 条` : "测试全部"}
        </button>
      </header>
      <div className="divide-y divide-line">
        {connections.map((connection) => {
          const feedback = probeFeedback?.get(connection.id);
          const ready = connection.sessions.filter((s) => s.state === "ready");
          const projects = new Set(
            ready.flatMap((s) => (s.project ? [s.project.id] : [])),
          );
          const rows = connection.sessions.flatMap((s) => matched.get(s) ?? []);
          const alerts = [
            ...new Set(
              rows
                .filter(
                  (r) =>
                    r.agentCrashed ||
                    r.busyReason ||
                    r.busy ||
                    Number(r.pendingApprovals) > 0,
                )
                .map((r) => String(runtimeStatus(r))),
            ),
          ];
          return (
            <article key={connection.id} className="p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="mr-auto text-sm font-medium">
                  连接{" "}
                  <span className="font-mono text-xs text-ink-soft">
                    · {connection.id.slice(0, 8)}
                  </span>
                </h3>
                <span
                  className={`rounded-md px-2 py-0.5 text-xs ${stateColor[connection.state]}`}
                >
                  {stateText[connection.state]}
                </span>
              </div>
              <dl
                aria-label={`${connection.id} 负载`}
                className="my-3 grid grid-cols-3 gap-3"
              >
                {[
                  ["项目", projects.size],
                  ["session", ready.length],
                  ["执行中", ready.filter((s) => s.running).length],
                ].map(([name, count]) => (
                  <div key={name}>
                    <dt className="text-xs text-ink-mute">{name}</dt>
                    <dd className="mt-1 text-lg font-semibold tabular-nums">
                      {count}
                    </dd>
                  </div>
                ))}
              </dl>
              {alerts.length > 0 && (
                <p
                  className={`mb-3 break-words rounded-lg px-3 py-2 text-xs ${rows.some((r) => r.agentCrashed) ? "bg-danger-bg text-danger-ink" : "bg-warn-bg text-warn-ink"}`}
                >
                  {alerts.join(" · ")}
                </p>
              )}
              <div className="flex items-center justify-between gap-3">
                <p
                  role="status"
                  className={`min-w-0 break-words text-xs ${feedback ? (feedback.pending ? "text-info-ink" : "text-warn-ink") : connection.probe?.status === "error" ? "text-warn-ink" : connection.probe?.status === "success" ? "text-ok-ink" : "text-ink-mute"}`}
                >
                  {feedback?.text ?? probeText(connection.probe)}
                  {!feedback && connection.probe && (
                    <time className="ml-2 text-ink-mute">
                      {new Date(connection.probe.at).toLocaleTimeString()}
                    </time>
                  )}
                </p>
                <button
                  className={`${button} shrink-0`}
                  disabled={feedback?.pending}
                  aria-busy={feedback?.pending}
                  onClick={() => probe(connection.id)}
                >
                  {feedback?.pending ? "测试中…" : "测试"}
                </button>
              </div>
              <details className="mt-3 border-t border-line pt-3 text-xs">
                <summary className="cursor-pointer text-ink-soft hover:text-ink">
                  项目与 session 明细
                </summary>
                <div className="my-3 flex items-center gap-2 text-ink-mute">
                  <span className="min-w-0 break-all font-mono">
                    {connection.id}
                  </span>
                  <CopyButton
                    getText={() => connection.id}
                    label="复制连接 ID"
                  />
                </div>
                {connection.processHandle != null && (
                  <p className="mb-2 text-ink-mute">
                    进程句柄 {connection.processHandle}
                  </p>
                )}
                <ul className="space-y-2">
                  {connection.sessions.map((session) => (
                    <li
                      key={session.id}
                      className="rounded-lg border border-line bg-base/50 p-3"
                    >
                      <p className="break-all font-medium">
                        {session.project?.path ?? "未关联项目"}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                        <span className="break-all font-mono text-ink-mute">
                          {session.id}
                        </span>
                        <span
                          className={
                            session.running ? "text-info-ink" : "text-ink-mute"
                          }
                        >
                          {session.state === "loading"
                            ? "加载中"
                            : session.running
                              ? "执行中"
                              : "空闲"}
                        </span>
                      </div>
                      {(matched.get(session) ?? []).map((row, index) => (
                        <RuntimeDetails key={index} row={row} />
                      ))}
                    </li>
                  ))}
                </ul>
                {!connection.sessions.length && (
                  <p className="text-ink-mute">没有绑定的 session。</p>
                )}
              </details>
            </article>
          );
        })}
      </div>
      {!connections.length && (
        <p className="p-6 text-center text-sm text-ink-mute">
          当前没有受管理的连接。
        </p>
      )}
      {unmatched.length > 0 && (
        <section className="border-t border-line p-4">
          <h3 className="text-sm font-medium">
            未关联连接的会话{" "}
            <span className="ml-2 text-ink-mute">{unmatched.length}</span>
          </h3>
          {unmatched.map((row, index) => (
            <details
              key={index}
              className="mt-3 rounded-lg border border-line p-3 text-xs"
            >
              <summary className="cursor-pointer break-all text-ink-soft">
                <span className="font-mono">
                  {row.sessionId || "未绑定 session"}
                </span>
                <span
                  className={`ml-3 ${row.agentCrashed ? "text-danger-ink" : row.busyReason || row.busy ? "text-warn-ink" : "text-ink-mute"}`}
                >
                  {String(runtimeStatus(row))}
                </span>
                {row.listOnly && (
                  <span className="ml-2 text-ink-mute">预热</span>
                )}
              </summary>
              <p className="mt-3 break-all">
                {row.workspacePath || "未关联项目"}
              </p>
              <RuntimeDetails row={row} />
            </details>
          ))}
        </section>
      )}
    </section>
  );
}
