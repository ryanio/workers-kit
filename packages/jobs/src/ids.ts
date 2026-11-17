// Workflow instance ids. An id carries the job and a key for the work it does
// (a cron slot, a user, a payment), so a second create of the same pair is
// refused by Workflows and counted as a duplicate. That refusal is the dedup:
// Cloudflare can fire one cron twice in a slot, from two data centers about
// 30 seconds apart, and an event can be sent twice.

const UNSAFE = /[^a-zA-Z0-9_-]/g;
const MAX_ID = 100;

/** `<job>-<key>`, in the characters Workflows accepts, at most 100 long. */
export function instanceId(job: string, key: string): string {
  return `${job}-${key}`.replace(UNSAFE, "_").slice(0, MAX_ID);
}

export type SlotKeyFormat = "minute" | "day";

/**
 * A cron slot as a key: `YYYYMMDDHHmm` (UTC) by default, or `YYYYMMDD` for
 * setups whose crons fire at most once a day. Both are fixed width, so the
 * latest slot is the largest string.
 */
export function slotKey(ms: number, format: SlotKeyFormat = "minute"): string {
  const iso = new Date(ms).toISOString();
  return format === "day" ? iso.slice(0, 10).replaceAll("-", "") : iso.slice(0, 16).replace(/[-T:]/g, "");
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
  return (err instanceof Error ? err.message : String(err)).startsWith("Aborting engine");
}
