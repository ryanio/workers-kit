/**
 * A small client for Discord's REST API (v10) and the interaction responses a
 * Worker answers with, on `fetch` and timers only.
 *
 * A 429 waits Discord's `retry_after` and tries again, for every method:
 * Discord did not act on a rate limited request, so even a POST is safe to
 * repeat. A 5xx, a timeout or a network error is retried only for GET, PUT,
 * PATCH and DELETE. A POST is not, because it may have landed: a message
 * that timed out can still be in the channel. When a response says its
 * bucket is spent, the next call on that route waits for the reset first.
 *
 * The token goes only into the Authorization header. Interaction webhooks
 * (`editOriginal`, `followup`, `deleteOriginal`) send no token at all, since
 * the interaction token in the path is the credential.
 */

import { type DateLike, toMillis } from "./format.js";
import {
  type FetchJsonOptions,
  fetchJson,
  HttpError,
  transient,
  withRetry,
} from "./http.js";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface DiscordRestOptions {
  /** The bot token, or an OAuth2 access token with `kind: "Bearer"`. Leave it out for a client that only answers interactions. */
  token?: string;
  /** Default "Bot". */
  kind?: "Bot" | "Bearer";
  /** Per attempt. Default 15 seconds. */
  timeoutMs?: number;
  /** How many 429s one call waits out before it throws. Default 5. */
  max429?: number;
  /**
   * Retry a 5xx, a timeout or a network error on the methods that allow it.
   * Default true. False never retries them on any method, for billed calls;
   * a 429 is still waited out.
   */
  retryServerErrors?: boolean;
  /** A 429 asking for a longer wait than this throws at once. Default 60 seconds. */
  maxWaitMs?: number;
  /** Default `https://discord.com/api/v10`. */
  apiBase?: string;
  /** Discord asks for `DiscordBot (url, version)`. */
  userAgent?: string;
  fetch?: Fetch;
  /** For tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface DiscordRequestOptions {
  /** Shown in the server's audit log next to the change. Sent URI-encoded as `X-Audit-Log-Reason`. */
  reason?: string;
  /** Appended to the path as a query string; undefined values are left out. */
  query?: Record<string, string | number | boolean | undefined>;
  /** False sends no Authorization header. */
  auth?: boolean;
  signal?: AbortSignal;
}

