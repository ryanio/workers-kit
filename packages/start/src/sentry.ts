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
  exception?: { values?: { value?: string; type?: string }[] };
}

// biome-ignore lint/suspicious/noExplicitAny: each SDK types its events differently; these options must be assignable to all of them.
type AnyEvent = any;
type BeforeSend = (event: AnyEvent, hint: AnyEvent) => AnyEvent;

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

/** A `beforeSend` that drops local events and keeps the rest. */
export function dropLocalEvents<T extends SentryEventLike>(event: T): T | null {
  return isLocalEvent(event) ? null : event;
}

/** Browser wording for a request that never left the device: Chrome, Safari, Firefox. */
export const NETWORK_ERROR = /failed to fetch|load failed|networkerror/i;
/** Errors thrown by extension content scripts and injected wallets. */
export const EXTENSION_ERROR =
  /func \w+ not found|tronlink|trap returned falsish|origin not allowed|object captured as promise rejection with keys: code, (data, )?message/i;
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

/** Whether a browser event is noise that is not the app's to fix. `extra` adds patterns matched against the message. */
export function isBrowserNoise(
  event: SentryEventLike,
  extra: readonly RegExp[] = [],
): boolean {
  const message = event.exception?.values?.[0]?.value ?? "";
  return [NETWORK_ERROR, EXTENSION_ERROR, USER_REJECTION, ...extra].some((re) =>
    re.test(message),
  );
}

/** A DSN worth using: an `https://` URL. Anything else (empty, `off`, a placeholder) turns Sentry off. */
export function validDsn(dsn: string | null | undefined): string | undefined {
  const value = dsn?.trim();
  return value?.startsWith("https://") ? value : undefined;
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
  beforeSendTransaction: BeforeSend;
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
  } = {},
): BrowserSentryOptions {
  const dsn = validDsn(options.dsn);
  const noise = options.noise ?? [];
  const out: BrowserSentryOptions = {
    dsn,
    enabled: dsn !== undefined && options.enabled !== false,
    denyUrls: [...BROWSER_DENY_URLS, ...(options.denyUrls ?? [])],
    beforeSend: chain(
      (event) =>
        isLocalEvent(event) || isBrowserNoise(event, noise) ? null : event,
      options.beforeSend,
    ),
    beforeSendTransaction: dropLocalEvents,
  };
  if (options.tracesSampleRate !== undefined)
    out.tracesSampleRate = options.tracesSampleRate;
  if (options.tags) out.initialScope = { tags: options.tags };
  if (options.release) out.release = options.release;
  if (options.environment) out.environment = options.environment;
  return out;
}
