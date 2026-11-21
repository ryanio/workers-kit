import { createPublicClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import {
  rpcSignatureClient,
  type SignatureClient,
  verifyWalletSignature,
} from "../src/index.js";

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

  it("is undefined when viem says false because the RPC is down", async () => {
    const down = {
      verifyMessage: async () => false,
      getChainId: async () => {
        throw new Error("fetch failed");
      },
    };
    await expect(
      verifyWalletSignature({
        client: down,
        address: wallet,
        message,
        signature: smartSignature,
      }),
    ).resolves.toBeUndefined();
    const up = { verifyMessage: async () => false, getChainId: async () => 1 };
    await expect(
      verifyWalletSignature({
        client: up,
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

describe("rpcSignatureClient", () => {
  const smartSignature = `0x${"ab".repeat(200)}` as const;
  const TRUE_WORD = `0x${"0".repeat(63)}1`;
  const FALSE_WORD = `0x${"0".repeat(64)}`;

  /** A JSON-RPC function that answers eth_chainId and eth_call from the given handlers. */
  function fakeRpc(handlers: {
    eth_call?: () => Promise<unknown>;
    eth_chainId?: () => Promise<unknown>;
  }) {
    return vi.fn(async (method: string, _params: unknown[]) => {
      const handler = handlers[method as keyof typeof handlers];
      if (!handler) throw new Error(`unexpected ${method}`);
      return handler();
    });
  }

  it("reads the chain id through the request function", async () => {
    const request = fakeRpc({ eth_chainId: async () => "0x2105" });
    await expect(rpcSignatureClient(request).getChainId()).resolves.toBe(8453);
    expect(request).toHaveBeenCalledWith("eth_chainId", []);
  });

  it("passes a smart wallet the chain vouches for, through eth_call", async () => {
    const request = fakeRpc({ eth_call: async () => TRUE_WORD });
    await expect(
      verifyWalletSignature({
        client: rpcSignatureClient(request),
        address: wallet,
        message,
        signature: smartSignature,
      }),
    ).resolves.toBe(true);
    const [method, params] = request.mock.calls[0] ?? [];
    expect(method).toBe("eth_call");
    expect(params?.[0]).toMatchObject({ data: expect.stringMatching(/^0x/) });
  });

  it("is false when the chain answers no and is up", async () => {
    const request = fakeRpc({
      eth_call: async () => FALSE_WORD,
      eth_chainId: async () => "0x1",
    });
    await expect(
      verifyWalletSignature({
        client: rpcSignatureClient(request),
        address: wallet,
        message,
        signature: smartSignature,
      }),
    ).resolves.toBe(false);
  });

  it("is undefined when the RPC is down, and does not retry", async () => {
    const down = async () => {
      throw new Error("fetch failed");
    };
    const request = fakeRpc({ eth_call: down, eth_chainId: down });
    await expect(
      verifyWalletSignature({
        client: rpcSignatureClient(request),
        address: wallet,
        message,
        signature: smartSignature,
      }),
    ).resolves.toBeUndefined();
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "eth_call",
      "eth_chainId",
    ]);
  });
});
