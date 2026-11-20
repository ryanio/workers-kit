import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  createJobs,
  d1Ledger,
  type JobParams,
  jobEnv,
  jobFactory,
} from "../../src/index.js";

export type Env = {
  DB: D1Database;
  JOB_WORKFLOW: Workflow<JobParams>;
  LABEL?: string;
};
type Events = { "user/created": { userId: string } };

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

export const jobs = createJobs<Env, Events>({
  jobs: [welcome, daily, sweep],
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
