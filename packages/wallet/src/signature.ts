import {
  type Address,
  type Hex,
  isAddress,
  isAddressEqual,
  isHex,
  recoverMessageAddress,
  type SignableMessage,
} from "viem";

/**
 * The part of a viem `PublicClient` the smart wallet check uses. Any public client fits; so does a
 * test double with just this method.
 */
export interface SignatureClient {
  verifyMessage(args: {
    address: Address;
    message: SignableMessage;
    signature: Hex;
  }): Promise<boolean>;
}

export interface VerifyWalletSignatureOptions {
  /** A public client on the wallet's chain. Without one, only plain accounts can pass. */
  client?: SignatureClient | undefined;
  address: string;
  message: SignableMessage;
  signature: string;
  /** How long the chain check may take before it counts as unanswered. Default 5000. */
  timeoutMs?: number | undefined;
}

const TIMED_OUT = Symbol("timed out");

/**
 * Whether `signature` is `address`'s signature of `message`.
 *
 * A plain account's signature is recovered here, with no network. Anything else goes to the
 * client's `verifyMessage`, which checks ERC-1271 for a deployed contract wallet and ERC-6492 for
 * one not deployed yet.
 *
 * True or false is the answer. Undefined means the chain check could not finish (the RPC failed or
 * took longer than `timeoutMs`), so the caller can answer "try again" rather than "not yours".
 */
export async function verifyWalletSignature({
  client,
  address,
  message,
  signature,
  timeoutMs = 5000,
}: VerifyWalletSignatureOptions): Promise<boolean | undefined> {
  if (!isAddress(address, { strict: false }) || !isHex(signature)) return false;
  try {
    const recovered = await recoverMessageAddress({ message, signature });
    if (isAddressEqual(recovered, address)) return true;
  } catch {
    // Not a plain account's signature. A smart wallet's may still be good.
  }
  if (!client) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  try {
    const result = await Promise.race([
      client.verifyMessage({ address, message, signature }),
      timeout,
    ]);
    return result === TIMED_OUT ? undefined : result;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
