import type { Duration } from "./types.js";

const UNIT_MS: Record<string, number> = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000,
  year: 31_536_000_000,
};

/** A Workflows duration in ms: a number is ms already, a string is `<n> <unit>`. */
export function durationMs(duration: Duration): number {
  if (typeof duration === "number") return duration;
  const m = /^(\d+(?:\.\d+)?) (second|minute|hour|day|week|month|year)s?$/.exec(
    duration,
  );
  if (!m) throw new Error(`"${duration}" is not a duration`);
  return Number(m[1]) * (UNIT_MS[m[2] as string] as number);
}
