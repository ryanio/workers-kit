/**
 * The formatting every app writes twice: counts, plurals, relative times, UTC
 * stamps, money, slugs and word wrapping.
 *
 * Everything here is pure and locale-free on purpose. Numbers go through
 * `en-US` grouping and dates are read and written in UTC, because these
 * strings end up in a Worker's response, an OG card, a Discord message and a
 * test assertion, none of which has a user's locale or timezone to hand. A
 * page that wants the visitor's locale should format in the browser.
 *
 * A date argument is an ISO string, epoch milliseconds or a `Date`. Anything
 * unparseable gives an empty string rather than `Invalid Date`, so a bad row
 * in a database leaves a gap in the page instead of a mark across it.
 */

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
] as const;

export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 7 * DAY_MS;

/** An ISO string, epoch milliseconds or a Date. */
export type DateLike = Date | number | string;

/**
 * The largest time a `Date` holds, per ECMA-262. Past it `toISOString` throws,
 * so a row carrying nanoseconds or microseconds instead of milliseconds would
 * turn a page into a 500 rather than a gap.
 */
const MAX_TIME = 8.64e15;

/**
 * `value` as epoch milliseconds, or `null` when it will not parse.
 *
 * A date-only string and an ISO timestamp without a zone are both read as UTC.
 * `Date.parse` already does that for `2026-11-20`, but not for
 * `2026-11-20 14:03:00`, which SQLite's `datetime()` returns and which would
 * otherwise be read in whatever zone the runtime thinks it is in.
 */
export function toMillis(value: DateLike | null | undefined): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.getTime();
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && Math.abs(value) <= MAX_TIME ? value : null;
  }
  const text = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

/** The word alone: `plural(1, "reply", "replies")` is "reply", anything else "replies". */
export function plural(count: number, one: string, many?: string): string {
  return count === 1 ? one : (many ?? `${one}s`);
}

export interface CountedOptions {
  /** Spell the count up to twelve: "three muses". Above twelve it stays a numeral. */
  words?: boolean | undefined;
  /** Shorten a large count: "1.2k muses". */
  compact?: boolean | undefined;
}

/**
 * A count with its noun, grouped: "1 reply", "1,204 replies". This is the one
 * to reach for in prose; `plural` is for a count shown apart from its word.
 */
export function counted(
  count: number,
  one: string,
  many?: string,
  options: CountedOptions = {},
): string {
  const number = options.words
    ? numberWord(count)
    : options.compact
      ? compactCount(count)
      : formatCount(count);
  return `${number} ${plural(count, one, many)}`;
}

/** Grouped with commas: 1204 is "1,204". */
export function formatCount(count: number): string {
  return Number.isFinite(count) ? count.toLocaleString("en-US") : "";
}

export interface CompactCountOptions {
  /** Below this, the count is grouped in full. Default 10,000. */
  threshold?: number | undefined;
}

/**
 * A short count for somewhere narrow: "9,999", then "12.3k", "4.5m", "1.2b".
 * Grouped in full below `threshold`, because "9.9k" hides whether a number
 * crossed ten thousand while "9,934" does not.
 */
export function compactCount(
  count: number,
  options: CompactCountOptions = {},
): string {
  if (!Number.isFinite(count)) {
    return "";
  }
  const threshold = options.threshold ?? 10_000;
  const size = Math.abs(count);
  if (size < threshold) {
    return formatCount(count);
  }
  // The largest unit at or below the count.
  let index = 0;
  while (index + 1 < UNITS.length && size >= (UNITS[index + 1]?.scale ?? 0)) {
    index += 1;
  }
  let unit = UNITS[index] as Unit;
  let scaled = Number((count / unit.scale).toFixed(1));
  // 999,950 scales to 1000.0 at one decimal, which belongs in the unit above
  // rather than reading as "1000k". Rounding can push it up by one unit at
  // most, and never past the largest one.
  if (Math.abs(scaled) >= 1000 && index + 1 < UNITS.length) {
    unit = UNITS[index + 1] as Unit;
    scaled = Number((count / unit.scale).toFixed(1));
  }
  return `${scaled.toFixed(1).replace(/\.0$/, "")}${unit.suffix}`;
}

interface Unit {
  scale: number;
  suffix: string;
}

const UNITS: readonly Unit[] = [
  { scale: 1e3, suffix: "k" },
  { scale: 1e6, suffix: "m" },
  { scale: 1e9, suffix: "b" },
  { scale: 1e12, suffix: "t" },
];

/** Spelled up to twelve, grouped numerals above it. Negatives stay numerals. */
export function numberWord(count: number): string {
  if (Number.isInteger(count) && count >= 0 && count < WORDS.length) {
    return WORDS[count] as string;
  }
  return formatCount(count);
}

/** "1st", "2nd", "3rd", "4th", "11th", "21st". */
export function ordinal(count: number): string {
  if (!Number.isFinite(count)) {
    return "";
  }
  const rounded = Math.trunc(count);
  const size = Math.abs(rounded) % 100;
  const suffix =
    size >= 11 && size <= 13
      ? "th"
      : size % 10 === 1
        ? "st"
        : size % 10 === 2
          ? "nd"
          : size % 10 === 3
            ? "rd"
            : "th";
  return `${formatCount(rounded)}${suffix}`;
}

