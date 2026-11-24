import { Disclosure } from "../../../shared/ui/Disclosure.tsx";
import { BadgeDot, Listbox, StatusDot } from "../../../shared/ui/controls.tsx";
import { useState, type ReactNode } from "react";
import { MetricStrip } from "../../../shared/ui/MetricStrip.tsx";
import type { AcpConnectionDiagnostic } from "../../acpConnection/types.ts";
import type {
  DesktopMemoryPoint,
  DesktopTurnMemory,
  DiagnosticSessionKey,
  ResourceGroup,
  ResourceSnapshot,
} from "../types.ts";

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
const panel = "min-w-0 rounded-popover border border-line bg-surface";

function DesktopWorkingSetDetails({
  current,
  turn,
}: {
  readonly current: DesktopMemoryPoint | null | undefined;
  readonly turn: DesktopTurnMemory | null | undefined;
}) {
  const rows = [
    { key: "total", label: "Desktop 合计" },
    { key: "executable", label: "主程序" },
    { key: "interface", label: "主界面 WebView2" },
    { key: "browser", label: "内嵌浏览器" },
    { key: "other", label: "其他 Desktop 子进程" },
  ] as const;
  const columns = [
    ...(turn
      ? [
          { label: "轮前", point: turn.before },
          { label: "峰值时刻", point: turn.peak },
        ]
      : []),
    { label: "当前", point: current },
  ];
  const showOther = columns.some(
    ({ point }) => point && point.memory.other !== 0,
  );
  return (
    <Disclosure
      defaultOpen
      layout="row"
      className="mt-3 border-t border-line"
      summary="工作集明细"
    >
      {turn?.hasOverlap && (
        <p className="mb-2 text-ui-caption text-warn-ink">
          本轮有其他会话同时运行。表中是这段时间整个 Desktop 的读数。
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-ui-caption tabular-nums">
          <thead className="text-ink-mute">
            <tr>
              <th scope="col" className="pb-1 font-normal">
                组成
              </th>
              {columns.map(({ label, point }) => (
                <th
                  key={label}
                  scope="col"
                  className="pb-1 pl-2 text-right font-normal whitespace-nowrap"
                >
                  {label}
                  {point && (
                    <span className="block">
                      {new Date(point.at).toLocaleTimeString()}
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows
              .filter(({ key }) => key !== "other" || showOther)
              .map(({ key, label }) => (
                <tr key={key} className="border-t border-line">
                  <th scope="row" className="py-1.5 pr-1 font-medium">
                    {label}
                  </th>
                  {columns.map(({ label, point }) => {
                    const bytes = point?.memory[key] ?? null;
                    const before = turn?.before?.memory[key];
                    const change =
                      label === "峰值时刻" && bytes !== null && before != null
                        ? bytes - before
                        : 0;
                    return (
                      <td
                        key={label}
                        className="py-1.5 pl-2 text-right whitespace-nowrap"
                      >
                        {memory(bytes)}
                        {change !== 0 && (
                          <span
                            className="block text-ink-mute"
                            data-hint="较轮前变化"
                          >
                            {change > 0 ? "+" : "−"}
                            {memory(Math.abs(change))}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-ui-caption text-ink-mute">
        {turn?.peak && "峰值按 Desktop 合计取样，各项对应同一时刻。"}
        {turn && !turn.peak && "本轮暂无有效读数，约每 2 秒采样一次。"}
        {!turn && "当前会话暂无轮次对照。"}
        工作集按进程相加，共享页可能重复计入。
      </p>
    </Disclosure>
  );
}

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
              <BadgeDot className="mr-1.5 ui-icon-8" />
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
  focusedSession,
  connections,
  now,
  children,
  jsHeapBytes,
}: {
  readonly resources: ResourceSnapshot | null;
  readonly focusedSession?: DiagnosticSessionKey;
  readonly connections: readonly AcpConnectionDiagnostic[];
  readonly now?: number;
  readonly jsHeapBytes?: number;
  readonly children?: ReactNode;
}) {
  const [selected, setSelected] = useState("all");
  const latest = resources?.groups ?? [];
  const history = resources?.history ?? [];
  const desktop = latest.find((g) => g.id === "desktop");
  const savedTurn = resources?.turnMemory;
  const turn =
    savedTurn &&
    savedTurn.session.scope === focusedSession?.scope &&
    savedTurn.session.sessionId === focusedSession.sessionId
      ? savedTurn
      : undefined;
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
      <div className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-[minmax(0,1.8fr)_1fr_1.25fr]">
        <section className={`${panel} p-4`}>
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <StatusDot tone="info" className="ui-icon-8" />
            Desktop
          </h2>
          <MetricStrip
            embedded
            label="Desktop"
            metrics={[
              { label: "CPU", value: cpu(desktop?.cpuPercent ?? null) },
              { label: "工作集", value: memory(desktop?.memoryBytes ?? null) },
            ]}
          />
          <DesktopWorkingSetDetails
            current={resources?.desktopMemory}
            turn={turn}
          />
        </section>
        <section className={`${panel} p-4`}>
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <StatusDot tone="ok" className="ui-icon-8" />
            全部 agent
          </h2>
          <MetricStrip
            embedded
            label="全部 agent"
            metrics={[
              { label: "CPU", value: cpu(agentTotal.cpuPercent) },
              { label: "内存", value: memory(agentTotal.memoryBytes) },
            ]}
          />
        </section>
        <section className={`${panel} p-4 md:col-span-2 xl:col-span-1`}>
          <h2 className="text-sm font-medium">连接负载</h2>
          <MetricStrip
            embedded
            label="连接负载"
            metrics={[
              { label: "ACP 连接", value: connections.length },
              { label: "项目", value: projects.size },
              { label: "session", value: ready.length },
              { label: "执行中", value: ready.filter((s) => s.running).length },
            ]}
          />
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
          className="rounded-control bg-danger-bg px-4 py-2 text-sm text-danger-ink"
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
          <div className="flex items-center gap-2 text-xs text-ink-mute">
            <span>监控对象</span>
            <Listbox
              label="监控对象"
              value={selection}
              onChange={setSelected}
              className="py-1.5 text-ui-sm"
              options={[
                { value: "all", label: "Desktop 与全部 agent" },
                ...latest.map(({ id, rootPid }) => ({
                  value: id,
                  label: `${label(id)} · PID ${rootPid}`,
                })),
                ...historical.map(([id, pid]) => ({
                  value: id,
                  label: `${label(id)} · PID ${pid}`,
                  group: "历史进程组",
                })),
              ]}
            />
          </div>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <Chart title="CPU" unit="cpu" series={chartSeries("cpuPercent")} />
          <Chart
            title="内存工作集"
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
                <Disclosure
                  layout="row"
                  key={id}
                  className="text-xs"
                  summary={
                    <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_5rem_6rem] items-center gap-2 pr-4">
                      <span className="min-w-0">
                        <span className="text-sm font-medium">{label(id)}</span>
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
                    </span>
                  }
                >
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
                </Disclosure>
              );
            })}
          </div>
          {!latest.length && (
            <p className="p-6 text-center text-sm text-ink-mute">
              暂无进程数据
            </p>
          )}
          {historical.length > 0 && (
            <Disclosure
              className="border-t border-line px-4 py-3 text-xs text-ink-mute"
              summary={<>历史进程组 · {historical.length}</>}
            >
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
            </Disclosure>
          )}
        </section>
        {children}
      </div>
    </div>
  );
}
