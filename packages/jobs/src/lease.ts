/**
 * A TTL lease in a Durable Object, and the `JobLock` that talks to it.
 *
 * `singleton` on a job declines to start a run while another run of the same
 * job is still going. Cloudflare has nothing that does this, so a run takes a
 * lease before its body and hands it back afterwards. One object instance per
 * job id, so contention on a busy job never serializes an unrelated one.
 *
 * ## Every lease has a TTL, and there is no way to take one without
 *
 * A run that dies holding a lease never releases it, so the clock is the only
 * thing that can free the key. Without a TTL one crash wedges a job until the
 * next deploy, which is worse than the pile-up the lease exists to prevent.
 *
 * ## The TTL measures liveness, not run length
 *
 * A live holder renews on a heartbeat, so the lease only has to outlast the
 * gap between heartbeats rather than the longest run the job could honestly
 * have. That is what lets it be short enough for a dead holder's key to come
 * back in under a minute. `createJobs` renews on `renewEveryMs` and stops one
 * interval short of the job's `singleton.staleAfter`.
 *
 * ## Renew and release are token-matched
 *
 * A run whose lease expired mid-flight has already lost the key to whoever
 * took it over. Its late release must do nothing, rather than delete a row and
 * hand a third run the key, and its late renewal must not evict the holder
 * that replaced it.
 *
 * A matching token on an expired row is a different case: any taker would have
 * overwritten the token, so the row only lapsed and nobody claimed it. Renewal
 * there is what keeps a merely slow holder guarded instead of running over a
 * free key.
 *
 * ## No `blockConcurrencyWhile`
 *
 * Every await in `acquire`, `renew` and `release` is a storage call, and the
 * object's input gate holds back new events while one is in flight, so two
 * acquires cannot both read "free" before either writes. Any other I/O added
 * inside those calls opens that gate and needs the wrapper back.
 */

import type { JobLease, JobLock } from "./types.js";

/** Storage-key prefix, so a lease row is never confused with other object state. */
const DEFAULT_KEY_PREFIX = "lease:";

/**
 * The longest lease the store will hand out, an hour. Nothing guarded by one
 * should run for an hour, so a caller asking for more has a bug, and honouring
 * it would wedge the key for the rest of the hour.
 */
const MAX_LEASE_MS = 60 * 60 * 1000;

/** Well clear of the 2 KiB storage-key ceiling, and past any real job key. */
const MAX_KEY_LENGTH = 1024;

/**
 * How long past its expiry a row waits before the sweep deletes it. The sweep
 * is storage hygiene only: `acquire` already treats an expired row as free, so
 * deleting one can never change who holds a key. It is there because a keyed
 * singleton keys on things that are never reused, so a run that dies without
 * releasing leaves a row nothing will ever overwrite.
 */
const SWEEP_GRACE_MS = 60_000;

/** The part of `DurableObjectStorage` the store needs. */
export interface LeaseStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  list<T>(options?: { prefix?: string }): Promise<Map<string, T>>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}

/**
 * A grant carries its token; a refusal has no token field at all, so there is
 * no shape saying "acquired, but here is no token" for a caller to misread.
 */
export type AcquireResult =
  | { acquired: false }
  | { acquired: true; token: string };

export interface LeaseStoreOptions {
  /** Milliseconds since the epoch. Defaults to `Date.now`. */
  now?: (() => number) | undefined;
  /** Default an hour. A longer lease than this is a caller bug and throws. */
  maxLeaseMs?: number | undefined;
  /**
   * Prefix on every lease row's storage key, so the rows never collide with
   * other state in the object. Default `"lease:"`. Set it to the prefix an
   * existing lock object already writes, so leases held across the switch are
   * still seen and old rows are still swept.
   */
  keyPrefix?: string | undefined;
  /** Called when a stored row will not parse. It is then treated as absent. */
  onBadRow?: ((key: string) => void) | undefined;
}

