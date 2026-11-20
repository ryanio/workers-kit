import {
  defaultGraceMs,
  firesPerDay,
  lastDueSlotMs,
  parseCron,
} from "./cron.js";
import type { JobDef } from "./define.js";
import { durationMs } from "./duration.js";
import { withJobEnv } from "./env.js";
import {
  instanceId,
  isDuplicateId,
  isEngineAbort,
  type SlotKeyFormat,
  slotKey,
} from "./ids.js";
import {
  errorText,
  type RunFinish,
  type RunLedger,
  type RunStart,
  statusFromOutput,
  toDecision,
  truncate,
} from "./ledger.js";
import { makeStep } from "./step.js";
import type {
  Duration,
  EventMap,
  EventOf,
  ExecutionContextLike,
  JobLease,
  JobLock,
  JobParams,
  Logger,
  RunScope,
  RunStatus,
  StandardSchemaV1,
  WorkflowBindingLike,
  WorkflowStepLike,
} from "./types.js";

export type CreateResult = "created" | "duplicate";

/** One inline run, for `runInline`. */
export type InlineCall = {
  job: string;
  /** Event jobs: the payload. */
  data?: unknown;
  /** Event jobs: the event name the handler sees. */
  event?: string;
  ts?: number;
  /** Cron jobs: the slot's scheduled time, in ms. Required for a cron. */
  slotMs?: number;
  /** The instance key. Default: the slot, or the job's first `key`. */
  key?: string;
  /** The run id the ledger and handler see. Default `<job>-<key>`. */
  runId?: string;
  /**
   * Run only this attempt (from 1), for a caller that delivers retries
   * itself, such as a queue consumer. Without it every attempt runs here.
   */
  attempt?: number;
};

export type InlineResult = {
  fn: string;
  /** The run id. */
  id: string;
  /**
   * `ran`; `duplicate` when the ledger already had this run's row on its
   * first attempt; `held` when a singleton skipped the run.
   */
  result: "ran" | "duplicate" | "held";
  status?: RunStatus;
  output?: unknown;
  error?: Error;
  /**
   * Set when this attempt failed and the job has attempts left: run attempt
   * `attempt + 1` after this long. Only returned with `attempt` set.
   */
  retryInMs?: number;
};

/** What `scheduled` and `backstop` did for one cron job. */
export type CronResult = {
  fn: string;
  id: string;
  result: CreateResult | InlineResult["result"];
  status?: RunStatus;
};

export type JobsOptions<Env> = {
  jobs: readonly JobDef<Env>[];
  /**
   * Workflow bindings by name. Event jobs use `events` unless they name
   * another, crons use `crons`, and `default` covers whichever is missing.
   * Inline jobs need none.
   */
  workflows: Record<string, (env: Env) => WorkflowBindingLike | undefined>;
  /** Where runs are recorded. The backstop needs one with `latestKeys`, a singleton cron one with `running`. */
  ledger?: (env: Env) => RunLedger;
  /**
   * The app's own lease for inline singleton jobs. With it, an inline
   * singleton takes a lease for the length of its run instead of reading the
   * ledger, and event jobs can be singletons by key. Crons on a Workflow
   * keep the ledger read: a lease cannot be held across a hibernation.
   */
  lock?: (env: Env) => JobLock;
  /** Cron slot keys: `YYYYMMDDHHmm` (default) or `YYYYMMDD`, for crons that fire at most once a day. */
  slotKey?: SlotKeyFormat;
  /**
   * Step defaults: delay 10 seconds, exponential backoff, timeout 10 minutes.
   * The delay and backoff also space an inline run's attempts.
   */
  steps?: {
    delay?: Duration;
    backoff?: "constant" | "linear" | "exponential";
    timeout?: Duration;
  };
  /** Most steps one instance may take before the adapter throws. Default 1,024, the Workflows cap. */
  maxSteps?: number;
  /** Instance retention. Default 7 days on success, 30 on error. */
  retention?: { successRetention?: Duration; errorRetention?: Duration };
  /** How the ledger and `onFinish` read a handler's return value. */
  statusOf?: (output: unknown) => RunStatus;
  /**
   * Wraps every run and every step callback, e.g. to set up a request-scoped
   * context, a tracing scope or a database client. It must call `fn` once
   * and return its result. A run's ledger writes and `onFinish` happen inside
   * the run's scope; errors thrown by the handler pass through it.
   */
  around?: <T>(scope: RunScope<Env>, fn: () => Promise<T>) => Promise<T>;
  /** Called after a run is recorded, e.g. for a cron monitor check-in. Errors are logged, not thrown. */
  onFinish?: (info: {
    job: string;
    status: RunStatus;
    env: Env;
    runId: string;
    error?: Error;
  }) => void | Promise<void>;
  backstop?: {
    /** How often one isolate checks. Default 15 minutes. */
    everyMs?: number;
    /** How late a slot may be before it counts as missed. Default `defaultGraceMs`. */
    graceMs?: (cron: string) => number;
    /**
     * What to do for a cron job with no row at all: `"wait"` (default) leaves
     * it until its trigger has run once, so a first deploy starts nothing on
     * its own; `"start"` starts its last due slot, which also catches a new
     * trigger that never fired.
     */
    firstRun?: "start" | "wait";
  };
  log?: Logger;
};

