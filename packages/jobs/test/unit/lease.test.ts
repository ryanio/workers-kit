/**
 * The lease. Its whole job is that two runs of one job never overlap and that
 * a run which dies holding a key does not wedge it, so the cases worth pinning
 * are contention, takeover after expiry, and the token checks that stop a late
 * release from handing a third run the key.
 */
import { describe, expect, it, vi } from "vitest";
import type { AcquireResult, LeaseStore } from "../../src/lease.js";
import { durableObjectLock, leaseStore } from "../../src/lease.js";

const START = Date.parse("2026-11-20T12:00:00Z");

function fakeStorage() {
  const rows = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    rows,
    get alarm() {
      return alarm;
    },
    get: async <T>(key: string): Promise<T | undefined> =>
      rows.get(key) as T | undefined,
    put: async (key: string, value: unknown): Promise<void> => {
      rows.set(key, value);
    },
    delete: (async (key: string | string[]) => {
      if (Array.isArray(key)) {
        let count = 0;
        for (const one of key) {
          count += rows.delete(one) ? 1 : 0;
        }
        return count;
      }
      return rows.delete(key);
    }) as {
      (key: string): Promise<boolean>;
      (keys: string[]): Promise<number>;
    },
    list: async <T>(options?: { prefix?: string }): Promise<Map<string, T>> => {
      const out = new Map<string, T>();
      for (const [key, value] of rows) {
        if (!options?.prefix || key.startsWith(options.prefix)) {
          out.set(key, value as T);
        }
      }
      return out;
    },
    getAlarm: async (): Promise<number | null> => alarm,
    setAlarm: async (at: number): Promise<void> => {
      alarm = at;
    },
  };
}

const token = (result: AcquireResult): string => {
  if (!result.acquired) {
    throw new Error("expected the lease to be granted");
  }
  return result.token;
};

