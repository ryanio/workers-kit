import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_TIME_SCRIPT,
  localizeTimes,
  localTime,
} from "../src/local-time.js";

// 03:30 UTC on 21 November is still 20 November in New York.
const late = "2026-11-21T03:30:00.000Z";

/** A `<time>` stand-in with the attributes the code reads. */
function timeElement(attributes: Record<string, string>) {
  return {
    attributes,
    textContent: "" as string | null,
    getAttribute(name: string) {
      return this.attributes[name] ?? null;
    },
    matches: () => true,
  };
}

describe("localTime", () => {
  it("writes the date in UTC, marked for the browser to rewrite", () => {
    expect(localTime(late)).toBe(
      `<time datetime="${late}" data-local="date">21 Nov 2026</time>`,
    );
    expect(localTime(late, "datetime", { order: "mdy" })).toBe(
      `<time datetime="${late}" data-local="datetime" data-order="mdy">Nov 21, 2026, 03:30 UTC</time>`,
    );
    expect(localTime("not a date")).toBe("");
  });
});

describe("localizeTimes", () => {
  it("rewrites each marked element in the zone it is given", () => {
    const date = timeElement({ datetime: late, "data-local": "date" });
    const stamp = timeElement({ datetime: late, "data-local": "datetime" });
    const odd = timeElement({ datetime: late, "data-local": "weird" });
    const root = { querySelectorAll: () => [date, stamp, odd] };
    expect(localizeTimes(root, { timeZone: "America/New_York" })).toBe(2);
    expect(date.textContent).toBe("20 Nov 2026");
    expect(stamp.textContent).toBe("20 Nov 2026, 22:30 EST");
    expect(odd.textContent).toBe("");
  });
});

describe("LOCAL_TIME_SCRIPT", () => {
  const RealFormat = Intl.DateTimeFormat;
  // The script reads the runtime's zone; pin it the way a browser in New York would have it.
  class NewYorkFormat extends RealFormat {
    constructor(locale?: string, options?: Intl.DateTimeFormatOptions) {
      super(locale, { ...options, timeZone: "America/New_York" });
    }
  }

  /** Runs `script` against stand-in elements, as a page with no bundle would. */
  function runScript(script: string, cases: Record<string, string>[]) {
    const elements = cases.map((attributes) => timeElement(attributes));
    const document = {
      documentElement: {},
      querySelectorAll: () => elements,
    };
    const observed: unknown[] = [];
    runInNewContext(script, {
      document,
      Intl: { ...Intl, DateTimeFormat: NewYorkFormat },
      Date,
      Number,
      String,
      isFinite,
      MutationObserver: class {
        observe(target: unknown) {
          observed.push(target);
        }
      },
    });
    return { texts: elements.map((e) => e.textContent), observed, document };
  }

  const now = Date.parse("2026-11-21T06:00:00Z");
  const cases: Record<string, string>[] = [
    { datetime: late, "data-local": "date" },
    { datetime: late, "data-local": "date", "data-order": "mdy" },
    {
      datetime: late,
      "data-local": "date",
      "data-month": "long",
      "data-weekday": "long",
    },
    { datetime: late, "data-local": "datetime", "data-order": "mdy" },
    { datetime: late, "data-local": "datetime", "data-weekday": "short" },
    { datetime: late, "data-local": "year" },
    { datetime: late, "data-local": "ago" },
    { datetime: "2026-11-21T05:59:30Z", "data-local": "ago" },
    { datetime: "2026-11-20T23:00:00Z", "data-local": "ago" },
    { datetime: "2026-11-15T06:00:00Z", "data-local": "ago" },
    {
      datetime: "2026-09-01T03:30:00Z",
      "data-local": "ago",
      "data-order": "mdy",
    },
  ];

  it("writes what localizeTimes writes, for every kind and option", () => {
    vi.useFakeTimers({ now });
    try {
      const { texts, observed, document } = runScript(LOCAL_TIME_SCRIPT, cases);
      const expected = cases.map((attributes) => timeElement(attributes));
      localizeTimes(
        { querySelectorAll: () => expected },
        { timeZone: "America/New_York" },
      );
      expect(texts).toEqual(expected.map((e) => e.textContent));
      expect(texts[0]).toBe("20 Nov 2026");
      expect(texts[2]).toBe("Friday, 20 November 2026");
      expect(observed).toEqual([document.documentElement]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still runs after a bundler that keeps names has been through the module", async () => {
    const { build } = await import("esbuild");
    const bundled = await build({
      entryPoints: [new URL("../src/local-time.ts", import.meta.url).pathname],
      bundle: true,
      write: false,
      format: "esm",
      keepNames: true,
      platform: "neutral",
    });
    const code = bundled.outputFiles[0]?.text ?? "";
    const mod = await import(
      `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
    );
    expect(mod.LOCAL_TIME_SCRIPT).not.toContain("__name");
    vi.useFakeTimers({ now });
    try {
      expect(
        runScript(mod.LOCAL_TIME_SCRIPT, [cases[0] as Record<string, string>])
          .texts,
      ).toEqual(["20 Nov 2026"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
