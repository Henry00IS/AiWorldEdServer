/**
 * Transfer link tokens. A token is 32 bytes in base64url (43 characters): the
 * owner's user id (u32), the owner's link counter (u32) and 24 bytes of
 * HMAC-SHA256 over both plus the owner connection's nonce, keyed with a secret
 * generated in memory at startup. The relay keeps no table of links: a token
 * names its owner, the MAC proves the relay issued it to that very connection
 * and the counter finds its creation time. A restart, or the owner
 * disconnecting, invalidates every token.
 */

/** Bytes of a decoded token. */
const TRANSFER_TOKEN_BYTES = 32;
/** Bytes of the MAC inside a token. */
const TRANSFER_TOKEN_MAC_BYTES = 24;
/** Characters of a token. */
export const TRANSFER_TOKEN_LENGTH = 43;

/** Owner and counter named by a token. */
export interface TransferTokenParts {
  user: number;
  counter: number;
}

/** Issues and checks transfer link tokens with a per-process secret. */
export class TransferLinkCodec {
  private readonly secret: Uint8Array;

  /**
   * Creates the codec with a fresh random secret.
   *
   * @param secret Secret key; tests may pass a fixed one.
   */
  constructor(secret: Uint8Array = crypto.getRandomValues(new Uint8Array(32))) {
    this.secret = secret;
  }

  /**
   * Builds the token of one link.
   *
   * @param user Owner user id.
   * @param counter Owner link counter.
   * @param nonce Owner connection nonce.
   * @returns 43 character base64url token.
   */
  encode(user: number, counter: number, nonce: Uint8Array): string {
    const bytes = new Uint8Array(TRANSFER_TOKEN_BYTES);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, user);
    view.setUint32(4, counter);
    bytes.set(this.mac(bytes.subarray(0, 8), nonce), 8);
    return Buffer.from(bytes).toString('base64url');
  }

  /**
   * Reads the owner and counter of a token without checking its MAC.
   *
   * @param token Token text.
   * @returns Parts, or null when it is not a token.
   */
  parts(token: string): TransferTokenParts | null {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const bytes = Buffer.from(token, 'base64url');
    if (bytes.length !== TRANSFER_TOKEN_BYTES) return null;
    return { user: bytes.readUInt32BE(0), counter: bytes.readUInt32BE(4) };
  }

  /**
   * Returns whether a token was issued for an owner connection.
   *
   * @param token Token text.
   * @param nonce Owner connection nonce.
   * @returns True when the MAC matches.
   */
  verify(token: string, nonce: Uint8Array): boolean {
    const parts = this.parts(token);
    if (parts === null) return false;
    const expected = this.encode(parts.user, parts.counter, nonce);
    return transferTokenEqual(expected, token);
  }

  /**
   * Computes the truncated MAC of a token head.
   *
   * @param head User id and counter bytes.
   * @param nonce Owner connection nonce.
   * @returns MAC bytes.
   */
  private mac(head: Uint8Array, nonce: Uint8Array): Uint8Array {
    const hasher = new Bun.CryptoHasher('sha256', this.secret);
    hasher.update(head);
    hasher.update(nonce);
    return new Uint8Array(hasher.digest().buffer).subarray(0, TRANSFER_TOKEN_MAC_BYTES);
  }
}

/**
 * Compares two tokens of equal length in constant time.
 *
 * @param a First token.
 * @param b Second token.
 * @returns True when equal.
 */
function transferTokenEqual(a: string, b: string): boolean {
  let difference = a.length ^ b.length;
  for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}