describe("leaseStore", () => {
  const build = (clock: { now: number }) => {
    const storage = fakeStorage();
    return { storage, store: leaseStore(storage, { now: () => clock.now }) };
  };

  it("grants a free key and refuses it while it is held", async () => {
    const clock = { now: START };
    const { store } = build(clock);
    const first = await store.acquire("sweep", 60_000);
    expect(first.acquired).toBe(true);

    clock.now = START + 59_999;
    expect(await store.acquire("sweep", 60_000)).toEqual({ acquired: false });
  });

  it("keeps two keys apart", async () => {
    const clock = { now: START };
    const { store } = build(clock);
    await store.acquire("sweep", 60_000);
    expect((await store.acquire("digest", 60_000)).acquired).toBe(true);
  });

  it("takes a lapsed key over with a new token", async () => {
    const clock = { now: START };
    const { store } = build(clock);
    const first = token(await store.acquire("sweep", 60_000));

    clock.now = START + 60_001;
    const second = await store.acquire("sweep", 60_000);
    expect(second.acquired).toBe(true);
    expect(token(second)).not.toBe(first);
  });

  it("extends a lease for the run that holds it", async () => {
    const clock = { now: START };
    const { store } = build(clock);
    const mine = token(await store.acquire("sweep", 60_000));

    clock.now = START + 30_000;
    await expect(store.renew("sweep", mine, 60_000)).resolves.toBe(true);

    clock.now = START + 80_000;
    // Without the renewal this key would be free by now.
    expect(await store.acquire("sweep", 60_000)).toEqual({ acquired: false });
  });

  it("tells a run that lost its lease, and does not evict the new holder", async () => {
    const clock = { now: START };
    const { store } = build(clock);
    const mine = token(await store.acquire("sweep", 60_000));

    clock.now = START + 60_001;
    const theirs = token(await store.acquire("sweep", 60_000));

    await expect(store.renew("sweep", mine, 60_000)).resolves.toBe(false);
    await expect(store.renew("sweep", theirs, 60_000)).resolves.toBe(true);
  });

  it("renews a lapsed row that nobody else claimed", async () => {
    // A matching token on an expired row can only mean the row lapsed and no
    // taker overwrote it, so a merely slow holder stays guarded.
    const clock = { now: START };
    const { store } = build(clock);
    const mine = token(await store.acquire("sweep", 60_000));
    clock.now = START + 90_000;
    await expect(store.renew("sweep", mine, 60_000)).resolves.toBe(true);
  });

  it("frees the key on release", async () => {
    const clock = { now: START };
    const { store } = build(clock);
    const mine = token(await store.acquire("sweep", 60_000));
    await store.release("sweep", mine);
    expect((await store.acquire("sweep", 60_000)).acquired).toBe(true);
  });

  it("ignores a release from a run that already lost the key", async () => {
    const clock = { now: START };
    const { store } = build(clock);
    const mine = token(await store.acquire("sweep", 60_000));
    clock.now = START + 60_001;
    await store.acquire("sweep", 60_000);

    // A late release that deleted the row would hand a third run the key
    // while the second is still running.
    await store.release("sweep", mine);
    expect(await store.acquire("sweep", 60_000)).toEqual({ acquired: false });
  });

  it("treats a row it cannot read as absent, and says so", async () => {
    const clock = { now: START };
    const storage = fakeStorage();
    const onBadRow = vi.fn();
    const store = leaseStore(storage, { now: () => clock.now, onBadRow });
    storage.rows.set("lease:sweep", { expiresAt: "soon" });
    expect((await store.acquire("sweep", 60_000)).acquired).toBe(true);
    expect(onBadRow).toHaveBeenCalledWith("lease:sweep");
  });

  it.each([
    ["an empty key", "", 60_000],
    ["a key past the storage ceiling", "k".repeat(1025), 60_000],
    ["a lease of zero", "sweep", 0],
    ["a negative lease", "sweep", -1],
    ["a lease past the cap", "sweep", 60 * 60 * 1000 + 1],
  ])(
    "throws rather than reporting contention for %s",
    async (_what, key, ms) => {
      const clock = { now: START };
      const { store } = build(clock);
      // Reporting a caller bug as contention would read as a healthy skip forever.
      await expect(store.acquire(key, ms)).rejects.toThrow(/job lease/);
    },
  );

  describe("sweep", () => {
    const seed = async (store: LeaseStore, clock: { now: number }) => {
      clock.now = START;
      await store.acquire("old", 1000);
      await store.acquire("live", 600_000);
    };

    it("drops rows a grace period past their expiry and keeps live ones", async () => {
      const clock = { now: START };
      const { store, storage } = build(clock);
      await seed(store, clock);

      clock.now = START + 1000 + 60_000;
      await store.sweep();
      expect([...storage.rows.keys()]).toEqual(["lease:live"]);
    });

    it("leaves a row that has only just expired, since nothing reads it anyway", async () => {
      const clock = { now: START };
      const { store, storage } = build(clock);
      await seed(store, clock);

      clock.now = START + 2000;
      await store.sweep();
      expect(storage.rows.has("lease:old")).toBe(true);
    });

    it("comes back for the earliest lease still alive", async () => {
      const clock = { now: START };
      const { store, storage } = build(clock);
      await seed(store, clock);

      clock.now = START + 61_000;
      await store.sweep();
      expect(storage.alarm).toBe(START + 600_000 + 60_000);
    });

    it("stops arming itself once there is nothing left", async () => {
      const clock = { now: START };
      const { store, storage } = build(clock);
      await store.acquire("old", 1000);
      clock.now = START + 61_001;
      await store.sweep();
      expect(storage.rows.size).toBe(0);
      expect(storage.alarm).toBe(START + 1000 + 60_000);
    });

    it("drops a row it cannot read", async () => {
      const clock = { now: START };
      const storage = fakeStorage();
      const store = leaseStore(storage, { now: () => clock.now });
      storage.rows.set("lease:junk", "not a lease");
      await store.sweep();
      expect(storage.rows.size).toBe(0);
    });
  });
});