export interface LeaseStore {
  /**
   * Takes the key for `leaseMs`, or reports that someone else holds it. A
   * held-but-expired lease is taken over rather than respected: that is the
   * self-heal, since the previous holder is either gone or about to find its
   * release refused on the token.
   */
  acquire(key: string, leaseMs: number): Promise<AcquireResult>;
  /** Pushes a held lease out, and answers whether the caller still owns the key. */
  renew(key: string, token: string, leaseMs: number): Promise<boolean>;
  /** Gives the key back. A token that does not match the stored one clears nothing. */
  release(key: string, token: string): Promise<void>;
  /** The object's `alarm`: drops rows whose lease expired and nobody re-took. */
  sweep(): Promise<void>;
}

interface Lease {
  expiresAt: number;
  token: string;
}

function parseLease(value: unknown): Lease | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const { expiresAt, token } = value as Partial<Lease>;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    return null;
  }
  if (typeof token !== "string" || token === "") {
    return null;
  }
  return { expiresAt, token };
}

/**
 * The lease logic, for a Durable Object to hold. The object itself stays in
 * the app, because it has to extend the runtime's base class:
 *
 *     export class JobLockObject extends DurableObject<Env> {
 *       private store = leaseStore(this.ctx.storage);
 *
 *       acquire(key: string, leaseMs: number) {
 *         return this.store.acquire(key, leaseMs);
 *       }
 *       renew(key: string, token: string, leaseMs: number) {
 *         return this.store.renew(key, token, leaseMs);
 *       }
 *       release(key: string, token: string) {
 *         return this.store.release(key, token);
 *       }
 *       alarm() {
 *         return this.store.sweep();
 *       }
 *     }
 */
export function leaseStore(
  storage: LeaseStorage,
  options: LeaseStoreOptions = {},
): LeaseStore {
  const now = options.now ?? (() => Date.now());
  const maxLeaseMs = options.maxLeaseMs ?? MAX_LEASE_MS;
  const keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  if (keyPrefix === "") {
    // An empty prefix would make the sweep list, and delete, every row in the object.
    throw new Error("job lease: keyPrefix must not be empty");
  }

  const check = (what: string, key: string, leaseMs: number): void => {
    if (key === "" || key.length > MAX_KEY_LENGTH) {
      throw new Error(
        `job lease: invalid ${what}, a key must be 1 to ${MAX_KEY_LENGTH} characters`,
      );
    }
    if (!Number.isFinite(leaseMs) || leaseMs <= 0 || leaseMs > maxLeaseMs) {
      throw new Error(
        `job lease: invalid ${what}, leaseMs must be above 0 and at most ${maxLeaseMs}`,
      );
    }
  };

  const read = async (storageKey: string): Promise<Lease | null> => {
    const stored = await storage.get(storageKey);
    if (stored === undefined) {
      return null;
    }
    const parsed = parseLease(stored);
    if (parsed === null) {
      // Nothing can tell who holds it, and the only other option is wedging
      // the key until a deploy.
      options.onBadRow?.(storageKey);
      return null;
    }
    return parsed;
  };

  const scheduleSweep = async (expiresAt: number): Promise<void> => {
    const due = expiresAt + SWEEP_GRACE_MS;
    const pending = await storage.getAlarm();
    if (pending === null || pending > due) {
      await storage.setAlarm(due);
    }
  };

  return {
    async acquire(key, leaseMs) {
      // A bad lease is rejected rather than answered with `{ acquired: false }`:
      // reporting a caller bug as contention would read as a healthy skip
      // forever.
      check("acquire", key, leaseMs);
      const storageKey = keyPrefix + key;
      const at = now();
      const held = await read(storageKey);
      if (held !== null && held.expiresAt > at) {
        return { acquired: false };
      }
      const lease: Lease = {
        expiresAt: at + leaseMs,
        token: crypto.randomUUID(),
      };
      await storage.put(storageKey, lease);
      await scheduleSweep(lease.expiresAt);
      return { acquired: true, token: lease.token };
    },

    async renew(key, token, leaseMs) {
      check("renew", key, leaseMs);
      const storageKey = keyPrefix + key;
      const held = await read(storageKey);
      if (held === null || held.token !== token) {
        return false;
      }
      const lease: Lease = { expiresAt: now() + leaseMs, token };
      await storage.put(storageKey, lease);
      await scheduleSweep(lease.expiresAt);
      return true;
    },

    async release(key, token) {
      const storageKey = keyPrefix + key;
      const held = await read(storageKey);
      if (held === null || held.token !== token) {
        return;
      }
      await storage.delete(storageKey);
    },

    async sweep() {
      const at = now();
      const rows = await storage.list({ prefix: keyPrefix });
      const dead: string[] = [];
      let earliestLive: number | null = null;
      for (const [storageKey, value] of rows) {
        const parsed = parseLease(value);
        if (parsed === null || parsed.expiresAt + SWEEP_GRACE_MS <= at) {
          dead.push(storageKey);
          continue;
        }
        earliestLive =
          earliestLive === null
            ? parsed.expiresAt
            : Math.min(earliestLive, parsed.expiresAt);
      }
      if (dead.length > 0) {
        await storage.delete(dead);
      }
      if (earliestLive !== null) {
        await storage.setAlarm(earliestLive + SWEEP_GRACE_MS);
      }
    },
  };
}

