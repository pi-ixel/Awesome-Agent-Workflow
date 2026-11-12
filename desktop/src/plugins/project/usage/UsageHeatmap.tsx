import { useState } from "react";
import { hintTooltipProps } from "../../../shared/ui/controls/HintTooltip.tsx";
import { SegmentedControl } from "../../../shared/ui/controls/SegmentedControl.tsx";
import { compactUsageNumber } from "./aggregate.ts";

export interface UsageDay {
  day: string;
  tokens: bigint;
  missing: number;
  turns: number;
}

const dayMs = 86_400_000;
const weeksShown = 52;
const grid = { gridTemplateColumns: `repeat(${weeksShown}, minmax(0, 1fr))` };
const colors = [
  "color-mix(in oklab, currentColor 4%, transparent)",
  "color-mix(in oklab, #0b7fff 18%, var(--color-surface))",
  "color-mix(in oklab, #0b7fff 36%, var(--color-surface))",
  "color-mix(in oklab, #0b7fff 58%, var(--color-surface))",
  "color-mix(in oklab, #0066dd 82%, var(--color-surface))",
];
const modes = [
  ["daily", "每日"],
  ["weekly", "每周"],
  ["cumulative", "累计"],
] as const;
const fullDay = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "long",
  timeZone: "UTC",
});
const asDate = (day: string) => new Date(day + "T00:00:00Z");

function tooltip(day: UsageDay, prefix = "") {
  return `${fullDay.format(asDate(day.day))}${prefix}\n${compactUsageNumber.format(day.tokens)} tokens · ${compactUsageNumber.format(day.turns)} 轮消息${day.missing ? ` · ${day.missing} 轮用量未知` : ""}`;
}

function Cell({ level }: { level: number }) {
  return (
    <span
      aria-hidden="true"
      className={`block aspect-square min-w-0 rounded-[4px] border transition-transform hover:scale-110 hover:border-line-strong ${level ? "border-line" : "border-transparent"}`}
      style={{ backgroundColor: colors[level] }}
    />
  );
}

function DailyCell({ day, peak }: { day: UsageDay; peak: bigint }) {
  const label = tooltip(day);
  const hint = hintTooltipProps(label);
  return (
    <span
      {...hint}
      aria-label={label.replace("\n", " ")}
      role="img"
      tabIndex={day.turns ? 0 : undefined}
    >
      <Cell level={scaled(day.tokens, peak, 4)} />
    </span>
  );
}

function WeeklyColumn({
  day,
  peak,
  cumulative,
}: {
  day: UsageDay;
  peak: bigint;
  cumulative: boolean;
}) {
  const label = tooltip(day, cumulative ? "（截至当周）" : "（当周）");
  const hint = hintTooltipProps(label);
  const level = scaled(day.tokens, peak, 4);
  const filled = scaled(day.tokens, peak, 7);
  return (
    <div
      {...hint}
      aria-label={label.replace("\n", " ")}
      role="img"
      tabIndex={day.turns ? 0 : undefined}
      className="flex min-w-0 flex-col gap-1"
    >
      {Array.from({ length: 7 }, (_, row) => (
        <Cell key={row} level={row >= 7 - filled ? level : 0} />
      ))}
    </div>
  );
}

function scaled(value: bigint, peak: bigint, levels: number) {
  if (peak === 0n) return 0;
  return Number((value * BigInt(levels) + peak - 1n) / peak);
}

export function UsageHeatmap({ days }: { days: UsageDay[] }) {
  const [mode, setMode] = useState<(typeof modes)[number][0]>("daily");
  const last = asDate(days.at(-1)!.day);
  const start =
    last.getTime() - (last.getUTCDay() + (weeksShown - 1) * 7) * dayMs;
  const byDay = new Map(days.map((day) => [day.day, day]));
  const weeks = Array.from({ length: weeksShown }, (_, column) =>
    Array.from({ length: 7 }, (_, row) => {
      const day = new Date(start + (column * 7 + row) * dayMs)
        .toISOString()
        .slice(0, 10);
      return byDay.get(day) ?? { day, tokens: 0n, missing: 0, turns: 0 };
    }),
  );
  const totals: UsageDay[] = [];
  const months = Array.from(
    { length: 12 },
    (_, index) => ((last.getUTCMonth() + index + 1) % 12) + 1,
  );
  let dailyPeak = 0n;
  let weeklyPeak = 0n;
  for (const week of weeks) {
    const previous = mode === "cumulative" ? totals.at(-1) : undefined;
    const total = {
      day: week[6]!.day,
      tokens: previous?.tokens ?? 0n,
      turns: previous?.turns ?? 0,
      missing: previous?.missing ?? 0,
    };
    for (const day of week) {
      if (day.tokens > dailyPeak) dailyPeak = day.tokens;
      total.tokens += day.tokens;
      total.turns += day.turns;
      total.missing += day.missing;
    }
    if (total.tokens > weeklyPeak) weeklyPeak = total.tokens;
    totals.push(total);
  }
  return (
    <section
      className="rounded-xl border border-line bg-surface px-3 py-3"
      aria-label="Token 活动"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="min-w-0 truncate text-ui-base font-medium text-ink">
          Token 活动
        </h3>
        <SegmentedControl
          groupLabel="Token 活动范围"
          value={mode}
          options={modes.map(([value, label]) => ({ value, label }))}
          onChange={setMode}
          className="shrink-0"
        />
      </div>
      <div className="grid w-full gap-x-0.5" style={grid}>
        {mode === "daily"
          ? weeks.map((week) => (
              <div key={week[0]!.day} className="flex min-w-0 flex-col gap-1">
                {week.map((day) => (
                  <DailyCell key={day.day} day={day} peak={dailyPeak} />
                ))}
              </div>
            ))
          : totals.map((day) => (
              <WeeklyColumn
                key={day.day}
                day={day}
                peak={weeklyPeak}
                cumulative={mode === "cumulative"}
              />
            ))}
      </div>
      <div
        className="mt-3 flex justify-between whitespace-nowrap text-[10px] text-ink-mute sm:text-ui-caption"
        aria-label="最近十二个月"
      >
        {months.map((month) => (
          <span key={month}>{month}月</span>
        ))}
      </div>
    </section>
  );
}
