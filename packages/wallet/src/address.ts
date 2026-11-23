/**
 * Addresses for people to read. No viem, so a page that only shows an
 * address does not bundle it.
 */

export interface ShortAddressOptions {
  /** Characters kept from the start, `0x` included. Default 6. */
  head?: number | undefined;
  /** Characters kept from the end. Default 4. */
  tail?: number | undefined;
  /** Between the two. Default "…". */
  ellipsis?: string | undefined;
}

/**
 * "0x49a3…d2b2": the start and end of an address or hash, which is what a
 * person compares. A value no longer than the shortened form (an ENS name,
 * a short id) comes back trimmed and whole.
 */
export function shortAddress(
  value: string | null | undefined,
  options: ShortAddressOptions = {},
): string {
  const text = (value ?? "").trim();
  const head = options.head ?? 6;
  const tail = options.tail ?? 4;
  const ellipsis = options.ellipsis ?? "…";
  if (text.length <= head + tail + ellipsis.length) return text;
  return `${text.slice(0, head)}${ellipsis}${text.slice(-tail)}`;
}
