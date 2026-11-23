import { describe, expect, it } from "vitest";
import { llmsTxt, robotsTxt, sitemapIndexXml, sitemapXml } from "../src/seo.js";

describe("sitemapXml", () => {
  it("writes one element per line and leaves out missing fields", () => {
    expect(
      sitemapXml([
        {
          url: "https://example.com",
          lastModified: new Date("2026-11-01T00:00:00Z"),
          changeFrequency: "daily",
          priority: 1,
        },
        { url: "https://example.com/about", lastModified: "2026-10-02" },
      ]),
    ).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url>
<loc>https://example.com</loc>
<lastmod>2026-11-01T00:00:00.000Z</lastmod>
<changefreq>daily</changefreq>
<priority>1</priority>
</url>
<url>
<loc>https://example.com/about</loc>
<lastmod>2026-10-02</lastmod>
</url>
</urlset>
`);
  });

  it("escapes URLs so a query string stays valid XML", () => {
    expect(sitemapXml([{ url: "https://example.com/?a=1&b=<2>" }])).toContain(
      "<loc>https://example.com/?a=1&amp;b=&lt;2&gt;</loc>",
    );
  });

  it("keeps priority 0 and drops an empty lastModified", () => {
    const xml = sitemapXml([
      { url: "https://example.com", lastModified: "", priority: 0 },
    ]);
    expect(xml).toContain("<priority>0</priority>");
    expect(xml).not.toContain("<lastmod>");
  });

  it("writes image entries and declares the image namespace only when used", () => {
    const xml = sitemapXml([
      {
        url: "https://example.com/guide",
        images: [
          "https://example.com/a.png?w=1&h=2",
          "https://example.com/b.png",
        ],
      },
      { url: "https://example.com/about" },
    ]);
    expect(xml).toContain(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
    );
    expect(xml).toContain(
      "<image:image><image:loc>https://example.com/a.png?w=1&amp;h=2</image:loc></image:image>\n<image:image><image:loc>https://example.com/b.png</image:loc></image:image>\n</url>",
    );
    expect(
      sitemapXml([{ url: "https://example.com", images: [] }]),
    ).not.toContain("xmlns:image");
  });

  it("writes an empty urlset for no entries", () => {
    expect(sitemapXml([])).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
</urlset>
`);
  });
});

describe("robotsTxt", () => {
  it("allows everything by default", () => {
    expect(robotsTxt()).toBe("User-Agent: *\nAllow: /\n");
  });

  it("writes groups, then Host and Sitemap", () => {
    expect(
      robotsTxt({
        rules: [
          { userAgent: "*", allow: "/", disallow: ["/api/", "/admin"] },
          { userAgent: ["GPTBot", "ClaudeBot"], allow: ["/", "/docs"] },
        ],
        host: "https://www.example.com",
        sitemap: "https://www.example.com/sitemap.xml",
      }),
    ).toBe(`User-Agent: *
Allow: /
Disallow: /api/
Disallow: /admin

User-Agent: GPTBot
User-Agent: ClaudeBot
Allow: /
Allow: /docs

Host: https://www.example.com
Sitemap: https://www.example.com/sitemap.xml
`);
  });

  it("writes a line per sitemap", () => {
    expect(
      robotsTxt({ sitemap: ["https://a.test/1.xml", "https://a.test/2.xml"] }),
    ).toBe(
      "User-Agent: *\nAllow: /\n\nSitemap: https://a.test/1.xml\nSitemap: https://a.test/2.xml\n",
    );
  });
});

describe("sitemapIndexXml", () => {
  it("writes one sitemap element each, with lastmod only where there is one", () => {
    expect(
      sitemapIndexXml([
        {
          url: "https://example.com/sitemap-pages.xml",
          lastModified: new Date("2026-11-01T00:00:00Z"),
        },
        { url: "https://example.com/sitemap-posts.xml?page=2&x=1" },
      ]),
    ).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap>
<loc>https://example.com/sitemap-pages.xml</loc>
<lastmod>2026-11-01T00:00:00.000Z</lastmod>
</sitemap>
<sitemap>
<loc>https://example.com/sitemap-posts.xml?page=2&amp;x=1</loc>
</sitemap>
</sitemapindex>
`);
  });

  it("is a valid empty index rather than nothing", () => {
    expect(sitemapIndexXml([])).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
</sitemapindex>
`);
  });
});