export interface DiscordRest {
  get<T = unknown>(path: string, opts?: DiscordRequestOptions): Promise<T>;
  /** A FormData body goes up as multipart (a file with `payload_json`), anything else as JSON. */
  post<T = unknown>(
    path: string,
    body?: unknown,
    opts?: DiscordRequestOptions,
  ): Promise<T>;
  patch<T = unknown>(
    path: string,
    body?: unknown,
    opts?: DiscordRequestOptions,
  ): Promise<T>;
  put<T = unknown>(
    path: string,
    body?: unknown,
    opts?: DiscordRequestOptions,
  ): Promise<T>;
  delete<T = unknown>(path: string, opts?: DiscordRequestOptions): Promise<T>;
  /** Edits the interaction's first response (PATCH `/webhooks/{app}/{token}/messages/@original`). */
  editOriginal<T = unknown>(
    appId: string,
    interactionToken: string,
    body: unknown,
  ): Promise<T>;
  /** Sends a followup message for the interaction (POST `/webhooks/{app}/{token}`). */
  followup<T = unknown>(
    appId: string,
    interactionToken: string,
    body: unknown,
  ): Promise<T>;
  /** Deletes the interaction's first response. */
  deleteOriginal(appId: string, interactionToken: string): Promise<void>;
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

const MAJOR = new Set(["channels", "guilds", "webhooks"]);

/**
 * The route a rate limit bucket belongs to: the method and path, with every
 * id replaced except the one after `channels`, `guilds` or `webhooks`, which
 * Discord counts as separate buckets.
 */
function routeKey(method: Method, path: string): string {
  const parts = (path.split("?")[0] ?? "").split("/");
  const route = parts.map((part, i) =>
    /^\d{15,21}$/.test(part) && !MAJOR.has(parts[i - 1] ?? "") ? ":id" : part,
  );
  return `${method} ${route.join("/")}`;
}

function withQuery(
  path: string,
  query: DiscordRequestOptions["query"],
): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  if (!qs) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${qs}`;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A Discord REST client. See the top of this file for how it retries. */
export function discordRest(options: DiscordRestOptions = {}): DiscordRest {
  const {
    token,
    kind = "Bot",
    timeoutMs = 15_000,
    max429 = 5,
    retryServerErrors = true,
    maxWaitMs = 60_000,
    apiBase = "https://discord.com/api/v10",
    userAgent = "DiscordBot (https://github.com/ryanio/workers-kit, 1)",
    fetch: fetcher = (u, i) => fetch(u, i),
    sleep = defaultSleep,
    now = Date.now,
  } = options;
  // When each route's bucket refills, and when a global limit lifts.
  const resumeAt = new Map<string, number>();
  let globalResumeAt = 0;

  const watch =
    (key: string): Fetch =>
    async (url, init) => {
      const res = await fetcher(url, init);
      const resetAfter = Number(res.headers.get("x-ratelimit-reset-after"));
      if (
        res.headers.get("x-ratelimit-remaining") === "0" &&
        Number.isFinite(resetAfter)
      ) {
        resumeAt.set(key, now() + resetAfter * 1000);
      }
      if (res.status === 429 && res.headers.get("x-ratelimit-global")) {
        const wait = Number(res.headers.get("retry-after"));
        if (Number.isFinite(wait)) globalResumeAt = now() + wait * 1000;
      }
      return res;
    };

  async function request<T>(
    method: Method,
    path: string,
    body: unknown,
    opts: DiscordRequestOptions = {},
  ): Promise<T> {
    const key = routeKey(method, path);
    const url = `${apiBase}${withQuery(path, opts.query)}`;
    const headers: Record<string, string> = { "user-agent": userAgent };
    if (token && opts.auth !== false)
      headers.authorization = `${kind} ${token}`;
    if (opts.reason && method !== "GET")
      headers["x-audit-log-reason"] = encodeURIComponent(opts.reason);
    const init: FetchJsonOptions = {
      method,
      headers,
      timeoutMs,
      retry: false,
      fetch: watch(key),
      ...(body !== undefined ? { body } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    };

    let limited = 0;
    let failed = 0;
    const retryIf = (err: unknown) => {
      if (err instanceof HttpError && err.status === 429) {
        if (limited++ >= max429) return false;
        return (err.retryAfter ?? 1) * 1000 <= maxWaitMs;
      }
      // Two more tries for a 5xx or a timeout, never for a POST.
      if (!retryServerErrors || method === "POST") return false;
      if (!transient(err) || failed >= 2) return false;
      failed++;
      return true;
    };

    return withRetry(
      async () => {
        const ahead = Math.max(resumeAt.get(key) ?? 0, globalResumeAt) - now();
        if (ahead > 0) await sleep(Math.min(ahead, maxWaitMs));
        return fetchJson<T>(url, init);
      },
      {
        attempts: max429 + 3,
        capMs: maxWaitMs,
        retryIf,
        sleep,
        now,
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
    );
  }

  const hook = (appId: string, interactionToken: string) =>
    `/webhooks/${appId}/${interactionToken}`;

  return {
    get: (path, opts) => request("GET", path, undefined, opts),
    post: (path, body, opts) => request("POST", path, body, opts),
    patch: (path, body, opts) => request("PATCH", path, body, opts),
    put: (path, body, opts) => request("PUT", path, body, opts),
    delete: (path, opts) => request("DELETE", path, undefined, opts),
    editOriginal: (appId, interactionToken, body) =>
      request(
        "PATCH",
        `${hook(appId, interactionToken)}/messages/@original`,
        body,
        {
          auth: false,
        },
      ),
    followup: (appId, interactionToken, body) =>
      request("POST", hook(appId, interactionToken), body, { auth: false }),
    deleteOriginal: async (appId, interactionToken) => {
      await request(
        "DELETE",
        `${hook(appId, interactionToken)}/messages/@original`,
        undefined,
        { auth: false },
      );
    },
  };
}

/** How an interaction is answered (the `type` of an interaction response). */
/**
 * How Discord shows a `<t:...>` timestamp, each in the reader's own zone and
 * language: `t` "22:30", `T` "22:30:00", `d` "20/11/2026", `D` "20 November
 * 2026", `f` "20 November 2026 22:30" (Discord's default), `F` with the
 * weekday, `R` "3 hours ago".
 */
export type DiscordTimeStyle = "t" | "T" | "d" | "D" | "f" | "F" | "R";

export interface DiscordTimeOptions {
  /** Read a number as seconds since the epoch rather than milliseconds, for stored unix times. */
  seconds?: boolean | undefined;
  /**
   * What to write for a value that is not a date. Default "-": Discord
   * refuses an embed field whose value is empty, so "" would fail the post.
   */
  fallback?: string | undefined;
}

/**
 * Discord's timestamp markup for a moment: `<t:1795254600:R>`. Every reader
 * sees it in their own time zone, so a message or embed description never
 * has to pick one. Takes anything `workers-start/format` reads as a date
 * (epoch milliseconds, or seconds with `{ seconds: true }`, an ISO or SQLite
 * string, a Date). Embed titles and footers do not render it: use the
 * embed's `timestamp` field there.
 */
export function discordTime(
  value: DateLike | null | undefined,
  style: DiscordTimeStyle = "f",
  options: DiscordTimeOptions = {},
): string {
  const ms =
    options.seconds && typeof value === "number"
      ? Number.isFinite(value)
        ? value * 1000
        : null
      : toMillis(value);
  if (ms === null) return options.fallback ?? "-";
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

/**
 * Third-party text (a username, a bio, a title) made safe for a message or an
 * embed: the characters that would format it are escaped, as is a heading's
 * `#` at the start of a line, the `<` that opens a mention, and the `:` of a
 * bare link, which Discord would make clickable. Discord hides the escapes.
 */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/[\\*_~`|[\]>]/g, "\\$&")
    .replace(/^(\s*)(-?#)/gm, "$1\\$2")
    .replace(/<(?=[@#:a-z])/gi, "\\<")
    .replace(/:\/\//g, "\\://");
}

/** The integer an embed's `color` takes, from "#5865f2", "5865f2" or "#fff". */
export function embedColor(hex: string): number {
  const digits = hex.trim().replace(/^#/, "");
  const full =
    digits.length === 3 ? [...digits].map((d) => d + d).join("") : digits;
  if (!/^[0-9a-f]{6}$/i.test(full)) {
    throw new RangeError(`"${hex}" is not a #rrggbb or #rgb colour`);
  }
  return Number.parseInt(full, 16);
}

