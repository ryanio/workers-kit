import { describe, expect, it } from "vitest";
import {
  aboutDuration,
  capitalize,
  compactCount,
  counted,
  DAY_MS,
  fitWords,
  formatCount,
  fullDate,
  listOf,
  numberWord,
  ordinal,
  percent,
  plural,
  slugify,
  timeAgo,
  toMillis,
  truncate,
  usd,
  utcDate,
  utcDay,
  utcStamp,
  w3cDate,
  wrapWords,
} from "../src/format.js";

describe("toMillis", () => {
  it("reads a timestamp with no zone as UTC", () => {
    // What SQLite's datetime() returns. Read in the runtime's own zone it
    // would be hours out, which is how "2h ago" shows up on a fresh row.
    expect(toMillis("2026-11-20 14:03:00")).toBe(
      Date.parse("2026-11-20T14:03:00Z"),
    );
    expect(toMillis("2026-11-20T14:03")).toBe(
      Date.parse("2026-11-20T14:03:00Z"),
    );
  });

  it("leaves a timestamp that carries a zone alone", () => {
    expect(toMillis("2026-11-20T14:03:00+02:00")).toBe(
      Date.parse("2026-11-20T12:03:00Z"),
    );
  });

  it("takes a Date and epoch milliseconds", () => {
    expect(toMillis(new Date(1234))).toBe(1234);
    expect(toMillis(0)).toBe(0);
  });

  it.each([null, undefined, "", "not a date", Number.NaN, new Date("x")])(
    "is null for %j",
    (value) => {
      expect(toMillis(value as never)).toBeNull();
    },
  );
});

describe("counts", () => {
  it("picks the word by the count, with an irregular plural when given one", () => {
    expect(plural(1, "reply")).toBe("reply");
    expect(plural(0, "reply")).toBe("replys");
    expect(plural(2, "reply", "replies")).toBe("replies");
  });

  it("groups a count with its noun", () => {
    expect(counted(1, "muse")).toBe("1 muse");
    expect(counted(1204, "muse")).toBe("1,204 muses");
    expect(counted(3, "muse", undefined, { words: true })).toBe("three muses");
    expect(counted(12_300, "muse", undefined, { compact: true })).toBe(
      "12.3k muses",
    );
  });

  it("keeps a count readable in full below the compact threshold", () => {
    // "9.9k" hides whether a number crossed ten thousand; 9,934 does not.
    expect(compactCount(9999)).toBe("9,999");
    expect(compactCount(10_000)).toBe("10k");
    expect(compactCount(12_340)).toBe("12.3k");
    expect(compactCount(4_500_000)).toBe("4.5m");
    expect(compactCount(1_200_000_000)).toBe("1.2b");
    expect(compactCount(-12_340)).toBe("-12.3k");
    expect(compactCount(1200, { threshold: 1000 })).toBe("1.2k");
  });

  it("spells up to twelve and no further", () => {
    expect(numberWord(0)).toBe("zero");
    expect(numberWord(12)).toBe("twelve");
    expect(numberWord(13)).toBe("13");
    expect(numberWord(-1)).toBe("-1");
    expect(numberWord(1.5)).toBe("1.5");
  });

  it("writes an ordinal, teens included", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 111].map(ordinal)).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "13th",
      "21st",
      "111th",
    ]);
  });

  it("moves up a unit rather than writing 1000 of the one below", () => {
    expect(compactCount(999_949)).toBe("999.9k");
    expect(compactCount(999_950)).toBe("1m");
    expect(compactCount(999_999)).toBe("1m");
    expect(compactCount(999_950_000)).toBe("1b");
    expect(compactCount(-999_950)).toBe("-1m");
    expect(compactCount(1.5e12)).toBe("1.5t");
  });

  it("is an empty string rather than NaN for a number that is not one", () => {
    expect(formatCount(Number.NaN)).toBe("");
    expect(compactCount(Number.POSITIVE_INFINITY)).toBe("");
    expect(ordinal(Number.NaN)).toBe("");
  });
});

describe("money and shares", () => {
  it("writes dollars, from dollars or from cents", () => {
    expect(usd(1204.5)).toBe("$1,204.50");
    expect(usd(120_450, { cents: true })).toBe("$1,204.50");
    expect(usd(1204.5, { digits: 0 })).toBe("$1,205");
  });

  it("keeps the sign outside the symbol", () => {
    expect(usd(-5)).toBe("-$5.00");
  });

  it("writes a share as a percent, and a dash when there is nothing to divide by", () => {
    expect(percent(0.1234)).toBe("12.3%");
    expect(percent(0.1234, 0)).toBe("12%");
    expect(percent(null)).toBe("-");
    expect(percent(undefined)).toBe("-");
  });
});

