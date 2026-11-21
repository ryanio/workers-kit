/**
 * Signed values: a payload a stranger holds and hands back, which the Worker
 * can trust without looking anything up.
 *
 *     signValue   base64url(JSON) + "." + base64url(HMAC-SHA256(secret, JSON))
 *     signature   base64url(HMAC-SHA256(secret, message)), detached
 *
 * The whole payload is signed rather than an opaque id, so the verifier gets
 * the claims back and can cross-check them (an expiry, a bound address, a
 * bound user) without a second read, and tampering in flight fails the
 * signature instead of quietly changing what the token asserts.
 *
 * Every verify is fail-closed and returns `null` for every reason there is: a
 * malformed token, a bad signature, a payload the check rejects and an expired
 * one are indistinguishable to the caller, so a route above cannot be turned
 * into an oracle.
 *
 * The verifier signs the JSON text as it arrives and never re-serializes it,
 * which means key order in whatever you pass to `signValue` is part of the
 * wire format. That is deliberate: re-serializing would let two different
 * payloads share a signature.
 *
 * Only the exact string `signValue` writes verifies. base64url has slack in
 * it: padding is optional, and the trailing character of a 32 byte MAC has
 * spare bits, so four different last characters decode to the same bytes.
 * Comparing the decoded bytes would make several token strings valid for one
 * payload, and an app that treats the token as the identity of the grant (a
 * one-shot link it marks used, a nonce table, a dedupe key) could then be
 * replayed with a variant of a token it has already retired. So the encoding
 * is checked too, and there is exactly one valid string per payload.
 *
 * Each surface brings its own secret. A leaked link-signing secret forges
 * one-shot links; a leaked session secret forges every signed-in user for as
 * long as the cookie lives. Different blast radius, different rotation.
 */

import {
  fromBase64Url,
  fromUtf8,
  hmacSha256,
  timingSafeEqual,
  toBase64Url,
  utf8,
} from "./bytes.js";
import {
  type CookieOptions,
  clearCookie,
  readCookie,
  serializeCookie,
} from "./cookies.js";

/** Serialize `payload` as JSON and sign it. */
export async function signValue(
  secret: string,
  payload: unknown,
): Promise<string> {
  const json = JSON.stringify(payload);
  if (json === undefined) {
    // `undefined`, a function and a symbol all serialize to nothing. There is
    // no token that carries them, so this is a caller bug, not a bad input.
    throw new TypeError("signValue: the payload does not serialize to JSON");
  }
  const mac = await hmacSha256(secret, json);
  return `${toBase64Url(utf8(json))}.${toBase64Url(mac)}`;
}

/**
 * The payload of a value `signValue` produced under the same secret, or `null`.
 *
 * `check` is where the payload's shape is settled, and it runs only after the
 * signature holds. Return the value to accept, or `null` or `undefined` to
 * reject. A zod schema fits as `(p) => Schema.safeParse(p).data`. Without a
 * check the payload comes back as `unknown`, which a caller then has to narrow
 * itself.
 */
export async function verifyValue<T = unknown>(
  secret: string | undefined,
  token: string | null | undefined,
  check?: (payload: unknown) => T | null | undefined,
): Promise<T | null> {
  if (!secret || !token) {
    return null;
  }
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1 || token.includes(".", dot + 1)) {
    return null;
  }
  const bodyText = token.slice(0, dot);
  const body = fromBase64Url(bodyText);
  if (!body || toBase64Url(body) !== bodyText) {
    return null;
  }
  const mac = await hmacSha256(secret, body);
  if (!timingSafeEqual(toBase64Url(mac), token.slice(dot + 1))) {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(fromUtf8(body));
  } catch {
    return null;
  }
  if (!check) {
    return payload as T;
  }
  return check(payload) ?? null;
}

/**
 * A detached signature over a message both sides can rebuild, base64url. For
 * an unsubscribe link or a tracked redirect, where the message is already in
 * the URL and only the proof has to travel.
 */
export async function signatureOf(
  secret: string,
  message: string,
): Promise<string> {
  return toBase64Url(await hmacSha256(secret, message));
}

/**
 * Whether `signature` is `signatureOf(secret, message)`, compared in constant
 * time. Only the exact text `signatureOf` writes is accepted, for the reason
 * `verifyValue` gives.
 */
