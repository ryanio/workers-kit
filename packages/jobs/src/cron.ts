// Cron expressions as Cloudflare Cron Triggers read them: five fields, UTC.
//
// Cloudflare counts weekday 1 as Sunday, where standard cron counts 1 as
// Monday, so a numeric weekday copied from another scheduler moves a job by a
// day. This module refuses numeric weekdays outright and accepts names only.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;
const MONTHS = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];

/** How far back the slot search looks: far enough for a yearly cron. */
const SEARCH_DAYS = 400;

export class CronError extends Error {
  constructor(cron: string, reason: string) {
    super(`cron "${cron}": ${reason}`);
    this.name = "CronError";
  }
}

export type CronFields = {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  days: ReadonlySet<number> | null;
  months: ReadonlySet<number> | null;
  weekdays: ReadonlySet<number> | null;
};

function range(from: number, to: number, step = 1): number[] {
  const out: number[] = [];
  for (let n = from; n <= to; n += step) out.push(n);
  return out;
}

function parseField(
  cron: string,
  field: string,
  min: number,
  max: number,
  names?: readonly string[],
  nameBase = 0,
): Set<number> {
  const value = (token: string): number => {
    if (names) {
      const at = names.indexOf(token.toUpperCase());
      if (at >= 0) return at + nameBase;
    }
    if (!/^\d{1,2}$/.test(token))
      throw new CronError(cron, `cannot read "${token}"`);
    const n = Number(token);
    if (n < min || n > max)
      throw new CronError(cron, `${n} is outside ${min}-${max}`);
    return n;
  };
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [base = "", stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1)
      throw new CronError(cron, `bad step in "${part}"`);
    let from: number;
    let to: number;
    if (base === "*") {
      from = min;
      to = max;
    } else if (base.includes("-")) {
      const [a = "", b = ""] = base.split("-");
      from = value(a);
      to = value(b);
      if (to < from)
        throw new CronError(cron, `range "${base}" runs backwards`);
    } else {
      from = value(base);
      to = stepText === undefined ? from : max;
    }
    for (const n of range(from, to, step)) out.add(n);
  }
  return out;
}

/**
 * Reads a five-field cron. Throws a `CronError` on anything Cloudflare would
 * read differently from standard cron (a numeric weekday) and on shapes this
 * module does not schedule (`L`, `W`, `#`, `?`, a day of month and a weekday
 * both restricted).
 */
export function parseCron(cron: string): CronFields {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) throw new CronError(cron, "needs five fields");
  const [minute = "", hour = "", dom = "", month = "", dow = ""] = parts;
  if (/[LW#?]/i.test(cron.replace(/[A-Z]{3}/gi, ""))) {
    throw new CronError(cron, "L, W, # and ? are not supported");
  }
  if (/\d/.test(dow)) {
    throw new CronError(
      cron,
      `weekday "${dow}" is numeric. Cloudflare reads 1 as Sunday; write weekdays as names (MON, TUE-FRI)`,
    );
  }
  const fields: CronFields = {
    minutes: parseField(cron, minute, 0, 59),
    hours: parseField(cron, hour, 0, 23),
    days: dom === "*" ? null : parseField(cron, dom, 1, 31),
    months: month === "*" ? null : parseField(cron, month, 1, 12, MONTHS, 1),
    weekdays: dow === "*" ? null : parseField(cron, dow, 0, 6, WEEKDAYS),
  };
  if (fields.days && fields.weekdays) {
    throw new CronError(
      cron,
      "restricts both day of month and weekday; pick one",
    );
  }
  return fields;
}

function dayMatches(f: CronFields, dayStartMs: number): boolean {
  const d = new Date(dayStartMs);
  return (
    (f.months === null || f.months.has(d.getUTCMonth() + 1)) &&
    (f.days === null || f.days.has(d.getUTCDate())) &&
    (f.weekdays === null || f.weekdays.has(d.getUTCDay()))
  );
}

/** The latest slot of `cron` at or before `atMs`, to the minute. */
export function slotAtOrBefore(cron: string, atMs: number): number {
  const f = parseCron(cron);
  const hours = [...f.hours].sort((a, b) => b - a);
  const minutes = [...f.minutes].sort((a, b) => b - a);
  const today = Math.floor(atMs / DAY_MS) * DAY_MS;
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    const day = today - i * DAY_MS;
    if (!dayMatches(f, day)) continue;
    for (const h of hours) {
      for (const m of minutes) {
        const slot = day + h * HOUR_MS + m * MINUTE_MS;
        if (slot <= atMs) return slot;
      }
    }
  }
  throw new CronError(
    cron,
    `no slot in the ${SEARCH_DAYS} days before ${new Date(atMs).toISOString()}`,
  );
}

/** How many times a cron can fire in one UTC day, at most. */
export function firesPerDay(cron: string): number {
  const f = parseCron(cron);
  return f.hours.size * f.minutes.size;
}

/**
 * How late a slot may be before the backstop treats it as missed: 10 minutes
 * for a cron that fires more than once an hour, 30 minutes otherwise. Both are
 * short of the period of the crons they cover, apart from `* * * * *`-style
 * schedules, where the backstop simply checks an older slot.
 */
export function defaultGraceMs(cron: string): number {
  return parseCron(cron).minutes.size > 1 ? 10 * MINUTE_MS : 30 * MINUTE_MS;
}

/** The latest slot of `cron` that should have started by `nowMs`, given its grace. */
export function lastDueSlotMs(
  cron: string,
  nowMs: number,
  graceMs = defaultGraceMs(cron),
): number {
  return slotAtOrBefore(cron, nowMs - graceMs);
}
