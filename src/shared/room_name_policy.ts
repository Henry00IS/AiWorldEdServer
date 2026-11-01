/** Dependency-free room and display name rules shared by client and server. */

/** Maximum room name length in code points (after trimming). */
export const ROOM_NAME_LENGTH_MAXIMUM = 128;
/** Maximum display name length in code points (after trimming). */
export const DISPLAY_NAME_LENGTH_MAXIMUM = 12;

/** Result of normalizing a user supplied name. */
export type NameNormalizeResult =
  { ok: true; name: string } | { ok: false; reason: 'empty' | 'too_long' | 'invalid_characters' };

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
 * Invisible, format, surrogate, private-use and line-separator characters; the
 * zero width joiner stays allowed for emoji sequences.
 */
const NAME_FORBIDDEN_CHARACTERS = /[\p{Cc}\p{Cs}\p{Co}\u2028\u2029]|(?!\u200D)\p{Cf}/u;
/**
 * Letters and marks that render as blank space (Hangul fillers, braille blank,
 * CGJ).
 */
const NAME_BLANK_LOOKING_CHARACTERS = /[\u034F\u115F\u1160\u2800\u3164\uFFA0]/u;
/** More than four stacked combining marks ("zalgo" text drawn over neighbours). */
const NAME_STACKED_MARKS = /\p{M}{5}/u;

/**
 * Collapses whitespace, NFC-normalizes, trims and checks length and forbidden
 * characters.
 *
 * @param rawName Name as typed by the user.
 * @param maximumLength Maximum length in code points.
 * @returns The normalized name or the reason it was rejected.
 */
function nameNormalizeWithLimit(rawName: string, maximumLength: number): NameNormalizeResult {
  if (nameHasForbiddenCharacters(rawName)) return { ok: false, reason: 'invalid_characters' };
  const name = rawName
    .normalize('NFC')
    .replace(/\p{White_Space}+/gu, ' ')
    .trim();
  if (name.length === 0) return { ok: false, reason: 'empty' };
  if (Array.from(name).length > maximumLength) return { ok: false, reason: 'too_long' };
  return { ok: true, name };
}

/**
 * Tells whether a name contains characters that are invisible, render as blank
 * or stack over neighbouring text.
 *
 * @param rawName Name as typed by the user.
 * @returns True when the name must be rejected.
 */
function nameHasForbiddenCharacters(rawName: string): boolean {
  return (
    NAME_FORBIDDEN_CHARACTERS.test(rawName) ||
    NAME_BLANK_LOOKING_CHARACTERS.test(rawName) ||
    NAME_STACKED_MARKS.test(rawName)
  );
}

/**
 * Default display name for a user who did not pick one; always within
 * DISPLAY_NAME_LENGTH_MAXIMUM.
 *
 * @param user User id.
 * @returns Name like "User 42".
 */
export function displayNameFallback(user: number): string {
  return `User ${user % 10_000_000}`;
}
