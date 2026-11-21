## X

`workers-start/x` calls the X API v2 as a user, signed with OAuth 1.0a over WebCrypto. OAuth 1.0a user tokens do not expire, so the four secrets are all it needs: no refresh and no stored token.

```ts
import { xClient } from "workers-start/x";

const x = xClient({
  consumerKey: env.X_CONSUMER_KEY,
  consumerSecret: env.X_CONSUMER_SECRET,
  token: env.X_ACCESS_TOKEN,
  tokenSecret: env.X_ACCESS_TOKEN_SECRET,
});

const mediaId = await x.uploadMedia(await image.arrayBuffer(), "image/png");
const tweet = await x.postTweet("gm", { mediaIds: [mediaId] });
const me = await x.get<{ data: { id: string } }>("/users/me");
await x.deleteTweet(tweet.id);
console.log(x.rateLimit); // { endpoint: "DELETE /tweets/...", limit, remaining, reset }
```

- A 429 waits until `x-rate-limit-reset` plus a second and tries again, for a POST too, since X did not act on it. A reset later than `maxWaitMs` (60 seconds) throws at once rather than waiting.
- A 5xx, a timeout or a network error is retried for GET and DELETE. A POST is tried once: a post that timed out may have gone out.
- An error status throws `HttpError` from `workers-start/http` with X's JSON body (`title`, `detail`, `errors`). Each attempt times out after `timeoutMs` (15 seconds) and is signed again with a fresh nonce.
- `rateLimit` holds the `x-rate-limit-*` headers of the last response that carried them. They describe that endpoint, not the account.
- `get(path, query)` signs the query string; `post(path, body)` sends JSON, which is not signed. `postTweet(text, { replyTo, quote, mediaIds })` returns `{ id, text }`.
- `uploadMedia(bytes, mimeType)` sends an image or GIF in one request to `POST /2/media/upload` and returns the media id. Video needs X's chunked upload, which is not here.
- `oauth1Header(creds, method, url, params)` returns the `Authorization` header for any call, X's or another OAuth 1.0a API's. `params` are the fields of a form-encoded body; leave them out for JSON or multipart. Sign the final URL, since a parameter added after signing gets a 401.
