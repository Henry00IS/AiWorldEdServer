/**
 * Dependency-free password policy for private collaboration rooms. Runs in the
 * browser (AiWorldEd client) and in Bun (relay server) without changes.
 */

/** Stable issue codes so clients can localize the explanation. */
export type PasswordPolicyIssue =
  | 'too_short'
  | 'too_long'
  | 'invalid_characters'
  | 'missing_uppercase'
  | 'missing_digit'
  | 'missing_special'
  | 'repeated_characters'
  | 'sequence'
  | 'low_variety'
  | 'common_password'
  | 'low_entropy';

/** Result of evaluating a password against the policy. */
export interface PasswordPolicyResult {
  /** True when the password satisfies every rule. */
  ok: boolean;
  /** Every rule the password violates, empty when ok. */
  issues: PasswordPolicyIssue[];
  /** Conservative entropy estimate in bits. */
  estimatedBits: number;
}

/** Minimum password length in code points. */
export const PASSWORD_LENGTH_MINIMUM = 8;
/** Maximum password length in code points. */
export const PASSWORD_LENGTH_MAXIMUM = 128;
/** Minimum number of distinct characters. */
export const PASSWORD_DISTINCT_CHARACTERS_MINIMUM = 5;
/** Longest allowed run of one repeated character. */
export const PASSWORD_REPEAT_RUN_MAXIMUM = 3;
/** Shortest ascending/descending or keyboard run that counts as a sequence. */
export const PASSWORD_SEQUENCE_RUN_MINIMUM = 4;
/** Minimum conservative entropy estimate in bits. */
export const PASSWORD_ENTROPY_BITS_MINIMUM = 40;

const KEYBOARD_ROWS: readonly string[] = [
  '`1234567890-=',
  'qwertyuiop[]',
  'asdfghjkl;\'',
  'zxcvbnm,./',
  'qwertzuiopü',
  'asdfghjklöä',
  'yxcvbnm',
  'azertyuiop',
  'qsdfghjklm',
  'wxcvbn',
];

const COMMON_PASSWORD_WORDS: readonly string[] = [
  'password', 'passwort', 'passw', 'qwerty', 'qwertz', 'azerty', 'letmein', 'welcome', 'admin',
  'iloveyou', 'monkey', 'dragon', 'football', 'baseball', 'master', 'login', 'sunshine',
  'princess', 'shadow', 'trustno', 'changeme', 'secret', 'aiworlded', 'hallo', 'hello',
  'summer', 'winter', 'spring', 'autumn', 'freedom', 'whatever', 'superman', 'batman',
  'starwars', 'pokemon', 'michael', 'jordan', 'charlie', 'killer', 'soccer', 'hunter',
  'abc', 'test', 'guest', 'root', 'user', 'default', 'computer', 'internet', 'google',
];

const LEET_SUBSTITUTIONS: Readonly<Record<string, string>> = {
  '0': 'o', '1': 'i', '!': 'i', '|': 'i', '3': 'e', '4': 'a', '@': 'a', '5': 's', '$': 's',
  '7': 't', '+': 't', '8': 'b', '9': 'g',
};

/**
 * Evaluates a password against every policy rule.
 *
 * @param password Candidate password exactly as typed.
 * @returns Policy verdict with all issues and the entropy estimate.
 */
export function passwordPolicyEvaluate(password: string): PasswordPolicyResult {
  const characters = Array.from(password);
  const issues: PasswordPolicyIssue[] = [];
  passwordPolicyCollectStructuralIssues(characters, issues);
  passwordPolicyCollectWeaknessIssues(password, characters, issues);
  const estimatedBits = passwordEntropyEstimateBits(characters);
  if (estimatedBits < PASSWORD_ENTROPY_BITS_MINIMUM) {
    issues.push('low_entropy');
  }
  return { ok: issues.length === 0, issues, estimatedBits };
}

/**
 * Returns whether the password satisfies the policy.
 *
 * @param password Candidate password.
 * @returns True when acceptable.
 */
