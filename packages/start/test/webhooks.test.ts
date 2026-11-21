import { describe, expect, it, vi } from "vitest";
import {
  timingSafeEqual,
  verifyDiscord,
  verifyHmac,
  verifySvix,
} from "../src/webhooks.js";

const NOW = Date.UTC(2026, 10, 20, 12);
const now = () => NOW;
const NOW_S = NOW / 1000;
const encoder = new TextEncoder();

const hex = (data: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(data), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
const b64 = (data: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(data)));

// A body whose exact bytes matter: odd spacing, key order and non-ASCII.
const BODY = '{"type":1,  "b":2,"a":"café ✓"}\n';

function post(body: string, headers: Record<string, string>): Request {
  return new Request("https://example.com/hook", {
    method: "POST",
    headers,
    body,
  });
}

async function discordKeys() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = hex(await crypto.subtle.exportKey("raw", pair.publicKey));
  const sign = async (timestamp: string, body: string) =>
    hex(
      await crypto.subtle.sign(
        "Ed25519",
        pair.privateKey,
        encoder.encode(timestamp + body),
      ),
    );
  return { publicKey, sign };
}

async function discordRequest(
  sign: (timestamp: string, body: string) => Promise<string>,
  options: { body?: string; sentBody?: string; timestamp?: number } = {},
) {
  const body = options.body ?? BODY;
  const timestamp = String(options.timestamp ?? NOW_S);
  return post(options.sentBody ?? body, {
    "x-signature-ed25519": await sign(timestamp, body),
    "x-signature-timestamp": timestamp,
  });
}