/** The lease object's methods, however the app exposed them. */
export interface LeaseStub {
  acquire(key: string, leaseMs: number): Promise<AcquireResult>;
  renew(key: string, token: string, leaseMs: number): Promise<boolean>;
  release(key: string, token: string): Promise<void>;
}

/** The part of `DurableObjectNamespace` the lock needs. */
export interface LeaseNamespace {
  /** Newer runtimes have it; older ones go through `idFromName` and `get`. */
  getByName?(name: string): LeaseStub;
  idFromName(name: string): unknown;
  get(id: unknown): LeaseStub;
}

export interface DurableObjectLockOptions {
  /**
   * How often `createJobs` renews a held lease. Default 10 seconds, which
   * against the default lease of three intervals leaves a dead holder's key
   * free in about half a minute.
   *
   * `createJobs` stops renewing one interval short of the job's `staleAfter`,
   * so renewal only ever happens for a job whose `staleAfter` is more than
   * twice this. Below that the lease is simply the job's own `staleAfter` and
   * nothing renews it, which is correct but is not the liveness lease this
   * file describes: a run that dies holds the key for the whole `staleAfter`
   * rather than ten seconds or so. Keep `staleAfter` well above twice this, or
   * lower this for a job that is honestly that short.
   */
  renewEveryMs?: number | undefined;
  /**
   * How long a lease runs before it lapses, from the renewal interval. Default
   * three intervals, so one missed renewal does not drop the key. It is capped
   * at the job's own `holdMs`, because a lease outliving the run it guards
   * would wedge the key past the point the job calls itself stale.
   */
  leaseMs?: number | undefined;
  /**
   * One object instance per key by default, so two busy keys never queue
   * behind each other. Return a fixed string to put every key in one instance.
   */
  instanceName?: ((key: string) => string) | undefined;
}

/**
 * A `JobLock` for `createJobs`, over a Durable Object holding a `leaseStore`.
 *
 *     const jobs = createJobs({ ..., lock: durableObjectLock(env.JOB_LOCK) });
 *
 * A throw from the object is left to propagate: `createJobs` treats a failed
 * acquire as "go ahead unguarded", which is the right call for a lock that is
 * a guard against duplicate work rather than against incorrect work. A job
 * where a second run would be incorrect belongs behind a database constraint.
 */
export function durableObjectLock(
  namespace: LeaseNamespace,
  options: DurableObjectLockOptions = {},
): JobLock {
  const renewEveryMs = options.renewEveryMs ?? 10_000;
  const leaseMs = options.leaseMs ?? renewEveryMs * 3;
  const nameOf = options.instanceName ?? ((key: string) => key);

  const stubFor = (key: string): LeaseStub => {
    const name = nameOf(key);
    return namespace.getByName
      ? namespace.getByName(name)
      : namespace.get(namespace.idFromName(name));
  };

  return {
    renewEveryMs,

    async acquire(key, { holdMs }): Promise<JobLease | null> {
      const hold = Math.max(1, Math.min(leaseMs, holdMs));
      const stub = stubFor(key);
      const result = await stub.acquire(key, hold);
      if (!result.acquired) {
        return null;
      }
      const { token } = result;
      return {
        renew: () => stubFor(key).renew(key, token, hold),
        release: () => stubFor(key).release(key, token),
      };
    },
  };
}