export async function verifySignature(
  secret: string | undefined,
  message: string,
  signature: string | null | undefined,
): Promise<boolean> {
  if (!secret || !signature) {
    return false;
  }
  return timingSafeEqual(await signatureOf(secret, message), signature);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_MS = 30 * DAY_MS;

/** What a session cookie carries on top of the caller's claims. */
export interface SessionEnvelope<T> {
  /** The caller's claims, whatever `issue` was given. */
  d: T;
  /** Issued at, unix milliseconds. */
  iat: number;
  /** Expires at, unix milliseconds. */
  exp: number;
}

export interface SessionCookieOptions<T> {
  /** The cookie's name. `__Host-` and `__Secure-` prefixes work as they do anywhere. */
  name: string;
  /**
   * The HMAC secret. `undefined` refuses every session and calls `onError`
   * once per read, which is the right failure for a missing binding: it fails
   * closed and it is loud.
   */
  secret: string | undefined;
  /** How long a freshly issued cookie lives. Default 30 days. */
  ttlMs?: number | undefined;
  /**
   * Re-stamp the cookie once this much of its life has passed, so an active
   * visitor never meets the expiry. Default a sixth of `ttlMs`, which against
   * the default 30 days re-stamps a daily visitor about once every five days.
   */
  refreshAfterMs?: number | undefined;
  /**
   * Merged over `HttpOnly`, `Secure`, `SameSite=Lax` and `Path=/`. `maxAge`
   * and `expires` are set from `ttlMs` and cannot be overridden here.
   */
  cookie?: CookieOptions | undefined;
  /** Checks the claims. Same contract as `verifyValue`'s. */
  check?: ((claims: unknown) => T | null | undefined) | undefined;
  /** Milliseconds since the epoch. Defaults to `Date.now`. */
  now?: (() => number) | undefined;
  /** Called when the secret is missing. A cookie that simply does not verify never calls it. */
  onError?: ((error: Error) => void) | undefined;
}

export interface IssuedSession<T> {
  claims: T;
  /** A ready `Set-Cookie` value. */
  cookie: string;
  envelope: SessionEnvelope<T>;
  token: string;
}

export interface ReadSession<T> {
  claims: T;
  envelope: SessionEnvelope<T>;
  /** True once `refreshAfterMs` has passed, so `refreshCookie` is worth sending. */
  shouldRefresh: boolean;
  /**
   * A re-stamped `Set-Cookie` when `shouldRefresh`, else `null`. Attach it
   * verbatim; leaving it off only means the visitor signs in again sooner.
   *
   * It carries the claims exactly as the old cookie did. An app that revokes
   * by bumping an epoch should mint its own with `issue` instead, from the
   * epoch it just read, so a revoke racing a refresh cannot be re-stamped
   * into the future.
   */
  refreshCookie: string | null;
}

export interface SessionCookie<T> {
  issue(claims: T): Promise<IssuedSession<T>>;
  /** `null` for not signed in, for every reason: no cookie, a bad one, an expired one. */
  read(request: {
    headers: { get(name: string): string | null };
  }): Promise<ReadSession<T> | null>;
  /** A `Set-Cookie` that signs the visitor out. */
  clear(): string;
  /** The raw cookie value, for a caller that wants to verify it itself. */
  token(request: {
    headers: { get(name: string): string | null };
  }): string | undefined;
}

/**
 * A signed session cookie with a sliding expiry: mint one, read it back, and
 * get a re-stamped cookie once it is far enough through its life.
 *
 * Nothing is stored server side, so there is no list of live sessions to read
 * or write on the hot path. The flip side is that a signed cookie cannot be
 * taken back before it expires. The usual answer is an epoch: keep a counter
 * on the user, put it in the claims, and compare the two in the read you
 * already do for that user. Bumping the counter is then a fleet-wide sign-out.
 *
 *     const session = sessionCookie<{ uid: string; ep: number }>({
 *       name: "__Host-session",
 *       secret: env.SESSION_SECRET,
 *       check: (c) => SessionClaims.safeParse(c).data,
 *     });
 *
 *     const found = await session.read(request);
 *     const user = found && (await getUser(found.claims.uid));
 *     if (!user || user.epoch !== found.claims.ep) return signedOut();
 */
export function sessionCookie<T>(
  options: SessionCookieOptions<T>,
): SessionCookie<T> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const refreshAfterMs = options.refreshAfterMs ?? Math.floor(ttlMs / 6);
  const now = options.now ?? (() => Date.now());
  // `maxAge` and `expires` come from `ttlMs`, so an override of either is
  // dropped rather than shipped beside the one this computes.
  const { maxAge: _maxAge, expires: _expires, ...given } = options.cookie ?? {};
  const attributes: CookieOptions = {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    ...given,
  };

  const envelope = (claims: T): SessionEnvelope<T> => {
    const issuedAt = now();
    return { d: claims, iat: issuedAt, exp: issuedAt + ttlMs };
  };

  const write = (token: string): string =>
    serializeCookie(options.name, token, {
      ...attributes,
      maxAge: Math.floor(ttlMs / 1000),
    });

  const secretOrNull = (): string | null => {
    if (options.secret) {
      return options.secret;
    }
    options.onError?.(
      new Error(
        `No secret for the ${options.name} cookie, refusing every session.`,
      ),
    );
    return null;
  };

  const checkEnvelope = (payload: unknown): SessionEnvelope<T> | null => {
    if (typeof payload !== "object" || payload === null) {
      return null;
    }
    const { d, iat, exp } = payload as Partial<SessionEnvelope<unknown>>;
    if (typeof iat !== "number" || typeof exp !== "number") {
      return null;
    }
    if (exp <= now()) {
      return null;
    }
    const claims = options.check ? options.check(d) : (d as T);
    if (claims === null || claims === undefined) {
      return null;
    }
    return { d: claims, iat, exp };
  };

  return {
    async issue(claims) {
      const secret = options.secret;
      if (!secret) {
        throw new Error(`No secret for the ${options.name} cookie.`);
      }
      const made = envelope(claims);
      const token = await signValue(secret, made);
      return { claims, cookie: write(token), envelope: made, token };
    },

    token(request) {
      return readCookie(request, options.name);
    },

    async read(request) {
      const secret = secretOrNull();
      if (secret === null) {
        return null;
      }
      const token = readCookie(request, options.name);
      const found = await verifyValue(secret, token, checkEnvelope);
      if (found === null) {
        return null;
      }
      const shouldRefresh = now() - found.iat >= refreshAfterMs;
      let refreshCookie: string | null = null;
      if (shouldRefresh) {
        refreshCookie = write(await signValue(secret, envelope(found.d)));
      }
      return {
        claims: found.d,
        envelope: found,
        refreshCookie,
        shouldRefresh,
      };
    },

    clear() {
      return clearCookie(options.name, attributes);
    },
  };
}