export interface UsdOptions {
  /** The amount is in cents, not dollars. */
  cents?: boolean | undefined;
  /** Default 2. Pass 0 for a whole-dollar figure. */
  digits?: number | undefined;
}

/** "$1,204.50". */
export function usd(amount: number, options: UsdOptions = {}): string {
  if (!Number.isFinite(amount)) {
    return "";
  }
  const dollars = options.cents ? amount / 100 : amount;
  const digits = options.digits ?? 2;
  const sign = dollars < 0 ? "-" : "";
  return `${sign}$${Math.abs(dollars).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

/** A share as a percent: `percent(0.1234)` is "12.3%". `null` gives a dash. */
export function percent(share: number | null | undefined, digits = 1): string {
  if (share === null || share === undefined || !Number.isFinite(share)) {
    return "-";
  }
  return `${(share * 100).toFixed(digits)}%`;
}

export interface TimeAgoOptions {
  /** Milliseconds since the epoch. Defaults to `Date.now`. */
  now?: number | undefined;
  /**
   * Past this many milliseconds, fall back to a date instead of a count of
   * days. Default 30 days. `Infinity` keeps counting days forever.
   */
  absoluteAfterMs?: number | undefined;
}

/**
 * "just now", "5m ago", "3h ago", "6d ago", and past `absoluteAfterMs` the
 * date. Anything in the future reads as "just now", since a clock a little
 * ahead of the server is the ordinary cause and "in 2s" only looks broken.
 */
export function timeAgo(
  value: DateLike | null | undefined,
  options: TimeAgoOptions = {},
): string {
  const then = toMillis(value);
  if (then === null) {
    return "";
  }
  const now = options.now ?? Date.now();
  const elapsed = now - then;
  if (elapsed < 90 * SECOND_MS) {
    return "just now";
  }
  if (elapsed < HOUR_MS) {
    return `${Math.floor(elapsed / MINUTE_MS)}m ago`;
  }
  if (elapsed < DAY_MS) {
    return `${Math.floor(elapsed / HOUR_MS)}h ago`;
  }
  if (elapsed < (options.absoluteAfterMs ?? 30 * DAY_MS)) {
    return `${Math.floor(elapsed / DAY_MS)}d ago`;
  }
  return fullDate(then);
}

/** "2026-11-20", in UTC. */
export function utcDate(value: DateLike | null | undefined): string {
  const ms = toMillis(value);
  return ms === null ? "" : new Date(ms).toISOString().slice(0, 10);
}

/** "2026-11-20 14:03 UTC". */
export function utcStamp(value: DateLike | null | undefined): string {
  const ms = toMillis(value);
  return ms === null
    ? ""
    : `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** "20 November 2026", in UTC. */
export function fullDate(value: DateLike | null | undefined): string {
  const ms = toMillis(value);
  if (ms === null) {
    return "";
  }
  const date = new Date(ms);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/**
 * The UTC day number, whole days since 1970-01-01. The key for a daily bucket:
 * two timestamps share a day exactly when their `utcDay` matches, with no
 * string formatting or timezone in the way.
 */
export function utcDay(value: DateLike | null | undefined): number | null {
  const ms = toMillis(value);
  return ms === null ? null : Math.floor(ms / DAY_MS);
}

/** An ISO timestamp with the milliseconds dropped, which is what sitemaps and feeds want. */
export function w3cDate(value: DateLike | null | undefined): string {
  const ms = toMillis(value);
  return ms === null
    ? ""
    : new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * A rough wait in prose: "about five minutes", "about an hour", "about two
 * hours". For a progress line, where a precise figure would only invite
 * someone to time it.
 */
export function aboutDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "about a minute";
  }
  const minutes = Math.max(1, Math.round(ms / MINUTE_MS));
  if (minutes % 60 !== 0) {
    return `about ${counted(minutes, "minute", undefined, { words: true })}`;
  }
  const hours = minutes / 60;
  return hours === 1
    ? "about an hour"
    : `about ${counted(hours, "hour", undefined, { words: true })}`;
}

export interface ListOfOptions {
  /** Default "and". */
  conjunction?: string | undefined;
  /** Default false. True writes "a, b, and c". */
  oxfordComma?: boolean | undefined;
}

/** "a", "a and b", "a, b and c". */
export function listOf(
  items: readonly string[],
  options: ListOfOptions = {},
): string {
  const conjunction = options.conjunction ?? "and";
  const kept = items.filter((item) => item !== "");
  if (kept.length === 0) {
    return "";
  }
  if (kept.length === 1) {
    return kept[0] as string;
  }
  if (kept.length === 2) {
    return `${kept[0]} ${conjunction} ${kept[1]}`;
  }
  const comma = options.oxfordComma ? "," : "";
  return `${kept.slice(0, -1).join(", ")}${comma} ${conjunction} ${kept.at(-1)}`;
}

/** First character upper-cased, the rest untouched, so an acronym survives. */
export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export interface SlugifyOptions {
  /** Cut the slug to this many characters, on a separator where it can. Default 80. */
  maxLength?: number | undefined;
}

/**
 * A URL-safe slug: lowercase, accents folded to their base letter, every run
 * of anything else a single hyphen, no hyphen at either end.
 *
 * An empty result is an empty string, not a thrown error or a random slug. A
 * caller whose slug has to exist (a profile handle, say) checks for that and
 * mints its own.
 */
export function slugify(text: string, options: SlugifyOptions = {}): string {
  const folded = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const maxLength = options.maxLength ?? 80;
  if (folded.length <= maxLength) {
    return folded;
  }
  const cut = folded.slice(0, maxLength);
  const lastSeparator = cut.lastIndexOf("-");
  return (
    lastSeparator > maxLength / 2 ? cut.slice(0, lastSeparator) : cut
  ).replace(/-+$/, "");
}

export interface TruncateOptions {
  /** Default "…". Counted against `maxLength`. */
  ellipsis?: string | undefined;
  /** Cut on a word boundary where one is near the limit. Default true. */
  onWord?: boolean | undefined;
}

/** `text` cut to `maxLength` characters, ellipsis included, or unchanged if it fits. */
export function truncate(
  text: string,
  maxLength: number,
  options: TruncateOptions = {},
): string {
  if (text.length <= maxLength) {
    return text;
  }
  const ellipsis = options.ellipsis ?? "…";
  const room = maxLength - ellipsis.length;
  if (room <= 0) {
    return ellipsis.slice(0, maxLength);
  }
  const cut = whole(text.slice(0, room));
  if (options.onWord === false) {
    return cut + ellipsis;
  }
  const space = cut.lastIndexOf(" ");
  return (space > room / 2 ? cut.slice(0, space) : cut).trimEnd() + ellipsis;
}

/**
 * `text` without a trailing lone high surrogate. Slicing by index can land in
 * the middle of an astral character, and half of one renders as a replacement
 * glyph wherever it ends up.
 */
function whole(text: string): string {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

export interface WrapWordsOptions {
  /**
   * How wide a candidate line is. Defaults to its character count. A card
   * renderer passes its own measurer here, in whatever unit `width` is, so the
   * wrap happens in pixels rather than characters.
   */
  measure?: ((text: string) => number) | undefined;
  /** Stop after this many lines and put an ellipsis on the last one. */
  maxLines?: number | undefined;
}

/**
 * `text` broken into lines no wider than `width`, on spaces. A single word too
 * wide for a line gets its own line rather than being cut, since hyphenating
 * an address or a handle makes it unreadable; a caller that cannot overflow
 * should `truncate` each line afterwards.
 *
 * Existing line breaks in `text` are kept.
 */
export function wrapWords(
  text: string,
  width: number,
  options: WrapWordsOptions = {},
): string[] {
  const measure = options.measure ?? ((line: string) => line.length);
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter((w) => w !== "")) {
      const candidate = line === "" ? word : `${line} ${word}`;
      if (line !== "" && measure(candidate) > width) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  const maxLines = options.maxLines;
  if (maxLines === undefined || lines.length <= maxLines) {
    return lines;
  }
  const kept = lines.slice(0, maxLines);
  const last = kept.at(-1) ?? "";
  kept[kept.length - 1] = last === "" ? "…" : `${last.trimEnd()}…`;
  return kept;
}

export interface FitWordsOptions extends WrapWordsOptions {
  /** How many lines there is room for. Required: without a limit nothing can fail to fit. */
  maxLines: number;
}

/**
 * `text` wrapped into at most `maxLines` lines no wider than `width`, or `null`
 * when it does not fit, either because a single word is too wide or because it
 * would need another line.
 *
 * This is the other half of `wrapWords`, for a label drawn at a size you
 * control: try the largest size, and on `null` try the next one down. An
 * ellipsis is the wrong answer for a title on a card or a name on a device
 * screen, where the room is yours to give.
 *
 *     const size = [48, 40, 32].map((s) => ({ s, lines: fitWords(title, width, {
 *       maxLines: 2,
 *       measure: (line) => advance(line, s),
 *     }) })).find((tried) => tried.lines !== null);
 */
export function fitWords(
  text: string,
  width: number,
  options: FitWordsOptions,
): string[] | null {
  const measure = options.measure ?? ((line: string) => line.length);
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter((w) => w !== "")) {
      const candidate = line === "" ? word : `${line} ${word}`;
      if (measure(candidate) <= width) {
        line = candidate;
        continue;
      }
      // A word wider than the line cannot be wrapped, only shrunk, wherever
      // in the text it falls.
      if (line === "" || measure(word) > width) {
        return null;
      }
      lines.push(line);
      line = word;
      if (lines.length >= options.maxLines) {
        return null;
      }
    }
    lines.push(line);
    if (lines.length > options.maxLines) {
      return null;
    }
  }
  return lines;
}