describe("durableObjectLock", () => {
  function fakeNamespace(withGetByName: boolean) {
    const clock = { now: START };
    const stores = new Map<string, LeaseStore>();
    const names: string[] = [];
    const storageFor = new Map<string, ReturnType<typeof fakeStorage>>();
    const stub = (name: string) => {
      names.push(name);
      let store = stores.get(name);
      if (!store) {
        const storage = fakeStorage();
        storageFor.set(name, storage);
        store = leaseStore(storage, { now: () => clock.now });
        stores.set(name, store);
      }
      return store;
    };
    const namespace = withGetByName
      ? {
          getByName: (name: string) => stub(name),
          idFromName: () => {
            throw new Error("idFromName should not be reached");
          },
          get: () => {
            throw new Error("get should not be reached");
          },
        }
      : {
          idFromName: (name: string) => ({ name }),
          get: (id: unknown) => stub((id as { name: string }).name),
        };
    return { clock, names, namespace, storageFor };
  }

  it("grants a lease and renews and releases it under the same token", async () => {
    const { namespace, clock } = fakeNamespace(true);
    const lock = durableObjectLock(namespace, { renewEveryMs: 20_000 });
    expect(lock.renewEveryMs).toBe(20_000);

    const lease = await lock.acquire("sweep", {
      job: "sweep",
      runId: "r1",
      holdMs: 300_000,
    });
    expect(lease).not.toBeNull();

    // Another run finds the key taken.
    await expect(
      lock.acquire("sweep", { job: "sweep", runId: "r2", holdMs: 300_000 }),
    ).resolves.toBeNull();

    clock.now = START + 50_000;
    await expect(lease?.renew?.()).resolves.toBe(true);

    await lease?.release();
    await expect(
      lock.acquire("sweep", { job: "sweep", runId: "r3", holdMs: 300_000 }),
    ).resolves.not.toBeNull();
  });

  it("never holds a lease longer than the job allows", async () => {
    const { namespace, clock } = fakeNamespace(true);
    const lock = durableObjectLock(namespace, {
      renewEveryMs: 20_000,
      leaseMs: 60_000,
    });
    await lock.acquire("sweep", {
      job: "sweep",
      runId: "r1",
      holdMs: 5000,
    });
    // holdMs, not leaseMs: a job that calls itself stale after 5 seconds must
    // not leave its key locked for a minute.
    clock.now = START + 5001;
    await expect(
      lock.acquire("sweep", { job: "sweep", runId: "r2", holdMs: 5000 }),
    ).resolves.not.toBeNull();
  });

  it("gives each key its own instance, so one busy job never blocks another", async () => {
    const { namespace, names } = fakeNamespace(true);
    const lock = durableObjectLock(namespace);
    await lock.acquire("sweep", { job: "sweep", runId: "r1", holdMs: 60_000 });
    await lock.acquire("digest", {
      job: "digest",
      runId: "r2",
      holdMs: 60_000,
    });
    expect(names).toEqual(["sweep", "digest"]);
  });

  it("takes the instance name from the caller when it is given one", async () => {
    const { namespace, names } = fakeNamespace(true);
    const lock = durableObjectLock(namespace, { instanceName: () => "one" });
    const sweep = await lock.acquire("sweep", {
      job: "sweep",
      runId: "r1",
      holdMs: 60_000,
    });
    const digest = await lock.acquire("digest", {
      job: "digest",
      runId: "r2",
      holdMs: 60_000,
    });
    expect(names).toEqual(["one", "one"]);
    // Sharing an instance must not make two keys collide.
    expect(sweep).not.toBeNull();
    expect(digest).not.toBeNull();
  });

  it("falls back to idFromName on a runtime without getByName", async () => {
    const { namespace, names } = fakeNamespace(false);
    const lock = durableObjectLock(namespace);
    const lease = await lock.acquire("sweep", {
      job: "sweep",
      runId: "r1",
      holdMs: 60_000,
    });
    expect(lease).not.toBeNull();
    expect(names).toEqual(["sweep"]);
  });
});
