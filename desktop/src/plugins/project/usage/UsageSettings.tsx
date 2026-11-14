import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { MetricStrip } from "../../../shared/ui/MetricStrip.tsx";
import { Listbox } from "../../../shared/ui/controls.tsx";
import { SegmentedControl } from "../../../shared/ui/controls/SegmentedControl.tsx";
import { CircleHelpIcon } from "../../../shared/ui/icons.tsx";
import {
  queryUsage,
  retryUsage,
  usageState,
  type UsageSnapshot,
} from "./service.ts";
import {
  compactUsageNumber,
  summarizeUsage,
} from "./aggregate.ts";
import { UsageHeatmap } from "./UsageHeatmap.tsx";

const number = new Intl.NumberFormat("zh-CN");
const colors = [
  "#0b7fff",
  "#21a88a",
  "#9671e0",
  "#d88637",
  "#d45081",
  "#6a92a8",
];
type Day = { day: string; tokens: bigint };
type TrendSeries = { name: string; color: string; values: number[] };
const chartDate = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
  timeZone: "UTC",
});

function Trend({ days, series }: { days: Day[]; series: TrendSeries[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const draw = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      ctx.scale(ratio, ratio);
      const inset = Math.min(36, width / 8);
      const top = 10;
      const bottom = height - 28;
      const step = (width - 2 * inset) / Math.max(1, days.length - 1);
      const x = (index: number) => inset + step * index;
      const peak = Math.max(1, ...series.flatMap(({ values }) => values));
      const y = (value: number) => bottom - (value / peak) * (bottom - top);
      const theme = getComputedStyle(canvas);
      ctx.strokeStyle =
        theme.getPropertyValue("--color-line").trim() || "#e3e3e3";
      ctx.setLineDash([3, 3]);
      for (let line = 0; line <= 4; line++) {
        const row = top + ((bottom - top) * line) / 4;
        ctx.beginPath();
        ctx.moveTo(inset, row);
        ctx.lineTo(width - inset, row);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      for (const { color, values } of series) {
        // Monotone cubic interpolation preserves local maxima and keeps zero flat.
        const slopes = values.slice(1).map((value, i) => value - values[i]!);
        const slope = (i: number) => {
          const a = slopes[i - 1];
          const b = slopes[i];
          if (a === undefined || b === undefined) return a ?? b ?? 0;
          return a * b > 0 ? (2 * a * b) / (a + b) : 0;
        };
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x(0), y(values[0] ?? 0));
        for (let i = 1; i < values.length; i++) {
          ctx.bezierCurveTo(
            x(i - 1) + step / 3,
            y(values[i - 1]! + slope(i - 1) / 3),
            x(i) - step / 3,
            y(values[i]! - slope(i) / 3),
            x(i),
            y(values[i]!),
          );
        }
        ctx.stroke();
      }
      ctx.font = "13px " + theme.fontFamily;
      ctx.textAlign = "center";
      ctx.fillStyle =
        theme.getPropertyValue("--color-ink-mute").trim() || "#777";
      const ticks = Math.min(days.length, Math.max(2, Math.floor(width / 62)));
      for (let i = 0; i < ticks; i++) {
        const index = Math.round(
          (i * (days.length - 1)) / Math.max(1, ticks - 1),
        );
        ctx.fillText(
          chartDate.format(new Date(days[index]!.day + "T00:00:00Z")),
          x(index),
          bottom + 19,
        );
      }
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [days, series]);
  return (
    <>
      <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 px-3 text-ui-caption text-ink-mute">
        {series.map(({ name, color }, index) => (
          <li key={index} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="size-2.5 rounded-sm"
              style={{ backgroundColor: color }}
            />
            {name}
          </li>
        ))}
      </ul>
      <canvas
        ref={ref}
        className="h-60 w-full"
        role="img"
        aria-label={days
          .map(({ day, tokens }) => `${day}：${number.format(tokens)} Token`)
          .join("，")}
      />
    </>
  );
}

type AgentFilter = StoreApi<{ agent: string }>;

export function UsageAgentFilter({
  agents,
  filter,
}: {
  agents: readonly { id: string; displayName: string }[];
  filter: AgentFilter;
}) {
  const agent = useStore(filter, (state) => state.agent);
  return (
    <Listbox
      label="Agent"
      value={agent}
      options={[{ value: "", label: "全部 Agent" }, ...agents.map(({ id, displayName }) => ({ value: id, label: displayName }))]}
      onChange={(value) => filter.setState({ agent: value })}
      className="py-1.5 text-sm"
    />
  );
}

export function UsageSettings({ filter }: { filter: AgentFilter }) {
  const agent = useStore(filter, (state) => state.agent);
  const [range, setRange] = useState(7);
  const [displayRange, setDisplayRange] = useState(7);
  const [refresh, setRefresh] = useState(0);
  const [response, setResponse] = useState<{
    agent: string;
    snapshot: UsageSnapshot | null;
  }>();
  const [failure, setFailure] = useState<{ agent: string; message: string }>();
  const snapshot = response?.agent === agent ? response.snapshot : undefined;
  const queryError = failure?.agent === agent ? failure.message : "";
  const { revision, error } = useStore(usageState);
  useEffect(() => {
    let active = true;
    void queryUsage("", agent, range).then(
      (next) => {
        if (!active) return;
        setResponse({ agent, snapshot: next });
        setDisplayRange(range);
        setFailure(undefined);
      },
      (reason: unknown) => {
        if (!active) return;
        setFailure({ agent, message: String(reason) });
      },
    );
    return () => {
      active = false;
    };
  }, [agent, range, refresh, revision]);
  useEffect(() => {
    const timer = window.setInterval(
      () => setRefresh((value) => value + 1),
      60_000,
    );
    return () => window.clearInterval(timer);
  }, []);
  const usage = snapshot && summarizeUsage(snapshot, displayRange);
  const rangeTotal =
    usage?.trend.reduce((total, day) => total + day.tokens, 0n) ?? 0n;
  let angle = 0;
  const segments =
    usage?.models
      .filter((model) => model.tokens > 0)
      .map((model, index) => {
        const start = angle;
        angle += (Number(model.tokens) / Number(rangeTotal)) * 360;
        return `${colors[index % colors.length]} ${start}deg ${angle}deg`;
      }) ?? [];
  return (
    <section className="flex min-w-0 flex-col gap-5" aria-label="使用统计">
      {(error || queryError) && (
        <div role="alert" className="rounded-lg bg-surface p-3 text-danger-ink">
          {error ? `统计数据保存失败：${error}` : `统计读取失败：${queryError}`}
          <button
            type="button"
            className="ml-3 underline"
            onClick={() => {
              void retryUsage().then(() => setRefresh((value) => value + 1));
            }}
          >
            重试
          </button>
        </div>
      )}
      {snapshot === undefined && !queryError && (
        <p role="status">正在读取统计…</p>
      )}
      {snapshot === null && <p>使用统计需要桌面应用。</p>}
      {snapshot && usage && (
        <>
          <MetricStrip
            label="累计统计"
            metrics={[
              {
                label: "累计 Token",
                value: compactUsageNumber.format(usage.total),
                title: number.format(usage.total),
              },
              {
                label: "单日峰值 Token",
                value: compactUsageNumber.format(usage.peak),
                title: number.format(usage.peak),
              },
              {
                label: "当前连续天数",
                value: `${number.format(usage.current)} 天`,
              },
              {
                label: "最长连续天数",
                value: `${number.format(usage.longest)} 天`,
              },
            ]}
          />
          <UsageHeatmap days={usage.activity} />
          <section
            aria-label="每日 Token 趋势图"
            className="space-y-3 rounded-xl border border-line bg-surface p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <h3 className="text-ui-base font-medium text-ink">
                每日 Token 趋势图
              </h3>
              <SegmentedControl
                groupLabel="时间范围"
                value={displayRange}
                options={[{ value: 7, label: "近 7 天" }, { value: 30, label: "近 30 天" }]}
                onChange={setRange}
                className="ml-auto"
              />
            </div>
            <Trend
              days={usage.trend}
              series={usage.models
                .filter((model) => model.tokens > 0)
                .map((model, index) => ({
                  name: model.label,
                  color: colors[index % colors.length]!,
                  values: usage.trend.map(({ day }) =>
                    Number(model.daily?.get(day) ?? 0n),
                  ),
                }))}
            />
          </section>
          <section
            aria-label="模型用量"
            className="space-y-3 rounded-xl border border-line bg-surface p-4"
          >
            <h3 className="text-ui-base font-medium text-ink">模型用量</h3>
            <div className="grid items-center gap-4 px-3 py-3 md:grid-cols-2">
              {segments.length > 0 && (
                <div
                  aria-hidden="true"
                  className="mx-auto grid size-48 shrink-0 place-items-center rounded-full md:size-52"
                  style={{
                    background: `conic-gradient(${segments.join(",")})`,
                  }}
                >
                  <div className="grid size-[65%] place-content-center rounded-full bg-surface text-center text-xs">
                    <strong className="tabular-nums">
                      {compactUsageNumber.format(rangeTotal)}
                    </strong>
                    <span>Token</span>
                  </div>
                </div>
              )}
              {rangeTotal === 0n && (
                <p className="text-sm text-ink-mute">
                  此时间范围暂无 Token 用量。
                </p>
              )}
              <ul className="min-w-0">
                {usage.models
                  .filter((model) => model.tokens > 0)
                  .map((model, index) => (
                    <li
                      key={model.key}
                      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 border-b border-line py-2 text-ui-caption last:border-b-0"
                    >
                      <span
                        aria-hidden="true"
                        className="size-2.5 shrink-0 rounded-sm"
                        style={{ background: colors[index % colors.length] }}
                      />
                      <span className="flex min-w-0 items-center gap-1.5 font-mono">
                        <span className="min-w-0 wrap-anywhere">{model.label}</span>
                        {model.showModelId && model.model && (
                          <span
                            role="img"
                            tabIndex={0}
                            aria-label="模型 ID"
                            data-hint={model.model}
                            className="shrink-0 rounded text-ink-mute focus-visible:outline-2 focus-visible:outline-info"
                          >
                            <CircleHelpIcon className="size-3.5" />
                          </span>
                        )}
                      </span>
                      <span className="font-mono text-ink-mute tabular-nums">
                        {(
                          (Number(model.tokens) / Number(rangeTotal)) *
                          100
                        ).toFixed(1)}
                        %
                      </span>
                      <span
                        className="col-start-2 min-w-0 text-ink-mute"
                        data-hint={number.format(model.tokens)}
                      >
                        {compactUsageNumber.format(model.tokens)} tokens
                      </span>
                    </li>
                  ))}
              </ul>
            </div>
          </section>
        </>
      )}
    </section>
  );
}
