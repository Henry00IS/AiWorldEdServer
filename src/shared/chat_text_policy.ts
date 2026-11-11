/** Dependency-free chat message rules shared by client and server. */

/** Maximum chat message length in code points (after normalizing). */
export const CHAT_TEXT_LENGTH_MAXIMUM = 2000;
/** Maximum number of lines in one chat message (after normalizing). */
export const CHAT_TEXT_LINES_MAXIMUM = 20;
/** Minimum time between two chat messages of one session in milliseconds. */
export const CHAT_SEND_INTERVAL_MS = 5000;
/** How long after it was sent a chat message may be edited by its sender. */
export const CHAT_EDIT_WINDOW_MS = 5 * 60 * 1000;
/** Minimum time between two edits of one session in milliseconds. */
export const CHAT_EDIT_INTERVAL_MS = 1000;
/** Most edits of one chat message. */
export const CHAT_EDITS_PER_MESSAGE_MAXIMUM = 20;
/** Most different emoji one chat message may carry as reactions. */
export const CHAT_REACTION_EMOJIS_PER_MESSAGE_MAXIMUM = 20;
/** Most reactions of all members together on one chat message. */
export const CHAT_REACTIONS_PER_MESSAGE_MAXIMUM = 200;
/** Most reactions of one member on one chat message. */
export const CHAT_REACTIONS_PER_MEMBER_MAXIMUM = 10;
/** Most reaction changes of one session per reaction window. */
export const CHAT_REACTIONS_PER_WINDOW = 10;
/** Length of the reaction rate window in milliseconds. */
export const CHAT_REACTION_WINDOW_MS = 5000;
/** How long a chat message can be reacted to, in milliseconds (one hour). */
export const CHAT_REACTION_AGE_MAXIMUM_MS = 60 * 60 * 1000;
/** Most recent chat messages per room that can be reacted to. */
export const CHAT_REACTION_MESSAGES_MAXIMUM = 300;
/** Longest reaction emoji in UTF-16 code units. */
export const CHAT_REACTION_EMOJI_LENGTH_MAXIMUM = 32;
/**
 * Exactly one emoji: a flag, a keycap, or a pictograph with an optional
 * presentation selector, skin tone or subdivision tag, joined to more with zero
 * width joiners.
 */
const CHAT_REACTION_EMOJI =
  /^(?:\p{RI}\p{RI}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:[\u{E0020}-\u{E007E}]+\u{E007F})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*)$/u;

/**
 * Largest raw chat text accepted on the wire in UTF-16 code units: enough for
 * the maximum length in astral emoji plus characters that normalizing strips.
 */
export const CHAT_TEXT_WIRE_MAXIMUM = 8192;

/** Result of normalizing a chat message. */
export type ChatTextNormalizeResult =
  { ok: true; text: string } | { ok: false; reason: 'empty' | 'too_long' | 'too_many_lines' };

/** Length and line limits a chat message is checked against. */
export interface ChatTextLimits {
  /** Maximum length in code points. */
  length: number;
  /** Maximum number of lines. */
  lines: number;
}

/** Protocol chat limits (a relay may announce stricter ones). */
export const CHAT_TEXT_LIMITS_DEFAULT: Readonly<ChatTextLimits> = {
  length: CHAT_TEXT_LENGTH_MAXIMUM,
  lines: CHAT_TEXT_LINES_MAXIMUM,
};

/** Line break sequences other than a plain line feed. */
const CHAT_LINE_BREAKS = /\r\n|[\r\u0085\u2028\u2029]/gu;
/**
 * Control (except line feed), surrogate, private-use, blank-looking and format
 * characters (bidi overrides, zero width spaces, tags); the zero width joiner
 * is handled separately.
 */
const CHAT_STRIPPED_CHARACTERS = /[\p{Cs}\p{Co}\u034F\u115F\u1160\u2800\u3164\uFFA0]|(?!\n)\p{Cc}|(?!\u200D)\p{Cf}/gu;
/**
 * Zero width joiners that do not sit between two emoji (the only place where
 * they join a visible sequence).
 */
const CHAT_LONE_JOINERS =
  /(?<![\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F])\u200D|\u200D(?!\p{Extended_Pictographic})/gu;
/** Combining marks beyond the fourth on one character ("zalgo" text). */
const CHAT_STACKED_MARKS = /(\p{M}{4})\p{M}+/gu;
/** Space characters other than line feeds (tabs included). */
const CHAT_INLINE_WHITESPACE = /[\t\v\f \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/gu;
/** Whitespace at the end of a line. */
const CHAT_TRAILING_LINE_WHITESPACE = / +\n/gu;
/** More than one empty line in a row. */
const CHAT_BLANK_LINE_RUNS = /\n{3,}/gu;

/**
 * Normalizes a chat message: NFC, one kind of line break, invisible and
 * spoofing characters removed, stacked marks capped, whitespace tidied, then
 * checks it is not empty and within the length and line limits.
 *
 * @param rawText Message as typed by the user.
 * @param limits Length and line limits.
 * @returns The normalized text or the reason it was rejected.
 */
export function chatTextNormalize(
  rawText: string,
  limits: Readonly<ChatTextLimits> = CHAT_TEXT_LIMITS_DEFAULT,
): ChatTextNormalizeResult {
  const text = chatTextClean(rawText);
  if (text.length === 0) return { ok: false, reason: 'empty' };
  if (chatTextLength(text) > limits.length) return { ok: false, reason: 'too_long' };
  if (chatTextLines(text) > limits.lines) return { ok: false, reason: 'too_many_lines' };
  return { ok: true, text };
}

/**
 * Applies every character and whitespace rule of chat messages without checking
 * limits.
 *
 * @param rawText Message as typed by the user.
 * @returns Cleaned text, possibly empty.
 */
export function chatTextClean(rawText: string): string {
  return rawText
    .normalize('NFC')
    .replace(CHAT_LINE_BREAKS, '\n')
    .replace(CHAT_INLINE_WHITESPACE, ' ')
    .replace(CHAT_STRIPPED_CHARACTERS, '')
    .replace(CHAT_LONE_JOINERS, '')
    .replace(CHAT_STACKED_MARKS, '$1')
    .replace(CHAT_TRAILING_LINE_WHITESPACE, '\n')
    .replace(CHAT_BLANK_LINE_RUNS, '\n\n')
    .trim();
}

/**
 * Counts the code points of a text (what the length limit measures).
 *
 * @param text Text.
 * @returns Number of code points.
 */
export function chatTextLength(text: string): number {
  let count = 0;
  for (const _codePoint of text) count++;
  return count;
}

/**
 * Counts the lines of a text.
 *
 * @param text Text.
 * @returns Number of lines (1 for text without line feeds).
 */
export function chatTextLines(text: string): number {
  let lines = 1;
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) lines++;
  return lines;
}

/**
 * Returns whether a text is exactly one emoji that may be used as a reaction.
 *
 * @param text Untrusted text.
 * @returns True for a single emoji in normalized form.
 */
export function chatReactionEmojiIs(text: string): boolean {
  if (text.length === 0 || text.length > CHAT_REACTION_EMOJI_LENGTH_MAXIMUM) return false;
  return text.normalize('NFC') === text && CHAT_REACTION_EMOJI.test(text);
}
