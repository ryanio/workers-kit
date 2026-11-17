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
  do<T>(name: string, config: StepConfig, callback: () => Promise<T>): Promise<T>;
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
};

export type StepOptions = { retries?: number; timeout?: Duration };

/** The `step` a handler gets. Every name is a memo key: keep it deterministic and never rename it. */
export interface JobStep<Ev extends EventMap = EventMap> {
  /** Runs `fn` once and checkpoints its result as JSON. A replay returns the checkpoint. */
  run<T>(name: string, fn: () => Promise<T> | T, options?: StepOptions): Promise<T>;
  sleep(name: string, duration: Duration): Promise<void>;
  sleepUntil(name: string, at: Date | number): Promise<void>;
  /** Starts the jobs these events trigger, inside one step, so it happens once. */
  sendEvent(name: string, events: EventOf<Ev> | readonly EventOf<Ev>[]): Promise<void>;
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
  /** The Workflow instance id. */
  runId: string;
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
    readonly validate: (value: unknown) => StandardSchemaV1.Result<Output> | Promise<StandardSchemaV1.Result<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

export declare namespace StandardSchemaV1 {
  type Result<Output> =
    | { readonly value: Output; readonly issues?: undefined }
    | { readonly issues: ReadonlyArray<Issue> };
  type Issue = {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
  };
  /** The type a schema's `validate` returns on success. */
  type InferOutput<S extends StandardSchemaV1> = NonNullable<S["~standard"]["types"]>["output"];
}

export type FailureContext<D, Env> = { error: Error; data: D; env: Env; runId: string };

export type RunStatus = "completed" | "failed" | "skipped";

export type Logger = {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
};
