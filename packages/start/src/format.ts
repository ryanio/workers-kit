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

export interface FormatBytesOptions {
  /** Digits after the point, trailing zeros dropped. Default 1. */
  decimals?: number | undefined;
  /** 1000 per step (kB, MB) instead of 1024 (KB, MB). Default false. */
  si?: boolean | undefined;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;
const SI_BYTE_UNITS = ["B", "kB", "MB", "GB", "TB", "PB"] as const;

/**
 * A size for people: "0 B", "512 B", "1.5 KB", "12 MB". Binary steps (1024)
 * with the KB/MB labels every OS and browser uses by default, or SI steps
 * with `si`. Whole bytes stay whole; a negative or non-finite size is "".
 */
export function formatBytes(
  bytes: number,
  { decimals = 1, si = false }: FormatBytesOptions = {},
): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  const step = si ? 1000 : 1024;
  const units = si ? SI_BYTE_UNITS : BYTE_UNITS;
  let value = bytes;
  let unit = 0;
  while (value >= step && unit < units.length - 1) {
    value /= step;
    unit++;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  // A value that rounds up to the next step reads better as that step.
  if (Number(value.toFixed(decimals)) >= step && unit < units.length - 1) {
    value /= step;
    unit++;
  }
  return `${Number(value.toFixed(decimals))} ${units[unit]}`;
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
  /** The month in the fallback date: "9 March 2026" (`long`, default) or "9 Mar 2026" (`short`). */
  month?: DateOptions["month"];
  /** The zone the fallback date is read in, as `fullDate` takes it. */
  timeZone?: DateOptions["timeZone"];
  /** The order of the fallback date, as `fullDate` takes it. */
  order?: DateOptions["order"];
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
  return fullDate(then, {
    month: options.month,
    timeZone: options.timeZone,
    order: options.order,
  });
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

export interface DateOptions {
  /** "November" (`long`, default) or "Nov" (`short`). */
  month?: "long" | "short" | undefined;
  /**
   * The zone the date is read in: an IANA name such as `"America/New_York"`,
   * `"local"` for the runtime's own zone (the visitor's, in a browser), or
   * `"UTC"`, the default. Anything a person reads should be in their zone:
   * `visitorTimeZone(request)` gives it on the server, `"local"` in the
   * browser. An unknown name falls back to UTC.
   */
  timeZone?: string | undefined;
  /** "20 Nov 2026" (`dmy`, default) or "Nov 20, 2026" (`mdy`, the US order). */
  order?: "dmy" | "mdy" | undefined;
  /** Lead with the weekday: "Fri, 20 Nov 2026" (`short`) or "Friday, 20 Nov 2026" (`long`). */
  weekday?: "short" | "long" | undefined;
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** The date part every date helper writes, in the order and with the weekday asked for. */
function datePart(
  { year, month, day }: ZonedParts,
  options: DateOptions,
  defaultMonth: DateOptions["month"],
): string {
  const name = monthName(month, options.month ?? defaultMonth);
  const date =
    options.order === "mdy"
      ? `${name} ${day}, ${year}`
      : `${day} ${name} ${year}`;
  if (!options.weekday) return date;
  // The weekday of the calendar date itself, so it agrees with the zone's day.
  const index = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const weekday = WEEKDAYS[index] ?? "";
  return `${options.weekday === "short" ? weekday.slice(0, 3) : weekday}, ${date}`;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const zoneFormats = new Map<string, Intl.DateTimeFormat | null>();

/** A cached formatter for the zone, or null for one the runtime does not know. */
function zoneFormat(timeZone: string | undefined): Intl.DateTimeFormat | null {
  const key = timeZone ?? "local";
  if (zoneFormats.has(key)) return zoneFormats.get(key) ?? null;
  let format: Intl.DateTimeFormat | null;
  try {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    });
  } catch {
    format = null;
  }
  zoneFormats.set(key, format);
  return format;
}

/** Whether the runtime knows this IANA zone. */
export function isTimeZone(name: string | null | undefined): boolean {
  return !!name && name !== "local" && zoneFormat(name) !== null;
}

function zoned(ms: number, timeZone: string | undefined): ZonedParts {
  const zone = timeZone === "local" ? undefined : (timeZone ?? "UTC");
  const format = zone === "UTC" ? null : zoneFormat(zone);
  if (!format) {
    const d = new Date(ms);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
    };
  }
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(ms)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 1,
    day: parts.day ?? 1,
    hour: (parts.hour ?? 0) % 24,
    minute: parts.minute ?? 0,
  };
}

