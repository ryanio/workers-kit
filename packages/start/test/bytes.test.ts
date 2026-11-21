/**
 * The encodings, checked against fixed vectors rather than against each other,
 * because a round trip through one broken pair of functions agrees with itself.
 */
import { describe, expect, it } from "vitest";
import {
  fromBase64,
  fromBase64Url,
  fromHex,
  fromUtf8,
  hmacSha256,
  randomBytes,
  randomHex,
  randomId,
  sha256Base64Url,
  sha256Hex,
  timingSafeEqual,
  toBase64,
  toBase64Url,
  toHex,
  utf8,
} from "../src/bytes.js";

const bytes = (...values: number[]) => new Uint8Array(values);

describe("hex", () => {
  it("writes two lowercase characters a byte", () => {
    expect(toHex(bytes(0, 15, 16, 255))).toBe("000f10ff");
  });

  it("reads either case back", () => {
    expect(fromHex("000F10ff")).toEqual(bytes(0, 15, 16, 255));
  });

  it("refuses an odd length or a non-hex character", () => {
    expect(fromHex("abc")).toBeUndefined();
    expect(fromHex("zz")).toBeUndefined();
    expect(fromHex("ab cd")).toBeUndefined();
  });
});

describe("base64", () => {
  // The three remainders, which is where a padding bug shows up.
  it.each([
    [bytes(), "", ""],
    [bytes(102), "Zg==", "Zg"],
    [bytes(102, 111), "Zm8=", "Zm8"],
    [bytes(102, 111, 111), "Zm9v", "Zm9v"],
  ])("encodes %j", (input, base64, base64url) => {
    expect(toBase64(input)).toBe(base64);
    expect(toBase64Url(input)).toBe(base64url);
  });

  it("uses the URL-safe alphabet and no padding", () => {
    // 0xfb 0xff encodes to "+/8=" in standard base64.
    const input = bytes(0xfb, 0xff, 0xbf);
    expect(toBase64(input)).toBe("+/+/");
    expect(toBase64Url(input)).toBe("-_-_");
  });

  it("reads base64url with or without its padding", () => {
    expect(fromBase64Url("-_-_")).toEqual(bytes(0xfb, 0xff, 0xbf));
    expect(fromBase64Url("Zg")).toEqual(bytes(102));
    expect(fromBase64Url("Zg==")).toEqual(bytes(102));
  });

  it("refuses standard base64 where base64url is expected", () => {
    // Accepting "+/+/" here would decode a token to bytes nobody signed.
    expect(fromBase64Url("+/+/")).toBeUndefined();
  });

  it("refuses a length no base64 can be, and a stray character", () => {
    expect(fromBase64("Zm9va")).toBeUndefined();
    expect(fromBase64Url("Zm9va")).toBeUndefined();
    expect(fromBase64("Zm9v!")).toBeUndefined();
    expect(fromBase64Url("Zm9v$")).toBeUndefined();
  });
});

describe("utf8", () => {
  it("round trips text outside the BMP", () => {
    expect(fromUtf8(utf8("héllo 🌊"))).toBe("héllo 🌊");
  });

  it("replaces an invalid sequence instead of throwing", () => {
    expect(fromUtf8(bytes(0xff, 0xfe))).toBe("��");
  });
});

describe("digests", () => {
  // NIST FIPS 180-4, the SHA-256 digest of "abc".
  const ABC =
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

  it("matches the published digest of abc", async () => {
    await expect(sha256Hex("abc")).resolves.toBe(ABC);
    await expect(sha256Hex(utf8("abc"))).resolves.toBe(ABC);
  });

  it("writes the same digest as base64url", async () => {
    await expect(sha256Base64Url("abc")).resolves.toBe(
      toBase64Url(fromHex(ABC) as Uint8Array),
    );
  });

  it("matches RFC 4231 test case 2 for HMAC-SHA256", async () => {
    const mac = await hmacSha256("Jefe", "what do ya want for nothing?");
    expect(toHex(mac)).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("takes a byte-array key, so a decoded secret needs no re-encoding", async () => {
    const text = await hmacSha256("Jefe", "x");
    const raw = await hmacSha256(utf8("Jefe"), utf8("x"));
    expect(toHex(raw)).toBe(toHex(text));
  });
});

describe("random", () => {
  it("returns the length asked for", () => {
    expect(randomBytes(0)).toHaveLength(0);
    expect(randomBytes(32)).toHaveLength(32);
    expect(randomHex(8)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("prefixes an id and keeps the rest hex", () => {
    expect(randomId("usr")).toMatch(/^usr_[0-9a-f]{16}$/);
    expect(randomId("sid", 16)).toMatch(/^sid_[0-9a-f]{32}$/);
  });

  it("does not repeat itself", () => {
    const seen = new Set(Array.from({ length: 50 }, () => randomHex(16)));
    expect(seen.size).toBe(50);
  });
});

describe("timingSafeEqual", () => {
  it("compares equal content across both input kinds", () => {
    expect(timingSafeEqual("secret", "secret")).toBe(true);
    expect(timingSafeEqual(utf8("secret"), "secret")).toBe(true);
  });

  it("is false for different content and for different lengths", () => {
    expect(timingSafeEqual("secret", "secrdt")).toBe(false);
    expect(timingSafeEqual("secret", "secret ")).toBe(false);
    expect(timingSafeEqual(bytes(1, 2), bytes(1, 2, 3))).toBe(false);
  });
});
