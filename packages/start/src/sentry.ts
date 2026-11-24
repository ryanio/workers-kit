/**
 * Sentry options for a Worker and its pages, without importing an SDK: the
 * objects here go straight into `withSentry` from `@sentry/cloudflare` and
 * `Sentry.init` from a browser SDK.
 *
 * What every app had written for itself: no DSN means no SDK traffic, events
 * from a local server (`wrangler dev`, `vite preview`) never reach the
 * production project, and in the browser the noise that is not the app's to
 * fix (requests that never left the device, extension and injected wallet
 * scripts, users declining a wallet prompt) is dropped. The Worker side drops
 * one workerd message only: the abort a Workflow engine raises when it evicts
 * an instance that is sleeping, which resumes on its own. Browser wording
 * describes nothing workerd says, so a broader filter could only hide a real
 * failure.
 *
 * Release and environment are left unset unless given, so
 * `@sentry/cloudflare` reads `SENTRY_RELEASE` (or `CF_VERSION_METADATA`) and
 * `SENTRY_ENVIRONMENT` from the Worker's env itself.
 *
 * Written for Sentry 11. The types come from `@sentry/core`, an optional peer
 * that every Sentry 11 SDK installs; nothing here is imported at runtime.
 */

import type {
  DataCollection,
  ErrorEvent,
  EventHint,
  Options,
} from "@sentry/core";

/** The part of a Sentry event the filters read. */
export interface SentryEventLike {
  request?: { url?: string };
  message?: string;
  logentry?: { message?: string };
  exception?: { values?: { value?: string; type?: string }[] };
}

