export type TaskSchedule =
  | { readonly kind: "once"; readonly date: string; readonly time: string; readonly timeZone: string }
  | { readonly kind: "daily"; readonly time: string; readonly timeZone: string }
  | { readonly kind: "weekly"; readonly weekdays: readonly number[]; readonly time: string; readonly timeZone: string };

export interface Occurrence {
  readonly at: number;
  readonly missingTime: boolean;
}

const dayMs = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  if (timeZone === "local") timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  const format = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  });
  formatters.set(timeZone, format);
  return format;
}

/** Encode a zoned calendar reading as UTC so arithmetic only changes the calendar. */
function wallTime(instant: number, format: Intl.DateTimeFormat): number {
  const parts = Object.fromEntries(format.formatToParts(instant).map(({ type, value }) => [type, value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
}

function resolveTime(local: number, format: Intl.DateTimeFormat): Occurrence {
  const offsets = [-dayMs, 0, dayMs].map((delta) => wallTime(local + delta, format) - local - delta);
  const candidates = offsets.map((offset) => local - offset).sort((a, b) => a - b);
  const exact = candidates.find((candidate) => wallTime(candidate, format) === local);
  if (exact !== undefined) return { at: exact, missingTime: false };
  // A spring-forward gap has no matching instant. Mark it missed once the
  // clock reaches a reading on the far side of the gap.
  return { at: candidates.at(-1)!, missingTime: true };
}

export function nextOccurrence(schedule: TaskSchedule, after: number): Occurrence | null {
  const format = formatter(schedule.timeZone);
  const [hours = 0, minutes = 0] = schedule.time.split(":").map(Number);
  const time = (hours * 60 + minutes) * 60_000;
  if (schedule.kind === "once") {
    const occurrence = resolveTime(Date.parse(`${schedule.date}T00:00:00Z`) + time, format);
    return occurrence.at > after ? occurrence : null;
  }

  const today = Math.floor(wallTime(after, format) / dayMs) * dayMs;
  for (let offset = 0; offset <= 7; offset += 1) {
    const day = today + offset * dayMs;
    if (schedule.kind === "weekly" && !schedule.weekdays.includes(new Date(day).getUTCDay())) continue;
    const occurrence = resolveTime(day + time, format);
    if (occurrence.at > after) return occurrence;
  }
  return null;
}

export function isValidSchedule(schedule: TaskSchedule): boolean {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) return false;
  try {
    formatter(schedule.timeZone);
    if (schedule.kind === "once") {
      const date = new Date(`${schedule.date}T00:00:00Z`);
      return date.toISOString().slice(0, 10) === schedule.date;
    }
    return schedule.kind === "daily" || (schedule.kind === "weekly" && schedule.weekdays.length > 0 &&
      schedule.weekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6));
  } catch {
    return false;
  }
}
