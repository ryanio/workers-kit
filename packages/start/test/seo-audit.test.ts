import { describe, expect, it } from "vitest";
import {
  auditSite,
  pageSignals,
  parseRobotsTxt,
  robotsAllows,
  type SeoFinding,
} from "../src/seo-audit.js";

const ORIGIN = "https://example.com";

function page(head: string): string {
  return `<!doctype html><html><head>${head}</head><body></body></html>`;
}

/** A fake site: path (with query) to a response factory. Anything else 404s. */
function site(routes: Record<string, () => Response>) {
  return async (input: string) => {
    const url = new URL(input);
    const route = routes[`${url.origin}${url.pathname}${url.search}`];
    return route ? route() : new Response("not found", { status: 404 });
  };
}

const html =
  (body: string, headers: Record<string, string> = {}) =>
  () =>
    new Response(body, {
      headers: { "content-type": "text/html", ...headers },
    });

const sitemap =
  (...paths: string[]) =>
  () =>
    new Response(
      `<?xml version="1.0"?><urlset>${paths.map((p) => `<url><loc>${ORIGIN}${p}</loc></url>`).join("")}</urlset>`,
    );

const rules = (findings: SeoFinding[]) =>
  findings.map((f) => `${f.rule} ${f.url}`);

describe("robots.txt matching", () => {
  const robots = parseRobotsTxt(`
User-agent: *
Disallow: /api/
Disallow: */opengraph-image*
Allow: /api/public$

User-agent: Googlebot
User-agent: Bingbot
Disallow: /private
Sitemap: https://example.com/sitemap.xml
`);

  it("reads groups and sitemaps", () => {
    expect(robots.sitemaps).toEqual(["https://example.com/sitemap.xml"]);
    expect(robots.groups[1]?.agents).toEqual(["googlebot", "bingbot"]);
  });

  it("uses the named group over * and the longest rule", () => {
    expect(robotsAllows(robots, `${ORIGIN}/private/x`, "Googlebot")).toBe(
      false,
    );
    // Googlebot's own group has no /api/ rule, so * does not apply to it.
    expect(robotsAllows(robots, `${ORIGIN}/api/x`, "Googlebot")).toBe(true);
    expect(robotsAllows(robots, `${ORIGIN}/api/x`, "OtherBot")).toBe(false);
    expect(robotsAllows(robots, `${ORIGIN}/api/public`, "OtherBot")).toBe(true);
    expect(
      robotsAllows(robots, `${ORIGIN}/blog/a/opengraph-image`, "OtherBot"),
    ).toBe(false);
  });
});

describe("pageSignals", () => {
  it("reads the canonical, robots meta and og:image in any attribute order", () => {
    const signals = pageSignals(
      page(
        `<link href="/a?x=1&amp;y=2" rel="canonical"><meta content="noindex, follow" name="robots"><meta property="og:image" content="/a/card.png">`,
      ),
      new Headers(),
      `${ORIGIN}/a`,
    );
    expect(signals).toEqual({
      canonical: `${ORIGIN}/a?x=1&y=2`,
      noindex: true,
      ogImage: `${ORIGIN}/a/card.png`,
    });
  });

  it("applies an X-Robots-Tag noindex only to the bot it names", () => {
    const at = (value: string) =>
      pageSignals("", new Headers({ "x-robots-tag": value }), ORIGIN).noindex;
    expect(at("noindex")).toBe(true);
    expect(at("googlebot: noindex")).toBe(true);
    expect(at("bingbot: noindex")).toBe(false);
    expect(at("max-snippet: 20, noindex")).toBe(true);
    expect(at("bingbot: noindex, googlebot: none")).toBe(true);
  });
});

