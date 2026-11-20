# AGENTS.md

`workers-wallet` is a TypeScript library for wallet signature checks and Sign-In with Ethereum on Cloudflare Workers, built on `viem`. The README is the user guide. This file is for agents changing the package; the repo's [AGENTS.md](../../AGENTS.md) has the commands, hooks and release steps shared by every package.

## Layout

- `src/signature.ts`: `verifyWalletSignature` and the `SignatureClient` type.
- `src/siwe.ts`: `parseSiwe`, `checkSiwe` and `verifySiwe`.
- `src/index.ts`: the only entry point.
- `test/signature.test.ts`, `test/siwe.test.ts`: generated keys sign through `privateKeyToAccount`, and a fake `verifyMessage` stands in for the chain. No test touches the network.

## Rules

- Consumers: none yet. The apps with hand-rolled copies to move onto it, all in `~/dev`: flock (`apps/site/src/claims.ts`), coral (`packages/worker/src/lib/wallet-signature.ts`), musegod (`apps/web/src/terrakin.ts`), glyphbots (`apps/site/src/shared/utils/siwe.ts`).
- `viem` is the only peer dependency. No runtime dependencies of its own.
- `undefined` from `verifyWalletSignature` means the chain could not answer, and `false` means it answered no. Keep the two apart: callers map them to 503 and 403. Turning one into the other is a breaking change.
- A plain account's signature never calls the client. Only a signature that does not recover to the address goes to the chain.
- The package is `"private": true` until the npm name has a trusted publisher (see the repo's Releases section).
