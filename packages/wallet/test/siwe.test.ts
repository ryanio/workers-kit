import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { type CreateSiweMessageParameters, createSiweMessage } from "viem/siwe";
import { describe, expect, it, vi } from "vitest";
import {
  type CheckSiweOptions,
  checkSiwe,
  parseSiwe,
  type SiweFields,
  verifySiwe,
} from "../src/index.js";

const account = privateKeyToAccount(generatePrivateKey());
const now = new Date("2026-11-20T12:00:00Z");

function siwe(overrides: Partial<CreateSiweMessageParameters> = {}): string {
  return createSiweMessage({
    address: account.address,
    chainId: 1,
    domain: "example.com",
    nonce: "abc12345",
    uri: "https://example.com/login",
    version: "1",
    issuedAt: now,
    ...overrides,
  });
}

function fields(
  overrides: Partial<CreateSiweMessageParameters> = {},
): SiweFields {
  const parsed = parseSiwe(siwe(overrides));
  if (!parsed) throw new Error("test message did not parse");
  return parsed;
}

const base: CheckSiweOptions = {
  domain: "example.com",
  nonce: "abc12345",
  now,
};

describe("parseSiwe", () => {
  it("reads the EIP-4361 fields", () => {
    const parsed = parseSiwe(
      siwe({
        statement: "Sign in to Example",
        expirationTime: new Date("2026-11-20T13:00:00Z"),
        resources: ["https://example.com/a"],
      }),
    );
    expect(parsed).toMatchObject({
      address: account.address,
      chainId: 1,
      domain: "example.com",
      nonce: "abc12345",
      uri: "https://example.com/login",
      version: "1",
      statement: "Sign in to Example",
      resources: ["https://example.com/a"],
    });
    expect(parsed?.issuedAt.toISOString()).toBe(now.toISOString());
    expect(parsed?.expirationTime?.toISOString()).toBe(
      "2026-11-20T13:00:00.000Z",
    );
  });

  it("is null for text that is not a SIWE message", () => {
    expect(parseSiwe("hello")).toBeNull();
    expect(parseSiwe("")).toBeNull();
  });

  it("is null when a required line is missing", () => {
    expect(parseSiwe(siwe().replace(/\nNonce: .*/, ""))).toBeNull();
    expect(parseSiwe(siwe().replace(/\nIssued At: .*/, ""))).toBeNull();
  });

  it("is null when a date is not an RFC 3339 date-time", () => {
    expect(
      parseSiwe(siwe().replace(/Issued At: .*/, "Issued At: yesterday")),
    ).toBeNull();
  });
});

describe("checkSiwe", () => {
  it("passes a message that fits", () => {
    expect(checkSiwe(fields(), base)).toEqual({ ok: true });
  });

  it("compares the domain ignoring case and takes a list", () => {
    expect(checkSiwe(fields(), { ...base, domain: "EXAMPLE.com" })).toEqual({
      ok: true,
    });
    expect(
      checkSiwe(fields(), {
        ...base,
        domain: ["www.example.com", "example.com"],
      }),
    ).toEqual({
      ok: true,
    });
  });

  it.each<
    [
      string,
      Partial<CreateSiweMessageParameters>,
      Partial<CheckSiweOptions>,
      string,
    ]
  >([
    ["another domain", { domain: "evil.com" }, {}, "domain"],
    ["another nonce", { nonce: "zzz99999" }, {}, "nonce"],
    ["another uri", {}, { uri: "https://example.com/other" }, "uri"],
    ["another chain", { chainId: 8453 }, { chainId: [1, 10] }, "chain"],
    [
      "an expired message",
      { expirationTime: new Date("2026-11-20T11:59:59Z") },
      {},
      "expired",
    ],
    [
      "a message not valid yet",
      { notBefore: new Date("2026-11-20T12:00:01Z") },
      {},
      "not-yet-valid",
    ],
    [
      "an Issued At past the skew",
      { issuedAt: new Date("2026-11-20T12:10:01Z") },
      {},
      "issued-in-future",
    ],
  ])("fails %s", (_, message, options, reason) => {
    expect(checkSiwe(fields(message), { ...base, ...options })).toEqual({
      ok: false,
      reason,
    });
  });

  it("allows an Issued At within the skew", () => {
    const ahead = fields({ issuedAt: new Date("2026-11-20T12:05:00Z") });
    expect(checkSiwe(ahead, base)).toEqual({ ok: true });
    expect(checkSiwe(ahead, { ...base, skewMs: 0 })).toEqual({
      ok: false,
      reason: "issued-in-future",
    });
  });

  it("leaves the nonce, uri and chain unchecked when they are not given", () => {
    const message = fields({ nonce: "other123", chainId: 137 });
    expect(checkSiwe(message, { domain: "example.com", now })).toEqual({
      ok: true,
    });
  });
});

describe("verifySiwe", () => {
  it("passes a message the address signed and returns its fields", async () => {
    const message = siwe();
    const signature = await account.signMessage({ message });
    const result = await verifySiwe({ ...base, message, signature });
    expect(result.ok).toBe(true);
    expect(result.ok && result.fields.address).toBe(account.address);
  });

  it("is malformed for text that is not a SIWE message", async () => {
    const signature = await account.signMessage({ message: "hi" });
    await expect(
      verifySiwe({ ...base, message: "hi", signature }),
    ).resolves.toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("fails the checks before asking the chain", async () => {
    const client = { verifyMessage: vi.fn(async () => true) };
    const message = siwe({ domain: "evil.com" });
    await expect(
      verifySiwe({
        ...base,
        client,
        message,
        signature: `0x${"ab".repeat(200)}`,
      }),
    ).resolves.toEqual({ ok: false, reason: "domain" });
    expect(client.verifyMessage).not.toHaveBeenCalled();
  });

  it("fails a signature from another key", async () => {
    const message = siwe();
    const signature = await privateKeyToAccount(
      generatePrivateKey(),
    ).signMessage({ message });
    await expect(verifySiwe({ ...base, message, signature })).resolves.toEqual({
      ok: false,
      reason: "signature",
    });
  });

  it("passes a smart wallet the client vouches for", async () => {
    const client = { verifyMessage: vi.fn(async () => true) };
    const message = siwe();
    const result = await verifySiwe({
      ...base,
      client,
      message,
      signature: `0x${"ab".repeat(200)}`,
    });
    expect(result.ok).toBe(true);
  });

  it("is unavailable when the chain check fails", async () => {
    const client = {
      verifyMessage: vi.fn(async (): Promise<boolean> => {
        throw new Error("rpc down");
      }),
    };
    await expect(
      verifySiwe({
        ...base,
        client,
        message: siwe(),
        signature: `0x${"ab".repeat(200)}`,
      }),
    ).resolves.toEqual({ ok: false, reason: "unavailable" });
  });
});
