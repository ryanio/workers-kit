/**
 * The guard and the alarm loop. What matters here is that the second firing of
 * a cron slot does nothing, that a dead run does not wedge the loop, and that
 * a run which throws still leaves the next alarm set.
 */
import { describe, expect, it, vi } from "vitest";
import type { RunGuard } from "../../src/alarm.js";
import {
  alarmRunner,
  armAlarm,
  nextTick,
  ranAt,
  runGuard,
  runnerCall,
} from "../../src/alarm.js";

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
    getAlarm: async (): Promise<number | null> => alarm,
    setAlarm: async (at: number): Promise<void> => {
      alarm = at;
    },
  };
}

describe("nextTick", () => {
  it("lands on the grid, not an interval after now", () => {
    // A ten minute grid means :00, :10, :20, whenever the object woke up.
    const at = Date.parse("2026-11-20T12:03:17Z");
    expect(new Date(nextTick(at, 600_000)).toISOString()).toBe(
      "2026-11-20T12:10:00.000Z",
    );
  });

  it("moves on from a mark it is standing exactly on", () => {
    const at = Date.parse("2026-11-20T12:10:00Z");
    expect(nextTick(at, 600_000)).toBe(at + 600_000);
  });
});

describe("armAlarm", () => {
  it("sets one when none is set", async () => {
    const storage = fakeStorage();
    await armAlarm(storage, 60_000, START);
    expect(storage.alarm).toBe(nextTick(START, 60_000));
  });

  it("leaves an alarm that is already pending alone", async () => {
    const storage = fakeStorage();
    await storage.setAlarm(START + 5);
    await armAlarm(storage, 60_000, START);
    expect(storage.alarm).toBe(START + 5);
  });
});

describe("runGuard", () => {
  const build = (clock: { now: number }, onStuck?: (ms: number) => void) => {
    const storage = fakeStorage();
    return {
      storage,
      guard: runGuard(storage, {
        gapMs: 45_000,
        stuckMs: 300_000,
        now: () => clock.now,
        ...(onStuck ? { onStuck } : {}),
      }),
    };
  };

  it("runs the first call and records when it started", async () => {
    const clock = { now: START };
    const { guard } = build(clock);
    const body = vi.fn(async () => {});
    await expect(guard.start(body)).resolves.toBe("ran");
    expect(body).toHaveBeenCalledOnce();
    await expect(guard.lastRunAt()).resolves.toBe(START);
  });

  it("skips the second firing of the same slot", async () => {
    const clock = { now: START };
    const { guard } = build(clock);
    await guard.start(async () => {});

    clock.now = START + 30_000;
    const body = vi.fn(async () => {});
    await expect(guard.start(body)).resolves.toBe("early");
    expect(body).not.toHaveBeenCalled();

    clock.now = START + 45_000;
    await expect(guard.start(body)).resolves.toBe("ran");
  });

  it("refuses a second run while one is going", async () => {
    const clock = { now: START };
    const { guard } = build(clock);
    let release = () => {};
    const first = guard.start(() => new Promise<void>((r) => (release = r)));
    await Promise.resolve();

    clock.now = START + 60_000;
    await expect(guard.start(async () => {})).resolves.toBe("busy");
    expect(guard.busyFor()).toBe(60_000);

    release();
    await expect(first).resolves.toBe("ran");
    expect(guard.busyFor()).toBeNull();
  });

  it("starts anyway once a run has been going long enough to be dead", async () => {
    const clock = { now: START };
    const onStuck = vi.fn();
    const { guard } = build(clock, onStuck);
    guard.start(() => new Promise<void>(() => {}));
    await Promise.resolve();

    clock.now = START + 300_001;
    await expect(guard.start(async () => {})).resolves.toBe("ran");
    expect(onStuck).toHaveBeenCalledWith(300_001);
  });

  it("releases the guard when the body throws", async () => {
    const clock = { now: START };
    const { guard } = build(clock);
    await expect(
      guard.start(async () => {
        throw new Error("run failed");
      }),
    ).rejects.toThrow("run failed");
    expect(guard.busyFor()).toBeNull();
  });
});

