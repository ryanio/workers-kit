import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
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
  it("rewrites marked elements in the browser's zone with nothing bundled", () => {
    class Element {
      constructor(readonly attributes: Record<string, string>) {}
      textContent = "";
      getAttribute(name: string) {
        return this.attributes[name] ?? null;
      }
      matches() {
        return false;
      }
      querySelectorAll() {
        return [];
      }
    }
    const date = new Element({ datetime: late, "data-local": "date" });
    const stamp = new Element({
      datetime: late,
      "data-local": "datetime",
      "data-order": "mdy",
    });
    const document = {
      documentElement: {},
      querySelectorAll: () => [date, stamp],
    };
    const observed: unknown[] = [];
    // The script reads the runtime's zone; pin it the way a browser in New York would have it.
    const RealFormat = Intl.DateTimeFormat;
    class NewYorkFormat extends RealFormat {
      constructor(locale?: string, options?: Intl.DateTimeFormatOptions) {
        super(locale, { ...options, timeZone: "America/New_York" });
      }
    }
    const NewYorkIntl = { ...Intl, DateTimeFormat: NewYorkFormat };
    runInNewContext(LOCAL_TIME_SCRIPT, {
      document,
      Element,
      Intl: NewYorkIntl,
      Date,
      Number,
      String,
      MutationObserver: class {
        observe(target: unknown) {
          observed.push(target);
        }
      },
    });
    expect(date.textContent).toBe("20 Nov 2026");
    expect(stamp.textContent).toBe("Nov 20, 2026, 22:30 EST");
    expect(observed).toEqual([document.documentElement]);
  });
});