export function passwordPolicyIsAcceptable(password: string): boolean {
  return passwordPolicyEvaluate(password).ok;
}

/**
 * Collects length, character-class and character-set issues.
 *
 * @param characters Password split into code points.
 * @param issues Issue list to append to.
 */
function passwordPolicyCollectStructuralIssues(characters: string[], issues: PasswordPolicyIssue[]): void {
  if (characters.length < PASSWORD_LENGTH_MINIMUM) issues.push('too_short');
  if (characters.length > PASSWORD_LENGTH_MAXIMUM) issues.push('too_long');
  if (characters.some(passwordCharacterIsControl)) issues.push('invalid_characters');
  if (!characters.some(passwordCharacterIsUppercase)) issues.push('missing_uppercase');
  if (!characters.some(passwordCharacterIsDigit)) issues.push('missing_digit');
  if (!characters.some(passwordCharacterIsSpecial)) issues.push('missing_special');
}

/**
 * Collects heuristic weakness issues (repeats, sequences, variety, common words).
 *
 * @param password Original password.
 * @param characters Password split into code points.
 * @param issues Issue list to append to.
 */
function passwordPolicyCollectWeaknessIssues(password: string, characters: string[], issues: PasswordPolicyIssue[]): void {
  if (passwordHasRepeatedCharacters(characters)) issues.push('repeated_characters');
  if (passwordHasSequence(password.toLowerCase())) issues.push('sequence');
  if (new Set(characters).size < PASSWORD_DISTINCT_CHARACTERS_MINIMUM) issues.push('low_variety');
  if (passwordIsCommonPattern(password)) issues.push('common_password');
}

/**
 * Detects long runs of one character or a single character dominating the password.
 *
 * @param characters Password split into code points.
 * @returns True when the password is too repetitive.
 */
export function passwordHasRepeatedCharacters(characters: string[]): boolean {
  const occurrences = new Map<string, number>();
  let runLength = 0;
  let previous = '';
  for (const character of characters) {
    runLength = character === previous ? runLength + 1 : 1;
    previous = character;
    if (runLength > PASSWORD_REPEAT_RUN_MAXIMUM) return true;
    occurrences.set(character, (occurrences.get(character) ?? 0) + 1);
  }
  const mostFrequent = Math.max(0, ...occurrences.values());
  return characters.length > 0 && mostFrequent * 2 > characters.length;
}

/**
 * Detects alphabetical/numeric runs (abcd, 4321) and keyboard runs (qwer, asdf).
 *
 * @param lowercasePassword Password in lower case.
 * @returns True when a sequence of at least the minimum run length exists.
 */
export function passwordHasSequence(lowercasePassword: string): boolean {
  return passwordHasCodePointSequence(lowercasePassword) || passwordHasKeyboardSequence(lowercasePassword);
}

/**
 * Detects runs where consecutive code points differ by exactly +1 or -1.
 *
 * @param text Text to scan.
 * @returns True when such a run reaches the minimum length.
 */
function passwordHasCodePointSequence(text: string): boolean {
  const codes = Array.from(text, (character) => character.codePointAt(0) ?? 0);
  let ascending = 1;
  let descending = 1;
  for (let index = 1; index < codes.length; index++) {
    const step = (codes[index] ?? 0) - (codes[index - 1] ?? 0);
    ascending = step === 1 ? ascending + 1 : 1;
    descending = step === -1 ? descending + 1 : 1;
    if (Math.max(ascending, descending) >= PASSWORD_SEQUENCE_RUN_MINIMUM) return true;
  }
  return false;
}

/**
 * Detects runs of adjacent keys on common keyboard layouts, in either direction.
 *
 * @param text Lower case text to scan.
 * @returns True when a keyboard run reaches the minimum length.
 */
