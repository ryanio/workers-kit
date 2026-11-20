## Webhooks

`workers-start/webhooks` checks signed webhooks on WebCrypto, with no SDK: Discord interactions (Ed25519), plain HMAC signatures (Alchemy, Neynar, GitHub and most others) and Svix (Resend, and any Standard Webhooks sender).

```ts
import { verifyDiscord, verifyHmac, verifySvix } from "workers-start/webhooks";

const onError = (error: Error) => console.error("webhook secret", error);

// Discord interactions
const interaction = await verifyDiscord(request, env.DISCORD_PUBLIC_KEY, { onError });
if (interaction === null) return new Response("bad signature", { status: 401 });
const payload = JSON.parse(interaction);

// Alchemy: hex HMAC-SHA256 of the body
const activity = await verifyHmac(request, {
  secret: env.ALCHEMY_SIGNING_KEY,
  header: "x-alchemy-signature",
  algorithm: "SHA-256",
  encoding: "hex",
  onError,
});

// GitHub: the same, after a "sha256=" prefix
const push = await verifyHmac(request, {
  secret: env.GITHUB_WEBHOOK_SECRET,
  header: "x-hub-signature-256",
  algorithm: "SHA-256",
  encoding: "hex",
  prefix: "sha256=",
});

// Resend, through Svix
const event = await verifySvix(request, env.RESEND_WEBHOOK_SECRET, { onError }); // whsec_...
```

- Each check reads the raw body once and returns it as text when the signature holds, or null when it does not. Parse the returned text, not the request: the signature is over the exact bytes sent, and the body can only be read once.
- Bad input (a missing header, malformed hex or base64, a wrong signature, a stale timestamp) is a null, never a throw. Every comparison runs in constant time, and `timingSafeEqual(a, b)` is exported for strings or bytes.
- A missing or malformed secret or key also gives null, and calls `onError`. A forged request never does, so a secret pasted with a stray character shows up in the logs instead of looking like an attacker being turned away.
- Answer null with 401, never 500. Senders retry a 5xx, so a 500 makes a forged or stale request come back again and again.
- `verifyDiscord` checks `X-Signature-Ed25519` over `X-Signature-Timestamp` plus the body, and refuses a timestamp more than `toleranceSeconds` (default 300) from the clock either way, so a captured request cannot be replayed.
- `verifySvix` reads `svix-id`, `svix-timestamp` and `svix-signature` (or the `webhook-*` names of Standard Webhooks), accepts any `v1` entry in the space separated list, which is how Svix rotates secrets, and has the same 300 second window. The secret may have its `whsec_` prefix or not.
- `verifyHmac` takes `algorithm` (`SHA-256`, `SHA-512` or `SHA-1`), `encoding` (`hex`, read in any case, or `base64`) and an optional `prefix`. Neynar is `{ header: "x-neynar-signature", algorithm: "SHA-512", encoding: "hex" }`. For a sender that signs a timestamp too, give `timestampHeader` and `signedPayload: (body, timestamp) => string` (Slack is `` `v0:${timestamp}:${body}` ``); the window is only worth anything when the timestamp is part of what was signed.
- `toleranceSeconds` and `now` (milliseconds since the epoch) set the window and the clock, for tests or a sender with a window of its own. On `verifyHmac` they apply only with `timestampHeader`.