function monthName(month: number, style: DateOptions["month"]): string {
  const name = MONTHS[month - 1] ?? "";
  return style === "short" ? name.slice(0, 3) : name;
}

/** "20 November 2026", or "20 Nov 2026" with `month: "short"`, in UTC unless `timeZone` says otherwise. */
export function fullDate(
  value: DateLike | null | undefined,
  options: DateOptions = {},
): string {
  const ms = toMillis(value);
  if (ms === null) {
    return "";
  }
  return datePart(zoned(ms, options.timeZone), options, "long");
}

/** "November 2026", or "Nov 2026" with `month: "short"`, read in `timeZone` (UTC by default). */
export function monthYear(
  value: DateLike | null | undefined,
  options: Pick<DateOptions, "month" | "timeZone"> = {},
): string {
  const ms = toMillis(value);
  if (ms === null) {
    return "";
  }
  const { year, month } = zoned(ms, options.timeZone);
  return `${monthName(month, options.month)} ${year}`;
}

export interface DateTimeOptions extends DateOptions {
  /** "2:03 PM" (`12h`) or "14:03" (`24h`, default). */
  clock?: "12h" | "24h" | undefined;
  /** Add the zone's short name ("EST", "GMT+1", "UTC"). Default true. */
  zoneName?: boolean | undefined;
}

/**
 * A date and time for people: "20 Nov 2026, 14:03 EST". Short month by
 * default. Read in `timeZone` (UTC by default; pass the visitor's).
 */
export function dateTime(
  value: DateLike | null | undefined,
  options: DateTimeOptions = {},
): string {
  const ms = toMillis(value);
  if (ms === null) {
    return "";
  }
  const parts = zoned(ms, options.timeZone);
  const { hour, minute } = parts;
  const mm = String(minute).padStart(2, "0");
  const time =
    options.clock === "12h"
      ? `${hour % 12 || 12}:${mm} ${hour < 12 ? "AM" : "PM"}`
      : `${String(hour).padStart(2, "0")}:${mm}`;
  const date = datePart(parts, options, "short");
  if (options.zoneName === false) return `${date}, ${time}`;
  return `${date}, ${time} ${zoneLabel(ms, options.timeZone)}`;
}

function zoneLabel(ms: number, timeZone: string | undefined): string {
  const zone = timeZone === "local" ? undefined : (timeZone ?? "UTC");
  if (zone === "UTC" || (zone !== undefined && !isTimeZone(zone))) return "UTC";
  try {
    const name = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "short",
    })
      .formatToParts(ms)
      .find((part) => part.type === "timeZoneName")?.value;
    return name ?? "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * The visitor's IANA time zone, from Cloudflare's `request.cf.timezone`, or
 * `fallback` (default "UTC") when there is none or the runtime does not know
 * it: a request from a test, a service binding, or a client Cloudflare could
 * not place. Pass it as `timeZone` to the date helpers on a server-rendered
 * page.
 */
export function visitorTimeZone(
  request: { cf?: unknown } | null | undefined,
  fallback = "UTC",
): string {
  const zone = (request?.cf as { timezone?: unknown } | undefined)?.timezone;
  return typeof zone === "string" && isTimeZone(zone) ? zone : fallback;
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
  /**
   * Split a word wider than the line across lines, between characters, rather
   * than giving it a line of its own that overflows. For a page or a PDF,
   * where overflowing text runs off the paper. Default false.
   */
  breakWords?: boolean | undefined;
}

