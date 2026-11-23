# workers-wallet

[![npm](https://img.shields.io/npm/v/workers-wallet?color=f38020&label=npm)](https://www.npmjs.com/package/workers-wallet) [![downloads](https://img.shields.io/npm/dm/workers-wallet?color=f38020)](https://www.npmjs.com/package/workers-wallet) [![CI](https://github.com/ryanio/workers-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/ryanio/workers-kit/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/ryanio/workers-kit/blob/main/LICENSE)

Wallet signature checks that pass plain accounts and smart wallets alike, and Sign-In with Ethereum, on [`viem`](https://viem.sh).

A plain account's signature is checked locally, with no network. A smart wallet's goes to the chain (ERC-1271 for a deployed wallet, ERC-6492 for one not deployed yet) under a timeout. When the chain cannot answer, the result says so, separately from "not signed", so a route can answer 503 instead of 403.

It has no runtime dependencies. `viem` is a peer.

## What is in it

| Export                  | For                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `verifyWalletSignature` | Whether an address signed a message: `true`, `false`, or `undefined` when the chain could not say |
| `parseSiwe`             | The EIP-4361 fields of a Sign-In with Ethereum message, or `null`                                 |
| `checkSiwe`             | Whether those fields fit this sign-in: domain, nonce, URI, chain and times                        |
| `verifySiwe`            | All three in one call                                                                             |
| `rpcSignatureClient`    | A `SignatureClient` on your own JSON-RPC function, for an app without a viem client               |
| `SignatureClient`       | The methods of a viem `PublicClient` the smart wallet check uses                                  |
| `shortAddress`          | "0x49a3…d2b2" for a person to read, also on `workers-wallet/address`, which imports no viem       |

## Install

```bash
npm install workers-wallet viem
```

## Signatures

```ts
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { verifyWalletSignature } from "workers-wallet";

const client = createPublicClient({ chain: base, transport: http(env.BASE_RPC_URL) });

const signed = await verifyWalletSignature({ client, address, message, signature });
if (signed === undefined) return new Response("Try again", { status: 503 });
if (!signed) return new Response("Not your wallet", { status: 403 });
```

The signature is first recovered locally. If it recovers to `address`, the answer is `true` and the client is never called. Otherwise the client's `verifyMessage` checks the address on the chain, which covers both ERC-1271 and ERC-6492.

- `client` is optional. Without one, only a plain account can pass, and anything else is `false`.
- `timeoutMs` (default 5000) bounds the chain check. Past it, or when the RPC throws, the answer is `undefined`. viem's `verifyMessage` reports a failed RPC call as `false`, so a `false` is checked against `client.getChainId()` (a viem `PublicClient` has it): a chain that does not answer makes the result `undefined`.
- An address that is not an address, or a signature that is not hex, is `false` without a call.
- `message` is a string or `{ raw }`, as in viem.

In tests, a fake chain has to answer `eth_chainId`: a `false` from `verifyMessage` is checked against it, and a fake that throws on unknown methods turns every refused signature into `undefined`.

The client must be on the wallet's chain: a smart wallet deployed on Base has no code on mainnet.

### Your own JSON-RPC function

An app that already sends JSON-RPC its own way (a provider with failover, a cached fetch) can wrap that function instead of building a viem client:

```ts
import { rpcSignatureClient, verifyWalletSignature } from "workers-wallet";

async function rpc(method: string, params: unknown[]) {
  const response = await fetch(env.BASE_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as {
    result?: unknown;
    error?: { message: string };
  };
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

const client = rpcSignatureClient(rpc);
const signed = await verifyWalletSignature({
  client,
  address,
  message,
  signature,
});
```

The function takes the method and its params and resolves to the call's `result`, or throws. `rpcSignatureClient` builds a viem client on it with a `custom` transport that does not retry (the timeout in `verifyWalletSignature` bounds the whole check) and gives it viem's own `verifyMessage` and `getChainId`. ERC-1271, ERC-6492 and the down-RPC check then work the same as with a `PublicClient`. The smart wallet check sends `eth_call`, and the down check sends `eth_chainId`.

## Sign-In with Ethereum

```ts
import { verifySiwe } from "workers-wallet";

const result = await verifySiwe({
  client,
  message,
  signature,
  domain: "example.com",
  nonce: await takeNonce(session),
});
if (!result.ok) {
  const status = result.reason === "unavailable" ? 503 : 401;
  return new Response(result.reason, { status });
}
const { address, chainId } = result.fields;
```

`verifySiwe` parses the message, runs `checkSiwe` on it, and only then checks the signature with `verifyWalletSignature`, so a message for another domain never costs an RPC call. A failure has one `reason`:

| `reason`           | Meaning                                                          |
| ------------------ | ---------------------------------------------------------------- |
| `malformed`        | Not a well formed EIP-4361 message                               |
| `domain`           | The domain is not one of `domain` (compared ignoring case)       |
| `uri`              | The URI is not one of `uri` (compared after normalising)         |
| `chain`            | The chain id is not in `chainId`                                 |
| `nonce`            | The nonce is not `nonce`                                         |
| `expired`          | Expiration Time is at or before `now`                            |
| `not-yet-valid`    | Not Before is after `now`                                        |
| `issued-in-future` | Issued At is more than `skewMs` (default 10 minutes) after `now` |
| `signature`        | The address did not sign the message                             |
| `unavailable`      | The chain check could not finish; the sign-in can be retried     |

The two halves work on their own too:

```ts
import { checkSiwe, parseSiwe } from "workers-wallet";

const fields = parseSiwe(message);
if (!fields) return new Response("Not a SIWE message", { status: 400 });
const check = checkSiwe(fields, {
  domain: ["example.com", "www.example.com"],
  uri: ["https://example.com/login", "https://www.example.com/login"],
  chainId: [1, 8453],
  nonce,
});
```

`uri` is one URI or a list. Both the message's URI and each allowed one are normalised before they are compared: the scheme and host are lowercased, a default port (80 for http, 443 for https) and a trailing slash are dropped. So `https://Example.com:443/login/` matches `https://example.com/login`, while another port, scheme or path does not. A URI with no host, such as a URN, is compared as written.

`parseSiwe` uses viem's `parseSiweMessage` and returns `null` when a required field (address, domain, URI, version 1, chain id, nonce, Issued At) is missing or a date is not an RFC 3339 date-time. `checkSiwe` leaves `nonce`, `uri` and `chainId` unchecked when they are not given; `now` takes a `Date` or milliseconds and defaults to the current time.

Freshness comes from the nonce. Issue one per sign-in on the server, store it, and pass it here; then delete it so the same message cannot sign in twice.

## Related

[`workers-start`](https://github.com/ryanio/workers-kit/tree/main/packages/start) has bindings, secrets and `afterResponse` for Workers apps. [`workers-api`](https://github.com/ryanio/workers-kit/tree/main/packages/api) has problem responses for the routes that answer these checks.

## License

MIT
