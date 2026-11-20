/**
 * Rate limiting on the Workers rate limiting binding, with one answer for
 * every app: the client is keyed by a salted hash of its IP (never the raw
 * address) or by an API key the app names, a missing binding fails open and
 * says so once per isolate, and a limited request gets a 429 problem
 * (RFC 9457) with `Retry-After`, the IETF `RateLimit-Policy` and `RateLimit`
 * headers, and `cache-control: no-store`.
 *
 * The binding counts per Cloudflare location over 10 or 60 seconds. Quotas
 * over hours or days (a plan's daily allowance) are product rules, not abuse
 * limits; keep those in the app's database.
 */

/** The `ratelimits` binding, structurally. */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** A limit as the headers and the 429 describe it, over any window. */
export interface RateLimitWindow {
  /** Names the limit in the headers, such as `api` or `join`. */
  name: string;
  /** Requests allowed per period. */
  limit: number;
  periodSeconds: number;
}

/** A limit counted by the binding, which supports 10 or 60 second periods. */
export interface RateLimitPolicy extends RateLimitWindow {
  /** Must match the binding's wrangler config. */
  periodSeconds: 10 | 60;
}

const encoder = new TextEncoder();

/**
 * A stable, anonymous key for the client: the SHA-256 of `salt` and the
 * client IP (`cf-connecting-ip`), hex, 32 characters. Without an IP (a
 * request from a test or a service binding) the key is `anon`.
 */
export async function clientKey(
  request: Request,
  { salt = "" }: { salt?: string } = {},
): Promise<string> {
  const ip = request.headers.get("cf-connecting-ip")?.trim();
  if (!ip) return "anon";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`${salt}\n${ip}`),
  );
  return [...new Uint8Array(digest).slice(0, 16)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const reported = new Set<string>();

/**
 * Whether the request may go ahead. A missing binding allows it (failing
 * closed would take the site down over a config slip) and calls `onUnbound`
 * once per isolate so the slip is seen. So does a binding that throws.
 */
export async function checkRateLimit(
  binding: RateLimitBinding | undefined | null,
  key: string,
  {
    onUnbound,
    name = "default",
  }: {
    onUnbound?: (error?: unknown) => void;
    /** Which limit this is, so each missing binding is reported once. */
    name?: string;
  } = {},
): Promise<boolean> {
  const report = (error?: unknown) => {
    const id = `${name}:${error === undefined ? "unbound" : "failing"}`;
    if (reported.has(id)) return;
    reported.add(id);
    onUnbound?.(error);
  };
  if (!binding) {
    report();
    return true;
  }
  try {
    return (await binding.limit({ key })).success;
  } catch (error) {
    report(error);
    return true;
  }
}

/** The IETF rate limit headers for a limited response, with `Retry-After`. */
export function rateLimitHeaders(
  policy: RateLimitWindow,
): Record<string, string> {
  const name = JSON.stringify(policy.name);
  return {
    "retry-after": String(policy.periodSeconds),
    "ratelimit-policy": `${name};q=${policy.limit};w=${policy.periodSeconds}`,
    ratelimit: `${name};r=0;t=${policy.periodSeconds}`,
  };
}

/** The 429 problem for `policy`. `detail` replaces the default sentence. */
/** The 429 problem body for `policy`, as a plain object (for OpenAPI examples). */
export function rateLimitProblem(policy: RateLimitWindow, detail?: string) {
  return {
    type: "about:blank",
    title: "Too Many Requests",
    status: 429 as const,
    code: "rate_limited" as const,
    detail:
      detail ??
      `Too many requests. Try again in ${policy.periodSeconds} seconds.`,
  };
}

export function tooManyRequests(
  policy: RateLimitWindow,
  { detail, text }: { detail?: string; text?: boolean } = {},
): Response {
  const sentence =
    detail ??
    `Too many requests. Try again in ${policy.periodSeconds} seconds.`;
  if (text) {
    return new Response(`${sentence}\n`, {
      status: 429,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        ...rateLimitHeaders(policy),
      },
    });
  }
  const body = rateLimitProblem(policy, sentence);
  return new Response(JSON.stringify(body), {
    status: 429,
    headers: {
      "content-type": "application/problem+json",
      "cache-control": "no-store",
      ...rateLimitHeaders(policy),
    },
  });
}

export interface RateLimitOptions {
  /** The key to count by. Defaults to `clientKey(request, { salt })`. */
  key?: string;
  /** Salt for the default IP key, such as a secret from the env. */
  salt?: string;
  /** Let verified bots (`request.cf.verifiedBotCategory`) through uncounted. */
  allowVerifiedBots?: boolean;
  /** Called once per isolate when the binding is missing or fails. */
  onUnbound?: (error?: unknown) => void;
  /** Detail for the 429. */
  detail?: string;
  /** Answer with plain text instead of a problem, for pages people read. */
  text?: boolean;
}

/**
 * Counts the request against `policy` and returns the 429 to send, or null
 * to go ahead.
 *
 *   const limited = await rateLimit(request, env.API_LIMIT, API_POLICY);
 *   if (limited) return limited;
 */
export async function rateLimit(
  request: Request,
  binding: RateLimitBinding | undefined | null,
  policy: RateLimitPolicy,
  options: RateLimitOptions = {},
): Promise<Response | null> {
  if (options.allowVerifiedBots) {
    const cf = (
      request as {
        cf?: {
          verifiedBotCategory?: string;
          botManagement?: { verifiedBot?: boolean };
        };
      }
    ).cf;
    if (cf?.verifiedBotCategory || cf?.botManagement?.verifiedBot) return null;
  }
  const key =
    options.key ??
    (await clientKey(request, options.salt ? { salt: options.salt } : {}));
  const allowed = await checkRateLimit(binding, `${policy.name}:${key}`, {
    name: policy.name,
    ...(options.onUnbound ? { onUnbound: options.onUnbound } : {}),
  });
  return allowed
    ? null
    : tooManyRequests(policy, {
        ...(options.detail ? { detail: options.detail } : {}),
        ...(options.text ? { text: true } : {}),
      });
}