export const InteractionResponseType = {
  Pong: 1,
  ChannelMessageWithSource: 4,
  DeferredChannelMessageWithSource: 5,
  DeferredUpdateMessage: 6,
  UpdateMessage: 7,
  ApplicationCommandAutocompleteResult: 8,
  Modal: 9,
  LaunchActivity: 12,
} as const;

export type InteractionResponseType =
  (typeof InteractionResponseType)[keyof typeof InteractionResponseType];

/** Message flags an interaction response or followup can carry. */
export const MessageFlags = {
  SuppressEmbeds: 1 << 2,
  Ephemeral: 1 << 6,
  SuppressNotifications: 1 << 12,
} as const;

/** The JSON Response that answers an interaction. */
export function interactionResponse(
  type: InteractionResponseType,
  data?: unknown,
): Response {
  return Response.json(data === undefined ? { type } : { type, data });
}

/**
 * "Thinking...": acknowledges the interaction within Discord's three seconds
 * so the real answer can follow through `editOriginal`.
 */
export function deferred(opts: { ephemeral?: boolean } = {}): Response {
  return interactionResponse(
    InteractionResponseType.DeferredChannelMessageWithSource,
    opts.ephemeral ? { flags: MessageFlags.Ephemeral } : undefined,
  );
}

/** The answer to Discord's PING when it checks the interactions endpoint. */
export function pong(): Response {
  return interactionResponse(InteractionResponseType.Pong);
}
