/**
 * A live check that a site's indexing signals agree: robots.txt, the
 * sitemap, each page's status, canonical and robots directives, and how the
 * site answers URLs that name nothing. It reads the deployed site over
 * `fetch`, so it runs after a deploy, from CI or a scheduled job, in Node or
 * in a Worker.
 */

import { mapLimit } from "./async.js";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** One disagreement the audit found. */
export interface SeoFinding {
  rule: SeoRule;
  url: string;
  message: string;
}

export type SeoRule =
  | "robots-unreachable"
  | "sitemap-unreachable"
  | "sitemap-status"
  | "sitemap-redirect"
  | "sitemap-canonical"
  | "sitemap-noindex"
  | "sitemap-blocked"
  | "image-blocked"
  | "soft-404"
  | "host-crawlable";

export interface SeoAuditOptions {
  /** The canonical origin, such as `https://www.example.com`. */
  origin: string;
  /**
   * Sitemap URLs to read. Default: the `Sitemap:` lines of robots.txt, or
   * `<origin>/sitemap.xml` when it names none. Sitemap indexes are followed.
   * An empty list checks no sitemap.
   */
  sitemaps?: string[];
  /** Read at most this many sitemap URLs. Default 500. */
  limit?: number;
  /**
   * Route patterns for pages that load by id, such as `/blog/$slug` or
   * `/profile/:name`. Each is requested once as written, since crawlers pull
   * patterns like these out of client bundles, and once with a made-up id.
   * Both must answer 404 or 410 or carry noindex.
   */
  probes?: string[];
  /**
   * Other origins the site uses that are not for search, such as an API
   * host. Each robots.txt must disallow `/` for every crawler.
   */
  privateHosts?: string[];
  /** Requests in flight at once. Default 8. */
  concurrency?: number;
  /** The crawler whose robots.txt group applies. Default `Googlebot`. */
  userAgent?: string;
  fetch?: Fetch;
  /** Abort each request after this long. Default 15 seconds. */
  timeoutMs?: number;
}

export interface SeoAuditResult {
  findings: SeoFinding[];
  /** Sitemap URLs that were checked. */
  checked: number;
}

// Robots.txt

interface RobotsGroup {
  agents: string[];
  rules: { allow: boolean; path: string }[];
}

export interface ParsedRobots {
  groups: RobotsGroup[];
  sitemaps: string[];
}

/** Robots.txt groups and Sitemap lines, as Google reads them (RFC 9309). */
export function parseRobotsTxt(body: string): ParsedRobots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current || (key !== "allow" && key !== "disallow")) continue;
    // An empty Disallow allows everything, so it adds no rule.
    if (value) current.rules.push({ allow: key === "allow", path: value });
  }
  return { groups, sitemaps };
}

function ruleMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}${anchored ? "$" : ""}`).test(path);
}

/**
 * Whether `userAgent` may fetch `url` under these rules: the most specific
 * matching group (or `*`), then the longest matching rule, with Allow
 * winning a tie.
 */
export function robotsAllows(
  robots: ParsedRobots,
  url: string,
  userAgent = "Googlebot",
): boolean {
  const agent = userAgent.toLowerCase();
  let groups = robots.groups.filter((g) =>
    g.agents.some((a) => a !== "*" && agent.startsWith(a)),
  );
  if (groups.length === 0) {
    groups = robots.groups.filter((g) => g.agents.includes("*"));
  }
  const parsed = new URL(url);
  const path = parsed.pathname + parsed.search;
  let best: { allow: boolean; length: number } | null = null;
  for (const group of groups) {
    for (const rule of group.rules) {
      if (!ruleMatches(rule.path, path)) continue;
      const length = rule.path.length;
      if (
        !best ||
        length > best.length ||
        (length === best.length && rule.allow)
      ) {
        best = { allow: rule.allow, length };
      }
    }
  }
  return best?.allow ?? true;
}

// Page signals

export interface PageSignals {
  canonical?: string | undefined;
  /** `noindex` from a robots or googlebot meta tag or the X-Robots-Tag header. */
  noindex: boolean;
  ogImage?: string | undefined;
}

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(
    /([a-zA-Z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g,
  )) {
    const name = m[1];
    if (name) out[name.toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return out;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

// Directives that carry a colon themselves, so a name before a colon is an
// agent only when it is not one of these.
const VALUED_DIRECTIVES = new Set([
  "unavailable_after",
  "max-snippet",
  "max-image-preview",
  "max-video-preview",
]);

/**
 * Whether an X-Robots-Tag value says noindex for `agent`. A directive after
 * "otherbot:" applies only to that bot, until the next agent name.
 */
function hasNoindex(value: string, agent = "googlebot"): boolean {
  let scope: string | null = null;
  for (const part of value.split(",")) {
    let directive = part;
    const named = part.match(/^\s*([a-z][\w-]*)\s*:\s*(.*)$/i);
    const name = named?.[1]?.toLowerCase();
    if (name && !VALUED_DIRECTIVES.has(name)) {
      scope = name;
      directive = named?.[2] ?? "";
    }
    if (scope && scope !== agent) continue;
    if (/^\s*(noindex|none)\s*$/i.test(directive)) return true;
  }
  return false;
}

/**
 * The canonical, noindex and og:image a page states, from its HTML head and
 * its X-Robots-Tag header. The canonical and og:image are resolved against
 * `url`.
 */
export function pageSignals(
  html: string,
  headers: Headers,
  url: string,
): PageSignals {
  const head = html.split(/<\/head>/i)[0] ?? html;
  let canonical: string | undefined;
  let ogImage: string | undefined;
  let noindex = hasNoindex(headers.get("x-robots-tag") ?? "");
  for (const m of head.matchAll(/<(link|meta)\b[^>]*>/gi)) {
    const attrs = attributes(m[0]);
    if (m[1]?.toLowerCase() === "link") {
      const rels = (attrs.rel ?? "").toLowerCase().split(/\s+/);
      if (rels.includes("canonical") && attrs.href && canonical === undefined) {
        canonical = new URL(decodeEntities(attrs.href), url).href;
      }
      continue;
    }
    const name = (attrs.name ?? "").toLowerCase();
    if ((name === "robots" || name === "googlebot") && attrs.content) {
      noindex ||= /\b(noindex|none)\b/i.test(attrs.content);
    }
    const property = (attrs.property ?? "").toLowerCase();
    if (property === "og:image" && attrs.content && ogImage === undefined) {
      ogImage = new URL(decodeEntities(attrs.content), url).href;
    }
  }
  return { canonical, noindex, ogImage };
}

/** Two URLs name the same page: equal, or both the origin with or without "/". */
export function sameUrl(a: string, b: string): boolean {
  const x = new URL(a);
  const y = new URL(b);
  if (x.pathname === "") x.pathname = "/";
  if (y.pathname === "") y.pathname = "/";
  x.hash = "";
  y.hash = "";
  return x.href === y.href;
}

// Sitemaps

/** The `<loc>` values of a sitemap or sitemap index, and which it is. */
export function parseSitemap(xml: string): {
  index: boolean;
  locs: string[];
} {
  const locs = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) =>
    decodeEntities(m[1] ?? ""),
  );
  return { index: /<sitemapindex\b/i.test(xml), locs };
}

// The audit

/** A path pattern with each `$param`, `:param` or `[param]` segment filled. */
function fillPattern(pattern: string, value: string | null): string {
  return pattern
    .split("/")
    .map((segment) =>
      value !== null && /^(\$|:|\[)/.test(segment)
        ? value
        : encodeURI(segment).replace(/\$/g, "%24"),
    )
    .join("/");
}

/**
 * Checks a deployed site's indexing signals and returns what disagrees.
 * Nothing here is a style rule: each finding is something Search Console
 * reports as a reason a page is not indexed.
 */
export async function auditSite(
  options: SeoAuditOptions,
): Promise<SeoAuditResult> {
  const origin = new URL(options.origin).origin;
  const userAgent = options.userAgent ?? "Googlebot";
  const limit = options.limit ?? 500;
  const concurrency = options.concurrency ?? 8;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const fetcher: Fetch = options.fetch ?? ((u, i) => fetch(u, i));
  const findings: SeoFinding[] = [];
  const get = (url: string, redirect: RequestRedirect = "manual") =>
    fetcher(url, {
      redirect,
      headers: {
        // Not a crawler's name: Cloudflare and others block a request that
        // claims to be Googlebot from an address Google does not own.
        "user-agent": "workers-start-seo-audit",
        accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

  let robots: ParsedRobots = { groups: [], sitemaps: [] };
  try {
    const res = await get(`${origin}/robots.txt`, "follow");
    if (res.ok) robots = parseRobotsTxt(await res.text());
    else if (res.status >= 500) {
      findings.push({
        rule: "robots-unreachable",
        url: `${origin}/robots.txt`,
        message: `robots.txt answered ${res.status}; Google stops crawling while it does`,
      });
    }
  } catch (error) {
    findings.push({
      rule: "robots-unreachable",
      url: `${origin}/robots.txt`,
      message: `robots.txt could not be read: ${String(error)}`,
    });
  }

  // Every sitemap URL, following indexes, up to the limit.
  const queue = [
    ...(options.sitemaps ??
      (robots.sitemaps.length > 0
        ? robots.sitemaps
        : [`${origin}/sitemap.xml`])),
  ];
  const pages: string[] = [];
  const seen = new Set<string>();
  while (queue.length > 0 && pages.length < limit) {
    const sitemap = queue.shift() as string;
    if (seen.has(sitemap)) continue;
    seen.add(sitemap);
    try {
      const res = await get(sitemap, "follow");
      if (!res.ok) throw new Error(`answered ${res.status}`);
      const { index, locs } = parseSitemap(await res.text());
      if (index) queue.push(...locs);
      else pages.push(...locs.slice(0, limit - pages.length));
    } catch (error) {
      findings.push({
        rule: "sitemap-unreachable",
        url: sitemap,
        message: `sitemap could not be read: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const images = new Map<string, string>();
  await mapLimit(pages, concurrency, async (url) => {
    if (!robotsAllows(robots, url, userAgent)) {
      findings.push({
        rule: "sitemap-blocked",
        url,
        message: "in the sitemap but disallowed by robots.txt",
      });
      return;
    }
    let res: Response;
    try {
      res = await get(url);
    } catch (error) {
      findings.push({
        rule: "sitemap-status",
        url,
        message: `request failed: ${String(error)}`,
      });
      return;
    }
    if (res.status >= 300 && res.status < 400) {
      findings.push({
        rule: "sitemap-redirect",
        url,
        message: `in the sitemap but redirects (${res.status}) to ${res.headers.get("location") ?? "?"}`,
      });
      return;
    }
    if (res.status !== 200) {
      findings.push({
        rule: "sitemap-status",
        url,
        message: `in the sitemap but answered ${res.status}`,
      });
      return;
    }
    const signals = pageSignals(await res.text(), res.headers, url);
    if (signals.noindex) {
      findings.push({
        rule: "sitemap-noindex",
        url,
        message: "in the sitemap but marked noindex",
      });
    }
    if (signals.canonical && !sameUrl(signals.canonical, url)) {
      findings.push({
        rule: "sitemap-canonical",
        url,
        message: `in the sitemap but its canonical is ${signals.canonical}`,
      });
    }
    if (signals.ogImage && !images.has(signals.ogImage)) {
      images.set(signals.ogImage, url);
    }
  });

  // A linked URL that robots.txt blocks can still be indexed, and Google
  // cannot read a noindex on a URL it may not fetch.
  for (const [image, page] of images) {
    if (new URL(image).origin !== origin) continue;
    if (!robotsAllows(robots, image, userAgent)) {
      findings.push({
        rule: "image-blocked",
        url: image,
        message: `og:image of ${page} is disallowed by robots.txt, so it can be indexed without Google reading its headers`,
      });
    }
  }

  const probeUrls = (options.probes ?? []).flatMap((pattern) => [
    `${origin}${fillPattern(pattern, null)}`,
    `${origin}${fillPattern(pattern, `seo-audit-${Math.random().toString(36).slice(2, 10)}`)}`,
  ]);
  await mapLimit(probeUrls, concurrency, async (url) => {
    try {
      const res = await get(url, "follow");
      if (res.status === 404 || res.status === 410) return;
      const signals = pageSignals(
        res.ok ? await res.text() : "",
        res.headers,
        url,
      );
      if (signals.noindex || res.status >= 500) return;
      findings.push({
        rule: "soft-404",
        url,
        message: `names nothing but answered ${res.status}${res.redirected ? ` at ${res.url}` : ""} without noindex; answer 404 or add noindex`,
      });
    } catch (error) {
      findings.push({
        rule: "soft-404",
        url,
        message: `request failed: ${String(error)}`,
      });
    }
  });

  for (const host of options.privateHosts ?? []) {
    const base = new URL(host).origin;
    try {
      const res = await get(`${base}/robots.txt`, "follow");
      const parsed = res.ok
        ? parseRobotsTxt(await res.text())
        : { groups: [], sitemaps: [] };
      if (robotsAllows(parsed, `${base}/`, userAgent)) {
        findings.push({
          rule: "host-crawlable",
          url: `${base}/robots.txt`,
          message:
            "a host that is not for search lets crawlers in; serve robots.txt with Disallow: /",
        });
      }
    } catch (error) {
      findings.push({
        rule: "host-crawlable",
        url: `${base}/robots.txt`,
        message: `robots.txt could not be read: ${String(error)}`,
      });
    }
  }

  findings.sort((a, b) =>
    a.rule === b.rule ? a.url.localeCompare(b.url) : a.rule < b.rule ? -1 : 1,
  );
  return { findings, checked: pages.length };
}
