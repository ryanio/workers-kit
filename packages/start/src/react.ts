/**
 * The reader's time zone in a React app that renders on the server. The
 * server cannot know the visitor's zone, so a date it writes must be in UTC,
 * and the first render in the browser must match it or React reports a
 * hydration mismatch. After that the browser can use its own zone.
 *
 * React is an optional peer: only this entry point imports it.
 */
import { useSyncExternalStore } from "react";

export interface ReaderTimeZone {
  /**
   * `"UTC"` on the server and during hydration, then `"local"`. Pass it as
   * `timeZone` to `fullDate`, `dateTime` or `timeAgo` from
   * `workers-start/format`.
   */
  timeZone: "UTC" | "local";
  /**
   * False on the server and during hydration. A relative time ("5m ago")
   * changes with the clock, so it can differ between the server's render and
   * the browser's: show the absolute date until this is true.
   */
  mounted: boolean;
}

const noSubscription = () => () => {};

/**
 * `{ timeZone, mounted }` for the component that renders a date. A component
 * that mounts after hydration (a client-side navigation) gets the reader's
 * zone on its first render, with no flash of UTC.
 *
 *     const { timeZone, mounted } = useReaderTimeZone();
 *     return <time dateTime={iso}>{mounted ? timeAgo(iso, { timeZone }) : fullDate(iso, { timeZone })}</time>;
 */
export function useReaderTimeZone(): ReaderTimeZone {
  const mounted = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
  return mounted
    ? { timeZone: "local", mounted: true }
    : { timeZone: "UTC", mounted: false };
}
