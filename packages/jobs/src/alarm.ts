/**
 * A cron loop in a Durable Object: one run at a time, from one place, and an
 * alarm under the cron in case the cron stops.
 *
 * ## Why the object
 *
 * Cloudflare fires a Cron Trigger in whatever data center it picks, often
 * twice in a slot about thirty seconds apart, and a KV write takes up to a
 * minute to reach another data center. Two runs in two places would each read
 * state from before the other's writes and do the same work twice, and a lock
 * kept in KV cannot stop that, because the lock has the same lag as the state.
 * A Durable Object is one object in one place, so every run starts there, one
 * at a time, and reads what the last one wrote.
 *
 * A call that lands within `gapMs` of the last run's start is skipped, which
 * is what makes the second firing of a slot free. A run still going after
 * `stuckMs` is taken as dead and the next call starts anyway, because an
 * object that was evicted mid-run leaves no other way back.
 *
 * ## Why the alarm
 *
 * Cloudflare promises a cron no timing at all and can stop firing one Worker's
 * crons for hours. A Durable Object alarm is promised at least once, with
 * retries. With `everyMs` the object keeps its own alarm on the marks of that
 * grid: every call in re-arms a missing one, and each alarm sets the next
 * before it runs, so a run that throws cannot end the loop. The cron and the
 * alarm both call in, whichever arrives first in a slot runs, and the other is
 * skipped by the gap.
 */

/** The part of `DurableObjectStorage` the guard needs. */
export interface RunStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

/** The part of `DurableObjectStorage` the alarm needs. */
export interface AlarmStorage {
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}

export interface RunGuardOptions {
  /** A call this soon after the last run's start is skipped as `early`. */
  gapMs: number;
  /** A run going for this long is taken as dead, and the next call starts anyway. */
  stuckMs: number;
  /** Milliseconds since the epoch. Defaults to `Date.now`. */
  now?: (() => number) | undefined;
  /** Called when a run looks dead and the guard starts anyway. */
  onStuck?: ((busyForMs: number) => void) | undefined;
}

/** What `start` did: ran the body, found one going, or skipped it as too soon. */
export type RunOutcome = "ran" | "busy" | "early";

export interface RunGuard {
  /**
   * Runs `body` unless another run holds the guard or the last one started
   * less than `gapMs` ago. The body's own errors are the caller's to handle;
   * the guard is released either way.
   */
  start(body: () => Promise<void>): Promise<RunOutcome>;
  /** How long the run under way has been going, milliseconds, or null. */
  busyFor(): number | null;
  /** When the last run started, or null before the first one. */
  lastRunAt(): Promise<number | null>;
}

const LAST_RUN_KEY = "lastRunAt";

/**
 * The first mark of an `everyMs` grid after `now`. The marks sit at 0,
 * `everyMs`, and so on since the epoch, so every ten minutes means :00, :10,
 * :20 and not ten minutes after whenever the object woke up.
 */
export function nextTick(now: number, everyMs: number): number {
  return (Math.floor(now / everyMs) + 1) * everyMs;
}

/**
 * Sets the alarm on the next mark when none is set. Every call into the object
 * does this, so an alarm lost to a failed run or a deploy comes back on the
 * next cron firing or status read.
 */
export async function armAlarm(
  storage: AlarmStorage,
  everyMs: number,
  now = Date.now(),
): Promise<void> {
  if ((await storage.getAlarm()) === null) {
    await storage.setAlarm(nextTick(now, everyMs));
  }
}

/**
 * The one-run-at-a-time guard on its own, for an object that wants it around
 * part of its work rather than all of it.
 */
export function runGuard(
  storage: RunStorage,
  options: RunGuardOptions,
): RunGuard {
  const now = options.now ?? (() => Date.now());
  let since: number | null = null;

  return {
    busyFor() {
      return since === null ? null : now() - since;
    },

    async lastRunAt() {
      return (await storage.get<number>(LAST_RUN_KEY)) ?? null;
    },

    async start(body) {
      const at = now();
      if (since !== null && at - since < options.stuckMs) {
        return "busy";
      }
      if (since !== null) {
        options.onStuck?.(at - since);
      }
      // Taken before the first await, so a second call cannot slip in.
      since = at;
      const mine = at;
      try {
        const last = await storage.get<number>(LAST_RUN_KEY);
        if (last !== undefined && at - last < options.gapMs) {
          return "early";
        }
        await storage.put(LAST_RUN_KEY, at);
        await body();
        return "ran";
      } finally {
        if (since === mine) {
          since = null;
        }
      }
    },
  };
}

