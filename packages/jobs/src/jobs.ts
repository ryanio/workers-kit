import { defaultGraceMs, firesPerDay, lastDueSlotMs, parseCron } from "./cron.js";
import type { JobDef } from "./define.js";
import { withJobEnv } from "./env.js";
import { instanceId, isDuplicateId, isEngineAbort, type SlotKeyFormat, slotKey } from "./ids.js";
import { errorText, type RunLedger, statusFromOutput, toDecision, truncate } from "./ledger.js";
import { makeStep } from "./step.js";
import type {
  Duration,
  EventMap,
  EventOf,
  JobParams,
  Logger,
  RunStatus,
  StandardSchemaV1,
  WorkflowBindingLike,
  WorkflowStepLike,
} from "./types.js";

export type CreateResult = "created" | "duplicate";

export type JobsOptions<Env> = {
  jobs: readonly JobDef<Env>[];
  /**
   * Workflow bindings by name. Event jobs use `events` unless they name
   * another, crons use `crons`, and `default` covers whichever is missing.
   */
  workflows: Record<string, (env: Env) => WorkflowBindingLike | undefined>;
  /** Where runs are recorded. The backstop needs one with `latestKeys`. */
  ledger?: (env: Env) => RunLedger;
  /** Cron slot keys: `YYYYMMDDHHmm` (default) or `YYYYMMDD`, for crons that fire at most once a day. */
  slotKey?: SlotKeyFormat;
  /** Step defaults: delay 10 seconds, exponential backoff, timeout 10 minutes. */
  steps?: { delay?: Duration; backoff?: "constant" | "linear" | "exponential"; timeout?: Duration };
  /** Most steps one instance may take before the adapter throws. Default 1,024, the Workflows cap. */
  maxSteps?: number;
  /** Instance retention. Default 7 days on success, 30 on error. */
  retention?: { successRetention?: Duration; errorRetention?: Duration };
  /** How the ledger and `onFinish` read a handler's return value. */
  statusOf?: (output: unknown) => RunStatus;
  /** Called after a run is recorded, e.g. for a cron monitor check-in. Errors are logged, not thrown. */
  onFinish?: (info: { job: string; status: RunStatus; env: Env; error?: Error }) => void | Promise<void>;
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

/** One schema issue as `path: message`, or the message alone at the root. */
function issueText(issue: StandardSchemaV1.Issue): string {
  const path = (issue.path ?? []).map((p) => String(typeof p === "object" ? p.key : p)).join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

const consoleLog: Logger = {
  info: (m, f) => console.info(m, f ?? {}),
  warn: (m, f) => console.warn(m, f ?? {}),
  error: (m, f) => console.error(m, f ?? {}),
};

export type Jobs<Env, Ev extends EventMap> = ReturnType<typeof createJobs<Env, Ev>>;

/**
 * One call that wires every job: `scheduled` for the Cron Trigger handler,
 * `sendEvent` for routes, `run` for the Workflow classes' `run()`, and
 * `catchUpCrons` for the request path. Throws at load time on a duplicate job
 * id, a cron Cloudflare would misread, or a job naming a Workflow that is not
 * in `workflows`, so a bad config fails the deploy instead of a run.
 */
export function createJobs<Env, Ev extends EventMap = EventMap>(options: JobsOptions<Env>) {
  const log = options.log ?? consoleLog;
  const format = options.slotKey ?? "minute";
  const statusOf = options.statusOf ?? statusFromOutput;
  const retention = options.retention ?? { successRetention: "7 days", errorRetention: "30 days" };
  const stepDefaults = {
    delay: options.steps?.delay ?? "10 seconds",
    backoff: options.steps?.backoff ?? ("exponential" as const),
    timeout: options.steps?.timeout ?? "10 minutes",
  };

  const byId = new Map<string, JobDef<Env>>();
  const subscribers = new Map<string, string[]>();
  const cronJobs = new Map<string, string[]>();
  for (const job of options.jobs) {
    if (byId.has(job.id)) throw new Error(`two jobs have the id "${job.id}"`);
    byId.set(job.id, job);
    const wf = workflowName(job);
    if (!options.workflows[wf]) throw new Error(`job ${job.id} runs on Workflow "${wf}", which is not in workflows`);
    if (job.event) subscribers.set(job.event, [...(subscribers.get(job.event) ?? []), job.id]);
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

  /** Creates one instance. A taken id means the work already started: `"duplicate"`, not an error. */
  async function createInstance(env: Env, fn: string, key: string, params: Omit<JobParams, "fn" | "key">) {
    const id = instanceId(fn, key);
    try {
      await bindingFor(env, fn).create({ id, params: { fn, key, ...params }, retention });
      return { fn, id, result: "created" as CreateResult };
    } catch (err) {
      if (isDuplicateId(err)) return { fn, id, result: "duplicate" as CreateResult };
      throw err;
    }
  }

  function keyFor(job: JobDef<Env>, data: unknown, nowMs: number): string {
    // A key function that throws is a bad payload. Falling back to a fixed
    // key would make every later delivery a duplicate of the first, so the
    // error goes to the sender instead.
    let key: string | null;
    try {
      key = job.key ? job.key(data, { nowMs }) : null;
    } catch (err) {
      throw new Error(`job ${job.id}: its key function threw: ${errorText(err)}`);
    }
    return key ?? `${nowMs.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Starts one instance per job that subscribes to each event. Every
   * subscriber is tried; if any create fails for a reason other than a taken
   * id, the first such error is thrown after the rest have been tried, so a
   * route keeps its own failure handling.
   */
  async function sendEvent<K extends keyof Ev & string>(
    env: Env,
    events: { name: K; data: Ev[K]; ts?: number } | readonly EventOf<Ev>[],
    nowMs = Date.now(),
  ) {
    const list = (Array.isArray(events) ? events : [events]) as readonly { name: string; data: unknown; ts?: number }[];
    const results: { fn: string; id: string; result: CreateResult }[] = [];
    let failure: unknown;
    for (const event of list) {
      const fns = subscribers.get(event.name) ?? [];
      if (fns.length === 0) log.warn("jobs.no_subscriber", { event: event.name });
      for (const fn of fns) {
        const job = byId.get(fn) as JobDef<Env>;
        try {
          const params = { data: event.data, event: event.name, ...(event.ts === undefined ? {} : { ts: event.ts }) };
          const r = await createInstance(env, fn, keyFor(job, event.data, nowMs), params);
          if (r.result === "duplicate") log.info("jobs.duplicate", { fn, event: event.name, id: r.id });
          results.push(r);
        } catch (err) {
          log.error("jobs.create_failed", { fn, event: event.name, error: errorText(err) });
          failure ??= err;
        }
      }
    }
    if (failure !== undefined) throw failure;
    return results;
  }

  /** One cron job's run for one slot. Safe to call twice: the id carries the slot. */
  function startCronSlot(env: Env, fn: string, slotMs: number) {
    return createInstance(env, fn, slotKey(slotMs, format), { data: {}, slotMs });
  }

  /** The Cron Trigger handler's body. Never throws; failures are logged. */
  async function scheduled(controller: { cron: string; scheduledTime: number }, env: Env) {
    const fns = cronJobs.get(controller.cron);
    if (!fns) {
      log.error("jobs.unmatched_cron", { cron: controller.cron });
      return [];
    }
    const results = [];
    for (const fn of fns) {
      try {
        const r = await startCronSlot(env, fn, controller.scheduledTime);
        log.info("jobs.cron_dispatch", { fn, cron: controller.cron, result: r.result });
        results.push(r);
      } catch (err) {
        log.error("jobs.cron_dispatch_failed", { fn, cron: controller.cron, error: errorText(err) });
      }
    }
    return results;
  }

  async function record(env: Env, what: string, write: (ledger: RunLedger) => Promise<void>) {
    if (!options.ledger) return;
    try {
      await write(options.ledger(env));
    } catch (err) {
      log.warn(`jobs.ledger_${what}_failed`, { error: errorText(err) });
    }
  }

  async function finished(env: Env, job: string, status: RunStatus, error?: Error) {
    if (!options.onFinish) return;
    try {
      await options.onFinish({ job, status, env, ...(error ? { error } : {}) });
    } catch (err) {
      log.warn("jobs.on_finish_failed", { job, error: errorText(err) });
    }
  }

  /**
   * The body of every Workflow class's `run()`. Code here outside a step runs
   * again on every replay, so it does only idempotent things: the ledger start
   * is insert-or-ignore, and the handler's side effects sit inside steps. It
   * adds no steps of its own on the success path, so existing instances
   * replay against the same step names after an upgrade.
   */
  async function run(
    env: Env,
    event: { payload: Readonly<JobParams>; instanceId: string },
    step: WorkflowStepLike,
  ): Promise<unknown> {
    const { fn, data, ts, slotMs } = event.payload;
    const job = byId.get(fn);
    if (!job) {
      log.error("jobs.unknown_fn", { fn, instanceId: event.instanceId });
      return { ok: false, reason: "unknown job" };
    }
    const runId = event.instanceId;
    const key = slotMs !== undefined ? slotKey(slotMs, format) : (event.payload.key ?? keyFor(job, data, Date.now()));
    await record(env, "start", (l) => l.start({ id: runId, fn, key }));

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
    });

    let input = data;
    if (job.schema) {
      const checked = await job.schema["~standard"].validate(data);
      if (checked.issues) {
        const output = { skipped: "invalid payload", issues: checked.issues.map(issueText) };
        log.warn("jobs.invalid_payload", { fn, instanceId: runId, issues: output.issues });
        await record(env, "finish", (l) =>
          l.finish({ id: runId, fn, key, status: "skipped", decision: toDecision(output, DECISION_MAX), error: null }),
        );
        await finished(env, fn, "skipped");
        return output;
      }
      input = checked.value;
    }

    try {
      const output = await withJobEnv(env, () =>
        job.handler({
          event: {
            name: event.payload.event ?? (job.cron ? "cron" : ""),
            data: input,
            ...(ts === undefined ? {} : { ts }),
          },
          step: adapter,
          env,
          runId,
        }),
      );
      const status = statusOf(output);
      await record(env, "finish", (l) =>
        l.finish({ id: runId, fn, key, status, decision: toDecision(output, DECISION_MAX), error: null }),
      );
      await finished(env, fn, status);
      return output;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (isEngineAbort(error)) throw error;
      log.error("jobs.failed", { fn, instanceId: runId, error: error.message });
      const onFailure = job.onFailure;
      if (onFailure) {
        await step.do(
          "on-failure",
          {
            retries: { limit: ON_FAILURE_RETRIES, delay: stepDefaults.delay, backoff: stepDefaults.backoff },
            timeout: stepDefaults.timeout,
          },
          async () => {
            await withJobEnv(env, () => onFailure({ error, data: input, env, runId }));
            return null;
          },
        );
      }
      await record(env, "finish", (l) =>
        l.finish({ id: runId, fn, key, status: "failed", decision: null, error: truncate(error.message, ERROR_MAX) }),
      );
      await finished(env, fn, "failed", error);
      throw error;
    }
  }

  /**
   * Starts every cron slot that is overdue and has no ledger row. Cloudflare
   * can leave a trigger registered but inert after a deploy, or skip a
   * Worker's crons for hours; this runs off request traffic instead, which
   * shares nothing with the cron system. The slot in the instance id makes a
   * race with a late trigger harmless. Returns the instances it started.
   */
  async function backstop(env: Env, nowMs = Date.now()) {
    const ledger = options.ledger?.(env);
    if (!ledger?.latestKeys) throw new Error("the backstop needs a ledger with latestKeys");
    const grace = options.backstop?.graceMs ?? defaultGraceMs;
    const due = [...cronJobs].flatMap(([cron, fns]) =>
      fns.map((fn) => ({ fn, slotMs: lastDueSlotMs(cron, nowMs, grace(cron)) })),
    );
    if (due.length === 0) return [];
    const latest = await ledger.latestKeys(due.map((d) => d.fn));
    const started = [];
    for (const { fn, slotMs } of due) {
      const last = latest.get(fn);
      if (last === undefined && (options.backstop?.firstRun ?? "wait") === "wait") continue;
      if ((last ?? "") >= slotKey(slotMs, format)) continue;
      const r = await startCronSlot(env, fn, slotMs);
      log.warn("jobs.backstop_started", { fn, slot: slotKey(slotMs, format), result: r.result });
      started.push(r);
    }
    return started;
  }

  let lastCheckMs = Number.NEGATIVE_INFINITY;

  /** `backstop`, at most once per isolate per `everyMs`, for the request path. Never throws. */
  async function catchUpCrons(env: Env, nowMs = Date.now()): Promise<void> {
    if (nowMs - lastCheckMs < (options.backstop?.everyMs ?? 15 * 60_000)) return;
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
