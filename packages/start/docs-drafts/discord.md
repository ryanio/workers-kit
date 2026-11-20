## Discord

`workers-start/discord` is a client for Discord's REST API (v10) on `fetch`, and the responses a Worker answers interactions with.

```ts
import { deferred, discordRest, pong } from "workers-start/discord";

const discord = discordRest({ token: env.DISCORD_BOT_TOKEN });

await discord.post(`/channels/${channelId}/messages`, { content: "gm" });
await discord.put(`/guilds/${guildId}/bans/${userId}`, undefined, {
  reason: "spam links",
});
const recent = await discord.get<{ id: string }[]>(
  `/channels/${channelId}/messages`,
  { query: { limit: 50 } },
);

// In the interactions route, after the signature check:
if (interaction.type === 1) return pong();
ctx.waitUntil(
  work().then((content) =>
    discord.editOriginal(env.DISCORD_APP_ID, interaction.token, { content }),
  ),
);
return deferred({ ephemeral: true });
```

- A 429 waits Discord's `retry_after` (from the JSON body or `Retry-After`, global and per-route alike) and tries again, up to `max429` times (5). Discord did not act on a rate limited request, so this applies to a POST too. A wait longer than `maxWaitMs` (60 seconds) throws instead.
- A 5xx, a timeout or a network error is tried twice more for GET, PUT, PATCH and DELETE. A POST is tried once: a message that timed out may still have been sent.
- When a response says its bucket is spent (`X-RateLimit-Remaining: 0`), the next call on that route waits for `X-RateLimit-Reset-After` first.
- Each attempt times out after `timeoutMs` (15 seconds). An error status throws `HttpError` from `workers-start/http` with Discord's JSON error in `body`, so `err.body.code === 10008` is an unknown message.
- `reason` goes into `X-Audit-Log-Reason`, URI-encoded. `query` is appended to the path. A `FormData` body goes up as multipart (a file with `payload_json`), anything else as JSON. A 204 returns `null`.
- `token` is optional; `kind: "Bearer"` sends an OAuth2 access token instead of a bot token. `editOriginal`, `followup` and `deleteOriginal` send no Authorization header, since the interaction token in the path is the credential.
- `interactionResponse(type, data)` returns the JSON `Response`; `InteractionResponseType` and `MessageFlags` hold the numbers. `deferred()` acknowledges within Discord's three seconds and `pong()` answers the endpoint check. Verifying the request signature is up to the app.
