/**
 * Dependency-free room and display name rules shared by client and server.
 */

/** Maximum room name length in code points (after trimming). */
export const ROOM_NAME_LENGTH_MAXIMUM = 128;
/** Maximum display name length in code points (after trimming). */
export const DISPLAY_NAME_LENGTH_MAXIMUM = 12;

/** Result of normalizing a user supplied name. */
export type NameNormalizeResult = { ok: true; name: string } | { ok: false; reason: 'empty' | 'too_long' | 'invalid_characters' };

/**
 * Trims and validates a room name.
 *
 * @param rawName Name as typed by the user.
 * @returns The normalized name or the reason it was rejected.
 */
export function roomNameNormalize(rawName: string): NameNormalizeResult {
  return nameNormalizeWithLimit(rawName, ROOM_NAME_LENGTH_MAXIMUM);
}

/**
 * Trims and validates a display (nick) name.
 *
 * @param rawName Name as typed by the user.
 * @returns The normalized name or the reason it was rejected.
 */
export function displayNameNormalize(rawName: string): NameNormalizeResult {
  return nameNormalizeWithLimit(rawName, DISPLAY_NAME_LENGTH_MAXIMUM);
}

/**
 * Trims, NFC-normalizes and checks length and forbidden characters.
 *
 * @param rawName Name as typed by the user.
 * @param maximumLength Maximum length in code points.
 * @returns The normalized name or the reason it was rejected.
 */
function nameNormalizeWithLimit(rawName: string, maximumLength: number): NameNormalizeResult {
  if (/[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/u.test(rawName)) return { ok: false, reason: 'invalid_characters' };
  const name = rawName.normalize('NFC').trim();
  if (name.length === 0) return { ok: false, reason: 'empty' };
  if (Array.from(name).length > maximumLength) return { ok: false, reason: 'too_long' };
  return { ok: true, name };
}

/**
 * Default display name for a user who did not pick one; always within DISPLAY_NAME_LENGTH_MAXIMUM.
 *
 * @param user User id.
 * @returns Name like "User 42".
 */
export function displayNameFallback(user: number): string {
  return `User ${user % 10_000_000}`;
}
