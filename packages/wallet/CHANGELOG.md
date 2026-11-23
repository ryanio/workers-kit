# Changelog

## 0.3.1 (2026-11-23)

- `viem` is an optional peer, so an app that imports only `workers-wallet/address` does not get viem and its dependencies in its lockfile. An app that checks signatures installs viem itself, as the README already says.

## 0.3.0 (2026-11-23)

- `shortAddress(value, { head, tail, ellipsis })` writes "0x49a3…d2b2" (6 and 4 by default), and leaves a value too short to shorten whole. It is on the root and on `workers-wallet/address`, which imports no viem, for a page that only shows addresses.

## 0.2.0 (2026-11-21)

- `checkSiwe`'s `uri` takes a string or a list, and both sides are normalised before the compare: scheme and host lowercased, a trailing slash and a default port dropped. An app can allow its www and bare hosts.
- README: a test fake chain must answer `eth_chainId`.
- `rpcSignatureClient(request)`: a `SignatureClient` on an app's own JSON-RPC function `(method, params) => Promise<result>`. It is a viem client with a `custom` transport that does not retry, with viem's own `verifyMessage` and `getChainId`, so ERC-1271, ERC-6492 and the down-RPC check work without a viem `PublicClient`.

## 0.1.1 (2026-11-21)

- `verifyWalletSignature` answers undefined, not false, when the RPC is down: viem's `verifyMessage` reports a failed call as false, so a false is checked against `client.getChainId()` (a viem `PublicClient` has it) and an unanswered chain means the check did not happen.

## 0.1.0 (2026-11-20)

- `verifyWalletSignature({ client?, address, message, signature, timeoutMs? })`: `true` when the signature recovers to the address (no network), otherwise the client's ERC-1271 or ERC-6492 answer, and `undefined` when the RPC throws or takes longer than `timeoutMs` (default 5000).
- `parseSiwe(message)`: the EIP-4361 fields through viem's `parseSiweMessage`, or `null` for a message missing a required field or with a date that is not RFC 3339.
- `checkSiwe(fields, { domain, nonce?, uri?, chainId?, now?, skewMs? })`: checks the domain, URI, chain, nonce, Expiration Time, Not Before and Issued At, and names the first that fails.
- `verifySiwe(options)`: parses, checks, then verifies the signature, so smart wallets sign in like plain accounts, with `malformed`, `signature` and `unavailable` as further reasons.
