/**
 * Cloudflare Access sign-ins. Access sits in front of an app (or a path of
 * it) and adds a signed JWT to every request it lets through, as the
 * `Cf-Access-Jwt-Assertion` header and the `CF_Authorization` cookie. The
 * header alone proves nothing, since anyone can send it to the Worker's other
 * hostnames, so this checks the token: RS256 signature against the team's
 * published keys, issuer, audience, `exp` and `nbf`, then the email against an
 * allowlist, or a service token's client id against its own list.
 *
 * WebCrypto only, so it runs in workerd, the browser and Node. Every failure
 * is a result, never a throw, and a missing config refuses everything.
 */

export interface AccessConfig {
  /** The team domain without scheme, such as `myteam.cloudflareaccess.com`. */
  teamDomain: string;
  /** The Access application's audience tag. */
  aud: string;
  /** Lowercased addresses allowed in. */
  emails: readonly string[];
  /** Client ids of Access service tokens allowed in. */
  serviceTokens: readonly string[];
}

/** Raw config values, as they come from Worker vars or secrets. */
export interface AccessEnv {
  teamDomain?: string | undefined;
  aud?: string | undefined;
  /** Comma or whitespace separated. */
  emails?: string | undefined;
  /** Comma or whitespace separated service token client ids. */
  serviceTokens?: string | undefined;
}

/**
 * The parsed config, or null when the team domain or audience is missing, or
 * when neither an email nor a service token is allowed. A null config makes
 * every check fail with `unconfigured`.
 */
