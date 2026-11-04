/**
 * Cleans the file name and type a transfer link owner announces before they
 * reach HTTP headers or the chat. The relay applies it authoritatively; the
 * editor uses the same code to show what downloaders will get.
 */
import { TRANSFER_MIME_PATTERN, TRANSFER_NAME_LENGTH_MAXIMUM } from './protocol_definitions.ts';

/** Type served for anything that is not a plain `type/subtype`. */
export const TRANSFER_MIME_FALLBACK = 'application/octet-stream';
/** Longest extension kept when a long name is shortened, dot included. */
const TRANSFER_EXTENSION_KEPT_MAXIMUM = 16;
/** Device names Windows reserves, with or without an extension. */
const TRANSFER_NAME_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;
/** Control, format (bidi overrides) and Windows-invalid characters. */
const TRANSFER_NAME_INVALID = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>:"|?*]/gu;

/**
 * Returns the served MIME type: a lowercase `type/subtype` without parameters,
 * else application/octet-stream.
 *
 * @param mime Announced type.
 * @returns Safe type.
 */
export function transferMimeSanitize(mime: string): string {
  const base = (mime.split(';')[0] ?? '').trim().toLowerCase();
  return TRANSFER_MIME_PATTERN.test(base) ? base : TRANSFER_MIME_FALLBACK;
}

/**
 * Returns a file name that is safe on every common file system: the last path
 * segment without control or Windows-invalid characters, trailing dots or
 * spaces, at most 255 characters with the extension kept. A name that is empty
 * or a reserved device name afterwards becomes the fallback (the link id).
 *
 * @param name Announced name.
 * @param fallback Url and file system safe name, e.g. the link id.
 * @returns Safe name.
 */
export function transferNameSanitize(name: string, fallback: string): string {
  const segment =
    name
      .normalize('NFC')
      .split(/[/\\]/)
      .filter((part) => part.trim() !== '')
      .at(-1) ?? '';
  const cleaned = transferNameTrim(transferNameShorten(transferNameTrim(segment.replace(TRANSFER_NAME_INVALID, ''))));
  const stem = cleaned.split('.')[0]?.trim() ?? '';
  if (cleaned === '' || TRANSFER_NAME_RESERVED.test(stem)) return transferNameFallback(cleaned, fallback);
  return cleaned;
}

/**
 * Returns the ASCII-only name for the plain `filename=` parameter: other
 * characters become `_`.
 *
 * @param name Sanitized name.
 * @returns ASCII name.
 */
export function transferNameAscii(name: string): string {
  return Array.from(name, (character) => (/^[\x20-\x7e]$/.test(character) ? character : '_')).join('');
}

/**
 * Removes leading spaces and trailing dots and spaces.
 *
 * @param name Name.
 * @returns Trimmed name.
 */
function transferNameTrim(name: string): string {
  return name.replace(/^\s+/u, '').replace(/[.\s]+$/u, '');
}

/**
 * Shortens a name to the length limit in characters, cutting the stem and
 * keeping a short extension.
 *
 * @param name Name.
 * @returns Name of at most the limit.
 */
function transferNameShorten(name: string): string {
  const characters = Array.from(name);
  if (characters.length <= TRANSFER_NAME_LENGTH_MAXIMUM) return name;
  const extension = transferNameExtension(name);
  const stem = characters.slice(0, TRANSFER_NAME_LENGTH_MAXIMUM - Array.from(extension).length).join('');
  return transferNameTrim(stem) + extension;
}

/**
 * Returns the extension of a name (dot included) when it is short enough to
 * keep, else an empty string.
 *
 * @param name Name.
 * @returns Extension or ''.
 */
function transferNameExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  const extension = name.slice(dot);
  return Array.from(extension).length <= TRANSFER_EXTENSION_KEPT_MAXIMUM && !/\s/u.test(extension) ? extension : '';
}

/**
 * Builds the fallback name: the link id plus the extension of the cleaned name
 * when it is plain ASCII.
 *
 * @param cleaned Cleaned name.
 * @param fallback Link id.
 * @returns Fallback name.
 */
function transferNameFallback(cleaned: string, fallback: string): string {
  const extension = transferNameExtension(cleaned);
  return /^\.[A-Za-z0-9]{1,15}$/.test(extension) ? fallback + extension : fallback;
}