/** A `beforeSend`: the event to send, or null to drop it, now or as a promise. */
export type SentryBeforeSend = (
  event: ErrorEvent,
  hint: EventHint,
) => ErrorEvent | null | PromiseLike<ErrorEvent | null>;
/** One `ignoreSpans` entry: a span name, a pattern, or a filter on name, op and attributes. */
export type SentryIgnoreSpan = NonNullable<Options["ignoreSpans"]>[number];

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Whether the event's request was served from this machine. An event with no request (a cron run, a workflow step) is not local. */
export function isLocalEvent(event: SentryEventLike): boolean {
  const url = event.request?.url;
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return LOCAL_HOSTS.has(host) || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

/**
 * A URL served from this machine, by the rule `isLocalEvent` applies:
 * localhost, 127.0.0.1, [::1] and any `*.localhost` host.
 */
export const LOCAL_URL =
  /^[a-z][a-z\d+.-]*:\/\/(?:[^/?#@]*@)?(?:localhost|127\.0\.0\.1|\[::1\]|[^/?#@:]*\.localhost)(?::\d*)?(?:[/?#]|$)/i;

/**
 * An `ignoreSpans` entry that drops spans from a local request. Sentry 11
 * streams spans and never calls `beforeSendTransaction`, so this is what
 * keeps local traces out. It reads `url.full`, which the request span
 * (`http.server` in a Worker, `pageload` and `navigation` in the browser)
 * carries from its start; ignoring that root span drops its children too.
 */
export const LOCAL_SPANS: SentryIgnoreSpan = {
  attributes: { "url.full": LOCAL_URL },
};

/** Header, cookie and query names never sent: client addresses, proxies and user names. */
const SENSITIVE_KEYS = {
  deny: ["forwarded", "-ip", "remote-", "via", "-user"],
};

/**
 * What the options let Sentry collect. Sentry 11 collects user info, cookies,
 * request and response bodies, database query data, AI and MCP inputs and
 * outputs and local variables in stack frames when `dataCollection` is unset, and cookies hold sessions while bodies hold
 * webhooks and payments. This turns all of those off and filters headers and
 * query parameters that name a client address or user. Sentry still strips
 * values that look like keys and tokens on its own.
 */
export const SENTRY_DATA_COLLECTION: DataCollection = {
  userInfo: false,
  cookies: false,
  httpHeaders: { request: SENSITIVE_KEYS, response: SENSITIVE_KEYS },
  httpBodies: [],
  urlQueryParams: SENSITIVE_KEYS,
  genAI: { inputs: false, outputs: false },
  mcp: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  graphQL: { document: false, variables: false },
  stackFrameVariables: false,
};

/**
 * What a Workflow engine throws into a run it evicts after the grace period,
 * which it does to every instance that sleeps (`step.sleep`,
 * `step.sleepUntil`, `step.waitForEvent`) for longer than that. The instance
 * stays waiting and resumes when the sleep ends, so the error is not a
 * failure, but `instrumentWorkflowWithSentry` reports it as unhandled.
 */
const WORKFLOW_EVICTION = /^Aborting engine: Grace period complete$/;

/** A Worker `beforeSend`: drops local events and Workflow evictions, keeps the rest. */
function dropWorkerNoise<T extends SentryEventLike>(event: T): T | null {
  const value = event.exception?.values?.[0]?.value;
  if (value !== undefined && WORKFLOW_EVICTION.test(value)) return null;
  return dropLocalEvents(event);
}

/** A `beforeSend` that drops local events and keeps the rest. */
export function dropLocalEvents<T extends SentryEventLike>(event: T): T | null {
  return isLocalEvent(event) ? null : event;
}

/** Browser wording for a request that never left the device: Chrome, Safari, Firefox. */
export const NETWORK_ERROR = /failed to fetch|load failed|network ?error/i;
/** Errors thrown by extension content scripts and injected wallets. */
export const EXTENSION_ERROR =
  /func \w+ not found|tronlink|trap returned falsish|origin not allowed|object captured as promise rejection with keys: (?=[^\n]*\bcode\b)(?=[^\n]*\bmessage\b)/i;
/** A person declining a wallet prompt. */
export const USER_REJECTION = /user rejected|user denied|rejected the request/i;

/** Scripts other people inject into the page: extensions, wallets and Google Translate's proxy. */
export const BROWSER_DENY_URLS: readonly RegExp[] = [
  /\/_\/translate_http\//i,
  /injected\.js/i,
  /inpage\.js/i,
  /contentscript/i,
  /chrome-extension:\/\//i,
  /moz-extension:\/\//i,
  /safari-(web-)?extension:\/\//i,
  /ms-browser-extension:\/\//i,
  /webkit-masked-url:/i,
];

/** The texts the noise check reads: the exception value, the message and the log entry. */
function messagesOf(event: SentryEventLike): string[] {
  return [
    event.exception?.values?.[0]?.value,
    event.message,
    event.logentry?.message,
  ].filter((m): m is string => typeof m === "string" && m !== "");
}

/** Whether a browser event is noise that is not the app's to fix. `extra` adds patterns matched against its messages. */
export function isBrowserNoise(
  event: SentryEventLike,
  extra: readonly RegExp[] = [],
): boolean {
  const patterns = [NETWORK_ERROR, EXTENSION_ERROR, USER_REJECTION, ...extra];
  return messagesOf(event).some((m) => patterns.some((re) => re.test(m)));
}

/** A DSN worth using: an `https://` URL. Anything else (empty, `off`, a placeholder) turns Sentry off. */
export function validDsn(dsn: string | null | undefined): string | undefined {
  const value = dsn?.trim();
  return value?.startsWith("https://") ? value : undefined;
}

interface ParsedDsn {
  key: string;
  origin: string;
  /** Any path before the project id, as a self-hosted Sentry under a prefix has. */
  prefix: string;
  projectId: string;
}

function parseDsn(dsn: string | null | undefined): ParsedDsn | undefined {
  const value = validDsn(dsn);
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const match = /^(.*)\/([0-9]+)\/?$/.exec(url.pathname);
  if (!(url.username && match)) return undefined;
  return {
    key: decodeURIComponent(url.username),
    origin: url.origin,
    prefix: match[1] ?? "",
    projectId: match[2] ?? "",
  };
}

/**
 * The CSP report endpoint for a DSN, for `contentSecurityPolicy({ reportUri })`:
 * `https://<key>@<host>/<projectId>` becomes
 * `https://<host>/api/<projectId>/security/?sentry_key=<key>`. Undefined for a
 * DSN that is missing or not a Sentry DSN.
 */
export function sentryReportUri(
  dsn: string | null | undefined,
): string | undefined {
  const parsed = parseDsn(dsn);
  if (!parsed) return undefined;
  const { key, origin, prefix, projectId } = parsed;
  return `${origin}${prefix}/api/${projectId}/security/?sentry_key=${encodeURIComponent(key)}`;
}

/**
 * The origin events for a DSN are sent to, `https://<host>`, for a CSP
 * `connect-src`. Undefined for a DSN that is missing or not a Sentry DSN.
 */
export function sentryConnectSource(
  dsn: string | null | undefined,
): string | undefined {
  return parseDsn(dsn)?.origin;
}

function isThenable(
  value: ReturnType<SentryBeforeSend>,
): value is PromiseLike<ErrorEvent | null> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function chain(...steps: (SentryBeforeSend | undefined)[]): SentryBeforeSend {
  // Synchronous while every step is, so a dropped event is dropped at once;
  // from the first step that returns a promise, the rest run after it.
  const run = (
    event: ErrorEvent | null,
    hint: EventHint,
    from: number,
  ): ReturnType<SentryBeforeSend> => {
    let current = event;
    for (let i = from; i < steps.length; i++) {
      const step = steps[i];
      if (!step || current === null) continue;
      const next = step(current, hint);
      if (isThenable(next)) {
        return Promise.resolve(next).then((value) => run(value, hint, i + 1));
      }
      current = next;
    }
    return current;
  };
  return (event, hint) => run(event, hint, 0);
}

interface CommonOptions {
  /** Overrides the DSN read from the env. */
  dsn?: string | undefined;
  /** Left unset by default: an unset rate means no tracing at all, where 0 still creates unsampled spans. */
  tracesSampleRate?: number;
  /** Runs after the built-in filters. */
  beforeSend?: SentryBeforeSend;
  /** More `ignoreSpans` entries, added after `LOCAL_SPANS`. */
  ignoreSpans?: readonly SentryIgnoreSpan[];
  /**
   * Fields laid over `SENTRY_DATA_COLLECTION`, one by one: `{ userInfo: true }`
   * turns user info on and keeps the rest strict. A field given replaces the
   * default's field whole.
   */
  dataCollection?: DataCollection;
  /** Tags set on every event, such as `{ runtime: "worker", worker: "api" }`. */
  tags?: Record<string, string>;
  release?: string;
  environment?: string;
}

export interface WorkerSentryOptions {
  dsn: string | undefined;
  enabled: boolean;
  tracesSampleRate?: number;
  beforeSend: SentryBeforeSend;
  ignoreSpans: SentryIgnoreSpan[];
  dataCollection: DataCollection;
  initialScope?: { tags: Record<string, string> };
  release?: string;
  environment?: string;
}

/**
 * Options for `withSentry`, `instrumentWorkflowWithSentry` and
 * `instrumentDurableObjectWithSentry`. Reads `SENTRY_DSN` from the env;
 * spread the result and add anything app-specific (integrations, samplers).
 */
export function workerSentryOptions(
  env: { SENTRY_DSN?: string | undefined },
  options: CommonOptions = {},
): WorkerSentryOptions {
  const dsn = validDsn(options.dsn ?? env.SENTRY_DSN);
  const out: WorkerSentryOptions = {
    dsn,
    enabled: dsn !== undefined,
    beforeSend: chain(dropWorkerNoise, options.beforeSend),
    ignoreSpans: [LOCAL_SPANS, ...(options.ignoreSpans ?? [])],
    dataCollection: { ...SENTRY_DATA_COLLECTION, ...options.dataCollection },
  };
  if (options.tracesSampleRate !== undefined)
    out.tracesSampleRate = options.tracesSampleRate;
  if (options.tags) out.initialScope = { tags: options.tags };
  if (options.release) out.release = options.release;
  if (options.environment) out.environment = options.environment;
  return out;
}

export interface BrowserSentryOptions extends WorkerSentryOptions {
  denyUrls: RegExp[];
}

/**
 * Options for a browser SDK's `Sentry.init`. Pass the DSN (from the build),
 * and `enabled: false` for dev builds, which the browser cannot tell from
 * the env.
 */
export function browserSentryOptions(
  options: CommonOptions & {
    enabled?: boolean;
    /** More script URLs to ignore. */
    denyUrls?: readonly RegExp[];
    /** More messages that are noise. */
    noise?: readonly RegExp[];
    /** Events to keep even when they read like noise, such as handled captures from a wallet flow. */
    keep?: (event: ErrorEvent) => boolean;
  } = {},
): BrowserSentryOptions {
  const dsn = validDsn(options.dsn);
  const noise = options.noise ?? [];
  const out: BrowserSentryOptions = {
    dsn,
    enabled: dsn !== undefined && options.enabled !== false,
    denyUrls: [...BROWSER_DENY_URLS, ...(options.denyUrls ?? [])],
    beforeSend: chain((event) => {
      if (isLocalEvent(event)) return null;
      if (options.keep?.(event)) return event;
      return isBrowserNoise(event, noise) ? null : event;
    }, options.beforeSend),
    ignoreSpans: [LOCAL_SPANS, ...(options.ignoreSpans ?? [])],
    dataCollection: { ...SENTRY_DATA_COLLECTION, ...options.dataCollection },
  };
  if (options.tracesSampleRate !== undefined)
    out.tracesSampleRate = options.tracesSampleRate;
  if (options.tags) out.initialScope = { tags: options.tags };
  if (options.release) out.release = options.release;
  if (options.environment) out.environment = options.environment;
  return out;
}