describe("times", () => {
  const now = Date.parse("2026-11-20T12:00:00Z");
  const ago = (ms: number) => timeAgo(now - ms, { now });

  it("counts up through the units", () => {
    expect(ago(0)).toBe("just now");
    expect(ago(89_000)).toBe("just now");
    expect(ago(90_000)).toBe("1m ago");
    expect(ago(59 * 60_000)).toBe("59m ago");
    expect(ago(60 * 60_000)).toBe("1h ago");
    expect(ago(23 * 3_600_000)).toBe("23h ago");
    expect(ago(DAY_MS)).toBe("1d ago");
    expect(ago(29 * DAY_MS)).toBe("29d ago");
  });

  it("falls back to a date once the count of days stops meaning anything", () => {
    expect(ago(30 * DAY_MS)).toBe("21 October 2026");
    expect(
      timeAgo(now - 400 * DAY_MS, { now, absoluteAfterMs: Infinity }),
    ).toBe("400d ago");
  });

  it("reads a clock a little ahead of the server as now, not as the future", () => {
    expect(timeAgo(now + 5000, { now })).toBe("just now");
  });

  it("is an empty string for a date that will not parse", () => {
    expect(timeAgo("nonsense", { now })).toBe("");
    expect(utcDate(null)).toBe("");
    expect(utcStamp("")).toBe("");
    expect(fullDate(undefined)).toBe("");
    expect(w3cDate("nope")).toBe("");
    expect(utcDay(null)).toBeNull();
  });

  it("refuses a time no Date can hold, instead of throwing", () => {
    // A row carrying nanoseconds or microseconds instead of milliseconds
    // would otherwise turn a page into a 500: toISOString throws past this.
    for (const out of [1e16, -1e16, 1.7e18]) {
      expect(utcDate(out)).toBe("");
      expect(utcStamp(out)).toBe("");
      expect(fullDate(out)).toBe("");
      expect(w3cDate(out)).toBe("");
      expect(timeAgo(out, { now })).toBe("");
      expect(toMillis(out)).toBeNull();
    }
    expect(toMillis(8.64e15)).toBe(8.64e15);
    expect(toMillis(8.64e15 + 1)).toBeNull();
  });

  it("writes the UTC forms", () => {
    const at = "2026-11-20T14:03:09.123Z";
    expect(utcDate(at)).toBe("2026-11-20");
    expect(utcStamp(at)).toBe("2026-11-20 14:03 UTC");
    expect(fullDate(at)).toBe("20 November 2026");
    expect(w3cDate(at)).toBe("2026-11-20T14:03:09Z");
  });

  it("buckets by UTC day, whatever the time of day", () => {
    expect(utcDay("2026-11-20T00:00:00Z")).toBe(utcDay("2026-11-20T23:59:59Z"));
    expect(utcDay("2026-11-21T00:00:00Z")).toBe(
      (utcDay("2026-11-20T00:00:00Z") as number) + 1,
    );
  });

  it("rounds a wait to prose", () => {
    expect(aboutDuration(90_000)).toBe("about two minutes");
    expect(aboutDuration(3_600_000)).toBe("about an hour");
    expect(aboutDuration(2 * 3_600_000)).toBe("about two hours");
    expect(aboutDuration(13 * 3_600_000)).toBe("about 13 hours");
    expect(aboutDuration(0)).toBe("about a minute");
  });
});

describe("text", () => {
  it("joins a list the way a sentence does", () => {
    expect(listOf([])).toBe("");
    expect(listOf(["a"])).toBe("a");
    expect(listOf(["a", "b"])).toBe("a and b");
    expect(listOf(["a", "b", "c"])).toBe("a, b and c");
    expect(listOf(["a", "b", "c"], { oxfordComma: true })).toBe("a, b, and c");
    expect(listOf(["a", "b"], { conjunction: "or" })).toBe("a or b");
    expect(listOf(["a", "", "c"])).toBe("a and c");
  });

  it("capitalizes without lower-casing an acronym", () => {
    expect(capitalize("hello")).toBe("Hello");
    expect(capitalize("eBPF rules")).toBe("EBPF rules");
    expect(capitalize("")).toBe("");
  });

  it("folds accents and punctuation into a slug", () => {
    expect(slugify("Crème Brûlée & Co.")).toBe("creme-brulee-co");
    expect(slugify("  --Hello--World--  ")).toBe("hello-world");
    expect(slugify("日本語")).toBe("");
  });

  it("cuts a long slug on a separator rather than mid-word", () => {
    expect(slugify("alpha beta gamma delta", { maxLength: 14 })).toBe(
      "alpha-beta",
    );
    expect(slugify("abcdefghijklmnop", { maxLength: 8 })).toBe("abcdefgh");
  });

  it("does not cut an astral character in half", () => {
    // Half a surrogate pair renders as a replacement glyph wherever it lands.
    expect(truncate("ab🌊cd", 4)).toBe("ab…");
    expect(truncate("ab🌊cd", 4, { onWord: false })).toBe("ab…");
    expect(truncate("🌊🌊🌊", 3)).toBe("🌊…");
  });

  it("truncates on a word boundary and counts the ellipsis", () => {
    expect(truncate("hello there friend", 30)).toBe("hello there friend");
    expect(truncate("hello there friend", 14)).toBe("hello there…");
    expect(truncate("hello there friend", 14, { onWord: false })).toBe(
      "hello there f…",
    );
    expect(truncate("hello", 3, { ellipsis: "..." })).toBe("...");
    expect(truncate("hello", 2, { ellipsis: "..." })).toBe("..");
  });
});

