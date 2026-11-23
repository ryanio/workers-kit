/**
 * Cookies on plain `Request` and `Response` objects, with no framework in the
 * middle.
 *
 * Reading a cookie never throws: a header that is absent, truncated or holds a
 * value that is not valid percent-encoding comes back as `undefined` or as the
 * raw text, because the browser sent it and the route still has to answer.
 *
 * Writing one is a string you put in `Set-Cookie`. `clearCookie` is the same
 * attributes with an empty value and a past expiry, which is the only way a
 * browser drops one: it matches on name, domain and path, so a clear whose
 * attributes differ from the cookie's leaves it in place.
 */

export interface CookieOptions {
  /** Default `/`, so one cookie covers the whole site. */
  path?: string | undefined;
  /** Leave it out for a host-only cookie. `.example.com` covers subdomains. */
  domain?: string | undefined;
  /** Seconds. A browser that honours it ignores `expires`. */
  maxAge?: number | undefined;
  expires?: Date | undefined;
  httpOnly?: boolean | undefined;
  secure?: boolean | undefined;
  /**
   * `lax` is almost always the one you want for a session: `strict` withholds
   * the cookie on the top-level cross-site navigation that an OAuth callback
   * or a deep link back from another app is, so a `strict` session cookie
   * reads as a broken sign-in rather than a tightened one. `none` requires
   * `secure`.
   */
  sameSite?: "lax" | "strict" | "none" | undefined;
  /** `__Host-` and `__Secure-` prefixes are the browser-enforced version of these flags. */
  partitioned?: boolean | undefined;
}

/**
 * Every cookie in a `Cookie` header, percent-decoded. When a name appears
 * twice the first value wins, as in `readCookie`: browsers send the cookie
 * with the longest path first, and a sibling subdomain can only add a second
 * one after it, so reading the last would let it override the real one.
 */
export function parseCookies(
  header: string | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) {
    return out;
  }
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const name = part.slice(0, eq).trim();
    if (name === "") {
      continue;
    }
    if (!Object.hasOwn(out, name)) {
      out[name] = decode(part.slice(eq + 1).trim());
    }
  }
  return out;
}

/**
 * One cookie from a request's `Cookie` header, or `undefined` when the header
 * or the cookie is absent. An empty value reads as `undefined` too, since that
 * is what a cleared cookie looks like on the way back.
 */
export function readCookie(
  request: { headers: { get(name: string): string | null } },
  name: string,
): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1 || part.slice(0, eq).trim() !== name) {
      continue;
    }
    const value = decode(part.slice(eq + 1).trim());
    return value === "" ? undefined : value;
  }
  return undefined;
}

/** RFC 6265's cookie-name: a token, so no controls, spaces or separators. */
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** An attribute value cannot carry a `;` or a control character. */
const COOKIE_ATTRIBUTE = /^[\u0020-\u003A\u003C-\u007E]*$/;

/**
 * A `Set-Cookie` header value. The value is percent-encoded, so it may hold
 * anything; `readCookie` and `parseCookies` decode it back.
 *
 * The name and the attributes are not encoded, because encoding them would
 * change what they mean, so a name or a `path` carrying a `;` throws instead:
 * it could otherwise append attributes of its own (a `Domain` widening the
 * cookie, say). Both are developer constants in every sane use, so a throw at
 * first call is the right place to find out.
 */
export function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions = {},
): string {
  if (!COOKIE_NAME.test(name)) {
    throw new TypeError(
      `serializeCookie: ${JSON.stringify(name)} is not a valid cookie name`,
    );
  }
  const path = options.path ?? "/";
  for (const [field, text] of [
    ["path", path],
    ["domain", options.domain ?? ""],
  ] as const) {
    if (!COOKIE_ATTRIBUTE.test(text)) {
      throw new TypeError(
        `serializeCookie: ${field} ${JSON.stringify(text)} cannot go in a Set-Cookie header`,
      );
    }
  }
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`];
  if (options.domain) {
    parts.push(`Domain=${options.domain}`);
  }
  if (options.expires) {
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  }
  if (options.secure) {
    parts.push("Secure");
  }
  if (options.httpOnly) {
    parts.push("HttpOnly");
  }
  if (options.sameSite) {
    parts.push(
      `SameSite=${options.sameSite.charAt(0).toUpperCase()}${options.sameSite.slice(1)}`,
    );
  }
  if (options.partitioned) {
    parts.push("Partitioned");
  }
  return parts.join("; ");
}

/**
 * A `Set-Cookie` value that drops `name`. Pass the same `path`, `domain` and
 * `partitioned` the cookie was written with: a browser matches on those, and a
 * clear that does not match them does nothing.
 */
export function clearCookie(name: string, options: CookieOptions = {}): string {
  return serializeCookie(name, "", {
    ...options,
    maxAge: 0,
    expires: new Date(0),
  });
}

/**
 * Adds one `Set-Cookie` to a response without dropping any already on it.
 * A response whose headers are immutable (`Response.redirect`, a `fetch`
 * answer) comes back as a copy, so use the returned response.
 */
export function appendCookie(response: Response, cookie: string): Response {
  try {
    response.headers.append("set-cookie", cookie);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    headers.append("set-cookie", cookie);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

function decode(value: string): string {
  if (!value.includes("%")) {
    return value;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