function passwordHasKeyboardSequence(text: string): boolean {
  for (let start = 0; start + PASSWORD_SEQUENCE_RUN_MINIMUM <= text.length; start++) {
    const window = text.slice(start, start + PASSWORD_SEQUENCE_RUN_MINIMUM);
    const reversed = Array.from(window).reverse().join('');
    if (KEYBOARD_ROWS.some((row) => row.includes(window) || row.includes(reversed))) return true;
  }
  return false;
}

/**
 * Detects passwords that are mostly a common word, optionally leet-speaked.
 *
 * @param password Original password.
 * @returns True when a common word makes up at least half of the password.
 */
export function passwordIsCommonPattern(password: string): boolean {
  const normalized = passwordNormalizeLeet(password.toLowerCase());
  const lowercase = password.toLowerCase();
  return COMMON_PASSWORD_WORDS.some(
    (word) => word.length * 2 >= password.length && (normalized.includes(word) || lowercase.includes(word)),
  );
}

/**
 * Replaces common leet-speak substitutions with their letters.
 *
 * @param lowercasePassword Lower case password.
 * @returns Normalized text.
 */
function passwordNormalizeLeet(lowercasePassword: string): string {
  return Array.from(lowercasePassword, (character) => LEET_SUBSTITUTIONS[character] ?? character).join('');
}

/**
 * Conservative entropy estimate: pool size of the used character classes
 * raised to the number of characters, where repeated characters only count
 * once and sequence steps count as half a character.
 *
 * @param characters Password split into code points.
 * @returns Estimated entropy in bits.
 */
export function passwordEntropyEstimateBits(characters: string[]): number {
  const poolSize = passwordCharacterPoolSize(characters);
  if (poolSize <= 1) return 0;
  const effectiveLength = passwordEffectiveLength(characters);
  return Math.round(effectiveLength * Math.log2(poolSize) * 10) / 10;
}

/**
 * Computes the character pool size from the character classes present.
 *
 * @param characters Password split into code points.
 * @returns Pool size.
 */
function passwordCharacterPoolSize(characters: string[]): number {
  let pool = 0;
  if (characters.some((character) => character >= 'a' && character <= 'z')) pool += 26;
  if (characters.some((character) => character >= 'A' && character <= 'Z')) pool += 26;
  if (characters.some(passwordCharacterIsDigit)) pool += 10;
  if (characters.some((character) => passwordCharacterIsSpecial(character) && character.charCodeAt(0) < 128)) pool += 33;
  if (characters.some((character) => character.charCodeAt(0) >= 128)) pool += 100;
  return pool;
}

/**
 * Counts characters, discounting repeats of earlier characters and +-1 steps.
 *
 * @param characters Password split into code points.
 * @returns Effective length used for the entropy estimate.
 */
function passwordEffectiveLength(characters: string[]): number {
  const seen = new Set<string>();
  let length = 0;
  let previousCode = Number.NaN;
  for (const character of characters) {
    const code = character.codePointAt(0) ?? 0;
    const isStep = Math.abs(code - previousCode) === 1;
    length += seen.has(character) ? 0.25 : isStep ? 0.5 : 1;
    seen.add(character);
    previousCode = code;
  }
  return length;
}

/**
 * @param character Single code point.
 * @returns True for A-Z or any other cased upper-case letter.
 */
export function passwordCharacterIsUppercase(character: string): boolean {
  return character !== character.toLowerCase() && character === character.toUpperCase();
}

/**
 * @param character Single code point.
 * @returns True for 0-9.
 */
export function passwordCharacterIsDigit(character: string): boolean {
  return character >= '0' && character <= '9';
}

/**
 * @param character Single code point.
 * @returns True for anything that is not a letter, digit, whitespace or control character.
 */
export function passwordCharacterIsSpecial(character: string): boolean {
  return !/[\p{L}\p{N}\s\p{Cc}]/u.test(character);
}

/**
 * @param character Single code point.
 * @returns True for control and format characters, which are never allowed.
 */
function passwordCharacterIsControl(character: string): boolean {
  return /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(character);
}
