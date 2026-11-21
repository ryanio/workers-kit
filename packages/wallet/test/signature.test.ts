import { createPublicClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { type SignatureClient, verifyWalletSignature } from "../src/index.js";

const account = privateKeyToAccount(generatePrivateKey());
const other = privateKeyToAccount(generatePrivateKey());
const wallet = "0x1111111111111111111111111111111111111111";
const message = "sign in please";

function fakeClient(answer: () => Promise<boolean>) {
  return { verifyMessage: vi.fn(answer) } satisfies SignatureClient;
}

describe("verifyWalletSignature, plain accounts", () => {
  it("passes the signer's own signature without asking the chain", async () => {
    const client = fakeClient(async () => false);
    const signature = await account.signMessage({ message });
    await expect(
      verifyWalletSignature({
        client,
        address: account.address,
        message,
        signature,
      }),
    ).resolves.toBe(true);
    expect(client.verifyMessage).not.toHaveBeenCalled();
  });

  it("matches the address ignoring case", async () => {
    const signature = await account.signMessage({ message });
    await expect(
      verifyWalletSignature({
        address: account.address.toLowerCase(),
        message,
        signature,
      }),
    ).resolves.toBe(true);
  });

  it("checks raw messages", async () => {
    const raw = { raw: "0xdeadbeef" } as const;
    const signature = await account.signMessage({ message: raw });
    await expect(
      verifyWalletSignature({
        address: account.address,
        message: raw,
        signature,
      }),
    ).resolves.toBe(true);
  });

  it("fails another key's signature when there is no client", async () => {
    const signature = await other.signMessage({ message });
    await expect(
      verifyWalletSignature({ address: account.address, message, signature }),
    ).resolves.toBe(false);
  });

  it("fails a signature of a different message", async () => {
    const signature = await account.signMessage({ message: "something else" });
    await expect(
      verifyWalletSignature({ address: account.address, message, signature }),
    ).resolves.toBe(false);
  });

  it("fails a bad address or a signature that is not hex, without asking the chain", async () => {
    const client = fakeClient(async () => true);
    const signature = await account.signMessage({ message });
    await expect(
      verifyWalletSignature({
        client,
        address: "not an address",
        message,
        signature,
      }),
    ).resolves.toBe(false);
    await expect(
      verifyWalletSignature({
        client,
        address: account.address,
        message,
        signature: "zz",
      }),
    ).resolves.toBe(false);
    expect(client.verifyMessage).not.toHaveBeenCalled();
  });
});

describe("verifyWalletSignature, smart wallets", () => {
  const smartSignature = `0x${"ab".repeat(200)}` as const;

  it("asks the client when the signature does not recover to the address", async () => {
    const client = fakeClient(async () => true);
    await expect(
      verifyWalletSignature({
        client,
        address: wallet,
        message,
        signature: smartSignature,
      }),
    ).resolves.toBe(true);
    expect(client.verifyMessage).toHaveBeenCalledWith({
      address: wallet,
      message,
      signature: smartSignature,
    });
  });

  it("asks the client about a plain signature from another key", async () => {
    const client = fakeClient(async () => true);
    const signature = await other.signMessage({ message });
    await expect(
      verifyWalletSignature({ client, address: wallet, message, signature }),
    ).resolves.toBe(true);
  });

  it("is false when the client says no", async () => {
    const client = fakeClient(async () => false);
    await expect(
      verifyWalletSignature({
        client,
        address: wallet,
        message,
        signature: smartSignature,
      }),
    ).resolves.toBe(false);
  });

  it("is undefined when the client throws", async () => {
    const client = fakeClient(async () => {
      throw new Error("HTTP request failed");
    });
    await expect(
      verifyWalletSignature({
        client,
        address: wallet,
        message,
        signature: smartSignature,
      }),
    ).resolves.toBeUndefined();
  });

  it("is undefined when the client does not answer within timeoutMs", async () => {
    const client = fakeClient(() => new Promise<boolean>(() => {}));
    await expect(
      verifyWalletSignature({
        client,
        address: wallet,
        message,
        signature: smartSignature,
        timeoutMs: 10,
      }),
    ).resolves.toBeUndefined();
  });

  it("is false without a client", async () => {
    await expect(
      verifyWalletSignature({
        address: wallet,
        message,
        signature: smartSignature,
      }),
    ).resolves.toBe(false);
  });

  it("takes a viem public client as the client", () => {
    const client: SignatureClient = createPublicClient({
      transport: http("http://127.0.0.1:1"),
    });
    expect(typeof client.verifyMessage).toBe("function");
  });
});
