/**
 * Dependency-free secure password generator for private room suggestions. Uses
 * the Web Crypto CSPRNG (browser and Bun) with unbiased rejection sampling.
 */
import { passwordPolicyIsAcceptable } from './password_policy.ts';

/** Upper case letters without the ambiguous I and O. */
export const PASSWORD_ALPHABET_UPPERCASE = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
/** Lower case letters without the ambiguous l and o. */
export const PASSWORD_ALPHABET_LOWERCASE = 'abcdefghijkmnpqrstuvwxyz';
/** Digits without the ambiguous 0 and 1. */
export const PASSWORD_ALPHABET_DIGITS = '23456789';
/** Special characters that are easy to type on common layouts. */
export const PASSWORD_ALPHABET_SPECIAL = '!#$%&*+-=?@_~';
/** Default suggested password length. */
export const PASSWORD_GENERATED_LENGTH_DEFAULT = 16;

const PASSWORD_ALPHABET_ALL =
  PASSWORD_ALPHABET_UPPERCASE + PASSWORD_ALPHABET_LOWERCASE + PASSWORD_ALPHABET_DIGITS + PASSWORD_ALPHABET_SPECIAL;

/**
 * Generates a password that contains every character class and passes the
 * policy.
 *
 * @param length Desired length, clamped to 12..128.
 * @returns A freshly generated password.
 */
export function passwordGenerate(length: number = PASSWORD_GENERATED_LENGTH_DEFAULT): string {
  const clampedLength = Math.min(128, Math.max(12, Math.floor(length)));
  for (;;) {
    const candidate = passwordGenerateCandidate(clampedLength);
    if (passwordPolicyIsAcceptable(candidate)) return candidate;
  }
}

/**
 * Builds one candidate with one character from each class, filled up and
 * shuffled.
 *
 * @param length Candidate length.
 * @returns Candidate password.
 */
function passwordGenerateCandidate(length: number): string {
  const characters = [
    passwordRandomCharacter(PASSWORD_ALPHABET_UPPERCASE),
    passwordRandomCharacter(PASSWORD_ALPHABET_LOWERCASE),
    passwordRandomCharacter(PASSWORD_ALPHABET_DIGITS),
    passwordRandomCharacter(PASSWORD_ALPHABET_SPECIAL),
  ];
  while (characters.length < length) characters.push(passwordRandomCharacter(PASSWORD_ALPHABET_ALL));
  passwordShuffleInPlace(characters);
  return characters.join('');
}

/**
 * @param alphabet Characters to choose from.
 * @returns One uniformly random character of the alphabet.
 */
function passwordRandomCharacter(alphabet: string): string {
  return alphabet.charAt(passwordRandomIndex(alphabet.length));
}

/**
 * Fisher-Yates shuffle driven by the CSPRNG.
 *
 * @param items Array shuffled in place.
 */
function passwordShuffleInPlace(items: string[]): void {
  for (let index = items.length - 1; index > 0; index--) {
    const swapIndex = passwordRandomIndex(index + 1);
    const current = items[index] ?? '';
    items[index] = items[swapIndex] ?? '';
    items[swapIndex] = current;
  }
}

/**
 * Unbiased random integer in [0, exclusiveMaximum) via rejection sampling.
 *
 * @param exclusiveMaximum Upper bound (exclusive), at most 2^32.
 * @returns Random index.
 */
export function passwordRandomIndex(exclusiveMaximum: number): number {
  const limit = Math.floor(0x100000000 / exclusiveMaximum) * exclusiveMaximum;
  const buffer = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buffer);
    const value = buffer[0] ?? 0;
    if (value < limit) return value % exclusiveMaximum;
  }
}