describe("alarmRunner", () => {
  const build = (
    clock: { now: number },
    extra: Record<string, unknown> = {},
  ) => {
    const storage = fakeStorage();
    const run = vi.fn(async (_at: number) => undefined as unknown);
    const loop = alarmRunner(storage, {
      everyMs: 60_000,
      gapMs: 45_000,
      stuckMs: 300_000,
      now: () => clock.now,
      run,
      ...extra,
    });
    return { loop, run, storage };
  };

  const get = (path: string) => new Request(`https://runner${path}`);

  it("runs on a plain call and answers 204 when the run returns nothing", async () => {
    const clock = { now: START };
    const { loop, run } = build(clock);
    const response = await loop.fetch(get("/run"));
    expect(response.status).toBe(204);
    expect(run).toHaveBeenCalledWith(START, expect.anything());
  });

  it("runs at the slot the cron names, not at the moment it arrives", async () => {
    const clock = { now: START + 31_000 };
    const { loop, run } = build(clock);
    await loop.fetch(get(`/run?at=${START}`));
    expect(run).toHaveBeenCalledWith(START, expect.anything());
  });

  it("answers the run's value as JSON", async () => {
    const clock = { now: START };
    const { loop, run } = build(clock);
    run.mockResolvedValue({ swept: 3 });
    const response = await loop.fetch(get("/run"));
    await expect(response.json()).resolves.toEqual({ swept: 3 });
  });

  it("reports when the last run started, plus the caller's own fields", async () => {
    const clock = { now: START };
    const { loop } = build(clock, { status: async () => ({ queued: 7 }) });
    await loop.fetch(get("/run"));
    const response = await loop.fetch(get("/ran"));
    await expect(response.json()).resolves.toEqual({
      ranAt: START,
      queued: 7,
    });
    await expect(ranAt((path) => loop.fetch(get(path)))).resolves.toBe(START);
  });

  it("re-arms a lost alarm on any call in, and runs nothing on /arm", async () => {
    const clock = { now: START };
    const { loop, run, storage } = build(clock);
    const response = await loop.fetch(get("/arm"));
    expect(response.status).toBe(204);
    expect(run).not.toHaveBeenCalled();
    expect(storage.alarm).toBe(nextTick(START, 60_000));
  });

  it("sets the next mark before it runs, so a throwing run cannot end the loop", async () => {
    const clock = { now: START };
    const onError = vi.fn();
    const { loop, storage } = build(clock, {
      run: async () => {
        throw new Error("sweep failed");
      },
      onError,
    });
    await loop.alarm();
    expect(storage.alarm).toBe(nextTick(START, 60_000));
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("keeps no alarm of its own without everyMs", async () => {
    const clock = { now: START };
    const { loop, storage } = build(clock, { everyMs: undefined });
    await loop.alarm();
    await loop.fetch(get("/arm"));
    expect(storage.alarm).toBeNull();
  });

  it("runs once when the cron fires twice in one slot", async () => {
    // The whole reason the object exists. The runner applies the guard
    // itself: a body that did not opt in would otherwise run twice.
    const clock = { now: START };
    const { loop, run } = build(clock);
    await loop.alarm();
    clock.now = START + 20_000;
    const second = await loop.fetch(get("/run"));

    expect(run).toHaveBeenCalledOnce();
    await expect(second.json()).resolves.toEqual({ skipped: "early" });
  });

  it("stamps the run even when the body returns nothing, so /ran is not null forever", async () => {
    // An uptime sweep watches ranAt; a loop that never stamps looks dead.
    const clock = { now: START };
    const { loop } = build(clock);
    await loop.alarm();
    await expect((await loop.fetch(get("/ran"))).json()).resolves.toEqual({
      ranAt: START,
    });
  });

  it("runs one body at a time when the alarm and the cron overlap", async () => {
    const clock = { now: START };
    let peak = 0;
    let live = 0;
    let release = () => {};
    const { loop } = build(clock, {
      run: () =>
        new Promise<void>((resolve) => {
          live += 1;
          peak = Math.max(peak, live);
          release = () => {
            live -= 1;
            resolve();
          };
        }),
    });
    const settle = async () => {
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }
    };
    const first = loop.alarm();
    await settle();
    expect(peak).toBe(1);

    // Past gapMs, so it is not an early skip, and well short of stuckMs.
    clock.now = START + 60_000;
    const second = await loop.fetch(get("/run"));
    await expect(second.json()).resolves.toEqual({ skipped: "busy" });
    expect(peak).toBe(1);

    release();
    await first;
  });

  it("leaves the guard to the body when asked to", async () => {
    const clock = { now: START };
    const outcomes: string[] = [];
    const { loop } = build(clock, {
      guarded: false,
      run: async (_at: number, guard: RunGuard) => {
        outcomes.push(await guard.start(async () => {}));
        return undefined;
      },
    });
    await loop.alarm();
    clock.now = START + 20_000;
    await loop.fetch(get("/run"));
    // The body's own guard decides, and the runner does not guard it twice.
    expect(outcomes).toEqual(["ran", "early"]);
  });

  it("catches a body that throws synchronously", async () => {
    // Letting it through would reject `alarm`, and workerd would retry at the
    // original time rather than the grid mark just written.
    const clock = { now: START };
    const onError = vi.fn();
    const { loop, storage } = build(clock, {
      run: () => {
        throw new Error("sync boom");
      },
      onError,
    });
    await expect(loop.alarm()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(storage.alarm).toBe(nextTick(START, 60_000));
  });

  it("survives a reporter that throws too", async () => {
    const clock = { now: START };
    const { loop } = build(clock, {
      run: async () => {
        throw new Error("boom");
      },
      onError: () => {
        throw new Error("the reporter is broken too");
      },
    });
    await expect(loop.alarm()).resolves.toBeUndefined();
  });

  it("hands back the outcome for an object that drives the loop itself", async () => {
    const clock = { now: START };
    const { loop, run } = build(clock);
    run.mockResolvedValue({ swept: 2 });
    await expect(loop.run()).resolves.toEqual({
      outcome: "ran",
      value: { swept: 2 },
    });
    clock.now = START + 1000;
    await expect(loop.run()).resolves.toEqual({
      outcome: "early",
      value: undefined,
    });
  });
});

describe("runnerCall", () => {
  it("addresses the instance by name and keeps the path and query", async () => {
    const fetchStub = vi.fn(async (request: Request) =>
      Response.json({ ranAt: 5, url: request.url }),
    );
    const namespace = {
      idFromName: vi.fn((name: string) => ({ name })),
      get: vi.fn(() => ({ fetch: fetchStub })),
    };
    const call = runnerCall(namespace, "sweep");
    await expect(ranAt(call)).resolves.toBe(5);
    expect(namespace.idFromName).toHaveBeenCalledWith("sweep");
    expect(fetchStub.mock.calls[0]?.[0].url).toBe("https://runner/ran");

    await call("/run?at=1");
    expect(fetchStub.mock.calls[1]?.[0].url).toBe("https://runner/run?at=1");
  });

  it("reads a missing ranAt as null", async () => {
    const call = async () => Response.json({});
    await expect(ranAt(call)).resolves.toBeNull();
  });
});
