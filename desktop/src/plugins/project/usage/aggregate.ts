import type { UsageSnapshot } from "./service.ts";

export const compactUsageNumber = new Intl.NumberFormat("zh-CN", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const dayMillis = 86_400_000;
const dayIndex = (day: string) => Date.parse(day + "T00:00:00Z") / dayMillis;
const dateAt = (day: number) =>
  new Date(day * dayMillis).toISOString().slice(0, 10);

export function summarizeUsage(snapshot: UsageSnapshot, range: number) {
  const today = dayIndex(snapshot.today);
  const byDay = new Map(
    snapshot.days.map(([day, tokens, missing, turns = 0]) => [
      day,
      { tokens: BigInt(tokens), missing, turns },
    ]),
  );
  let total = 0n;
  let peak = 0n;
  let missing = 0;
  let longest = 0;
  let streak = 0;
  let previous = -Infinity;
  for (const [day, { tokens, missing: absent }] of byDay) {
    total += tokens;
    if (tokens > peak) peak = tokens;
    missing += absent;
    if (tokens <= 0) continue;
    const index = dayIndex(day);
    streak = index === previous + 1 ? streak + 1 : 1;
    longest = Math.max(longest, streak);
    previous = index;
  }
  const current = previous >= today - 1 ? streak : 0;
  function series(length: number) {
    return Array.from({ length }, (_, index) => {
      const day = dateAt(today - length + 1 + index);
      return {
        day,
        tokens: byDay.get(day)?.tokens ?? 0n,
        missing: byDay.get(day)?.missing ?? 0,
        turns: byDay.get(day)?.turns ?? 0,
      };
    });
  }
  const start = new Date(today * dayMillis);
  start.setUTCFullYear(start.getUTCFullYear() - 1);
  const trend = series(range);
  const activity = series(today - Math.floor(start.getTime() / dayMillis));
  const byModel = new Map<
    string,
    {
      model: string | null;
      name?: string;
      tokens: bigint;
      estimated: number;
      daily?: Map<string, bigint>;
    }
  >();
  for (const [day, model, tokens, estimated, name] of snapshot.models) {
    const key = JSON.stringify([model, name ?? null]);
    const item = byModel.get(key) ?? {
      model,
      ...(name ? { name } : {}),
      tokens: 0n,
      estimated: 0,
    };
    item.tokens += BigInt(tokens);
    item.estimated += estimated;
    const daily = (item.daily ??= new Map());
    daily.set(day, (daily.get(day) ?? 0n) + BigInt(tokens));
    byModel.set(key, item);
  }
  const models = [...byModel.values()].sort((a, b) =>
    a.tokens === b.tokens ? 0 : a.tokens > b.tokens ? -1 : 1,
  );
  return { total, peak, missing, longest, current, trend, activity, models };
}

export function displayModelName(model: string | null, name?: string) {
  if (name) return name;
  if (
    !model ||
    /^(?:[\da-f]{12,}|[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/i.test(model)
  )
    return "未知模型";
  return model;
}
