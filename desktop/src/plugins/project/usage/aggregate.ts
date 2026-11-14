import type { UsageSnapshot } from "./service.ts";
import { usageModelId } from "./modelIdentity.ts";

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
  let longest = 0;
  let streak = 0;
  let previous = -Infinity;
  for (const [day, { tokens }] of byDay) {
    total += tokens;
    if (tokens > peak) peak = tokens;
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
      key: string;
      model: string | null;
      name?: string;
      nameDay?: string;
      tokens: bigint;
      estimated: number;
      daily?: Map<string, bigint>;
    }
  >();
  for (const [day, model, tokens, estimated, name, agent] of snapshot.models) {
    const canonicalModel = usageModelId(agent, model);
    const key = JSON.stringify([agent ?? null, canonicalModel]);
    const item = byModel.get(key) ?? {
      key,
      model: canonicalModel,
      tokens: 0n,
      estimated: 0,
    };
    if (name && (!item.nameDay || day >= item.nameDay)) {
      item.name = name;
      item.nameDay = day;
    }
    item.tokens += BigInt(tokens);
    item.estimated += estimated;
    const daily = (item.daily ??= new Map());
    daily.set(day, (daily.get(day) ?? 0n) + BigInt(tokens));
    byModel.set(key, item);
  }
  const ranked = [...byModel.values()].sort((a, b) =>
    a.tokens === b.tokens ? 0 : a.tokens > b.tokens ? -1 : 1,
  );
  const labels = new Map<string, number>();
  for (const model of ranked) {
    if (model.tokens <= 0n) continue;
    const label = displayModelName(model.model, model.name);
    labels.set(label, (labels.get(label) ?? 0) + 1);
  }
  const models = ranked.map((model) => {
    const label = displayModelName(model.model, model.name);
    return { ...model, label, showModelId: (labels.get(label) ?? 0) > 1 };
  });
  return { total, peak, longest, current, trend, activity, models };
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
