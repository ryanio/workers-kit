/** One `<url>` in a sitemap. Fields follow the sitemap protocol. */
export interface SitemapEntry {
  /** Absolute URL. Escaped for XML on output. */
  url: string;
  /** A Date is written as an ISO timestamp, a string as given. */
  lastModified?: Date | string;
  changeFrequency?:
    | "always"
    | "hourly"
    | "daily"
    | "weekly"
    | "monthly"
    | "yearly"
    | "never";
  priority?: number;
}

/** One group of rules in robots.txt. */
export interface RobotsRule {
  userAgent: string | readonly string[];
  allow?: string | readonly string[];
  disallow?: string | readonly string[];
}

export interface RobotsOptions {
  /** Defaults to one group that allows everything to every agent. */
  rules?: RobotsRule | readonly RobotsRule[];
  /** Written as a `Host:` line. */
  host?: string;
  /** Absolute sitemap URLs, one `Sitemap:` line each. */
  sitemap?: string | readonly string[];
}

function list<T>(value: T | readonly T[] | undefined): readonly T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value as T];
}

/** Escapes the five XML special characters. */
export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * A sitemap protocol `<urlset>` with one element per line. Fields left out of
 * an entry are left out of its `<url>`.
 */
export function sitemapXml(entries: readonly SitemapEntry[]): string {
  const urls = entries.map((entry) => {
    const lines = ["<url>", `<loc>${escapeXml(entry.url)}</loc>`];
    if (entry.lastModified !== undefined && entry.lastModified !== "") {
      const lastmod =
        entry.lastModified instanceof Date
          ? entry.lastModified.toISOString()
          : entry.lastModified;
      lines.push(`<lastmod>${escapeXml(lastmod)}</lastmod>`);
    }
    if (entry.changeFrequency) {
      lines.push(`<changefreq>${entry.changeFrequency}</changefreq>`);
    }
    if (entry.priority !== undefined) {
      lines.push(`<priority>${entry.priority}</priority>`);
    }
    lines.push("</url>");
    return lines.join("\n");
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n");
}

/**
 * A robots.txt body: each rule group as `User-Agent`, `Allow` and `Disallow`
 * lines, groups separated by a blank line, then `Host` and `Sitemap`.
 */
export function robotsTxt(options: RobotsOptions = {}): string {
  const rules = list(options.rules);
  const groups = (rules.length > 0 ? rules : [{ userAgent: "*", allow: "/" }])
    .map((rule) =>
      [
        ...list(rule.userAgent).map((agent) => `User-Agent: ${agent}`),
        ...list(rule.allow).map((path) => `Allow: ${path}`),
        ...list(rule.disallow).map((path) => `Disallow: ${path}`),
      ].join("\n"),
    )
    .join("\n\n");
  const footer = [
    ...(options.host ? [`Host: ${options.host}`] : []),
    ...list(options.sitemap).map((url) => `Sitemap: ${url}`),
  ];
  return footer.length > 0
    ? `${groups}\n\n${footer.join("\n")}\n`
    : `${groups}\n`;
}

/** One `<sitemap>` in a sitemap index. */
export interface SitemapIndexEntry {
  /** Absolute URL of a sitemap. Escaped for XML on output. */
  url: string;
  /** A Date is written as an ISO timestamp, a string as given. */
  lastModified?: Date | string;
}

/**
 * A `<sitemapindex>`, for a site past the 50,000 URL or 50 MB limit of one
 * sitemap, or one that simply splits its sitemaps by kind. The index is what
 * `robotsTxt`'s `sitemap` should point at once there is more than one.
 */
export function sitemapIndexXml(entries: readonly SitemapIndexEntry[]): string {
  const sitemaps = entries.map((entry) => {
    const lines = ["<sitemap>", `<loc>${escapeXml(entry.url)}</loc>`];
    if (entry.lastModified !== undefined && entry.lastModified !== "") {
      const lastmod =
        entry.lastModified instanceof Date
          ? entry.lastModified.toISOString()
          : entry.lastModified;
      lines.push(`<lastmod>${escapeXml(lastmod)}</lastmod>`);
    }
    lines.push("</sitemap>");
    return lines.join("\n");
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...sitemaps,
    "</sitemapindex>",
    "",
  ].join("\n");
}

/** One link in an `llms.txt` section. */
export interface LlmsLink {
  title: string;
  /** Absolute, so an agent that fetched the file from anywhere can follow it. */
  url: string;
  /** A sentence after the link, telling an agent what it will find there. */
  notes?: string;
}

/** One item of an `llms.txt` list: plain text, a link, or either with lines under it. */
export type LlmsItem =
  | string
  | LlmsLink
  | {
      /** The item's own line. */
      text: string | LlmsLink;
      /**
       * Lines under the item, indented to its text, in order: a string is a
       * line of its own, a list is a nested list.
       */
      lines?: readonly (string | LlmsList)[];
    };

/** A bulleted list, or a numbered one with `ordered`. */
export interface LlmsList {
  list: readonly LlmsItem[];
  ordered?: boolean;
}

/** A paragraph, or a list. Blocks are written in the order given, a blank line apart. */
export type LlmsBlock = string | LlmsList;

export interface LlmsSection {
  heading: string;
  /**
   * What comes under the heading, before `items` and `links`: paragraphs, and
   * lists in among them, in the order given.
   */
  body?: string | readonly LlmsBlock[];
  /** Plain bullets, for a list that is not links: limits, steps, what fits. */
  items?: readonly string[];
  links?: readonly LlmsLink[];
}

export interface LlmsOptions {
  /** The site or product name, the one H1 the format allows. */
  title: string;
  /** The blockquote under the title: one sentence on what this is. */
  summary?: string;
  /** Paragraphs and lists between the summary and the first section. */
  details?: string | readonly LlmsBlock[];
  /**
   * `## heading`, then its paragraphs, bullets and links in that order. A
   * section with none of the three is left out, so an empty query writes no
   * heading.
   */
  sections?: readonly LlmsSection[];
}

/**
 * An `llms.txt` body: the agent-facing index of a site, as
 * [llmstxt.org](https://llmstxt.org) lays it out. One H1, an optional
 * blockquote summary, free paragraphs, then `##` sections of links.
 *
 * Serve it at `/llms.txt` as `text/plain`. It is for the links an agent should
 * read, which is rarely the same set a sitemap carries: the docs, the API
 * description, the Markdown of the pages that matter, and not every tag page.
 */
export function llmsTxt(options: LlmsOptions): string {
  const blocks: string[] = [`# ${options.title}`];
  if (options.summary) {
    blocks.push(`> ${options.summary}`);
  }
  blocks.push(...written(list(options.details)));
  for (const section of list(options.sections)) {
    const body = written(list(section.body));
    const items = section.items ?? [];
    const links = section.links ?? [];
    if (body.length === 0 && items.length === 0 && links.length === 0) {
      continue;
    }
    blocks.push(`## ${section.heading}`);
    blocks.push(...body);
    const bullets = [
      ...items.map((item) => `- ${item}`),
      ...links.map((link) => `- ${linkLine(link)}`),
    ];
    if (bullets.length > 0) {
      blocks.push(bullets.join("\n"));
    }
  }
  return `${blocks.join("\n\n")}\n`;
}

function linkLine(link: LlmsLink): string {
  return link.notes
    ? `[${link.title}](${link.url}): ${link.notes}`
    : `[${link.title}](${link.url})`;
}

/** Each block as text, leaving out empty paragraphs and empty lists. */
function written(blocks: readonly LlmsBlock[]): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    if (typeof block === "string") {
      if (block !== "") out.push(block);
    } else if (block.list.length > 0) {
      out.push(listLines(block, "").join("\n"));
    }
  }
  return out;
}

function listLines(block: LlmsList, indent: string): string[] {
  const lines: string[] = [];
  block.list.forEach((item, index) => {
    const marker = block.ordered ? `${index + 1}. ` : "- ";
    const own = typeof item === "string" || "url" in item ? item : item.text;
    lines.push(
      `${indent}${marker}${typeof own === "string" ? own : linkLine(own)}`,
    );
    if (typeof item === "object" && "text" in item && item.lines) {
      const under = indent + " ".repeat(marker.length);
      for (const line of item.lines) {
        if (typeof line === "string") lines.push(`${under}${line}`);
        else lines.push(...listLines(line, under));
      }
    }
  });
  return lines;
}
