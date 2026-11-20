/**
 * A stand-in for a Cloudflare Access team in tests: a key pair made on the
 * spot, a `fetch` that serves its public key at the team's certs URL, and a
 * signer for tokens shaped like the ones Access issues.
 */
import type { AccessConfig } from "./access.js";

export interface TestAccessTeam {
  /** Config for `createAccessVerifier`, with `emails` allowed. */
  config: AccessConfig;
  /** Serves the team's certs; pass it as the verifier's `fetch`. */
  fetch: (url: string) => Promise<Response>;
  /** A signed token for `email`, valid for an hour, with `claims` on top. */
  token: (email: string, claims?: Record<string, unknown>) => Promise<string>;
  /** A signed token for a service token's client id. */
  serviceToken: (
    clientId: string,
    claims?: Record<string, unknown>,
  ) => Promise<string>;
  /** Signs any claims and header fields with the team's key. */
  sign: (
    claims: Record<string, unknown>,
    header?: Record<string, unknown>,
  ) => Promise<string>;
}

export interface TestAccessTeamOptions {
  teamDomain?: string;
  aud?: string;
  emails?: string[];
  serviceTokens?: string[];
  kid?: string;
  /** Milliseconds since the epoch, for `iat`, `nbf` and `exp`. */
  now?: () => number;
}

export async function createTestAccessTeam(
  options: TestAccessTeamOptions = {},
): Promise<TestAccessTeam> {
  const {
    teamDomain = "test.cloudflareaccess.com",
    aud = "test-aud",
    emails = ["admin@example.com"],
    serviceTokens = [],
    kid = "test-key",
    now = Date.now,
  } = options;
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as { privateKey: CryptoKey; publicKey: CryptoKey };
  const jwk = {
    ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as object),
    kid,
    alg: "RS256",
    use: "sig",
  };
  const certsUrl = `https://${teamDomain}/cdn-cgi/access/certs`;

  const sign = async (
    claims: Record<string, unknown>,
    header: Record<string, unknown> = {},
  ) => {
    const head = encode(JSON.stringify({ alg: "RS256", kid, ...header }));
    const body = encode(JSON.stringify(claims));
    const sig = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      pair.privateKey,
      new TextEncoder().encode(`${head}.${body}`),
    );
    return `${head}.${body}.${encode(new Uint8Array(sig))}`;
  };
  const base = () => {
    const iat = Math.floor(now() / 1000);
    return {
      aud: [aud],
      iss: `https://${teamDomain}`,
      iat,
      nbf: iat,
      exp: iat + 3600,
    };
  };

  return {
    config: {
      teamDomain,
      aud,
      emails: emails.map((e) => e.toLowerCase()),
      serviceTokens,
    },
    fetch: async (url) =>
      url === certsUrl
        ? Response.json({ keys: [jwk] })
        : new Response("not found", { status: 404 }),
    token: (email, claims = {}) =>
      sign({ ...base(), email, sub: "user-id", type: "app", ...claims }),
    serviceToken: (clientId, claims = {}) =>
      sign({
        ...base(),
        sub: "",
        type: "app",
        common_name: clientId,
        ...claims,
      }),
    sign,
  };
}

function encode(value: string | Uint8Array): string {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
