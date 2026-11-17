// Shared types. Nothing here imports `cloudflare:workers`, so the package runs
// under Node for tests and under workerd in production.

/** Event name to payload type, e.g. `{ "user/created": { userId: string } }`. */
// biome-ignore lint/suspicious/noExplicitAny: an interface map has no index signature, so the constraint is any-valued.
export type EventMap = Record<string, any>;

/** One event as a sender passes it: a name from the map and its payload. */
export type EventOf<Ev extends EventMap> = {
  [K in keyof Ev & string]: { name: K; data: Ev[K]; ts?: number };
}[keyof Ev & string];

/** A Workflows duration: milliseconds or a string such as `"10 minutes"`, as workers-types spells it. */
export type Duration =
  | number
  | `${number} ${"second" | "minute" | "hour" | "day" | "week" | "month" | "year"}${"s" | ""}`;

export type RetryConfig = {
  limit: number;
  delay: Duration;
  backoff?: "constant" | "linear" | "exponential";
};

export type StepConfig = { retries?: RetryConfig; timeout?: Duration };

/** The part of the Workflows `WorkflowStep` this package calls. */
export interface WorkflowStepLike {
  do<T>(
    name: string,
    config: StepConfig,
    callback: () => Promise<T>,
  ): Promise<T>;
  sleep(name: string, duration: Duration): Promise<void>;
  sleepUntil(name: string, timestamp: Date | number): Promise<void>;
}

/** The part of a Workflow binding this package calls. */
export interface WorkflowBindingLike {
  create(options: {
    id: string;
    params: JobParams;
    retention?: { successRetention?: Duration; errorRetention?: Duration };
  }): Promise<unknown>;
}

/**
 * What an instance carries as its params. `key` and `event` are written for
 * every new instance; the run body reads them when present and otherwise
 * works the key out from `data` again, so instances created before either
 * field existed still run.
 */
export type JobParams = {
  fn: string;
  data: unknown;
  /** The handler reads this, e.g. to sleep until a due time. */
  ts?: number;
  /** Crons: the slot's scheduled time, in ms. */
  slotMs?: number;
  /** The instance key (the tail of the instance id). */
  key?: string;
  /** The event that started it. */
  event?: string;
  /** Start no earlier than this, in ms: the run sleeps in a step named `not-before` first. */
  notBefore?: number;
};

export type StepOptions = { retries?: number; timeout?: Duration };

/** The `step` a handler gets. Every name is a memo key: keep it deterministic and never rename it. */
export interface JobStep<Ev extends EventMap = EventMap> {
  /** Runs `fn` once and checkpoints its result as JSON. A replay returns the checkpoint. */
  run<T>(
    name: string,
    fn: () => Promise<T> | T,
    options?: StepOptions,
  ): Promise<T>;
  sleep(name: string, duration: Duration): Promise<void>;
  sleepUntil(name: string, at: Date | number): Promise<void>;
  /** Starts the jobs these events trigger, inside one step, so it happens once. */
  sendEvent(
    name: string,
    events: EventOf<Ev> | readonly EventOf<Ev>[],
  ): Promise<void>;
  /**
   * Splits `items` into batches of `size` and runs each batch as its own step,
   * named `<name>-0`, `<name>-1`, and so on, one after another. Use it in
   * place of one step per item: Workflows caps an instance at 1,024 steps.
   * `items` must be the same on every replay, so read it from a step result.
   */
  forEachBatch<I, R>(
    name: string,
    items: readonly I[],
    size: number,
    fn: (batch: I[], index: number) => Promise<R> | R,
  ): Promise<R[]>;
}

export type JobContext<D, Env, Ev extends EventMap> = {
  event: { name: string; data: D; ts?: number };
  step: JobStep<Ev>;
  env: Env;
  /** The Workflow instance id, or the run id of an inline run. */
  runId: string;
  /** Inline runs: the attempt, from 1. Unset on a Workflow, where retries are per step. */
  attempt?: number;
};

/**
 * An app's own lease, for singleton jobs: a Durable Object, a KV row, a
 * database advisory lock. `createJobs` takes one as `lock`.
 */
export interface JobLock {
  /**
   * Takes the lease on `key`, or resolves `null` when another run holds it.
   * `key` is the job id, or `<job>:<singleton key>` for a keyed singleton.
   * `holdMs` is the longest the run may keep the lease: the job's
   * `singleton.staleAfter`. A throw lets the run go ahead unguarded.
   */
  acquire(
    key: string,
    options: { job: string; runId: string; holdMs: number },
  ): Promise<JobLease | null>;
  /**
   * How often to call a lease's `renew` while its run goes on. Renewal
   * stops one interval short of `holdMs`, and on release.
   */
  renewEveryMs?: number;
}

/** A lease `JobLock.acquire` granted. */
export interface JobLease {
  /** Pushes the lease out. Resolve `false` when it is no longer this run's. */
  renew?(): Promise<boolean>;
  /** Gives the lease back, once, when the run ends however it ends. */
  release(): Promise<void>;
}

/** The part of a Worker's `ExecutionContext` the package passes through to `around`. */
export type ExecutionContextLike = {
  waitUntil(promise: Promise<unknown>): void;
};

/**
 * What `around` is told about the code it wraps: a whole run (`step` is
 * `null`) or one step callback (`step` is its name, `on-failure` included).
 */
export type RunScope<Env> = {
  env: Env;
  job: string;
  runId: string;
  step: string | null;
  /** Inline runs: the attempt, from 1. */
  attempt?: number;
  /** The `ctx` given to `run`, `scheduled` or `runInline`. */
  ctx?: ExecutionContextLike;
};

/**
 * The Standard Schema v1 interface (standardschema.dev), declared here so the
 * package needs no runtime dependency. Zod 3.24+, Valibot 1 and ArkType 2
 * schemas all satisfy it.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) =>
      | StandardSchemaV1.Result<Output>
      | Promise<StandardSchemaV1.Result<Output>>;
    readonly types?:
      | { readonly input: Input; readonly output: Output }
      | undefined;
  };
}

export declare namespace StandardSchemaV1 {
  type Result<Output> =
    | { readonly value: Output; readonly issues?: undefined }
    | { readonly issues: ReadonlyArray<Issue> };
  type Issue = {
    readonly message: string;
    readonly path?:
      | ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>
      | undefined;
  };
  /** The type a schema's `validate` returns on success. */
  type InferOutput<S extends StandardSchemaV1> = NonNullable<
    S["~standard"]["types"]
  >["output"];
}

export type FailureContext<D, Env> = {
  error: Error;
  data: D;
  env: Env;
  runId: string;
};

/**
 * One instance key an event job's `key` may return in a list: tried in order,
 * the first id not taken wins. `notBefore` (ms) holds that run until then.
 */
export type KeyCandidate = string | { key: string; notBefore?: number };

export type RunStatus = "completed" | "failed" | "skipped";

export type Logger = {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
};
