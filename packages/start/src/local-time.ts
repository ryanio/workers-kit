/**
 * Dates in the reader's own time zone on pages a server renders once for
 * everyone (an edge-cached page, a static page). The server writes each date
 * in UTC inside `<time datetime="..." data-local="date">`, which stays true
 * without JavaScript, and the browser rewrites the text in its own zone.
 *
 * `localTime(value, kind)` writes the element on the server. In the browser,
 * a bundled page calls `localizeTimes(document)` (and `watchLocalTimes` to
 * cover content added later); a page with no bundle inlines
 * `LOCAL_TIME_SCRIPT` in a `<script>` tag, which does both.
 */
import {
  type DateLike,
  dateTime,
  fullDate,
  timeAgo,
  toMillis,
} from "./format.js";

/** What a `<time data-local>` shows: "20 Nov 2026", "20 Nov 2026, 22:30 EST", "3h ago" or "2026". */
export type LocalTimeKind = "date" | "datetime" | "ago" | "year";

export interface LocalTimeOptions {
  /** "20 Nov 2026" (`dmy`, default) or "Nov 20, 2026" (`mdy`). */
  order?: "dmy" | "mdy" | undefined;
  /** "Nov" (`short`, default) or "November" (`long`). */
  month?: "short" | "long" | undefined;
  /** Lead the date with the weekday: "Fri, 20 Nov 2026". Not used by `year` or `ago`. */
  weekday?: "short" | "long" | undefined;
}

const KINDS: readonly LocalTimeKind[] = ["date", "datetime", "ago", "year"];

function text(
  ms: number,
  kind: LocalTimeKind,
  timeZone: string,
  options: LocalTimeOptions,
): string {
  const { order, weekday } = options;
  const month = options.month ?? "short";
  if (kind === "year") return fullDate(ms, { timeZone }).slice(-4);
  if (kind === "ago") return timeAgo(ms, { timeZone, order, month });
  if (kind === "datetime")
    return dateTime(ms, { timeZone, order, month, weekday });
  return fullDate(ms, { timeZone, order, month, weekday });
}

function readOptions(element: TimeElement): LocalTimeOptions {
  const weekday = element.getAttribute("data-weekday");
  return {
    order: element.getAttribute("data-order") === "mdy" ? "mdy" : undefined,
    month: element.getAttribute("data-month") === "long" ? "long" : undefined,
    weekday: weekday === "short" || weekday === "long" ? weekday : undefined,
  };
}

/**
 * A `<time>` element for a server-rendered page: the date in UTC as its text,
 * marked for the browser to rewrite in the reader's zone. Empty for a value
 * that is not a date.
 */
export function localTime(
  value: DateLike | null | undefined,
  kind: LocalTimeKind = "date",
  options: LocalTimeOptions = {},
): string {
  const ms = toMillis(value);
  if (ms === null) return "";
  const marks =
    (options.order === "mdy" ? ' data-order="mdy"' : "") +
    (options.month === "long" ? ' data-month="long"' : "") +
    (options.weekday ? ` data-weekday="${options.weekday}"` : "");
  return `<time datetime="${new Date(ms).toISOString()}" data-local="${kind}"${marks}>${text(ms, kind, "UTC", options)}</time>`;
}

interface TimeElement {
  getAttribute(name: string): string | null;
  textContent: string | null;
}

interface Root {
  querySelectorAll(
    selector: string,
  ): Iterable<TimeElement> | ArrayLike<TimeElement>;
  matches?(selector: string): boolean;
}

/**
 * Rewrites every `<time data-local>` in `root` (and `root` itself when it is
 * one) in `timeZone`, the browser's own by default. Answers how many it
 * rewrote.
 */
export function localizeTimes(
  root: Root,
  { timeZone = "local" }: { timeZone?: string } = {},
): number {
  const found = Array.from(root.querySelectorAll("time[data-local]"));
  if (root.matches?.("time[data-local]"))
    found.push(root as unknown as TimeElement);
  let rewritten = 0;
  for (const element of found) {
    const ms = toMillis(element.getAttribute("datetime"));
    const kind = element.getAttribute("data-local") as LocalTimeKind;
    if (ms === null || !KINDS.includes(kind)) continue;
    element.textContent = text(ms, kind, timeZone, readOptions(element));
    rewritten++;
  }
  return rewritten;
}

/**
 * Keeps rewriting as content arrives (infinite scroll, client navigation).
 * Answers a function that stops watching.
 */
export function watchLocalTimes(root: Node = document): () => void {
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType === 1) localizeTimes(node as unknown as Root);
      }
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  return () => observer.disconnect();
}

/**
 * The browser half with nothing to bundle: put it in a `<script>` at the end
 * of the page. It rewrites every `<time data-local>` in the browser's zone and
 * keeps doing so for content added later. It is written as script text, not
 * taken from a function with `toString()`, because a bundler that keeps names
 * (wrangler's default) would put calls to its own helpers into that text. It
 * shares no code with the functions above; its test checks they agree.
 */
export const LOCAL_TIME_SCRIPT = `(function () {
  var SHORT = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
  var LONG = "January February March April May June July August September October November December".split(" ");
  var DAYS = "Sunday Monday Tuesday Wednesday Thursday Friday Saturday".split(" ");
  var format = new Intl.DateTimeFormat("en-US", {
    year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", hourCycle: "h23", timeZoneName: "short"
  });
  function show(el) {
    var ms = Date.parse(el.getAttribute("datetime") || "");
    var kind = el.getAttribute("data-local");
    if (!isFinite(ms) || ["date", "datetime", "ago", "year"].indexOf(kind) < 0) return;
    var p = {};
    format.formatToParts(ms).forEach(function (part) { p[part.type] = part.value; });
    var y = Number(p.year), m = Number(p.month), d = Number(p.day);
    var name = (el.getAttribute("data-month") === "long" ? LONG : SHORT)[m - 1];
    var date = el.getAttribute("data-order") === "mdy" ? name + " " + d + ", " + y : d + " " + name + " " + y;
    var wd = el.getAttribute("data-weekday");
    var withDay = date;
    if (wd === "short" || wd === "long") {
      var day = DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
      withDay = (wd === "short" ? day.slice(0, 3) : day) + ", " + date;
    }
    var elapsed = Date.now() - ms;
    var out = withDay;
    if (kind === "year") out = String(y);
    else if (kind === "datetime") out = withDay + ", " + ("0" + (Number(p.hour) % 24)).slice(-2) + ":" + p.minute + " " + p.timeZoneName;
    else if (kind === "ago") out = elapsed >= 2592000000 ? date
      : elapsed < 90000 ? "just now"
      : elapsed < 3600000 ? Math.floor(elapsed / 60000) + "m ago"
      : elapsed < 86400000 ? Math.floor(elapsed / 3600000) + "h ago"
      : Math.floor(elapsed / 86400000) + "d ago";
    el.textContent = out;
  }
  function scan(root) {
    if (root.matches && root.matches("time[data-local]")) show(root);
    var found = root.querySelectorAll("time[data-local]");
    for (var i = 0; i < found.length; i++) show(found[i]);
  }
  scan(document);
  new MutationObserver(function (records) {
    records.forEach(function (record) {
      record.addedNodes.forEach(function (node) { if (node.nodeType === 1) scan(node); });
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
`;