/** Scripts written without spaces, which a line may break between any two characters of. */
const BREAKS_AROUND =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff00-\uffef]/u;

/**
 * What a line may not start with (the basic kinsoku set), so "。" and "、" stay
 * on the line they close.
 */
const NO_BREAK_BEFORE =
  /[、。，．：；！？）」』】〉》〕ー々ぁぃぅぇぉっゃゅょァィゥェォッャュョ)\]}.,:;!?%]/u;

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter("en", { granularity: "grapheme" })
    : undefined;

/** `text` as user-perceived characters, so an emoji or a flag is never split. */
function graphemes(text: string): string[] {
  return segmenter
    ? Array.from(segmenter.segment(text), (part) => part.segment)
    : Array.from(text);
}

/**
 * A space-free word as the pieces a line may break between: the whole word
 * for Latin, Arabic or Korean, one piece per character for Chinese and
 * Japanese, with closing punctuation kept on the piece before it.
 */
function breakPieces(word: string): string[] {
  if (!BREAKS_AROUND.test(word)) {
    return [word];
  }
  const pieces: string[] = [];
  let previous = "";
  for (const char of graphemes(word)) {
    const last = pieces.length - 1;
    const canBreak =
      last >= 0 &&
      (BREAKS_AROUND.test(char) || BREAKS_AROUND.test(previous)) &&
      !NO_BREAK_BEFORE.test(char);
    if (canBreak || last < 0) {
      pieces.push(char);
    } else {
      pieces[last] += char;
    }
    previous = char;
  }
  return pieces;
}

/** Each paragraph's pieces, each with the text that joins it to the one before. */
function* paragraphs(text: string): Generator<[string, string][]> {
  for (const paragraph of text.split(/\r?\n/)) {
    const pieces: [string, string][] = [];
    for (const word of paragraph.split(/\s+/)) {
      if (word === "") {
        continue;
      }
      breakPieces(word).forEach((piece, index) => {
        pieces.push([index === 0 ? " " : "", piece]);
      });
    }
    yield pieces;
  }
}

/**
 * `text` broken into lines no wider than `width`, on spaces, and between the
 * characters of Chinese and Japanese, which use none. A line never starts with
 * closing punctuation such as "。".
 *
 * A single word too wide for a line gets its own line rather than being cut,
 * since hyphenating an address or a handle makes it unreadable; a caller that
 * cannot overflow sets `breakWords`, or should `truncate` each line afterwards.
 *
 * Existing line breaks in `text` are kept, and a blank or whitespace-only line
 * stays a blank line.
 */
export function wrapWords(
  text: string,
  width: number,
  options: WrapWordsOptions = {},
): string[] {
  const measure = options.measure ?? ((line: string) => line.length);
  const lines: string[] = [];
  for (const pieces of paragraphs(text)) {
    let line = "";
    for (const [joiner, piece] of pieces) {
      const candidate = line === "" ? piece : `${line}${joiner}${piece}`;
      if (line === "" || measure(candidate) <= width) {
        line = candidate;
      } else {
        lines.push(line);
        line = piece;
      }
      if (options.breakWords && measure(line) > width) {
        // Only a piece that is alone on its line can still be too wide.
        let chunk = "";
        for (const char of graphemes(line)) {
          if (chunk !== "" && measure(chunk + char) > width) {
            lines.push(chunk);
            chunk = char;
          } else {
            chunk += char;
          }
        }
        line = chunk;
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
  for (const pieces of paragraphs(text)) {
    let line = "";
    for (const [joiner, word] of pieces) {
      const candidate = line === "" ? word : `${line}${joiner}${word}`;
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