export interface AlarmRunnerOptions extends RunGuardOptions {
  /**
   * Keep an alarm on the marks of this grid. Leave it out for an object only
   * the cron calls into, which then has no alarm of its own.
   */
  everyMs?: number | undefined;
  /**
   * One run, inside the guard: it does not start while another run holds it or
   * one started less than `gapMs` ago. Whatever it returns is the `fetch`
   * response's JSON; `undefined` answers 204, and a skipped call answers
   * `{ skipped }`. Its errors are caught here, so report them inside.
   *
   * It is handed the guard as well, for `lastRunAt`, or for `guarded: false`.
   */
  run: (at: number, guard: RunGuard) => Promise<unknown>;
  /**
   * False leaves the guard to the body, which then calls `guard.start` itself.
   * For a run that wants the guard around part of its work, or that reports a
   * skip its own way. Default true.
   */
  guarded?: boolean | undefined;
  /** Extra fields for the `/ran` answer. */
  status?: (() => Promise<Record<string, unknown>>) | undefined;
  /** Called when `run` throws or rejects. */
  onError?: ((error: unknown) => void) | undefined;
}

/** What one call into the runner did. */
export interface RunAnswer {
  outcome: RunOutcome;
  /** What `run` returned, or undefined when it was skipped or returned nothing. */
  value: unknown;
}

export interface AlarmRunner {
  guard: RunGuard;
  /**
   * The object's `fetch`. Three paths: `/ran` answers when the last run
   * started plus whatever `status` adds, `/arm` only re-arms the alarm, and
   * anything else is one run, at `?at=` or now.
   */
  fetch(request: Request): Promise<Response>;
  /** The object's `alarm`: sets the next mark, then runs. */
  alarm(): Promise<void>;
  /** One run, for an object that drives the loop itself rather than over `fetch`. */
  run(at?: number): Promise<RunAnswer>;
}

/**
 * The whole loop, for an object whose `fetch` and `alarm` hand straight to it:
 *
 *     export class Runner extends DurableObject<Env> {
 *       private loop = alarmRunner(this.ctx.storage, {
 *         everyMs: 60_000,
 *         gapMs: 45_000,
 *         stuckMs: 5 * 60_000,
 *         run: (at) => sweep(this.env, at),
 *       });
 *
 *       fetch = (request: Request) => this.loop.fetch(request);
 *       alarm = () => this.loop.alarm();
 *     }
 *
 * and the Worker's `scheduled` reaches it with
 * `runnerCall(env.RUNNER, "sweep")("/run")`.
 */
export function alarmRunner(
  storage: RunStorage & AlarmStorage,
  options: AlarmRunnerOptions,
): AlarmRunner {
  const now = options.now ?? (() => Date.now());
  const guard = runGuard(storage, options);

  const run = async (at: number): Promise<RunAnswer> => {
    let value: unknown;
    try {
      // Called inside the try, so a `run` that throws synchronously is caught
      // too: otherwise `alarm` would reject and workerd would retry it at the
      // original time rather than the grid mark just written.
      if (options.guarded === false) {
        value = await options.run(at, guard);
        return { outcome: "ran", value };
      }
      const outcome = await guard.start(async () => {
        value = await options.run(at, guard);
      });
      return { outcome, value: outcome === "ran" ? value : undefined };
    } catch (error) {
      try {
        options.onError?.(error);
      } catch {
        // A reporter that throws must not take the loop down with it.
      }
      return { outcome: "ran", value: undefined };
    }
  };

  return {
    guard,

    run: (at) => run(at ?? now()),

    async fetch(request) {
      if (options.everyMs !== undefined) {
        await armAlarm(storage, options.everyMs, now());
      }
      const url = new URL(request.url);
      if (url.pathname === "/ran") {
        return Response.json({
          ranAt: await guard.lastRunAt(),
          ...(await options.status?.()),
        });
      }
      if (url.pathname === "/arm") {
        return new Response(null, { status: 204 });
      }
      const answer = await run(Number(url.searchParams.get("at")) || now());
      if (answer.outcome !== "ran") {
        return Response.json({ skipped: answer.outcome });
      }
      return answer.value === undefined
        ? new Response(null, { status: 204 })
        : Response.json(answer.value);
    },

    async alarm() {
      const at = now();
      // Set before the run, so a run that throws cannot end the loop.
      if (options.everyMs !== undefined) {
        await storage.setAlarm(nextTick(at, options.everyMs));
      }
      await run(at);
    },
  };
}

/** The part of `DurableObjectNamespace` the caller helpers need. */
export interface RunnerNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

/**
 * A call into the runner named `name`: `call("/ran")`, `call("/run?at=123")`.
 * The host in the URL is never resolved, so it can be anything.
 */
export function runnerCall(
  namespace: RunnerNamespace,
  name: string,
): (path: string) => Promise<Response> {
  return (path) =>
    namespace
      .get(namespace.idFromName(name))
      .fetch(new Request(`https://runner${path}`));
}

/** When the runner's last run started, read through `call`, or null. */
export async function ranAt(
  call: (path: string) => Promise<Response>,
): Promise<number | null> {
  const body = (await (await call("/ran")).json()) as {
    ranAt?: number | null;
  };
  return body.ranAt ?? null;
}