describe("auditSite", () => {
  it("passes a site whose signals agree", async () => {
    const result = await auditSite({
      origin: ORIGIN,
      probes: ["/blog/$slug"],
      fetch: site({
        [`${ORIGIN}/robots.txt`]: () =>
          new Response(`User-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sm.xml`),
        [`${ORIGIN}/sm.xml`]: sitemap("/", "/blog/a"),
        [`${ORIGIN}/`]: html(page(`<link rel="canonical" href="${ORIGIN}">`)),
        [`${ORIGIN}/blog/a`]: html(
          page(`<link rel="canonical" href="${ORIGIN}/blog/a">`),
        ),
      }),
    });
    expect(result).toEqual({ findings: [], checked: 2, challenged: [] });
  });

  it("finds a page whose canonical names the homepage", async () => {
    const { findings } = await auditSite({
      origin: ORIGIN,
      fetch: site({
        [`${ORIGIN}/sitemap.xml`]: sitemap("/tools"),
        [`${ORIGIN}/tools`]: html(
          page(`<link rel="canonical" href="${ORIGIN}">`),
        ),
      }),
    });
    expect(rules(findings)).toEqual([`sitemap-canonical ${ORIGIN}/tools`]);
  });

  it("finds sitemap URLs that redirect, fail, are noindex or are blocked", async () => {
    const { findings } = await auditSite({
      origin: ORIGIN,
      fetch: site({
        [`${ORIGIN}/robots.txt`]: () =>
          new Response("User-agent: *\nDisallow: /admin/"),
        [`${ORIGIN}/sitemap.xml`]: () =>
          new Response(
            `<sitemapindex><sitemap><loc>${ORIGIN}/one.xml</loc></sitemap></sitemapindex>`,
          ),
        [`${ORIGIN}/one.xml`]: sitemap("/old", "/gone", "/hidden", "/admin/x"),
        [`${ORIGIN}/old`]: () =>
          new Response(null, { status: 301, headers: { location: "/new" } }),
        [`${ORIGIN}/hidden`]: html(page(""), { "x-robots-tag": "noindex" }),
      }),
    });
    expect(rules(findings)).toEqual([
      `sitemap-blocked ${ORIGIN}/admin/x`,
      `sitemap-noindex ${ORIGIN}/hidden`,
      `sitemap-redirect ${ORIGIN}/old`,
      `sitemap-status ${ORIGIN}/gone`,
    ]);
  });

  it("finds a share image that robots.txt blocks", async () => {
    const { findings } = await auditSite({
      origin: ORIGIN,
      fetch: site({
        [`${ORIGIN}/robots.txt`]: () =>
          new Response("User-agent: *\nDisallow: */opengraph-image*"),
        [`${ORIGIN}/sitemap.xml`]: sitemap("/a"),
        [`${ORIGIN}/a`]: html(
          page(
            `<link rel="canonical" href="${ORIGIN}/a"><meta property="og:image" content="/a/opengraph-image">`,
          ),
        ),
      }),
    });
    expect(rules(findings)).toEqual([
      `image-blocked ${ORIGIN}/a/opengraph-image`,
    ]);
  });

  it("finds a route pattern that renders an indexable page", async () => {
    const indexable = html(page(`<meta name="robots" content="index">`));
    const { findings } = await auditSite({
      origin: ORIGIN,
      sitemaps: [],
      probes: ["/profile/$name", "/bot/:id"],
      fetch: async (input) => {
        const { pathname } = new URL(input);
        if (pathname.startsWith("/profile/")) return indexable();
        if (pathname === "/bot/:id") {
          return html(page(`<meta name="robots" content="noindex">`))();
        }
        return new Response("no", { status: 404 });
      },
    });
    expect(findings.map((f) => f.rule)).toEqual(["soft-404", "soft-404"]);
    expect(findings.map((f) => f.url)).toContain(`${ORIGIN}/profile/%24name`);
  });

  it("finds a host that is not for search but lets crawlers in", async () => {
    const api = "https://api.example.com";
    const open = await auditSite({
      origin: ORIGIN,
      sitemaps: [],
      privateHosts: [api],
      fetch: site({ [`${api}/robots.txt`]: () => new Response("# signals") }),
    });
    expect(rules(open.findings)).toEqual([`host-crawlable ${api}/robots.txt`]);

    const closed = await auditSite({
      origin: ORIGIN,
      sitemaps: [],
      privateHosts: [api],
      fetch: site({
        [`${api}/robots.txt`]: () =>
          new Response("User-agent: *\nDisallow: /\n"),
      }),
    });
    expect(closed.findings).toEqual([]);
  });

  it("sets aside a URL a Cloudflare challenge answers instead of failing it", async () => {
    const result = await auditSite({
      origin: ORIGIN,
      probes: ["/item/$id"],
      fetch: async (input) => {
        if (input.endsWith("/sitemap.xml")) return sitemap("/a")();
        return new Response("<html>Just a moment</html>", {
          status: 403,
          headers: { "cf-mitigated": "challenge" },
        });
      },
    });
    expect(result.findings).toEqual([]);
    expect(result.challenged).toHaveLength(3);
    expect(result.challenged).toContain(`${ORIGIN}/a`);
  });
});
