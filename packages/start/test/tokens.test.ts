import { describe, expect, it, vi } from "vitest";
import { fromBase64Url, toBase64Url, utf8 } from "../src/bytes.js";
import {
  sessionCookie,
  signatureOf,
  signValue,
  verifySignature,
  verifyValue,
} from "../src/tokens.js";

const SECRET = "a-secret-nobody-else-has";

const withCookie = (header: string) =>
  new Request("https://example.com", { headers: { cookie: header } });

/** The cookie value out of a Set-Cookie string. */
const cookieValue = (cookie: string) =>
  (cookie.split(";")[0] as string).split("=").slice(1).join("=");

describe("signValue and verifyValue", () => {
  it("hands the payload back under the same secret", async () => {
    const token = await signValue(SECRET, { uid: "usr_1", roles: ["admin"] });
    await expect(verifyValue(SECRET, token)).resolves.toEqual({
      uid: "usr_1",
      roles: ["admin"],
    });
  });

  it("is base64url, so it is safe in a cookie, a path and a query", async () => {
    const token = await signValue(SECRET, { n: 1 });
    expect(token).toMatch(/^[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+$/);
  });

  it("refuses another secret", async () => {
    const token = await signValue(SECRET, { uid: "usr_1" });
    await expect(verifyValue("another-secret", token)).resolves.toBeNull();
  });

  it("refuses a payload edited after signing", async () => {
    const token = await signValue(SECRET, { uid: "usr_1" });
    const forged = `${toBase64Url(utf8('{"uid":"usr_2"}'))}.${token.split(".")[1]}`;
    await expect(verifyValue(SECRET, forged)).resolves.toBeNull();
  });

  it("refuses a signature from another payload", async () => {
    const mine = await signValue(SECRET, { uid: "usr_1" });
    const theirs = await signValue(SECRET, { uid: "usr_2" });
    const swapped = `${mine.split(".")[0]}.${theirs.split(".")[1]}`;
    await expect(verifyValue(SECRET, swapped)).resolves.toBeNull();
  });

  it.each([
    ["no secret", undefined, "whatever.whatever"],
    ["no token", SECRET, undefined],
    ["an empty token", SECRET, ""],
    ["no dot", SECRET, "justonepart"],
    ["an empty body", SECRET, ".c2ln"],
    ["an empty signature", SECRET, "eyJ9."],
    ["a third part", SECRET, "eyJ9.c2ln.extra"],
    ["a body that is not base64url", SECRET, "not+base64url.c2ln"],
    ["a body that is not JSON", SECRET, "bm90IGpzb24.c2ln"],
  ])("is null for %s", async (_what, secret, token) => {
    await expect(verifyValue(secret, token)).resolves.toBeNull();
  });

  it("runs the check only after the signature holds", async () => {
    const check = vi.fn(() => ({ ok: true }));
    await verifyValue("wrong", await signValue(SECRET, { a: 1 }), check);
    expect(check).not.toHaveBeenCalled();

    await expect(
      verifyValue(SECRET, await signValue(SECRET, { a: 1 }), check),
    ).resolves.toEqual({ ok: true });
    expect(check).toHaveBeenCalledWith({ a: 1 });
  });

  it("is null when the check rejects the payload", async () => {
    const token = await signValue(SECRET, { uid: 7 });
    await expect(
      verifyValue(SECRET, token, (p) =>
        typeof (p as { uid: unknown }).uid === "string" ? p : null,
      ),
    ).resolves.toBeNull();
  });
});

describe("signatureOf and verifySignature", () => {
  it("accepts the message it was made for and nothing else", async () => {
    const signature = await signatureOf(SECRET, "usr_1:digest");
    await expect(
      verifySignature(SECRET, "usr_1:digest", signature),
    ).resolves.toBe(true);
    await expect(
      verifySignature(SECRET, "usr_2:digest", signature),
    ).resolves.toBe(false);
    await expect(
      verifySignature("another-secret", "usr_1:digest", signature),
    ).resolves.toBe(false);
  });

  it("is false for a missing or unreadable signature", async () => {
    await expect(verifySignature(SECRET, "m", null)).resolves.toBe(false);
    await expect(verifySignature(SECRET, "m", "")).resolves.toBe(false);
    await expect(verifySignature(SECRET, "m", "not+base64url")).resolves.toBe(
      false,
    );
    await expect(verifySignature(undefined, "m", "aaaa")).resolves.toBe(false);
  });
});

describe("sessionCookie", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const start = Date.parse("2026-11-20T00:00:00Z");

  const build = (clock: { now: number }, extra = {}) =>
    sessionCookie<{ uid: string }>({
      name: "__Host-session",
      secret: SECRET,
      ttlMs: 30 * DAY,
      now: () => clock.now,
      check: (claims) =>
        typeof (claims as { uid?: unknown }).uid === "string"
          ? (claims as { uid: string })
          : null,
      ...extra,
    });

  it("issues a cookie a browser will only send back over TLS", async () => {
    const clock = { now: start };
    const { cookie } = await build(clock).issue({ uid: "usr_1" });
    expect(cookie).toContain("__Host-session=");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    // Lax, not Strict: Strict withholds the cookie on the cross-site
    // navigation every OAuth callback is.
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain(`Max-Age=${30 * 24 * 60 * 60}`);
  });

  it("reads its own cookie back", async () => {
    const clock = { now: start };
    const session = build(clock);
    const { cookie } = await session.issue({ uid: "usr_1" });
    const found = await session.read(
      withCookie(`a=1; ${cookie.split(";")[0]}`),
    );
    expect(found?.claims).toEqual({ uid: "usr_1" });
    expect(found?.envelope.exp).toBe(start + 30 * DAY);
  });

  it("reads Date.now at each call, so fake timers set after construction apply", async () => {
    const session = build({ now: 0 }, { now: undefined });
    vi.useFakeTimers({ now: start });
    try {
      const { cookie } = await session.issue({ uid: "usr_1" });
      const found = await session.read(
        withCookie(cookie.split(";")[0] as string),
      );
      expect(found?.envelope.exp).toBe(start + 30 * DAY);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is not signed in once the cookie is past its expiry", async () => {
    const clock = { now: start };
    const session = build(clock);
    const { cookie } = await session.issue({ uid: "usr_1" });
    const request = withCookie(cookie.split(";")[0] as string);

    clock.now = start + 30 * DAY - 1;
    expect(await session.read(request)).not.toBeNull();
    clock.now = start + 30 * DAY;
    expect(await session.read(request)).toBeNull();
  });

  it("re-stamps only once the refresh point has passed", async () => {
    const clock = { now: start };
    const session = build(clock);
    const { cookie } = await session.issue({ uid: "usr_1" });
    const request = withCookie(cookie.split(";")[0] as string);

    clock.now = start + 4 * DAY;
    const early = await session.read(request);
    expect(early?.shouldRefresh).toBe(false);
    expect(early?.refreshCookie).toBeNull();

    // A sixth of thirty days.
    clock.now = start + 5 * DAY;
    const due = await session.read(request);
    expect(due?.shouldRefresh).toBe(true);
    const refreshed = due?.refreshCookie as string;
    const reread = await session.read(
      withCookie(refreshed.split(";")[0] as string),
    );
    expect(reread?.claims).toEqual({ uid: "usr_1" });
    expect(reread?.envelope.exp).toBe(clock.now + 30 * DAY);
    expect(reread?.shouldRefresh).toBe(false);
  });

  it("refuses a cookie whose claims no longer fit the check", async () => {
    const clock = { now: start };
    const token = await signValue(SECRET, {
      d: { uid: 7 },
      iat: start,
      exp: start + DAY,
    });
    expect(
      await build(clock).read(withCookie(`__Host-session=${token}`)),
    ).toBeNull();
  });

  it("refuses an envelope with no expiry at all", async () => {
    const clock = { now: start };
    const token = await signValue(SECRET, { d: { uid: "usr_1" } });
    expect(
      await build(clock).read(withCookie(`__Host-session=${token}`)),
    ).toBeNull();
  });

  it("clears with the same attributes, so the browser matches it", async () => {
    const clock = { now: start };
    const cleared = build(clock, {
      cookie: { domain: ".example.com" },
    }).clear();
    expect(cleared).toContain("Domain=.example.com");
    expect(cleared).toContain("Max-Age=0");
    expect(cookieValue(cleared)).toBe("");
  });

  it("sets the expiry from ttlMs, whatever the caller's cookie options say", async () => {
    const clock = { now: start };
    // Shipping an Expires beside the computed Max-Age is how a session cookie
    // ends up dying in a browser that honours the older attribute.
    const { cookie } = await build(clock, {
      cookie: { expires: new Date(0), maxAge: 5 },
    }).issue({ uid: "usr_1" });
    expect(cookie).not.toContain("Expires=");
    expect(cookie).toContain(`Max-Age=${30 * 24 * 60 * 60}`);
  });

  it("fails closed and loudly with no secret", async () => {
    const onError = vi.fn();
    const session = sessionCookie<{ uid: string }>({
      name: "s",
      secret: undefined,
      onError,
    });
    expect(await session.read(withCookie("s=anything"))).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
    await expect(session.issue({ uid: "usr_1" })).rejects.toThrow(/secret/);
  });

  it("hands over the raw cookie for a caller that verifies it itself", async () => {
    const clock = { now: start };
    const session = build(clock);
    const { cookie, token } = await session.issue({ uid: "usr_1" });
    expect(session.token(withCookie(cookie.split(";")[0] as string))).toBe(
      token,
    );
  });
});

describe("one string per payload", () => {
  // base64url has slack: padding is optional, and the last character of a
  // 32 byte MAC has spare bits, so four of them decode to the same bytes. A
  // verify on the decoded bytes would accept all of those, and an app that
  // retires a token by its string could be replayed with a variant.
  it("refuses a sibling of the signature that decodes the same", async () => {
    const ALPHABET =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const token = await signValue(SECRET, { a: 1 });
    const [body, signature] = token.split(".") as [string, string];
    const head = signature.slice(0, -1);
    // 32 bytes is 256 bits and base64url carries 258 in 43 characters, so the
    // last character has two spare bits: the four values sharing its top four
    // bits all decode to the same MAC.
    const base = ALPHABET.indexOf(signature.slice(-1)) & ~3;
    const siblings = [0, 1, 2, 3]
      .map((n) => `${head}${ALPHABET[base + n]}`)
      .filter((variant) => variant !== signature);

    expect(siblings).toHaveLength(3);
    const real = fromBase64Url(signature) as Uint8Array;
    for (const variant of siblings) {
      const bytes = fromBase64Url(variant) as Uint8Array;
      expect([...bytes]).toEqual([...real]);
      await expect(
        verifyValue(SECRET, `${body}.${variant}`),
      ).resolves.toBeNull();
    }
  });

  it("refuses a padded signature or a padded body", async () => {
    const token = await signValue(SECRET, { a: 1 });
    const [body, signature] = token.split(".") as [string, string];
    await expect(
      verifyValue(SECRET, `${body}.${signature}=`),
    ).resolves.toBeNull();
    await expect(
      verifyValue(SECRET, `${body}==.${signature}`),
    ).resolves.toBeNull();
    // The canonical one still verifies.
    await expect(verifyValue(SECRET, token)).resolves.toEqual({ a: 1 });
  });

  it("refuses a signature that is not the exact text signatureOf writes", async () => {
    const signature = await signatureOf(SECRET, "m");
    await expect(verifySignature(SECRET, "m", `${signature}=`)).resolves.toBe(
      false,
    );
    await expect(verifySignature(SECRET, "m", signature)).resolves.toBe(true);
  });

  it("throws rather than signing a payload that is not JSON", async () => {
    await expect(signValue(SECRET, undefined)).rejects.toThrow(
      /does not serialize/,
    );
    await expect(signValue(SECRET, () => {})).rejects.toThrow(
      /does not serialize/,
    );
  });
});