describe("wrapWords", () => {
  it("breaks on spaces inside the width", () => {
    expect(wrapWords("the quick brown fox jumps", 11)).toEqual([
      "the quick",
      "brown fox",
      "jumps",
    ]);
  });

  it("gives a word too wide for a line its own line rather than cutting it", () => {
    expect(wrapWords("a supercalifragilistic b", 6)).toEqual([
      "a",
      "supercalifragilistic",
      "b",
    ]);
  });

  it("keeps the breaks already in the text", () => {
    expect(wrapWords("one\ntwo three", 20)).toEqual(["one", "two three"]);
  });

  it("measures in whatever unit the caller measures in", () => {
    // A card renderer passes pixel widths; here every character is 10 wide.
    expect(
      wrapWords("aa bb cc", 55, { measure: (line) => line.length * 10 }),
    ).toEqual(["aa bb", "cc"]);
  });

  it("stops at maxLines and marks the cut", () => {
    expect(wrapWords("one two three four", 9, { maxLines: 1 })).toEqual([
      "one two…",
    ]);
    expect(wrapWords("one two three four", 9, { maxLines: 5 })).toEqual([
      "one two",
      "three",
      "four",
    ]);
  });
});

describe("fitWords", () => {
  // Every character is 10 wide, as a drawn label's measurer would be.
  const measure = (line: string) => line.length * 10;

  it("wraps into the room there is", () => {
    expect(fitWords("one two three", 90, { maxLines: 2, measure })).toEqual([
      "one two",
      "three",
    ]);
  });

  it("is null when it would need another line", () => {
    // Not an ellipsis: the caller's next move is a smaller size, not a cut.
    expect(fitWords("one two three", 90, { maxLines: 1, measure })).toBeNull();
  });

  it("is null when a single word is wider than the line", () => {
    expect(
      fitWords("a supercalifragilistic", 90, { maxLines: 3, measure }),
    ).toBeNull();
  });

  it("counts the lines already in the text against the limit", () => {
    expect(fitWords("one\ntwo", 90, { maxLines: 2, measure })).toEqual([
      "one",
      "two",
    ]);
    expect(
      fitWords("one\ntwo\nthree", 90, { maxLines: 2, measure }),
    ).toBeNull();
  });

  it("measures in characters when no measurer is given", () => {
    expect(fitWords("one two", 7, { maxLines: 1 })).toEqual(["one two"]);
    expect(fitWords("one two", 6, { maxLines: 1 })).toBeNull();
  });
});

describe("short month dates", () => {
  const now = Date.parse("2026-11-20T12:00:00Z");

  it("writes a three-letter month when asked", () => {
    expect(fullDate("2026-03-09T10:00:00Z", { month: "short" })).toBe(
      "9 Mar 2026",
    );
    expect(fullDate("2026-09-02", { month: "short" })).toBe("2 Sep 2026");
    expect(fullDate("2026-09-02", { month: "long" })).toBe("2 September 2026");
  });

  it("falls back to the short form from timeAgo too", () => {
    expect(timeAgo(now - 40 * DAY_MS, { now, month: "short" })).toBe(
      "11 Oct 2026",
    );
    expect(timeAgo(now - 40 * DAY_MS, { now })).toBe("11 October 2026");
  });
});

describe("wrapWords for Chinese, Japanese and long words", () => {
  it("breaks Chinese and Japanese between characters without adding spaces", () => {
    expect(wrapWords("西立面幕墙安装进度约六成", 5)).toEqual([
      "西立面幕墙",
      "安装进度约",
      "六成",
    ]);
    expect(wrapWords("これはテストです", 4)).toEqual(["これはテ", "ストです"]);
  });

  it("never starts a line with closing punctuation", () => {
    expect(wrapWords("西立面幕墙。安装", 5)).toEqual(["西立面幕", "墙。安装"]);
  });

  it("still breaks Latin only at spaces, even beside Chinese", () => {
    expect(wrapWords("GHX-1882 crane", 10)).toEqual(["GHX-1882", "crane"]);
    expect(wrapWords("crane 西立面", 8)).toEqual(["crane 西立", "面"]);
  });

  it("splits a word wider than the line when breakWords is set", () => {
    expect(
      wrapWords("a supercalifragilistic b", 6, { breakWords: true }),
    ).toEqual(["a", "superc", "alifra", "gilist", "ic b"]);
    // Without it the word keeps its own line, as before.
    expect(wrapWords("a supercalifragilistic b", 6)).toEqual([
      "a",
      "supercalifragilistic",
      "b",
    ]);
  });

  it("splits by grapheme, so an emoji is never cut in half", () => {
    expect(
      wrapWords("👍👍👍", 2, {
        breakWords: true,
        measure: (t) => [...t].length,
      }),
    ).toEqual(["👍👍", "👍"]);
  });

  it("keeps a blank or whitespace-only line as a blank", () => {
    expect(wrapWords("one\n   \ntwo\r\nthree", 20)).toEqual([
      "one",
      "",
      "two",
      "three",
    ]);
  });
});
