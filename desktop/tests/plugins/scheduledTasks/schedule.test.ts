import { describe, expect, it, vi } from "vitest";
import { isValidSchedule, nextOccurrence } from "../../../src/plugins/scheduledTasks/scheduler/schedule.ts";

describe("scheduled task calendar", () => {
  it("resolves one-off and weekly times in the configured zone", () => {
    const zone = { time: "09:15", timeZone: "Asia/Shanghai" };
    const before = Date.parse("2026-11-17T00:00Z");
    const expected = { at: Date.parse("2026-11-17T01:15Z"), missingTime: false };
    expect(nextOccurrence({ ...zone, kind: "once", date: "2026-11-17" }, before)).toEqual(expected);
    expect(nextOccurrence({ ...zone, kind: "weekly", weekdays: [2] }, before)).toEqual(expected);
    expect(nextOccurrence({ ...zone, kind: "once", date: "2026-11-17" }, expected.at)).toBeNull();
    expect(isValidSchedule({ ...zone, kind: "once", date: "2026-02-30" })).toBe(false);
  });

  it("marks a spring gap missed and uses the first instant of a repeated time", () => {
    const zone = { kind: "daily", timeZone: "America/New_York" } as const;
    const missing = nextOccurrence({ ...zone, time: "02:30" }, Date.parse("2026-03-08T00:00Z"));
    expect(missing).toEqual({ at: Date.parse("2026-03-08T07:30Z"), missingTime: true });
    const repeated = nextOccurrence({ ...zone, time: "01:30" }, Date.parse("2026-11-01T00:00Z"));
    expect(repeated).toEqual({ at: Date.parse("2026-11-01T05:30Z"), missingTime: false });
    expect(nextOccurrence({ ...zone, time: "01:30" }, repeated!.at)?.at).toBe(Date.parse("2026-11-02T06:30Z"));
  });
});


it("resolves local schedules against the current computer zone on each calculation", () => {
  const original = new Intl.DateTimeFormat().resolvedOptions();
  const zone = vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions");
  try {
    const schedule = { kind: "daily", time: "09:15", timeZone: "local" } as const;
    const before = Date.parse("2026-11-17T00:00Z");
    zone.mockReturnValue({ ...original, timeZone: "Asia/Shanghai" });
    expect(nextOccurrence(schedule, before)?.at).toBe(Date.parse("2026-11-17T01:15Z"));
    zone.mockReturnValue({ ...original, timeZone: "America/New_York" });
    expect(nextOccurrence(schedule, before)?.at).toBe(Date.parse("2026-11-17T14:15Z"));
  } finally { zone.mockRestore(); }
});