describe("verifyDiscord", () => {
  it("returns the raw body for a valid signature", async () => {
    const { publicKey, sign } = await discordKeys();
    const body = await verifyDiscord(await discordRequest(sign), publicKey, {
      now,
    });
    expect(body).toBe(BODY);
  });

  it("refuses a tampered body", async () => {
    const { publicKey, sign } = await discordKeys();
    const request = await discordRequest(sign, {
      sentBody: BODY.replace("1", "2"),
    });
    expect(await verifyDiscord(request, publicKey, { now })).toBeNull();
  });

  it("refuses a signature from another key", async () => {
    const { publicKey } = await discordKeys();
    const other = await discordKeys();
    const request = await discordRequest(other.sign);
    expect(await verifyDiscord(request, publicKey, { now })).toBeNull();
  });

  it("refuses stale and future timestamps outside the window", async () => {
    const { publicKey, sign } = await discordKeys();
    for (const timestamp of [NOW_S - 301, NOW_S + 301]) {
      const request = await discordRequest(sign, { timestamp });
      expect(await verifyDiscord(request, publicKey, { now })).toBeNull();
    }
    const edge = await discordRequest(sign, { timestamp: NOW_S - 300 });
    expect(await verifyDiscord(edge, publicKey, { now })).toBe(BODY);
    const tight = await discordRequest(sign, { timestamp: NOW_S - 30 });
    expect(
      await verifyDiscord(tight, publicKey, { now, toleranceSeconds: 10 }),
    ).toBeNull();
  });

  it("refuses missing headers and malformed hex", async () => {
    const { publicKey, sign } = await discordKeys();
    const sig = await sign(String(NOW_S), BODY);
    const cases: Record<string, string>[] = [
      {},
      { "x-signature-ed25519": sig },
      { "x-signature-timestamp": String(NOW_S) },
      {
        "x-signature-ed25519": `${sig.slice(0, -1)}z`,
        "x-signature-timestamp": String(NOW_S),
      },
      {
        "x-signature-ed25519": sig.slice(0, -2),
        "x-signature-timestamp": String(NOW_S),
      },
      { "x-signature-ed25519": sig, "x-signature-timestamp": "soon" },
    ];
    for (const headers of cases) {
      expect(
        await verifyDiscord(post(BODY, headers), publicKey, { now }),
      ).toBeNull();
    }
  });

  it("gives null and calls onError for a missing or malformed key", async () => {
    const { sign } = await discordKeys();
    for (const key of [
      undefined,
      "",
      "abc",
      "zz".repeat(32),
      "ab".repeat(31),
    ]) {
      const onError = vi.fn();
      const request = await discordRequest(sign);
      expect(await verifyDiscord(request, key, { now, onError })).toBeNull();
      expect(onError).toHaveBeenCalledOnce();
    }
  });

  it("does not call onError for a forged request", async () => {
    const { publicKey } = await discordKeys();
    const other = await discordKeys();
    const onError = vi.fn();
    await verifyDiscord(await discordRequest(other.sign), publicKey, {
      now,
      onError,
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("gives null for a body that was already read", async () => {
    const { publicKey, sign } = await discordKeys();
    const request = await discordRequest(sign);
    await request.text();
    expect(await verifyDiscord(request, publicKey, { now })).toBeNull();
  });
});

async function hmac(
  secret: string,
  hash: "SHA-256" | "SHA-512" | "SHA-1",
  text: string,
) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, encoder.encode(text));
}

describe("verifyHmac", () => {
  const secret = "whk_test_signing_key";

  it("verifies an Alchemy style hex SHA-256 signature", async () => {
    const request = post(BODY, {
      "x-alchemy-signature": hex(await hmac(secret, "SHA-256", BODY)),
    });
    const body = await verifyHmac(request, {
      secret,
      header: "x-alchemy-signature",
      algorithm: "SHA-256",
      encoding: "hex",
    });
    expect(body).toBe(BODY);
  });

  it("verifies a Neynar style hex SHA-512 signature in upper case", async () => {
    const request = post(BODY, {
      "X-Neynar-Signature": hex(
        await hmac(secret, "SHA-512", BODY),
      ).toUpperCase(),
    });
    const body = await verifyHmac(request, {
      secret,
      header: "X-Neynar-Signature",
      algorithm: "SHA-512",
      encoding: "hex",
    });
    expect(body).toBe(BODY);
  });

  it("verifies a GitHub signature after its prefix and needs the prefix", async () => {
    const sig = hex(await hmac(secret, "SHA-256", BODY));
    const options = {
      secret,
      header: "x-hub-signature-256",
      algorithm: "SHA-256",
      encoding: "hex",
      prefix: "sha256=",
    } as const;
    const good = post(BODY, { "x-hub-signature-256": `sha256=${sig}` });
    expect(await verifyHmac(good, options)).toBe(BODY);
    const bare = post(BODY, { "x-hub-signature-256": sig });
    expect(await verifyHmac(bare, options)).toBeNull();
  });

  it("verifies base64 and SHA-1", async () => {
    const request = post(BODY, {
      "x-sig": b64(await hmac(secret, "SHA-1", BODY)),
    });
    const body = await verifyHmac(request, {
      secret,
      header: "x-sig",
      algorithm: "SHA-1",
      encoding: "base64",
    });
    expect(body).toBe(BODY);
  });

  it("refuses a tampered body, a wrong secret and another algorithm", async () => {
    const sig = hex(await hmac(secret, "SHA-256", BODY));
    const options = {
      secret,
      header: "x-sig",
      algorithm: "SHA-256",
      encoding: "hex",
    } as const;
    expect(
      await verifyHmac(post(`${BODY} `, { "x-sig": sig }), options),
    ).toBeNull();
    expect(
      await verifyHmac(post(BODY, { "x-sig": sig }), {
        ...options,
        secret: "another",
      }),
    ).toBeNull();
    expect(
      await verifyHmac(post(BODY, { "x-sig": sig }), {
        ...options,
        algorithm: "SHA-512",
      }),
    ).toBeNull();
  });

  it("refuses a missing header and malformed hex or base64", async () => {
    const sig = await hmac(secret, "SHA-256", BODY);
    const hexOptions = {
      secret,
      header: "x-sig",
      algorithm: "SHA-256",
      encoding: "hex",
    } as const;
    const base64Options = { ...hexOptions, encoding: "base64" } as const;
    expect(await verifyHmac(post(BODY, {}), hexOptions)).toBeNull();
    for (const value of [`${hex(sig)}0`, `${hex(sig).slice(2)}zz`, ""]) {
      expect(
        await verifyHmac(post(BODY, { "x-sig": value }), hexOptions),
      ).toBeNull();
    }
    for (const value of [`${b64(sig)}!`, "a", "===="]) {
      expect(
        await verifyHmac(post(BODY, { "x-sig": value }), base64Options),
      ).toBeNull();
    }
  });

  it("checks a signed timestamp against the window", async () => {
    const signedPayload = (body: string, timestamp: string) =>
      `v0:${timestamp}:${body}`;
    const options = {
      secret,
      header: "x-sig",
      algorithm: "SHA-256",
      encoding: "hex",
      timestampHeader: "x-timestamp",
      signedPayload,
      now,
    } as const;
    const at = async (timestamp: number, sentTimestamp = timestamp) =>
      post(BODY, {
        "x-sig": hex(
          await hmac(secret, "SHA-256", signedPayload(BODY, String(timestamp))),
        ),
        "x-timestamp": String(sentTimestamp),
      });
    expect(await verifyHmac(await at(NOW_S), options)).toBe(BODY);
    expect(await verifyHmac(await at(NOW_S - 301), options)).toBeNull();
    expect(await verifyHmac(await at(NOW_S + 301), options)).toBeNull();
    // A fresh timestamp swapped onto an old signature fails the signature.
    expect(await verifyHmac(await at(NOW_S - 60, NOW_S), options)).toBeNull();
    const noTimestamp = post(BODY, {
      "x-sig": hex(await hmac(secret, "SHA-256", BODY)),
    });
    expect(await verifyHmac(noTimestamp, options)).toBeNull();
  });

  it("gives null and calls onError for a missing secret", async () => {
    const sig = hex(await hmac(secret, "SHA-256", BODY));
    for (const missing of [undefined, null, ""]) {
      const onError = vi.fn();
      const body = await verifyHmac(post(BODY, { "x-sig": sig }), {
        secret: missing,
        header: "x-sig",
        algorithm: "SHA-256",
        encoding: "hex",
        onError,
      });
      expect(body).toBeNull();
      expect(onError).toHaveBeenCalledOnce();
    }
  });
});

const SVIX_KEY = crypto.getRandomValues(new Uint8Array(24));
const SVIX_SECRET = `whsec_${b64(SVIX_KEY)}`;

async function svixSignature(
  key: Uint8Array<ArrayBuffer>,
  id: string,
  timestamp: number,
  body: string,
) {
  const k = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return `v1,${b64(await crypto.subtle.sign("HMAC", k, encoder.encode(`${id}.${timestamp}.${body}`)))}`;
}

async function svixRequest(
  options: {
    key?: Uint8Array<ArrayBuffer>;
    timestamp?: number;
    sentBody?: string;
    signature?: (sig: string) => string;
  } = {},
) {
  const id = "msg_2Yq8test";
  const timestamp = options.timestamp ?? NOW_S;
  const sig = await svixSignature(options.key ?? SVIX_KEY, id, timestamp, BODY);
  return post(options.sentBody ?? BODY, {
    "svix-id": id,
    "svix-timestamp": String(timestamp),
    "svix-signature": options.signature ? options.signature(sig) : sig,
  });
}

describe("verifySvix", () => {
  it("returns the raw body for a valid delivery", async () => {
    expect(await verifySvix(await svixRequest(), SVIX_SECRET, { now })).toBe(
      BODY,
    );
  });

  it("accepts a secret without the whsec_ prefix", async () => {
    expect(await verifySvix(await svixRequest(), b64(SVIX_KEY), { now })).toBe(
      BODY,
    );
  });

  it("accepts any matching entry in a list of signatures", async () => {
    const old = await svixSignature(
      crypto.getRandomValues(new Uint8Array(24)),
      "msg_2Yq8test",
      NOW_S,
      BODY,
    );
    const request = await svixRequest({
      signature: (sig) => `v2,abc ${old} v1,!!! ${sig}`,
    });
    expect(await verifySvix(request, SVIX_SECRET, { now })).toBe(BODY);
  });

  it("reads the Standard Webhooks header names", async () => {
    const sig = await svixSignature(SVIX_KEY, "msg_1", NOW_S, BODY);
    const request = post(BODY, {
      "webhook-id": "msg_1",
      "webhook-timestamp": String(NOW_S),
      "webhook-signature": sig,
    });
    expect(await verifySvix(request, SVIX_SECRET, { now })).toBe(BODY);
  });

  it("refuses a tampered body and another secret", async () => {
    const tampered = await svixRequest({ sentBody: `${BODY}x` });
    expect(await verifySvix(tampered, SVIX_SECRET, { now })).toBeNull();
    const other = await svixRequest({
      key: crypto.getRandomValues(new Uint8Array(24)),
    });
    expect(await verifySvix(other, SVIX_SECRET, { now })).toBeNull();
  });

  it("refuses stale and future timestamps", async () => {
    for (const timestamp of [NOW_S - 301, NOW_S + 301]) {
      const request = await svixRequest({ timestamp });
      expect(await verifySvix(request, SVIX_SECRET, { now })).toBeNull();
    }
  });

  it("refuses missing headers and malformed signatures", async () => {
    const full = await svixRequest();
    for (const name of ["svix-id", "svix-timestamp", "svix-signature"]) {
      const headers = new Headers(full.headers);
      headers.delete(name);
      expect(
        await verifySvix(post(BODY, Object.fromEntries(headers)), SVIX_SECRET, {
          now,
        }),
      ).toBeNull();
    }
    for (const signature of [
      (sig: string) => sig.replace("v1,", "v1;"),
      (sig: string) => `${sig}!`,
      () => "v1,",
      (sig: string) => sig.replace("v1,", "v0,"),
    ]) {
      const request = await svixRequest({ signature });
      expect(await verifySvix(request, SVIX_SECRET, { now })).toBeNull();
    }
  });

  it("gives null and calls onError for a missing or malformed secret", async () => {
    for (const secret of [undefined, "", "whsec_", "whsec_not base64!"]) {
      const onError = vi.fn();
      expect(
        await verifySvix(await svixRequest(), secret, { now, onError }),
      ).toBeNull();
      expect(onError).toHaveBeenCalledOnce();
    }
  });
});

describe("timingSafeEqual", () => {
  it("compares strings and bytes", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("é", new Uint8Array([0xc3, 0xa9]))).toBe(true);
    expect(
      timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3])),
    ).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });
});

