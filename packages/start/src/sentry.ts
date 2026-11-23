/**
 * Sentry options for a Worker and its pages, without importing an SDK: the
 * objects here go straight into `withSentry` from `@sentry/cloudflare` and
 * `Sentry.init` from a browser SDK.
 *
 * What every app had written for itself: no DSN means no SDK traffic, events
 * from a local server (`wrangler dev`, `vite preview`) never reach the
 * production project, and in the browser the noise that is not the app's to
 * fix (requests that never left the device, extension and injected wallet
 * scripts, users declining a wallet prompt) is dropped. The Worker side gets
 * no message filters: browser wording describes nothing workerd says, so a
 * filter there could only hide a real failure.
 *
 * Release and environment are left unset unless given, so
 * `@sentry/cloudflare` reads `SENTRY_RELEASE` (or `CF_VERSION_METADATA`) and
 * `SENTRY_ENVIRONMENT` from the Worker's env itself.
 */

/** The part of a Sentry event the filters read. */
export interface SentryEventLike {
  request?: { url?: string };
  message?: string;
  logentry?: { message?: string };
  exception?: { values?: { value?: string; type?: string }[] };
}

// biome-ignore lint/suspicious/noExplicitAny: each SDK types its events differently; these options must be assignable to all of them.
type AnyEvent = any;
type BeforeSend = (event: AnyEvent, hint: AnyEvent) => AnyEvent;
// biome-ignore lint/suspicious/noExplicitAny: Sentry 10 and 11 type `ignoreSpans` entries differently; these options must be assignable to both.
type IgnoreSpan = any;

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
 * Sentry 10 also applies it to transactions.
 */
export const LOCAL_SPANS = { attributes: { "url.full": LOCAL_URL } } as const;

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

function chain(...steps: (BeforeSend | undefined)[]): BeforeSend {
  return (event, hint) => {
    let current = event;
    for (const step of steps) {
      if (!step || current === null) continue;
      current = step(current, hint);
    }
    return current;
  };
}

interface CommonOptions {
  /** Overrides the DSN read from the env. */
  dsn?: string | undefined;
  /** Left unset by default: an unset rate means no tracing at all, where 0 still creates unsampled spans. */
  tracesSampleRate?: number;
  /** Runs after the built-in filters. */
  beforeSend?: BeforeSend;
  /** More `ignoreSpans` entries, added after `LOCAL_SPANS`. */
  ignoreSpans?: readonly IgnoreSpan[];
  /** Tags set on every event, such as `{ runtime: "worker", worker: "api" }`. */
  tags?: Record<string, string>;
  release?: string;
  environment?: string;
}

export interface WorkerSentryOptions {
  dsn: string | undefined;
  enabled: boolean;
  tracesSampleRate?: number;
  beforeSend: BeforeSend;
  /** Sentry 10 and earlier, or Sentry 11 with `traceLifecycle: "static"`. */
  beforeSendTransaction: BeforeSend;
  /** Sentry 11 with streamed spans, the default. */
  ignoreSpans: IgnoreSpan[];
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
    beforeSend: chain(dropLocalEvents, options.beforeSend),
    beforeSendTransaction: dropLocalEvents,
    ignoreSpans: [LOCAL_SPANS, ...(options.ignoreSpans ?? [])],
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
    keep?: (event: AnyEvent) => boolean;
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
    beforeSendTransaction: dropLocalEvents,
    ignoreSpans: [LOCAL_SPANS, ...(options.ignoreSpans ?? [])],
  };
  if (options.tracesSampleRate !== undefined)
    out.tracesSampleRate = options.tracesSampleRate;
  if (options.tags) out.initialScope = { tags: options.tags };
  if (options.release) out.release = options.release;
  if (options.environment) out.environment = options.environment;
  return out;
}
