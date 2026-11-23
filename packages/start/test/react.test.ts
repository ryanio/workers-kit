import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { fullDate } from "../src/format.js";
import { useReaderTimeZone } from "../src/react.js";

const late = "2026-11-21T03:30:00Z";

function Stamp() {
  const { timeZone, mounted } = useReaderTimeZone();
  return createElement(
    "time",
    { dateTime: late, "data-mounted": String(mounted) },
    fullDate(late, { timeZone }),
  );
}

describe("useReaderTimeZone", () => {
  it("renders UTC on the server, so hydration has the same text", () => {
    expect(renderToString(createElement(Stamp))).toBe(
      `<time dateTime="${late}" data-mounted="false">21 November 2026</time>`,
    );
  });

  it("gives the reader's zone once the browser has it", async () => {
    vi.resetModules();
    vi.doMock("react", () => ({
      useSyncExternalStore: (_s: unknown, client: () => boolean) => client(),
    }));
    const { useReaderTimeZone: inBrowser } = await import("../src/react.js");
    expect(inBrowser()).toEqual({ timeZone: "local", mounted: true });
    vi.doUnmock("react");
  });
});
