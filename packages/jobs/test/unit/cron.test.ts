/**
 * Cron reading as Cloudflare does it: names for weekdays, UTC slots, and the
 * last slot the backstop expects to have run.
 */
import { describe, expect, it } from "vitest";
import {
  defaultGraceMs,
  lastDueSlotMs,
  parseCron,
  slotAtOrBefore,
} from "../../src/cron.js";

const iso = (ms: number) => new Date(ms).toISOString();
// Tuesday 2026-11-03 12:00 UTC
const NOW = Date.UTC(2026, 10, 3, 12, 0);

describe("parseCron", () => {
  it("refuses a numeric weekday, which Cloudflare reads with 1 as Sunday", () => {
    expect(() => parseCron("0 13 * * 1")).toThrow(/numeric.*names/);
    expect(() => parseCron("0 13 * * 1-5")).toThrow(/numeric/);
  });

  it("refuses shapes it cannot schedule", () => {
    expect(() => parseCron("0 13 * *")).toThrow(/five fields/);
    expect(() => parseCron("0 13 L * *")).toThrow(/not supported/);
    expect(() => parseCron("0 13 1 * MON")).toThrow(/pick one/);
    expect(() => parseCron("0 25 * * *")).toThrow(/outside/);
  });

  it("reads names, lists, ranges and steps", () => {
    const f = parseCron("*/15 9-17 * * MON-FRI");
    expect([...f.minutes]).toEqual([0, 15, 30, 45]);
    expect(f.hours.size).toBe(9);
    expect([...(f.weekdays ?? [])]).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("slots", () => {
  it("finds the latest daily, weekly, hourly and sub-hourly slot", () => {
    expect(iso(slotAtOrBefore("0 4 * * *", NOW))).toBe(
      "2026-11-03T04:00:00.000Z",
    );
    expect(iso(slotAtOrBefore("0 13 * * *", NOW))).toBe(
      "2026-11-02T13:00:00.000Z",
    );
    expect(iso(slotAtOrBefore("0 13 * * MON", NOW))).toBe(
      "2026-11-02T13:00:00.000Z",
    );
    expect(
      iso(slotAtOrBefore("0 10 * * MON", Date.UTC(2026, 10, 2, 9, 0))),
    ).toBe("2026-10-26T10:00:00.000Z");
    expect(iso(slotAtOrBefore("30 * * * *", NOW))).toBe(
      "2026-11-03T11:30:00.000Z",
    );
    expect(iso(slotAtOrBefore("0 */4 * * *", NOW))).toBe(
      "2026-11-03T12:00:00.000Z",
    );
    expect(iso(slotAtOrBefore("*/5 * * * *", NOW + 7 * 60_000))).toBe(
      "2026-11-03T12:05:00.000Z",
    );
    expect(iso(slotAtOrBefore("0 0 1 JAN *", NOW))).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });

  it("allows a daily slot 30 minutes and a sub-hourly one 10 before it counts as due", () => {
    expect(defaultGraceMs("0 4 * * *")).toBe(30 * 60_000);
    expect(defaultGraceMs("*/5 * * * *")).toBe(10 * 60_000);
    expect(iso(lastDueSlotMs("0 4 * * *", Date.UTC(2026, 10, 3, 4, 20)))).toBe(
      "2026-11-02T04:00:00.000Z",
    );
    expect(iso(lastDueSlotMs("0 4 * * *", Date.UTC(2026, 10, 3, 4, 31)))).toBe(
      "2026-11-03T04:00:00.000Z",
    );
    expect(iso(lastDueSlotMs("*/5 * * * *", NOW))).toBe(
      "2026-11-03T11:50:00.000Z",
    );
  });
});
