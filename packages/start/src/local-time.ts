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
}

const KINDS: readonly LocalTimeKind[] = ["date", "datetime", "ago", "year"];

function text(
  ms: number,
  kind: LocalTimeKind,
  timeZone: string,
  order: LocalTimeOptions["order"],
): string {
  if (kind === "year") return fullDate(ms, { timeZone }).slice(-4);
  if (kind === "ago") return timeAgo(ms, { timeZone, order, month: "short" });
  if (kind === "datetime") return dateTime(ms, { timeZone, order });
  return fullDate(ms, { timeZone, order, month: "short" });
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
  const order = options.order === "mdy" ? ' data-order="mdy"' : "";
  return `<time datetime="${new Date(ms).toISOString()}" data-local="${kind}"${order}>${text(ms, kind, "UTC", options.order)}</time>`;
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
    const order =
      element.getAttribute("data-order") === "mdy" ? "mdy" : undefined;
    element.textContent = text(ms, kind, timeZone, order);
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
 * keeps doing so for content added later. Self-contained on purpose, so it
 * shares no code with the functions above; its test checks they agree.
 */
function inlineLocalTimes(): void {
  const months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
  const fmt = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
    timeZoneName: "short",
  });
  const show = (el: Element): void => {
    const ms = Date.parse(el.getAttribute("datetime") || "");
    const kind = el.getAttribute("data-local");
    if (!Number.isFinite(ms) || !kind) return;
    const p: Record<string, string> = {};
    for (const part of fmt.formatToParts(ms)) p[part.type] = part.value;
    const day = `${Number(p.day)}`;
    const month = months[Number(p.month) - 1];
    const date =
      el.getAttribute("data-order") === "mdy"
        ? `${month} ${day}, ${p.year}`
        : `${day} ${month} ${p.year}`;
    const elapsed = Date.now() - ms;
    let out = date;
    if (kind === "year") out = `${p.year}`;
    else if (kind === "datetime")
      out = `${date}, ${String(Number(p.hour) % 24).padStart(2, "0")}:${p.minute} ${p.timeZoneName}`;
    else if (kind === "ago" && elapsed < 30 * 86400000)
      out =
        elapsed < 90000
          ? "just now"
          : elapsed < 3600000
            ? `${Math.floor(elapsed / 60000)}m ago`
            : elapsed < 86400000
              ? `${Math.floor(elapsed / 3600000)}h ago`
              : `${Math.floor(elapsed / 86400000)}d ago`;
    el.textContent = out;
  };
  const scan = (root: Element | Document): void => {
    if (root instanceof Element && root.matches("time[data-local]")) show(root);
    for (const el of root.querySelectorAll("time[data-local]")) show(el);
  };
  scan(document);
  new MutationObserver((records) => {
    for (const record of records)
      for (const node of record.addedNodes)
        if (node instanceof Element) scan(node);
  }).observe(document.documentElement, { childList: true, subtree: true });
}

/** `inlineLocalTimes` as script text, for a page with no bundle. */
export const LOCAL_TIME_SCRIPT = `(${inlineLocalTimes.toString()})();`;