export function parseAccessConfig(env: AccessEnv): AccessConfig | null {
  const teamDomain = (env.teamDomain ?? "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  const aud = (env.aud ?? "").trim();
  const emails = list(env.emails)
    .map((e) => e.toLowerCase())
    .filter((e) => e.includes("@"));
  const serviceTokens = list(env.serviceTokens);
  if (!teamDomain || !aud) return null;
  if (emails.length === 0 && serviceTokens.length === 0) return null;
  return { teamDomain, aud, emails, serviceTokens };
}

const list = (value: string | undefined) =>
  (value ?? "").split(/[\s,]+/).filter(Boolean);

/** The Access token on a request: the header Access adds, else its cookie. */
export function accessToken(request: Request): string | null {
  const header = request.headers.get("cf-access-jwt-assertion");
  if (header) return header;
  const cookie = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(
    request.headers.get("cookie") ?? "",
  );
  return cookie?.[1] ?? null;
}

export type AccessFailure =
  /** No config: 503. */
  | "unconfigured"
  /** No token, or one that does not verify: 401. */
  | "unauthenticated"
  /** A valid token for someone not on the list: 403. */
  | "forbidden"
  /** The team's keys could not be fetched: 503. */
  | "unavailable";

export type AccessResult =
  | { ok: true; email: string; service?: undefined }
  | { ok: true; service: string; email?: undefined }
  | {
      ok: false;
      status: 401 | 403 | 503;
      code: AccessFailure;
      reason: string;
    };

export interface AccessVerifierOptions {
  /** Fetches the certs URL. Defaults to the global `fetch`. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Milliseconds since the epoch. Defaults to `Date.now`. */
  now?: () => number;
  /** How long fetched keys are trusted. Default one hour. */
  ttlMs?: number;
  /** An unknown key id refetches at most this often. Default one minute. */
  refreshMs?: number;
  /** Timeout on the certs fetch. Default 5 seconds. */
  timeoutMs?: number;
  /** Seconds of clock difference allowed on `exp` and `nbf`. Default 60. */
  leewaySeconds?: number;
}

export type AccessVerifier = (
  token: string | null | undefined,
  config: AccessConfig | null,
) => Promise<AccessResult>;

type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
interface KeySet {
  keys: Map<string, Key>;
  fetchedAt: number;
  /** Whether the last fetch gave keys. */
  ok: boolean;
  refreshing?: Promise<void> | undefined;
}

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

const deny = (
  status: 401 | 403 | 503,
  code: AccessFailure,
  reason: string,
): AccessResult => ({ ok: false, status, code, reason });

/**
 * A verifier with its own key cache. Keys are cached per team for `ttlMs`; a
 * token naming a key id the cache lacks refetches at most once per
 * `refreshMs`, so a stream of made-up key ids cannot hammer the certs URL. A
 * failed or empty fetch keeps the keys already held.
 */
export function createAccessVerifier(
  options: AccessVerifierOptions = {},
): AccessVerifier {
  const {
    fetch: fetcher = (url, init) => fetch(url, init),
    now = Date.now,
    ttlMs = 60 * 60_000,
    refreshMs = 60_000,
    timeoutMs = 5_000,
    leewaySeconds = 60,
  } = options;
  const sets = new Map<string, KeySet>();

  async function refresh(url: string, set: KeySet): Promise<void> {
    set.fetchedAt = now();
    set.ok = await load(url, set);
  }

  async function load(url: string, set: KeySet): Promise<boolean> {
    try {
      const res = await fetcher(url, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { keys?: unknown };
      const next = new Map<string, Key>();
      for (const jwk of Array.isArray(body.keys) ? body.keys : []) {
        const { kid, kty } = (jwk ?? {}) as { kid?: unknown; kty?: unknown };
        if (typeof kid !== "string" || kty !== "RSA") continue;
        try {
          next.set(
            kid,
            await crypto.subtle.importKey("jwk", jwk, RS256, false, ["verify"]),
          );
        } catch {
          // A key that will not import is skipped; the others still work.
        }
      }
      if (next.size === 0) return false;
      set.keys = next;
      return true;
    } catch {
      return false;
    }
  }

  /** The key for `kid`, null when the team has none, or "unavailable". */
  async function key(
    teamDomain: string,
    kid: string,
  ): Promise<Key | null | "unavailable"> {
    const url = `https://${teamDomain}/cdn-cgi/access/certs`;
    let set = sets.get(url);
    if (!set) {
      set = {
        keys: new Map(),
        fetchedAt: Number.NEGATIVE_INFINITY,
        ok: false,
      };
      sets.set(url, set);
    }
    if (set.refreshing) await set.refreshing;
    const age = now() - set.fetchedAt;
    if (age <= ttlMs && set.keys.has(kid)) return set.keys.get(kid) ?? null;
    if (age > refreshMs) {
      const current = set;
      current.refreshing ??= refresh(url, current).finally(() => {
        current.refreshing = undefined;
      });
      await current.refreshing;
    }
    const found = set.keys.get(kid);
    if (found) return found;
    return !set.ok && set.keys.size === 0 ? "unavailable" : null;
  }

  return async (token, config) => {
    if (!config) return deny(503, "unconfigured", "Access is not configured.");
    if (!token) return deny(401, "unauthenticated", "No Access token.");

    const parts = token.split(".");
    if (parts.length !== 3)
      return deny(401, "unauthenticated", "Malformed token.");
    const [head, body, signature] = parts as [string, string, string];
    const header = decodeJson(head);
    const claims = decodeJson(body);
    if (!header || !claims)
      return deny(401, "unauthenticated", "Malformed token.");
    if (header.alg !== "RS256")
      return deny(401, "unauthenticated", "Unexpected algorithm.");
    if (typeof header.kid !== "string" || !header.kid)
      return deny(401, "unauthenticated", "Token has no key id.");

    const found = await key(config.teamDomain, header.kid);
    if (found === "unavailable")
      return deny(503, "unavailable", "Could not load the Access keys.");
    if (!found) return deny(401, "unauthenticated", "Unknown signing key.");

    let valid = false;
    try {
      const sig = base64UrlDecode(signature);
      valid =
        sig !== null &&
        (await crypto.subtle.verify(
          RS256,
          found,
          sig,
          new TextEncoder().encode(`${head}.${body}`),
        ));
    } catch {
      valid = false;
    }
    if (!valid) return deny(401, "unauthenticated", "Bad signature.");

    if (claims.iss !== `https://${config.teamDomain}`)
      return deny(401, "unauthenticated", "Wrong issuer.");
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(config.aud))
      return deny(401, "unauthenticated", "Wrong audience.");
    const nowS = now() / 1000;
    if (typeof claims.exp !== "number" || claims.exp + leewaySeconds < nowS)
      return deny(401, "unauthenticated", "Token expired.");
    if (typeof claims.nbf === "number" && claims.nbf - leewaySeconds > nowS)
      return deny(401, "unauthenticated", "Token not valid yet.");

    if (typeof claims.email === "string" && claims.email.includes("@")) {
      const email = claims.email.trim().toLowerCase();
      return config.emails.includes(email)
        ? { ok: true, email }
        : deny(403, "forbidden", "This account is not on the allowed list.");
    }
    // A service token's sign-in: an app token for nobody, named by client id.
    // A client certificate's sign-in also has a name and no email, so the
    // name alone is not enough.
    const service =
      claims.type === "app" &&
      claims.sub === "" &&
      claims.email === undefined &&
      typeof claims.common_name === "string"
        ? claims.common_name
        : null;
    if (service && config.serviceTokens.includes(service))
      return { ok: true, service };
    return deny(403, "forbidden", "This sign-in is not on the allowed list.");
  };
}

let shared: AccessVerifier | undefined;

/**
 * Checks a token with a verifier shared by the whole isolate, so the team's
 * keys are fetched once per hour, not once per request.
 */
export function verifyAccessToken(
  token: string | null | undefined,
  config: AccessConfig | null,
): Promise<AccessResult> {
  shared ??= createAccessVerifier();
  return shared(token, config);
}

function base64UrlDecode(part: string): Uint8Array<ArrayBuffer> | null {
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

function decodeJson(part: string): Record<string, unknown> | null {
  const bytes = base64UrlDecode(part);
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
