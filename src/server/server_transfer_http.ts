/**
 * Plain HTTP side of transfer links: `GET` and `HEAD` on
 * `<WEBSOCKET_PATH>/transfer/<link>` stream the file from the owner's editor.
 * Responses are downloads by default (`Content-Disposition: attachment`);
 * `?inline` serves images, video and audio inline for embedding. Every response
 * forbids sniffing and scripting and allows GET from any origin.
 */
import { handlerTransferLinkOwner } from '../handlers/handler_transfer.ts';
import type { ServerCore } from './server_core.ts';
import { TRANSFER_LINK_PATTERN, TRANSFER_PATH_SEGMENT } from '../shared/protocol_definitions.ts';
import { transferMimeSanitize, transferNameAscii, transferNameSanitize } from '../shared/transfer_file_policy.ts';
import {
  transferDownloadEnd,
  transferDownloadInfo,
  transferDownloadStart,
  transferStreamCreate,
} from '../transfer/transfer_stream.ts';

/** Headers on every transfer response. */
const TRANSFER_HEADERS_COMMON: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Expose-Headers': 'Content-Disposition, Content-Length, Content-Type',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; sandbox",
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};
/** Status texts of refused downloads. */
const TRANSFER_STATUS_TEXT: Readonly<Record<number, string>> = {
  404: 'not found',
  405: 'method not allowed',
  413: 'file too large',
  503: 'too many downloads, try again later',
  504: 'the owner did not answer',
};

/**
 * Returns the URL path prefix of transfer links, e.g. `/ws/transfer/`.
 *
 * @param websocketPath Configured WebSocket path.
 * @returns Prefix ending in a slash.
 */
export function transferHttpPrefix(websocketPath: string): string {
  return `${websocketPath.replace(/\/+$/, '')}/${TRANSFER_PATH_SEGMENT}/`;
}

/**
 * Answers a request on a transfer link path.
 *
 * @param core Relay core.
 * @param request HTTP request.
 * @param link Path rest after the prefix.
 * @returns Response; the body streams from the owner.
 */
export async function transferHttpServe(core: ServerCore, request: Request, link: string): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: TRANSFER_HEADERS_COMMON });
  if (request.method !== 'GET' && request.method !== 'HEAD') return transferHttpStatus(405);
  const owner = TRANSFER_LINK_PATTERN.test(link) ? handlerTransferLinkOwner(core, link) : null;
  if (owner === null) return transferHttpStatus(404);
  const download = transferDownloadStart(owner, link);
  if (download === null) return transferHttpStatus(503);
  request.signal.addEventListener('abort', () => transferDownloadEnd(download, null), { once: true });
  const info = await transferDownloadInfo(download);
  if (!info.ok) return transferHttpStatus(info.status);
  const inline = new URL(request.url).searchParams.has('inline');
  const headers = transferHttpHeaders(info, link, inline);
  if (request.method === 'GET') return new Response(transferStreamCreate(download), { headers });
  transferDownloadEnd(download, null);
  return new Response(null, { headers });
}

/**
 * Builds the headers of a served file.
 *
 * @param info Announced size, name and type.
 * @param link Link id, the fallback name.
 * @param inline True for `?inline`.
 * @returns Headers.
 */
export function transferHttpHeaders(
  info: { size: number; name: string; mime: string },
  link: string,
  inline: boolean,
): Record<string, string> {
  const mime = transferMimeSanitize(info.mime);
  return {
    ...TRANSFER_HEADERS_COMMON,
    'Content-Type': mime,
    'Content-Length': String(info.size),
    'Content-Disposition': transferHttpDisposition(
      transferNameSanitize(info.name, link),
      inline && transferInlineAllowed(mime),
    ),
    'Accept-Ranges': 'none',
  };
}

/**
 * Builds `Content-Disposition` with a plain ASCII `filename` and the exact
 * UTF-8 `filename*`.
 *
 * @param name Sanitized name.
 * @param inline True to serve inline.
 * @returns Header value.
 */
export function transferHttpDisposition(name: string, inline: boolean): string {
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? 'inline' : 'attachment'}; filename="${transferNameAscii(name)}"; filename*=UTF-8''${encoded}`;
}

/**
 * Returns whether a type may be served inline: images except SVG, video and
 * audio.
 *
 * @param mime Sanitized type.
 * @returns True when inline is allowed.
 */
function transferInlineAllowed(mime: string): boolean {
  if (mime === 'image/svg+xml') return false;
  return mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/');
}

/**
 * Builds a plain text error response.
 *
 * @param status HTTP status.
 * @returns Response.
 */
function transferHttpStatus(status: number): Response {
  const headers = { ...TRANSFER_HEADERS_COMMON, 'Content-Type': 'text/plain; charset=utf-8' };
  if (status === 405) Object.assign(headers, { Allow: 'GET, HEAD, OPTIONS' });
  if (status === 503) Object.assign(headers, { 'Retry-After': '5' });
  return new Response(`${TRANSFER_STATUS_TEXT[status] ?? 'error'}\n`, { status, headers });
}
