import { isAddress } from "viem";
import { parseSiweMessage, type SiweMessage } from "viem/siwe";
import { type SignatureClient, verifyWalletSignature } from "./signature.js";

/** The EIP-4361 fields of a Sign-In with Ethereum message. */
export type SiweFields = SiweMessage & { issuedAt: Date };

/**
 * The EIP-4361 fields of `message`, or null when it is not a well formed Sign-In with Ethereum
 * message: a required field missing, an address that is not one, or a date that is not an
 * RFC 3339 date-time.
 */
export function parseSiwe(message: string): SiweFields | null {
  let fields: ReturnType<typeof parseSiweMessage>;
  try {
    fields = parseSiweMessage(message);
  } catch {
    return null;
  }
  const { address, chainId, domain, issuedAt, nonce, uri, version } = fields;
  if (!address || !isAddress(address, { strict: false })) return null;
  if (!domain || !uri || !nonce || version !== "1") return null;
  if (chainId === undefined || !Number.isSafeInteger(chainId)) return null;
  if (!validDate(issuedAt)) return null;
  for (const date of [fields.expirationTime, fields.notBefore]) {
    if (date !== undefined && !validDate(date)) return null;
  }
  return { ...fields, address, chainId, domain, issuedAt, nonce, uri, version };
}

function validDate(date: Date | undefined): date is Date {
  return date instanceof Date && !Number.isNaN(date.getTime());
}

export type SiweFailure =
  | "domain"
  | "uri"
  | "chain"
  | "nonce"
  | "expired"
  | "not-yet-valid"
  | "issued-in-future";

export type SiweCheck = { ok: true } | { ok: false; reason: SiweFailure };

export interface CheckSiweOptions {
  /** The host the message must name, port included if it has one. Compared ignoring case. */
  domain: string | readonly string[];
  /** The nonce this server issued for the sign-in. Unchecked when omitted. */
  nonce?: string | undefined;
  /** The exact URI the message must name. Unchecked when omitted. */
  uri?: string | undefined;
  /** The chain ids the message may name. Unchecked when omitted. */
  chainId?: number | readonly number[] | undefined;
  /** The time to check against. Default now. */
  now?: Date | number | undefined;
  /**
   * How far ahead of `now` the wallet's Issued At may be, for clock drift between the wallet and
   * the server. Default 10 minutes.
   */
  skewMs?: number | undefined;
}

/**
 * Whether parsed SIWE fields fit this sign-in: the domain, the nonce, the URI and the chain when
 * given, and the times (not expired, past Not Before, issued no later than `now` plus `skewMs`).
 * It does not check the signature; `verifySiwe` does both.
 */
export function checkSiwe(
  fields: SiweFields,
  options: CheckSiweOptions,
): SiweCheck {
  const now = options.now === undefined ? Date.now() : Number(options.now);
  const skewMs = options.skewMs ?? 10 * 60_000;
  const fail = (reason: SiweFailure): SiweCheck => ({ ok: false, reason });
  const domains =
    typeof options.domain === "string" ? [options.domain] : options.domain;
  const domain = fields.domain.toLowerCase();
  if (!domains.some((d) => d.toLowerCase() === domain)) return fail("domain");
  if (options.uri !== undefined && fields.uri !== options.uri)
    return fail("uri");
  if (options.chainId !== undefined) {
    const chains =
      typeof options.chainId === "number" ? [options.chainId] : options.chainId;
    if (!chains.includes(fields.chainId)) return fail("chain");
  }
  if (options.nonce !== undefined && fields.nonce !== options.nonce)
    return fail("nonce");
  if (fields.expirationTime && fields.expirationTime.getTime() <= now)
    return fail("expired");
  if (fields.notBefore && fields.notBefore.getTime() > now)
    return fail("not-yet-valid");
  if (fields.issuedAt.getTime() > now + skewMs) return fail("issued-in-future");
  return { ok: true };
}

export interface VerifySiweOptions extends CheckSiweOptions {
  /** A public client on the message's chain, for smart wallets. Without one, only plain accounts pass. */
  client?: SignatureClient | undefined;
  message: string;
  signature: string;
  /** How long the chain check may take. Default 5000. */
  timeoutMs?: number | undefined;
}

export type SiweResult =
  | { ok: true; fields: SiweFields }
  | {
      ok: false;
      /**
       * `malformed`: not a SIWE message. `signature`: the address did not sign it. `unavailable`:
       * the chain check could not finish, so the sign-in may be retried. Anything else is the
       * `checkSiwe` failure.
       */
      reason: SiweFailure | "malformed" | "signature" | "unavailable";
    };

/**
 * Parses a Sign-In with Ethereum message, checks it with `checkSiwe`, then checks the signature
 * with `verifyWalletSignature`, so a smart wallet signs in the same as a plain account.
 */
export async function verifySiwe({
  client,
  message,
  signature,
  timeoutMs,
  ...options
}: VerifySiweOptions): Promise<SiweResult> {
  const fields = parseSiwe(message);
  if (!fields) return { ok: false, reason: "malformed" };
  const check = checkSiwe(fields, options);
  if (!check.ok) return check;
  const signed = await verifyWalletSignature({
    client,
    address: fields.address,
    message,
    signature,
    timeoutMs,
  });
  if (signed === undefined) return { ok: false, reason: "unavailable" };
  if (!signed) return { ok: false, reason: "signature" };
  return { ok: true, fields };
}
