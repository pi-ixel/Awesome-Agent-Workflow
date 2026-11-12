import { useState, type ReactNode } from "react";
import { MetricStrip } from "../../../shared/ui/MetricStrip.tsx";
import type { AcpConnectionDiagnostic } from "../../acpConnection/types.ts";
import type { ResourceGroup, ResourceSnapshot } from "../types.ts";

type Totals = Pick<ResourceGroup, "cpuPercent" | "memoryBytes">;
const empty: Totals = { cpuPercent: null, memoryBytes: null };
function sum(groups: readonly Totals[]): Totals {
  return {
    cpuPercent: groups.every((g) => g.cpuPercent !== null)
      ? groups.reduce((n, g) => n + (g.cpuPercent ?? 0), 0)
      : null,
    memoryBytes: groups.every((g) => g.memoryBytes !== null)
      ? groups.reduce((n, g) => n + (g.memoryBytes ?? 0), 0)
      : null,
  };
}
function cpu(value: number | null) {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}
function memory(value: number | null) {
  return value === null
    ? "—"
    : value >= 1024 ** 3
      ? `${(value / 1024 ** 3).toFixed(2)} GiB`
      : `${(value / 1024 ** 2).toFixed(0)} MiB`;
}
function label(id: string) {
  return id === "desktop" ? "Desktop" : `Agent · 句柄 ${id.slice(6)}`;
}
const panel = "min-w-0 rounded-xl border border-line bg-surface";
type Series = {
  name: string;
  color: string;
  points: { at: number; value: number | null }[];
};
function Chart({
  series,
  title,
  unit,
}: {
  series: Series[];
  title: string;
  unit: "cpu" | "memory";
}) {
  const all = series.flatMap((s) => s.points);
  const last = Math.max(0, ...all.map((p) => p.at));
  const max =
    unit === "cpu"
      ? 100
      : Math.max(1024 ** 2, ...all.map((p) => p.value ?? 0)) * 1.15;
  const format = unit === "cpu" ? cpu : memory;
  return (
    <section className={`${panel} p-4`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{title}</h3>
        <div className="flex flex-wrap gap-4 text-xs">
          {series.map((s) => (
            <span key={s.name} className={s.color}>
              <span
                aria-hidden="true"
                className="mr-1.5 inline-block h-2 w-2 rounded-full bg-current"
              />
              {s.name}{" "}
              <strong className="ml-1 font-medium tabular-nums">
                {format(s.points.at(-1)?.value ?? null)}
              </strong>
            </span>
          ))}
        </div>
      </div>
      <div className="relative mt-5 pl-14">
        <div className="absolute inset-y-0 left-0 flex flex-col justify-between pb-1 text-xs tabular-nums text-ink-mute">
          <span>{format(max)}</span>
          <span>{format(max / 2)}</span>
          <span>0</span>
        </div>
        <svg
          role="img"
          aria-label={`${title}最近 15 分钟趋势`}
          viewBox="0 0 600 160"
          preserveAspectRatio="none"
          className="h-40 w-full overflow-visible"
        >
          <path
            d="M0 4H600 M0 80H600 M0 156H600"
            stroke="currentColor"
            className="text-line-strong"
            strokeDasharray="3 5"
            fill="none"
          />
          {series.map((s) => {
            const segments: string[][] = [];
            let segment: string[] = [];
            let previous = 0;
            for (const point of s.points) {
              if (
                point.value === null ||
                (previous && point.at - previous > 6000)
              ) {
                if (segment.length) segments.push(segment);
                segment = [];
              }
              previous = point.at;
              if (point.value === null) continue;
              const x = Math.max(
                0,
                Math.min(600, 600 - ((last - point.at) / 900000) * 600),
              );
              segment.push(
                `${x.toFixed(2)},${(156 - Math.min(1, point.value / max) * 152).toFixed(2)}`,
              );
            }
            if (segment.length) segments.push(segment);
            return (
              <g key={s.name} className={s.color}>
                {segments.map((points, index) => (
                  <g key={index}>
                    <polygon
                      points={`${points[0]!.split(",")[0]},156 ${points.join(" ")} ${points.at(-1)!.split(",")[0]},156`}
                      fill="currentColor"
                      opacity=".06"
                    />
                    <polyline
                      points={points.join(" ")}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      vectorEffect="non-scaling-stroke"
                    />
                    <circle
                      cx={points.at(-1)!.split(",")[0]}
                      cy={points.at(-1)!.split(",")[1]}
                      r="2.5"
                      fill="currentColor"
                    />
                  </g>
                ))}
              </g>
            );
          })}
        </svg>
        {!all.some((p) => p.value !== null) && (
          <span className="absolute inset-0 flex items-center justify-center text-xs text-ink-mute">
            暂无趋势数据
          </span>
        )}
      </div>
      <div className="mt-3 flex justify-between pl-14 text-xs text-ink-mute">
        <span>15 分钟前</span>
        <span>现在</span>
      </div>
    </section>
  );
}

export function ResourceReport({
  resources,
  connections,
  now,
  children,
  jsHeapBytes,
}: {
  readonly resources: ResourceSnapshot | null;
  readonly connections: readonly AcpConnectionDiagnostic[];
  readonly now?: number;
  readonly jsHeapBytes?: number;
  readonly children?: ReactNode;
}) {
  const [selected, setSelected] = useState("all");
  const latest = resources?.groups ?? [];
  const history = resources?.history ?? [];
  const desktop = latest.find((g) => g.id === "desktop");
  const agents = latest.filter((g) => g.handle !== null);
  const agentTotal =
    resources?.supported && history.length ? sum(agents) : empty;
  const known = new Map<string, number>();
  for (const frame of history)
    for (const g of frame.groups) known.set(g.id, g.rootPid);
  const exits = new Map<string, number>();
  for (const exited of resources?.exited ?? []) {
    const id = `agent:${exited.handle}`;
    known.set(id, exited.pid);
    exits.set(id, exited.observedAt);
  }
  const currentIds = new Set(latest.map((g) => g.id));
  for (const g of latest) known.set(g.id, g.rootPid);
  const historical = [...known].filter(([id]) => !currentIds.has(id));
  const selection =
    selected === "all" || known.has(selected) ? selected : "all";
  const sources =
    selection === "all"
      ? [
          { id: "desktop", name: "Desktop", color: "text-info-ink" },
          { id: "agents", name: "全部 agent", color: "text-ok-ink" },
        ]
      : [{ id: selection, name: label(selection), color: "text-info-ink" }];
  const chartSeries = (metric: keyof Totals): Series[] =>
    sources.map((s) => ({
      ...s,
      points: history.map((frame) => ({
        at: frame.at,
        value: (s.id === "agents"
          ? sum(frame.groups.filter((g) => g.handle !== null))
          : (frame.groups.find((g) => g.id === s.id) ?? empty))[metric],
      })),
    }));
  const ready = connections.flatMap((c) =>
    c.sessions.filter((s) => s.state === "ready"),
  );
  const projects = new Set(
    ready.flatMap((s) => (s.project ? [s.project.id] : [])),
  );
  const newest = history.at(-1)?.at;
  return (
    <div className="space-y-5">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[1fr_1fr_1.25fr]">
        {[
          { name: "Desktop", metrics: desktop ?? empty, color: "bg-info-ink" },
          { name: "全部 agent", metrics: agentTotal, color: "bg-ok-ink" },
        ].map(({ name, metrics, color }) => (
          <section key={name} className={`${panel} p-4`}>
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <span className={`h-2 w-2 rounded-full ${color}`} />
              {name}
            </h2>
            <MetricStrip embedded label={name} metrics={[
              { label: "CPU", value: cpu(metrics.cpuPercent) },
              { label: "内存", value: memory(metrics.memoryBytes) },
            ]} />
          </section>
        ))}
        <section className={`${panel} p-4 md:col-span-2 xl:col-span-1`}>
          <h2 className="text-sm font-medium">连接负载</h2>
          <MetricStrip embedded label="连接负载" metrics={[
            { label: "ACP 连接", value: connections.length },
            { label: "项目", value: projects.size },
            { label: "session", value: ready.length },
            { label: "执行中", value: ready.filter((s) => s.running).length },
          ]} />
        </section>
      </div>
      {!resources ? (
        <p className="text-sm text-ink-mute">等待资源采样…</p>
      ) : !resources.supported ? (
        <p className="text-sm text-ink-mute">此平台不支持进程资源监控。</p>
      ) : null}
      {resources?.error && (
        <p
          role="alert"
          className="rounded-lg bg-danger-bg px-4 py-2 text-sm text-danger-ink"
        >
          采样失败：{resources.error}
        </p>
      )}
      {newest && now && now - newest > 10000 ? (
        <p className="text-sm text-warn-ink">资源采样已过期。</p>
      ) : null}
      {latest.some((g) => g.incomplete) && (
        <p className="text-xs text-warn-ink">部分进程读数不完整</p>
      )}
      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">资源趋势</h2>
          <label className="flex items-center gap-2 text-xs text-ink-mute">
            监控对象
            <select
              className="max-w-full rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs text-ink"
              value={selection}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="all">Desktop 与全部 agent</option>
              {latest.map(({ id, rootPid }) => (
                <option key={id} value={id}>
                  {label(id)} · PID {rootPid}
                </option>
              ))}
              {historical.length > 0 && (
                <optgroup label="历史进程组">
                  {historical.map(([id, pid]) => (
                    <option key={id} value={id}>
                      {label(id)} · PID {pid}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <Chart title="CPU" unit="cpu" series={chartSeries("cpuPercent")} />
          <Chart
            title="物理内存"
            unit="memory"
            series={chartSeries("memoryBytes")}
          />
        </div>
      </section>
      <div className="grid items-start gap-3 xl:grid-cols-2">
        <section className={`${panel} overflow-hidden`}>
          <header className="border-b border-line px-4 py-4">
            <h2 className="text-sm font-semibold">
              当前进程组{" "}
              <span className="ml-2 font-normal text-ink-mute">
                {latest.length}
              </span>
            </h2>
          </header>
          <div className="grid grid-cols-[minmax(0,1fr)_5rem_6rem] gap-2 bg-raised/50 px-4 py-2 text-xs text-ink-mute">
            <span>进程组</span>
            <span className="text-right">CPU</span>
            <span className="text-right">内存</span>
          </div>
          <div className="divide-y divide-line">
            {latest.map((group) => {
              const { id, rootPid, handle } = group;
              const connection = connections.find(
                (c) => handle !== null && c.processHandle === handle,
              );
              return (
                <details key={id} className="group text-xs">
                  <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_5rem_6rem] items-center gap-2 px-4 py-3 hover:bg-raised/50 [&::-webkit-details-marker]:hidden">
                    <span className="min-w-0">
                      <span className="text-sm font-medium">
                        <span className="mr-2 inline-block text-ink-mute transition-transform group-open:rotate-90">
                          ›
                        </span>
                        {label(id)}
                      </span>
                      <span className="mt-1 block pl-4 text-ink-mute">
                        PID {rootPid}
                        {group.incomplete && " · 读数不完整"}
                      </span>
                    </span>
                    <span className="text-right tabular-nums">
                      {cpu(group.cpuPercent)}
                    </span>
                    <span className="text-right tabular-nums">
                      {memory(group.memoryBytes)}
                    </span>
                  </summary>
                  <div className="space-y-3 border-t border-line bg-base/50 p-4">
                    {id === "desktop" && (
                      <dl className="flex items-center justify-between gap-3">
                        <dt
                          className="text-ink-mute"
                          data-hint="主窗口 JavaScript 堆当前占用"
                        >
                          前端 JS 堆
                        </dt>
                        <dd className="tabular-nums">
                          {jsHeapBytes === undefined
                            ? "暂无读数"
                            : memory(jsHeapBytes)}
                        </dd>
                      </dl>
                    )}
                    {connection && (
                      <p className="break-all text-ink-mute">
                        ACP 连接：{connection.id}
                      </p>
                    )}
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead className="text-ink-mute">
                          <tr>
                            <th className="pb-2 font-normal">进程</th>
                            <th className="pb-2 font-normal">PID / 父 PID</th>
                            <th className="pb-2 text-right font-normal">CPU</th>
                            <th className="pb-2 text-right font-normal">
                              内存
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.processes.map((p) => (
                            <tr key={p.pid} className="border-t border-line">
                              <td className="py-2 pr-2 break-all">{p.name}</td>
                              <td className="whitespace-nowrap pr-2 tabular-nums">
                                {p.pid} / {p.parentPid}
                              </td>
                              <td className="whitespace-nowrap text-right tabular-nums">
                                {cpu(p.cpuPercent)}
                              </td>
                              <td className="whitespace-nowrap pl-2 text-right tabular-nums">
                                {memory(p.memoryBytes)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </details>
              );
            })}
          </div>
          {!latest.length && (
            <p className="p-6 text-center text-sm text-ink-mute">
              暂无进程数据
            </p>
          )}
          {historical.length > 0 && (
            <details className="border-t border-line px-4 py-3 text-xs text-ink-mute">
              <summary className="cursor-pointer">
                历史进程组 · {historical.length}
              </summary>
              <ul className="mt-3 space-y-2">
                {historical.map(([id, pid]) => {
                  const observedAt = exits.get(id);
                  return (
                    <li key={id}>
                      {label(id)} · PID {pid} ·{" "}
                      {observedAt !== undefined
                        ? `检测到退出 ${new Date(observedAt).toLocaleTimeString()}`
                        : "无法追踪"}
                    </li>
                  );
                })}
              </ul>
            </details>
          )}
        </section>
        {children}
      </div>
    </div>
  );
}
