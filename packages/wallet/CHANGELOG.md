# Changelog

## 0.1.0 (2026-11-20)

- `verifyWalletSignature({ client?, address, message, signature, timeoutMs? })`: `true` when the signature recovers to the address (no network), otherwise the client's ERC-1271 or ERC-6492 answer, and `undefined` when the RPC throws or takes longer than `timeoutMs` (default 5000).
- `parseSiwe(message)`: the EIP-4361 fields through viem's `parseSiweMessage`, or `null` for a message missing a required field or with a date that is not RFC 3339.
- `checkSiwe(fields, { domain, nonce?, uri?, chainId?, now?, skewMs? })`: checks the domain, URI, chain, nonce, Expiration Time, Not Before and Issued At, and names the first that fails.
- `verifySiwe(options)`: parses, checks, then verifies the signature, so smart wallets sign in like plain accounts, with `malformed`, `signature` and `unavailable` as further reasons.
