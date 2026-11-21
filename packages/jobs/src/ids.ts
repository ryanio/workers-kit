// Workflow instance ids. An id carries the job and a key for the work it does
// (a cron slot, a user, a payment), so a second create of the same pair is
// refused by Workflows and counted as a duplicate. That refusal is the dedup:
// Cloudflare can fire one cron twice in a slot, from two data centers about
// 30 seconds apart, and an event can be sent twice.

const UNSAFE = /[^a-zA-Z0-9_-]/g;
const MAX_ID = 100;

/**
 * `<job>-<key>`, in the characters Workflows accepts, at most 100 long. An id
 * already in those characters and at most 100 long is used as it is. Any other
 * character becomes `_`, and then the id ends in `-` and a 12-character hash
 * of the raw `<job>-<key>`, so `a.b@c` and `a_b@c` never share an id. An id
 * past 100 keeps its first 87 characters and ends in the same hash, so two
 * long keys that share a prefix still get different ids.
 */
export function instanceId(job: string, key: string): string {
  const raw = `${job}-${key}`;
  const id = raw.replace(UNSAFE, "_");
  if (id === raw && id.length <= MAX_ID) return id;
  const suffix = `-${hash12(raw)}`;
  return id.slice(0, MAX_ID - suffix.length) + suffix;
}

/** 48 bits of FNV-1a over the UTF-16 code units, as 12 hex characters. Stable across runtimes. */
function hash12(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c ^ (a >>> 7), 0x01000193) >>> 0;
  }
  return (
    (a >>> 0).toString(16).padStart(8, "0") +
    ((b >>> 0) & 0xffff).toString(16).padStart(4, "0")
  );
}

export type SlotKeyFormat = "minute" | "day";

/**
 * A cron slot as a key: `YYYYMMDDHHmm` (UTC) by default, or `YYYYMMDD` for
 * setups whose crons fire at most once a day. Both are fixed width, so the
 * latest slot is the largest string.
 */
export function slotKey(ms: number, format: SlotKeyFormat = "minute"): string {
  const iso = new Date(ms).toISOString();
  return format === "day"
    ? iso.slice(0, 10).replaceAll("-", "")
    : iso.slice(0, 16).replace(/[-T:]/g, "");
}

const DUPLICATE = /already[ ._]exists|duplicate/i;

/** True when a `create()` failed because the id is taken. */
export function isDuplicateId(err: unknown): boolean {
  return DUPLICATE.test(err instanceof Error ? err.message : String(err));
}

/**
 * True for the error the engine raises when it hibernates or moves an
 * instance to a new version. The instance is alive and replays from its last
 * step, so this is not a failure to record or act on.
 */
export function isEngineAbort(err: unknown): boolean {
  return (err instanceof Error ? err.message : String(err)).startsWith(
    "Aborting engine",
  );
}