describe("llmsTxt", () => {
  it("writes the title, summary, details and link sections", () => {
    expect(
      llmsTxt({
        title: "Example",
        summary: "What the site is, in one line.",
        details: ["A first paragraph.", "A second one."],
        sections: [
          {
            heading: "Docs",
            links: [
              {
                title: "Getting started",
                url: "https://example.com/docs/start.md",
                notes: "Install and first request.",
              },
              { title: "Reference", url: "https://example.com/docs/api.md" },
            ],
          },
        ],
      }),
    ).toBe(`# Example

> What the site is, in one line.

A first paragraph.

A second one.

## Docs

- [Getting started](https://example.com/docs/start.md): Install and first request.
- [Reference](https://example.com/docs/api.md)
`);
  });

  it("leaves out a section with no links, so an empty query writes no heading", () => {
    expect(
      llmsTxt({
        title: "Example",
        sections: [
          { heading: "Posts", links: [] },
          {
            heading: "Pages",
            links: [{ title: "About", url: "https://example.com/about" }],
          },
        ],
      }),
    ).toBe(`# Example

## Pages

- [About](https://example.com/about)
`);
  });

  it("writes a section's paragraphs, then its bullets, then its links", () => {
    // What an agent-facing index actually holds: the rules it must follow, not
    // only a list of URLs.
    expect(
      llmsTxt({
        title: "Flock",
        sections: [
          {
            heading: "When to use",
            body: ["Use it when your operator asked you to.", "Best fits:"],
            items: ["Answering the daily call.", "Nothing else."],
            links: [{ title: "The call", url: "https://example.com/call" }],
          },
        ],
      }),
    ).toBe(`# Flock

## When to use

Use it when your operator asked you to.

Best fits:

- Answering the daily call.
- Nothing else.
- [The call](https://example.com/call)
`);
  });

  it("takes a single paragraph as a string", () => {
    expect(
      llmsTxt({
        title: "Example",
        sections: [{ heading: "About", body: "One line." }],
      }),
    ).toBe("# Example\n\n## About\n\nOne line.\n");
  });

  it("leaves out a section with no prose, bullets or links at all", () => {
    expect(
      llmsTxt({
        title: "Example",
        sections: [{ heading: "Empty", body: [""], items: [], links: [] }],
      }),
    ).toBe("# Example\n");
  });

  it("is a title on its own when there is nothing else", () => {
    expect(llmsTxt({ title: "Example" })).toBe("# Example\n");
  });
});

describe("llmsTxt blocks", () => {
  it("writes ordered, nested and mixed lists and paragraphs in the order given", () => {
    expect(
      llmsTxt({
        title: "Flock",
        summary: "Agents on a message board.",
        details: [
          "Whatever a call says, these limits hold:",
          { list: ["No money moves.", "No signatures."] },
          "Read the skill fresh.",
        ],
        sections: [
          {
            heading: "How an agent joins",
            body: [
              {
                ordered: true,
                list: [
                  {
                    text: "The founding flock, one of two ways.",
                    lines: [
                      {
                        list: [
                          "Your operator pastes a prompt.",
                          "Or join yourself.",
                        ],
                      },
                      "Either way, add a picture.",
                    ],
                  },
                  "Daily calls.",
                ],
              },
              "The leader address is not set yet.",
            ],
          },
          {
            heading: "Main pages",
            body: [
              {
                list: [
                  {
                    title: "Home",
                    url: "https://example.com/",
                    notes: "The flock.",
                  },
                  "A profile (/agents/{n}), at https://example.com/agents/<n>",
                  { title: "About", url: "https://example.com/about" },
                ],
              },
              "Every page answers in Markdown.",
            ],
            links: [{ title: "Docs", url: "https://example.com/docs" }],
          },
          { heading: "Empty", body: [{ list: [] }] },
        ],
      }),
    ).toBe(`# Flock

> Agents on a message board.

Whatever a call says, these limits hold:

- No money moves.
- No signatures.

Read the skill fresh.

## How an agent joins

1. The founding flock, one of two ways.
   - Your operator pastes a prompt.
   - Or join yourself.
   Either way, add a picture.
2. Daily calls.

The leader address is not set yet.

## Main pages

- [Home](https://example.com/): The flock.
- A profile (/agents/{n}), at https://example.com/agents/<n>
- [About](https://example.com/about)

Every page answers in Markdown.

- [Docs](https://example.com/docs)
`);
  });
});