const DECISION_MAX = 2000;
const ERROR_MAX = 500;
const ON_FAILURE_RETRIES = 2;
/** Longest an inline run waits between attempts inside one invocation. */
const MAX_INLINE_WAIT_MS = 30_000;

/** One schema issue as `path: message`, or the message alone at the root. */
function issueText(issue: StandardSchemaV1.Issue): string {
  const path = (issue.path ?? [])
    .map((p) => String(typeof p === "object" ? p.key : p))
    .join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

const consoleLog: Logger = {
  info: (m, f) => console.info(m, f ?? {}),
  warn: (m, f) => console.warn(m, f ?? {}),
  error: (m, f) => console.error(m, f ?? {}),
};

const toError = (err: unknown) =>
  err instanceof Error ? err : new Error(String(err));

/**
 * The delay an error asks for with a `retryAfter` property, in seconds as a
 * number or a numeric string (an HTTP `Retry-After`), or undefined.
 */
function retryAfterMs(err: unknown): number | undefined {
  const raw = (err as { retryAfter?: unknown } | null)?.retryAfter;
  if (typeof raw !== "number" && (typeof raw !== "string" || raw.trim() === ""))
    return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/** A `WorkflowStepLike` for inline runs: each step runs once per memo, and sleeping is refused. */
function memoStep(memo: Map<string, unknown>): WorkflowStepLike {
  const noSleep = async (name: string): Promise<never> => {
    throw new Error(
      `step "${name}": an inline job cannot sleep. Run it on a Workflow.`,
    );
  };
  return {
    async do<T>(name: string, _config: unknown, callback: () => Promise<T>) {
      if (memo.has(name)) return memo.get(name) as T;
      const result = await callback();
      memo.set(name, result);
      return result;
    },
    sleep: noSleep,
    sleepUntil: noSleep,
  };
}

export type Jobs<Env, Ev extends EventMap> = ReturnType<
  typeof createJobs<Env, Ev>
>;

/**
 * One call that wires every job: `scheduled` for the Cron Trigger handler,
 * `sendEvent` for routes, `run` for the Workflow classes' `run()`,
 * `runInline` for jobs that run where they are delivered, and `catchUpCrons`
 * for the request path. Throws at load time on a duplicate job id, a cron
 * Cloudflare would misread, a job naming a Workflow that is not in
 * `workflows`, or a singleton with nothing to guard it, so a bad config fails the
 * deploy instead of a run.
 */
export function createJobs<Env, Ev extends EventMap = EventMap>(
  options: JobsOptions<Env>,
) {
  const log = options.log ?? consoleLog;
  const format = options.slotKey ?? "minute";
  const statusOf = options.statusOf ?? statusFromOutput;
  const retention = options.retention ?? {
    successRetention: "7 days",
    errorRetention: "30 days",
  };
  const stepDefaults = {
    delay: options.steps?.delay ?? "10 seconds",
    backoff: options.steps?.backoff ?? ("exponential" as const),
    timeout: options.steps?.timeout ?? "10 minutes",
  };
  const delayMs = durationMs(stepDefaults.delay);

  const byId = new Map<string, JobDef<Env>>();
  const subscribers = new Map<string, string[]>();
  const cronJobs = new Map<string, string[]>();
  for (const job of options.jobs) {
    if (byId.has(job.id)) throw new Error(`two jobs have the id "${job.id}"`);
    byId.set(job.id, job);
    const wf = workflowName(job);
    if (!job.inline && !options.workflows[wf])
      throw new Error(
        `job ${job.id} runs on Workflow "${wf}", which is not in workflows`,
      );
    if (job.singleton && job.event && !(job.inline && options.lock))
      throw new Error(
        `job ${job.id} is an event singleton, which needs inline: true and a lock`,
      );
    if (
      job.singleton &&
      job.cron &&
      !options.ledger &&
      !(job.inline && options.lock)
    )
      throw new Error(
        `job ${job.id} is a singleton, which needs a ledger to find its running slot, or a lock`,
      );
    if (job.event)
      subscribers.set(job.event, [
        ...(subscribers.get(job.event) ?? []),
        job.id,
      ]);
    if (job.cron) {
      parseCron(job.cron);
      if (format === "day" && firesPerDay(job.cron) > 1) {
        throw new Error(
          `job ${job.id}: cron "${job.cron}" fires more than once a day, so slotKey "day" would drop runs`,
        );
      }
      cronJobs.set(job.cron, [...(cronJobs.get(job.cron) ?? []), job.id]);
    }
  }

  function workflowName(job: JobDef<Env>): string {
    if (job.workflow) return job.workflow;
    const lane = job.cron ? "crons" : "events";
    return options.workflows[lane] ? lane : "default";
  }

  function bindingFor(env: Env, fn: string): WorkflowBindingLike {
    const job = byId.get(fn);
    if (!job) throw new Error(`unknown job ${fn}`);
    const binding = options.workflows[workflowName(job)]?.(env);
    if (!binding) throw new Error(`no Workflow binding for job ${fn}`);
    return binding;
  }

  function scoped<T>(scope: RunScope<Env>, fn: () => Promise<T>): Promise<T> {
    return options.around ? options.around(scope, fn) : fn();
  }

  /** Creates one instance. A taken id means the work already started: `"duplicate"`, not an error. */
  async function createInstance(
    env: Env,
    fn: string,
    key: string,
    params: Omit<JobParams, "fn" | "key">,
  ) {
    const id = instanceId(fn, key);
    try {
      await bindingFor(env, fn).create({
        id,
        params: { fn, key, ...params },
        retention,
      });
      return { fn, id, result: "created" as CreateResult };
    } catch (err) {
      if (isDuplicateId(err))
        return { fn, id, result: "duplicate" as CreateResult };
      throw err;
    }
  }

  /** The keys to try for one delivery, in order. */
  function keysFor(
    job: JobDef<Env>,
    data: unknown,
    nowMs: number,
  ): { key: string; notBefore?: number }[] {
    // A key function that throws is a bad payload. Falling back to a fixed
    // key would make every later delivery a duplicate of the first, so the
    // error goes to the sender instead.
    let out: ReturnType<NonNullable<JobDef["key"]>>;
    try {
      out = job.key ? job.key(data, { nowMs }) : null;
    } catch (err) {
      throw new Error(
        `job ${job.id}: its key function threw: ${errorText(err)}`,
      );
    }
    if (out === null || out === undefined)
      return [
        {
          key: `${nowMs.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        },
      ];
    if (typeof out === "string") return [{ key: out }];
    if (out.length === 0)
      throw new Error(`job ${job.id}: its key function returned no keys`);
    return out.map((c) => (typeof c === "string" ? { key: c } : c));
  }

  function keyFor(job: JobDef<Env>, data: unknown, nowMs: number): string {
    return (keysFor(job, data, nowMs)[0] as { key: string }).key;
  }

  /**
   * Starts one instance per job that subscribes to each event. Every
   * subscriber is tried; if any create fails for a reason other than a taken
   * id, the first such error is thrown after the rest have been tried, so a
   * route keeps its own failure handling. An inline subscriber counts as a
   * failure: its events are delivered by the app and run with `runInline`.
   */
  async function sendEvent<K extends keyof Ev & string>(
    env: Env,
    events: { name: K; data: Ev[K]; ts?: number } | readonly EventOf<Ev>[],
    nowMs = Date.now(),
  ) {
    const list = (Array.isArray(events) ? events : [events]) as readonly {
      name: string;
      data: unknown;
      ts?: number;
    }[];
    const results: { fn: string; id: string; result: CreateResult }[] = [];
    let failure: unknown;
    for (const event of list) {
      const fns = subscribers.get(event.name) ?? [];
      if (fns.length === 0)
        log.warn("jobs.no_subscriber", { event: event.name });
      for (const fn of fns) {
        const job = byId.get(fn) as JobDef<Env>;
        try {
          if (job.inline)
            throw new Error(
              `job ${fn} runs inline: deliver its event yourself and run it with runInline`,
            );
          const params = {
            data: event.data,
            event: event.name,
            ...(event.ts === undefined ? {} : { ts: event.ts }),
          };
          let r: { fn: string; id: string; result: CreateResult } | undefined;
          for (const { key, notBefore } of keysFor(job, event.data, nowMs)) {
            r = await createInstance(env, fn, key, {
              ...params,
              ...(notBefore === undefined ? {} : { notBefore }),
            });
            if (r.result === "created") break;
          }
          if (!r) continue;
          if (r.result === "duplicate")
            log.info("jobs.duplicate", { fn, event: event.name, id: r.id });
          results.push(r);
        } catch (err) {
          log.error("jobs.create_failed", {
            fn,
            event: event.name,
            error: errorText(err),
          });
          failure ??= err;
        }
      }
    }
    if (failure !== undefined) throw failure;
    return results;
  }

  /** One cron job's run for one slot. Safe to call twice: the id carries the slot. */
  function startCronSlot(env: Env, fn: string, slotMs: number) {
    return createInstance(env, fn, slotKey(slotMs, format), {
      data: {},
      slotMs,
    });
  }

  async function record(
    env: Env,
    what: string,
    write: (ledger: RunLedger) => Promise<void>,
  ) {
    if (!options.ledger) return;
    try {
      await write(options.ledger(env));
    } catch (err) {
      log.warn(`jobs.ledger_${what}_failed`, { error: errorText(err) });
    }
  }

  /** The ledger start: `false` when the row was already there, otherwise unknown or `true`. */
  async function recordStart(
    env: Env,
    run: RunStart,
  ): Promise<boolean | undefined> {
    if (!options.ledger) return undefined;
    try {
      return (await options.ledger(env).start(run)) ?? undefined;
    } catch (err) {
      log.warn("jobs.ledger_start_failed", { error: errorText(err) });
      return undefined;
    }
  }

  async function finished(
    env: Env,
    info: { job: string; status: RunStatus; runId: string; error?: Error },
  ) {
    if (!options.onFinish) return;
    try {
      await options.onFinish({ ...info, env });
    } catch (err) {
      log.warn("jobs.on_finish_failed", {
        job: info.job,
        error: errorText(err),
      });
    }
  }

  /** Records a finish, then calls `onFinish`. */
  async function finish(env: Env, run: RunFinish, error?: Error) {
    await record(env, "finish", (l) => l.finish(run));
    await finished(env, {
      job: run.fn,
      status: run.status,
      runId: run.id,
      ...(error ? { error } : {}),
    });
  }

  /** The payload as the schema outputs it, or the skip a refused payload gets. */
  async function validate(
    job: JobDef<Env>,
    data: unknown,
    runId: string,
  ): Promise<{ input: unknown } | { skipped: Record<string, unknown> }> {
    if (!job.schema) return { input: data };
    const checked = await job.schema["~standard"].validate(data);
    if (!checked.issues) return { input: checked.value };
    const output = {
      skipped: "invalid payload",
      issues: checked.issues.map(issueText),
    };
    log.warn("jobs.invalid_payload", {
      fn: job.id,
      instanceId: runId,
      issues: output.issues,
    });
    return { skipped: output };
  }

  /**
   * For a singleton cron: the id of an unfinished earlier run, after
   * recording this slot as skipped, or null when the slot may run. Fails
   * open: a ledger that cannot answer lets the slot run, with a warning.
   */
  async function heldBy(
    env: Env,
    job: JobDef<Env>,
    key: string,
    runId: string,
  ): Promise<string | null> {
    if (!job.singleton) return null;
    let other: { id: string } | null;
    try {
      const ledger = options.ledger?.(env);
      if (!ledger?.running) {
        log.warn("jobs.singleton_unguarded", { fn: job.id });
        return null;
      }
      other = await ledger.running(job.id, {
        staleAfterMs: job.singleton.staleAfterMs,
        exceptKey: key,
      });
    } catch (err) {
      log.warn("jobs.singleton_check_failed", {
        fn: job.id,
        error: errorText(err),
      });
      return null;
    }
    if (!other) return null;
    log.info("jobs.singleton_held", { fn: job.id, key, running: other.id });
    await recordHeld(env, { id: runId, fn: job.id, key }, other.id);
    return other.id;
  }

  /**
   * Records a run a singleton skipped: a start, then a `skipped` finish. A
   * first attempt whose row already existed is a repeat of a recorded run,
   * so it is left as it was; a later attempt's row is closed as skipped.
   */
  async function recordHeld(env: Env, run: RunStart, running?: string) {
    const claimed = await recordStart(env, run);
    if (claimed === false && (run.attempt ?? 1) === 1) return;
    await finish(env, {
      ...run,
      status: "skipped",
      decision: toDecision(
        { skipped: "singleton", ...(running ? { running } : {}) },
        DECISION_MAX,
      ),
      error: null,
    });
  }

  /**
   * Takes the app's lease for an inline singleton: the lease, `"held"` when
   * another run has it, or `null` to run unguarded (no lock, or one that
   * threw, which is logged).
   */
  async function takeLease(
    env: Env,
    job: JobDef<Env>,
    data: unknown,
    runId: string,
  ): Promise<JobLease | "held" | null> {
    const singleton = job.singleton as NonNullable<JobDef["singleton"]>;
    let lockKey = job.id;
    let lease: JobLease | null;
    try {
      if (singleton.key) lockKey = `${job.id}:${singleton.key(data)}`;
      lease = await (options.lock as (env: Env) => JobLock)(env).acquire(
        lockKey,
        { job: job.id, runId, holdMs: singleton.staleAfterMs },
      );
    } catch (err) {
      log.warn("jobs.lock_failed", {
        fn: job.id,
        key: lockKey,
        error: errorText(err),
      });
      return null;
    }
    if (lease) return lease;
    log.info("jobs.singleton_held", { fn: job.id, key: lockKey });
    return "held";
  }

  /**
   * Renews a lease every `renewEveryMs` until `stop`, or until one more
   * interval would pass `holdMs`. A renewal that resolves `false` ends it; one
   * that throws is retried on the next beat. The run goes on either way.
   */
  function keepLease(env: Env, job: JobDef<Env>, lease: JobLease) {
    const every = options.lock?.(env).renewEveryMs;
    const renew = lease.renew?.bind(lease);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (renew && every && every > 0) {
      const giveUpAt =
        Date.now() + (job.singleton as { staleAfterMs: number }).staleAfterMs;
      const beat = async () => {
        if (stopped) return;
        if (Date.now() + every >= giveUpAt) {
          log.warn("jobs.lock_ceiling", { fn: job.id });
          return;
        }
        try {
          if (!(await renew())) {
            log.error("jobs.lock_lost", { fn: job.id });
            return;
          }
        } catch (err) {
          log.warn("jobs.lock_renew_failed", {
            fn: job.id,
            error: errorText(err),
          });
        }
        if (!stopped) timer = setTimeout(beat, every);
      };
      timer = setTimeout(beat, every);
    }
    return async () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      try {
        await lease.release();
      } catch (err) {
        log.warn("jobs.lock_release_failed", {
          fn: job.id,
          error: errorText(err),
        });
      }
    };
  }

  /** `startCronSlot`, unless the job is a singleton with a run still going. */
  async function dispatchCronSlot(
    env: Env,
    fn: string,
    slotMs: number,
  ): Promise<CronResult> {
    const job = byId.get(fn) as JobDef<Env>;
    const key = slotKey(slotMs, format);
    const id = instanceId(fn, key);
    if (await heldBy(env, job, key, id)) return { fn, id, result: "held" };
    return startCronSlot(env, fn, slotMs);
  }

  /**
   * The Cron Trigger handler's body. Inline jobs run here, concurrently with
   * each other, and are awaited; the rest get their Workflow instance. Never
   * throws; failures are logged. Pass `ctx` for `around`.
   */
  async function scheduled(
    controller: { cron: string; scheduledTime: number },
    env: Env,
    ctx?: ExecutionContextLike,
  ): Promise<CronResult[]> {
    const fns = cronJobs.get(controller.cron);
    if (!fns) {
      log.error("jobs.unmatched_cron", { cron: controller.cron });
      return [];
    }
    const results: CronResult[] = [];
    const inline: Promise<CronResult | undefined>[] = [];
    for (const fn of fns) {
      if (byId.get(fn)?.inline) {
        inline.push(
          runInline(env, { job: fn, slotMs: controller.scheduledTime }, ctx)
            .then(({ id, result, status }) => {
              log.info("jobs.cron_ran", {
                fn,
                cron: controller.cron,
                result,
                status,
              });
              return { fn, id, result, ...(status ? { status } : {}) };
            })
            .catch((err: unknown) => {
              log.error("jobs.cron_run_failed", {
                fn,
                cron: controller.cron,
                error: errorText(err),
              });
              return undefined;
            }),
        );
        continue;
      }
      try {
        const r = await dispatchCronSlot(env, fn, controller.scheduledTime);
        log.info("jobs.cron_dispatch", {
          fn,
          cron: controller.cron,
          result: r.result,
        });
        results.push(r);
      } catch (err) {
        log.error("jobs.cron_dispatch_failed", {
          fn,
          cron: controller.cron,
          error: errorText(err),
        });
      }
    }
    for (const r of await Promise.all(inline)) if (r) results.push(r);
    return results;
  }

  /**
   * The body of every Workflow class's `run()`. Code here outside a step runs
   * again on every replay, so it does only idempotent things: the ledger start
   * is insert-or-ignore, and the handler's side effects sit inside steps. It
   * adds no steps of its own on the success path, apart from the
   * `not-before` sleep of an instance created with `notBefore`, so existing
   * instances replay against the same step names after an upgrade. Pass the
   * Workflow's `this.ctx` as `ctx` for `around`.
   */
  async function run(
    env: Env,
    event: { payload: Readonly<JobParams>; instanceId: string },
    step: WorkflowStepLike,
    ctx?: ExecutionContextLike,
  ): Promise<unknown> {
    const { fn, data, ts, slotMs, notBefore } = event.payload;
    const job = byId.get(fn);
    if (!job) {
      log.error("jobs.unknown_fn", { fn, instanceId: event.instanceId });
      return { ok: false, reason: "unknown job" };
    }
    const runId = event.instanceId;
    const key =
      slotMs !== undefined
        ? slotKey(slotMs, format)
        : (event.payload.key ?? keyFor(job, data, Date.now()));
    if (notBefore !== undefined) await step.sleepUntil("not-before", notBefore);

    const scope: RunScope<Env> = {
      env,
      job: fn,
      runId,
      step: null,
      ...(ctx ? { ctx } : {}),
    };
    return scoped(scope, async () => {
      await recordStart(env, { id: runId, fn, key });

      const adapter = makeStep<Ev, Env>({
        step,
        env,
        retries: job.retries,
        ...stepDefaults,
        timeout: job.timeout ?? stepDefaults.timeout,
        maxSteps: options.maxSteps ?? 1024,
        dispatch: async (events) => {
          await sendEvent(env, events as readonly EventOf<Ev>[]);
        },
        wrap: (name, cb) => scoped({ ...scope, step: name }, cb),
      });

      const checked = await validate(job, data, runId);
      if ("skipped" in checked) {
        await finish(env, {
          id: runId,
          fn,
          key,
          status: "skipped",
          decision: toDecision(checked.skipped, DECISION_MAX),
          error: null,
          output: checked.skipped,
        });
        return checked.skipped;
      }
      const input = checked.input;

      try {
        const output = await withJobEnv(env, () =>
          job.handler({
            event: {
              name: event.payload.event ?? (job.cron ? "cron" : ""),
              data: input,
              ...((ts ?? slotMs) === undefined ? {} : { ts: ts ?? slotMs }),
            },
            step: adapter,
            env,
            runId,
          }),
        );
        const status = statusOf(output);
        await finish(env, {
          id: runId,
          fn,
          key,
          status,
          decision: toDecision(output, DECISION_MAX),
          error: null,
          output,
        });
        return output;
      } catch (err) {
        const error = toError(err);
        if (isEngineAbort(error)) throw error;
        log.error("jobs.failed", {
          fn,
          instanceId: runId,
          error: error.message,
        });
        const onFailure = job.onFailure;
        if (onFailure) {
          await step.do(
            "on-failure",
            {
              retries: {
                limit: ON_FAILURE_RETRIES,
                delay: stepDefaults.delay,
                backoff: stepDefaults.backoff,
              },
              timeout: stepDefaults.timeout,
            },
            () =>
              scoped({ ...scope, step: "on-failure" }, async () => {
                await withJobEnv(env, () =>
                  onFailure({ error, data: input, env, runId }),
                );
                return null;
              }),
          );
        }
        await finish(
          env,
          {
            id: runId,
            fn,
            key,
            status: "failed",
            decision: null,
            error: truncate(error.message, ERROR_MAX),
            cause: error,
          },
          error,
        );
        throw error;
      }
    });
  }

  /** How long to wait after a failed attempt: the error's `retryAfter`, or the step backoff. */
  function retryDelayMs(err: unknown, attempt: number): number {
    const asked = retryAfterMs(err);
    if (asked !== undefined) return asked;
    if (stepDefaults.backoff === "constant") return delayMs;
    if (stepDefaults.backoff === "linear") return delayMs * attempt;
    return delayMs * 2 ** (attempt - 1);
  }

  /**
   * Runs a job in this invocation instead of on a Workflow: `scheduled()`
   * calls it for inline crons, and an app calls it for inline event jobs it
   * delivers itself (a queue consumer, a Durable Object alarm).
   *
   * Without `attempt`, it runs up to `retries + 1` attempts here, waiting
   * between them as `steps` says (an error's `retryAfter` wins; any wait is
   * capped at 30 seconds). Each attempt replays the steps the last one
   * finished. With `attempt`, it runs that attempt alone and returns
   * `retryInMs` when there are attempts left, for the caller to deliver
   * attempt + 1; steps run again on each delivery.
   *
   * The first attempt claims the ledger row, so a second delivery of the
   * same run id is a `duplicate` and does not run. A singleton skips the
   * run while an earlier one holds the slot: by the app's `lock` when there
   * is one, held for this call's attempts, otherwise by the ledger (crons,
   * first attempts only). The last failed attempt runs
   * `onFailure` once. Throws for an unknown job or an attempt past the
   * job's last; a failed run resolves with `status: "failed"`.
   */
  async function runInline(
    env: Env,
    call: InlineCall,
    ctx?: ExecutionContextLike,
  ): Promise<InlineResult> {
    const job = byId.get(call.job);
    if (!job) throw new Error(`unknown job ${call.job}`);
    if (job.cron && call.slotMs === undefined)
      throw new Error(`job ${job.id} is a cron: runInline needs slotMs`);
    const attempts = job.retries + 1;
    const first = call.attempt ?? 1;
    if (!Number.isInteger(first) || first < 1 || first > attempts)
      throw new Error(
        `job ${job.id}: attempt ${first} is outside its ${attempts} attempts`,
      );
    const data = job.cron ? {} : call.data;
    const key =
      call.key ??
      (call.slotMs !== undefined
        ? slotKey(call.slotMs, format)
        : keyFor(job, data, Date.now()));
    const runId = call.runId ?? instanceId(job.id, key);
    const held = { fn: job.id, id: runId, result: "held" as const };
    let release: (() => Promise<void>) | undefined;
    if (job.singleton && options.lock) {
      const lease = await takeLease(env, job, data, runId);
      if (lease === "held") {
        await recordHeld(env, {
          id: runId,
          fn: job.id,
          key,
          attempt: first,
        });
        return held;
      }
      if (lease) release = keepLease(env, job, lease);
    } else if (first === 1 && (await heldBy(env, job, key, runId))) return held;

    try {
      return await runAttempts(
        env,
        job,
        call,
        { data, key, runId, first },
        ctx,
      );
    } finally {
      await release?.();
    }
  }

  /** The attempts of one `runInline` call. */
  async function runAttempts(
    env: Env,
    job: JobDef<Env>,
    call: InlineCall,
    r0: { data: unknown; key: string; runId: string; first: number },
    ctx: ExecutionContextLike | undefined,
  ): Promise<InlineResult> {
    const { data, key, runId, first } = r0;
    const attempts = job.retries + 1;
    const memo = new Map<string, unknown>();
    for (let attempt = first; ; attempt++) {
      const r = await runAttempt(env, job, {
        data,
        key,
        runId,
        attempt,
        last: attempt === attempts,
        memo,
        event: call.event ?? (job.cron ? "cron" : (job.event ?? "")),
        ts: call.ts ?? call.slotMs,
        ctx,
      });
      if (r.retryInMs === undefined) return r;
      if (call.attempt !== undefined) return r;
      await new Promise((done) =>
        setTimeout(done, Math.min(r.retryInMs as number, MAX_INLINE_WAIT_MS)),
      );
    }
  }

  /** One inline attempt, inside the run's `around` scope. */
  async function runAttempt(
    env: Env,
    job: JobDef<Env>,
    a: {
      data: unknown;
      key: string;
      runId: string;
      attempt: number;
      last: boolean;
      memo: Map<string, unknown>;
      event: string;
      ts: number | undefined;
      ctx: ExecutionContextLike | undefined;
    },
  ): Promise<InlineResult> {
    const fn = job.id;
    const base = { fn, id: a.runId };
    const run = { id: a.runId, fn, key: a.key, attempt: a.attempt };
    const scope: RunScope<Env> = {
      env,
      job: fn,
      runId: a.runId,
      step: null,
      attempt: a.attempt,
      ...(a.ctx ? { ctx: a.ctx } : {}),
    };
    // Set when the handler throws, which is rethrown through `around`.
    let failed: InlineResult | undefined;
    try {
      const r = await scoped(scope, async (): Promise<InlineResult> => {
        const claimed = await recordStart(env, run);
        if (a.attempt === 1 && claimed === false) {
          log.info("jobs.duplicate", { fn, id: a.runId });
          return { ...base, result: "duplicate" };
        }
        const checked = await validate(job, a.data, a.runId);
        if ("skipped" in checked) {
          await finish(env, {
            ...run,
            status: "skipped",
            decision: toDecision(checked.skipped, DECISION_MAX),
            error: null,
            output: checked.skipped,
          });
          return {
            ...base,
            result: "ran",
            status: "skipped",
            output: checked.skipped,
          };
        }
        const adapter = makeStep<Ev, Env>({
          step: memoStep(a.memo),
          env,
          retries: 0,
          ...stepDefaults,
          maxSteps: options.maxSteps ?? 1024,
          dispatch: async (events) => {
            await sendEvent(env, events as readonly EventOf<Ev>[]);
          },
          wrap: (name, cb) => scoped({ ...scope, step: name }, cb),
        });
        let output: unknown;
        try {
          output = await withJobEnv(env, () =>
            job.handler({
              event: {
                name: a.event,
                data: checked.input,
                ...(a.ts === undefined ? {} : { ts: a.ts }),
              },
              step: adapter,
              env,
              runId: a.runId,
              attempt: a.attempt,
            }),
          );
        } catch (err) {
          const error = toError(err);
          const message = truncate(error.message, ERROR_MAX);
          if (!a.last) {
            const delay = retryDelayMs(err, a.attempt);
            log.warn("jobs.attempt_failed", {
              fn,
              runId: a.runId,
              attempt: a.attempt,
              error: error.message,
            });
            await record(env, "retrying", async (l) => {
              await l.retrying?.({
                ...run,
                error: message,
                delayMs: delay,
                cause: error,
              });
            });
            failed = {
              ...base,
              result: "ran",
              status: "failed",
              error,
              retryInMs: delay,
            };
          } else {
            log.error("jobs.failed", { fn, runId: a.runId, error: message });
            await inlineOnFailure(env, job, scope, error, checked.input);
            await finish(
              env,
              {
                ...run,
                status: "failed",
                decision: null,
                error: message,
                cause: error,
              },
              error,
            );
            failed = { ...base, result: "ran", status: "failed", error };
          }
          throw error;
        }
        const status = statusOf(output);
        await finish(env, {
          ...run,
          status,
          decision: toDecision(output, DECISION_MAX),
          error: null,
          output,
        });
        return { ...base, result: "ran", status, output };
      });
      return failed ?? r;
    } catch (err) {
      if (failed) return failed;
      throw err;
    }
  }

  /** An inline run's `onFailure`: up to three tries, then logged. Never throws. */
  async function inlineOnFailure(
    env: Env,
    job: JobDef<Env>,
    scope: RunScope<Env>,
    error: Error,
    data: unknown,
  ) {
    const onFailure = job.onFailure;
    if (!onFailure) return;
    for (let i = 0; i <= ON_FAILURE_RETRIES; i++) {
      try {
        await scoped({ ...scope, step: "on-failure" }, () =>
          withJobEnv(env, () =>
            onFailure({ error, data, env, runId: scope.runId }),
          ),
        );
        return;
      } catch (err) {
        if (i === ON_FAILURE_RETRIES)
          log.error("jobs.on_failure_failed", {
            fn: job.id,
            runId: scope.runId,
            error: errorText(err),
          });
      }
    }
  }

  /**
   * Starts every cron slot that is overdue and has no ledger row. Cloudflare
   * can leave a trigger registered but inert after a deploy, or skip a
   * Worker's crons for hours; this runs off request traffic instead, which
   * shares nothing with the cron system. The slot in the instance id makes a
   * race with a late trigger harmless. Inline crons are left out: the request
   * path has no time to run them. Returns what it did per job.
   */
  async function backstop(env: Env, nowMs = Date.now()): Promise<CronResult[]> {
    const ledger = options.ledger?.(env);
    if (!ledger?.latestKeys)
      throw new Error("the backstop needs a ledger with latestKeys");
    const grace = options.backstop?.graceMs ?? defaultGraceMs;
    const due = [...cronJobs].flatMap(([cron, fns]) =>
      fns
        .filter((fn) => !byId.get(fn)?.inline)
        .map((fn) => ({
          fn,
          slotMs: lastDueSlotMs(cron, nowMs, grace(cron)),
        })),
    );
    if (due.length === 0) return [];
    const latest = await ledger.latestKeys(due.map((d) => d.fn));
    const started: CronResult[] = [];
    for (const { fn, slotMs } of due) {
      const last = latest.get(fn);
      if (
        last === undefined &&
        (options.backstop?.firstRun ?? "wait") === "wait"
      )
        continue;
      if ((last ?? "") >= slotKey(slotMs, format)) continue;
      const r = await dispatchCronSlot(env, fn, slotMs);
      log.warn("jobs.backstop_started", {
        fn,
        slot: slotKey(slotMs, format),
        result: r.result,
      });
      started.push(r);
    }
    return started;
  }

  let lastCheckMs = Number.NEGATIVE_INFINITY;

  /** `backstop`, at most once per isolate per `everyMs`, for the request path. Never throws. */
  async function catchUpCrons(env: Env, nowMs = Date.now()): Promise<void> {
    if (nowMs - lastCheckMs < (options.backstop?.everyMs ?? 15 * 60_000))
      return;
    lastCheckMs = nowMs;
    try {
      await backstop(env, nowMs);
    } catch (err) {
      log.warn("jobs.backstop_failed", { error: errorText(err) });
    }
  }

  return {
    sendEvent,
    scheduled,
    run,
    runInline,
    backstop,
    catchUpCrons,
    startCronSlot,
    /** Cron expression to the jobs it starts, built from the jobs' own triggers. */
    crons: cronJobs as ReadonlyMap<string, readonly string[]>,
    /** Event name to the jobs it starts. */
    subscribers: subscribers as ReadonlyMap<string, readonly string[]>,
    jobs: byId as ReadonlyMap<string, JobDef<Env>>,
    slotKey: (ms: number) => slotKey(ms, format),
  };
}
