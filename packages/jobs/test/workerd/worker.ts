import {
  DurableObject,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  createJobs,
  d1Ledger,
  durableObjectLock,
  type JobParams,
  jobEnv,
  jobFactory,
  leaseStore,
} from "../../src/index.js";

export type Env = {
  DB: D1Database;
  JOB_WORKFLOW: Workflow<JobParams>;
  JOB_LOCK: DurableObjectNamespace<JobLockObject>;
  LABEL?: string;
};
type Events = {
  "user/created": { userId: string };
  "claim/filed": { claimId: string };
};

/** The lease object the README shows, with the package's own store inside it. */
export class JobLockObject extends DurableObject<Env> {
  private store = leaseStore(this.ctx.storage);

  acquire(key: string, leaseMs: number) {
    return this.store.acquire(key, leaseMs);
  }
  renew(key: string, token: string, leaseMs: number) {
    return this.store.renew(key, token, leaseMs);
  }
  release(key: string, token: string) {
    return this.store.release(key, token);
  }
  override alarm() {
    return this.store.sweep();
  }
}

/** Set while the keyed singleton below is in its run, so a test can overlap two. */
const inFlight = new Map<string, () => void>();
export const releaseClaim = (claimId: string) => inFlight.get(claimId)?.();
export const inFlightKeys = () => [...inFlight.keys()];

const defineJob = jobFactory<Events, Env>();

// What `around` set for the code it wraps: the scope's name, and whether the
// Workflow's ctx reached it.
const scopes = new AsyncLocalStorage<{ name: string; ctx: boolean }>();

const welcome = defineJob(
  {
    id: "send-welcome",
    retries: 1,
    event: "user/created",
    key: (d) => d.userId,
  },
  async ({ event, step, env }) => {
    const count = await step.run("count-rows", async () => {
      const row = await jobEnv<Env>()
        .DB.prepare("SELECT COUNT(*) AS n FROM job_runs")
        .first<{ n: number }>();
      return row?.n ?? 0;
    });
    const at = await step.run("stamp", () => new Date(Date.UTC(2026, 0, 1)));
    const sums = await step.forEachBatch("sum", [1, 2, 3, 4, 5], 2, (batch) =>
      batch.reduce((a, b) => a + b, 0),
    );
    await step.sleep("nap", 1);
    const scope = await step.run("scope", () => scopes.getStore());
    return {
      scope,
      ok: true,
      userId: event.data.userId,
      count,
      at,
      sums,
      sameEnv: env === jobEnv<Env>(),
    };
  },
);

const daily = defineJob(
  { id: "daily", retries: 1, cron: "0 13 * * *" },
  async () => ({ ok: true }),
);
const sweep = defineJob(
  { id: "sweep", retries: 1, cron: "*/15 * * * *" },
  async () => ({ skipped: "nothing to do" }),
);

/** An inline event singleton, keyed, guarded by the Durable Object lease. */
const settleClaim = defineJob(
  {
    id: "settle-claim",
    retries: 0,
    inline: true,
    event: "claim/filed",
    key: (d) => d.claimId,
    singleton: { staleAfter: "30 seconds", key: (d) => d.claimId },
  },
  async ({ event }) => {
    const { claimId } = event.data;
    await new Promise<void>((resolve) => {
      inFlight.set(claimId, resolve);
    });
    inFlight.delete(claimId);
    return { settled: claimId };
  },
);

export const jobs = createJobs<Env, Events>({
  jobs: [welcome, daily, sweep, settleClaim],
  lock: (env) => durableObjectLock(env.JOB_LOCK),
  workflows: { default: (env) => env.JOB_WORKFLOW },
  ledger: (env) => d1Ledger(env.DB),
  backstop: { firstRun: "start" },
  around: (scope, fn) =>
    scopes.run(
      {
        name: `${scope.runId}/${scope.step ?? "run"}`,
        ctx: scope.ctx !== undefined,
      },
      fn,
    ),
  log: { info() {}, warn() {}, error: (m, f) => console.error(m, f) },
});

export class JobWorkflow extends WorkflowEntrypoint<Env, JobParams> {
  override async run(
    event: Readonly<WorkflowEvent<JobParams>>,
    step: WorkflowStep,
  ) {
    return jobs.run(this.env, event, step, this.ctx);
  }
}

export default {
  async fetch() {
    return new Response("ok");
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(jobs.scheduled(controller, env));
  },
} satisfies ExportedHandler<Env>;