describe("a body past the cap", () => {
  /** A chunked body with no content-length, counting how much was pulled. */
  const streamed = (total: number) => {
    const chunk = new Uint8Array(64 * 1024);
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= total) {
          controller.close();
          return;
        }
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    return { body, pulled: () => pulled };
  };

  it("is refused without being read to the end, and without calling onError", async () => {
    const onError = vi.fn();
    const big = streamed(8 * 1024 * 1024);
    const request = new Request("https://x.test/hook", {
      method: "POST",
      body: big.body,
      headers: {
        "svix-id": "msg_1",
        "svix-timestamp": String(NOW_S),
        "svix-signature": "v1,AAAA",
      },
      duplex: "half",
    } as RequestInit);
    expect(await verifySvix(request, SVIX_SECRET, { now, onError })).toBeNull();
    expect(big.pulled()).toBeLessThanOrEqual(1024 * 1024 + 2 * 64 * 1024);
    expect(onError).not.toHaveBeenCalled();
  });

  it("reads a body under a raised cap", async () => {
    const request = await svixRequest();
    expect(
      await verifySvix(request, SVIX_SECRET, { now, maxBytes: 10 }),
    ).toBeNull();
    expect(await verifySvix(await svixRequest(), SVIX_SECRET, { now })).toBe(
      BODY,
    );
  });
});
