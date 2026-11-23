# AGENTS.md

`workers-wallet` is a TypeScript library for wallet signature checks and Sign-In with Ethereum on Cloudflare Workers, built on `viem`. The README is the user guide. This file is for agents changing the package; the repo's [AGENTS.md](../../AGENTS.md) has the commands, hooks and release steps shared by every package.

## Layout

- `src/signature.ts`: `verifyWalletSignature`, `rpcSignatureClient` and the `SignatureClient` type.
- `src/siwe.ts`: `parseSiwe`, `checkSiwe` and `verifySiwe`.
- `src/address.ts`: `shortAddress`, the `workers-wallet/address` entry, which imports no viem.
- `src/index.ts`: the root entry, everything.
- `test/signature.test.ts`, `test/siwe.test.ts`: generated keys sign through `privateKeyToAccount`, and a fake `verifyMessage` stands in for the chain. `rpcSignatureClient` tests answer `eth_call` and `eth_chainId` from a fake request function. No test touches the network.

## Rules

- Consumers: coral, flock, glyphbots, musegod and wompworld (all in `~/dev`). Before adding a feature, search them for hand-rolled versions of it; after a release, move them onto it.
- `viem` is the only peer dependency. No runtime dependencies of its own.
- `undefined` from `verifyWalletSignature` means the chain could not answer, and `false` means it answered no. Keep the two apart: callers map them to 503 and 403. Turning one into the other is a breaking change.
- A plain account's signature never calls the client. Only a signature that does not recover to the address goes to the chain.
