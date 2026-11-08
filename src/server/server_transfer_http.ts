/**
 * Plain HTTP side of transfer links: `GET` and `HEAD` on
 * `<WEBSOCKET_PATH>/transfer/<link>` stream the file from the owner's editor.
 * Safe browser-renderable types (raster images, video, audio, PDF) open inline,
 * everything else downloads; `?download` always downloads. A single `Range` is
 * served as 206 so players can seek. Every response forbids sniffing and
 * scripting and allows GET from any origin.
 *
 * Safe raster images always stream as raw media (including to Discordbot). For
 * other types, Discord's crawler alone may receive a tiny Open Graph HTML card
 * (filename + size); `?raw=1` / `?download` and ordinary clients always get the
 * raw byte stream. Active types and size limits stay enforced. Cards of files
 * the editor previews point their image at `?thumbnail`, which asks the owner
 * for a small PNG instead of the file.
 */
import { handlerTransferLinkOwner } from '../handlers/handler_transfer.ts';
import type { ServerCore } from './server_core.ts';
import { TRANSFER_LINK_PATTERN, TRANSFER_PATH_SEGMENT } from '../shared/protocol_definitions.ts';
import { transferMimeSanitize, transferNameAscii, transferNameSanitize } from '../shared/transfer_file_policy.ts';
import {
  transferDownloadEnd,
  transferDownloadInfo,
  transferDownloadRange,
  transferDownloadStart,
  transferStreamCreate,
  type TransferDownload,
} from '../transfer/transfer_stream.ts';

/** Headers on every transfer response. */
const TRANSFER_HEADERS_COMMON: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Disposition, Content-Length, Content-Range, Content-Type',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

/** CSP of every response; PDF viewers are plugins, which `sandbox` blocks. */
const TRANSFER_CSP = "default-src 'none'; img-src 'self'; media-src 'self'";

/** Types a browser renders without running content of the file. */
const TRANSFER_INLINE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'video/mp4',
  'video/webm',
  'video/ogg',
  'application/pdf',
]);

/** Extensions of files whose owner renders a `?thumbnail` PNG preview. */
const TRANSFER_THUMBNAIL_EXTENSIONS = ['.curve'];

/** Messages of refused downloads; `{limit}` becomes the size cap. */
const TRANSFER_STATUS_TEXT: Readonly<Record<number, string>> = {
  404: 'This link is no longer available.',
  405: 'Only GET and HEAD are allowed.',
  413: 'This file exceeds the {limit} limit.',
  416: 'The requested range is not available.',
  502: 'The sender sent invalid data.',
  503: 'Too many downloads right now, try again later.',
  504: 'The sender did not answer.',
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
 * Answers a request on a transfer link path. Images stay raw for Discordbot
 * (direct embeds); other types get a title card unless `?raw=1` / `?download`,
 * which always stream bytes. `?thumbnail` asks the owner for a PNG preview.
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
  const url = transferHttpPublicUrl(request, core.config.trustProxy);
  const download = transferDownloadStart(owner, link, url.searchParams.has('thumbnail'));
  if (download === null) return transferHttpStatus(503);
  request.signal.addEventListener('abort', () => transferDownloadEnd(download, null), { once: true });
  const info = await transferDownloadInfo(download);
  if (!info.ok) return transferHttpStatus(info.status, owner.limits.sizeMaximum);
  if (transferHttpIsDiscordbot(request) && !transferHttpWantsRaw(url) && !transferHttpIsSafeRasterImage(info.mime)) {
    transferDownloadEnd(download, null);
    return transferHttpDiscordUnfurl(url, info, link, request.method === 'HEAD');
  }
  const inline = !url.searchParams.has('download');
  const headers = transferHttpHeaders(info, link, inline);
  if (request.method === 'GET') return transferHttpGet(download, request.headers.get('range'), info.size, headers);
  transferDownloadEnd(download, null);
  return new Response(null, { headers });
}

/**
 * Returns the request URL as the downloader sees it: behind a trusted proxy
 * that terminated TLS (`X-Forwarded-Proto: https`) it is an https URL, so the
 * links of crawler cards work.
 *
 * @param request HTTP request.
 * @param trustProxy Whether the relay sits behind a trusted proxy.
 * @returns Public request URL.
 */
export function transferHttpPublicUrl(request: Request, trustProxy: boolean): URL {
  const url = new URL(request.url);
  if (trustProxy && request.headers.get('x-forwarded-proto') === 'https') url.protocol = 'https:';
  return url;
}

/**
 * Streams a `GET`, the whole file or one requested range.
 *
 * @param download Download whose info arrived.
 * @param header `Range` header, or null.
 * @param size File size.
 * @param headers Headers of the whole file.
 * @returns 200, 206 or 416 response.
 */
function transferHttpGet(
  download: TransferDownload,
  header: string | null,
  size: number,
  headers: Record<string, string>,
): Response {
  if (header === null) return new Response(transferStreamCreate(download), { headers });
  const range = transferHttpRange(header, size);
  if (range === null) {
    transferDownloadEnd(download, null);
    return transferHttpStatus(416, 0, { 'Content-Range': `bytes */${size}` });
  }
  transferDownloadRange(download, range.start, range.end);
  const partial = { 'Content-Range': `bytes ${range.start}-${range.end - 1}/${size}` };
  Object.assign(headers, partial, { 'Content-Length': String(range.end - range.start) });
  return new Response(transferStreamCreate(download), { status: 206, headers });
}

/**
 * Parses a single `bytes=` range against the file size.
 *
 * @param header `Range` header value.
 * @param size File size.
 * @returns First byte and end (exclusive), or null when invalid, unsatisfiable
 *   or more than one range.
 */
export function transferHttpRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null || (match[1] === '' && match[2] === '')) return null;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    return suffix > 0 && size > 0 ? { start: Math.max(0, size - suffix), end: size } : null;
  }
  const start = Number(match[1]);
  const last = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  return start < size && start <= last ? { start, end: last + 1 } : null;
}

/**
 * Builds the headers of a served file.
 *
 * @param info Announced size, name and type.
 * @param link Link id, the fallback name.
 * @param inline False for `?download`.
 * @returns Headers.
 */
export function transferHttpHeaders(
  info: { size: number; name: string; mime: string },
  link: string,
  inline: boolean,
): Record<string, string> {
  const mime = transferMimeSanitize(info.mime);
  const shown = inline && transferInlineAllowed(mime);
  return {
    ...TRANSFER_HEADERS_COMMON,
    'Content-Security-Policy': shown && mime === 'application/pdf' ? TRANSFER_CSP : `${TRANSFER_CSP}; sandbox`,
    'Content-Type': mime,
    'Content-Length': String(info.size),
    'Content-Disposition': transferHttpDisposition(transferNameSanitize(info.name, link), shown),
    'Accept-Ranges': 'bytes',
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
 * Returns whether a type opens inline: raster images, video, audio and PDF,
 * never SVG, HTML, XML, scripts or other active types.
 *
 * @param mime Sanitized type.
 * @returns True when inline is allowed.
 */
export function transferInlineAllowed(mime: string): boolean {
  return TRANSFER_INLINE_TYPES.has(mime) || mime.startsWith('audio/');
}

/** True when the crawler User-Agent looks like Discord's link preview bot. */
export function transferHttpIsDiscordbot(request: Request): boolean {
  return /Discordbot/i.test(request.headers.get('user-agent') ?? '');
}

/** True when the client asked for the raw byte stream instead of an HTML card. */
export function transferHttpWantsRaw(url: URL): boolean {
  return url.searchParams.has('raw') || url.searchParams.has('download');
}

/**
 * True for safe raster images that Discord embeds from a direct media URL. SVG
 * and other active image types are excluded.
 *
 * @param mime Announced MIME type.
 * @returns True when Discordbot should receive raw bytes.
 */
export function transferHttpIsSafeRasterImage(mime: string): boolean {
  const sanitized = transferMimeSanitize(mime);
  return sanitized.startsWith('image/') && sanitized !== 'image/svg+xml';
}

/**
 * Absolute URL of the raw media bytes for Open Graph tags (`?raw=1`).
 *
 * @param requestUrl Request URL of the transfer link.
 * @returns Absolute raw URL.
 */
export function transferHttpRawUrl(requestUrl: URL): string {
  const raw = new URL(requestUrl.href);
  raw.search = '';
  raw.searchParams.set('raw', '1');
  return raw.toString();
}

/**
 * Absolute URL of the PNG preview for Open Graph tags (`?thumbnail`), or null
 * when the file type has no preview.
 *
 * @param requestUrl Request URL of the transfer link.
 * @param name Sanitized file name.
 * @returns Absolute thumbnail URL, or null.
 */
export function transferHttpThumbnailUrl(requestUrl: URL, name: string): string | null {
  const lower = name.toLowerCase();
  if (!TRANSFER_THUMBNAIL_EXTENSIONS.some((extension) => lower.endsWith(extension))) return null;
  const thumbnail = new URL(requestUrl.href);
  thumbnail.search = 'thumbnail';
  return thumbnail.toString();
}

/**
 * Escapes text for an HTML attribute value.
 *
 * @param value Raw text.
 * @returns Escaped text.
 */
function transferHttpEscapeAttr(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/"/gu, '&quot;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

/**
 * Builds a tiny Open Graph HTML card for Discord's crawler for non-image
 * transfers. Metadata comes from the owner's announcement only. `?raw=1` in the
 * body link avoids recursive HTML cards when Discord follows the file. Filename
 * is the title; description is the human size (no MIME chatter).
 *
 * @param requestUrl Incoming request URL.
 * @param info Announced size, name and type.
 * @param link Link id.
 * @param headOnly True for HEAD.
 * @returns HTML (or empty-body HEAD) response.
 */
export function transferHttpDiscordUnfurl(
  requestUrl: URL,
  info: { size: number; name: string; mime: string },
  link: string,
  headOnly: boolean,
): Response {
  const name = transferNameSanitize(info.name, link);
  const rawUrl = transferHttpRawUrl(requestUrl);
  const title = transferHttpEscapeAttr(name);
  const description = transferHttpEscapeAttr(transferHttpHumanSize(info.size));
  const pageUrl = transferHttpEscapeAttr(requestUrl.toString().split('?')[0] ?? requestUrl.toString());
  const tags: string[] = [
    '<meta charset="utf-8">',
    '<meta property="og:site_name" content="AiWorldEd">',
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    `<meta property="og:url" content="${pageUrl}">`,
    '<meta property="og:type" content="website">',
    '<meta name="theme-color" content="#F5A623">',
    ...transferHttpDiscordImageTags(transferHttpThumbnailUrl(requestUrl, name)),
  ];
  const body =
    `<!doctype html><html><head>${tags.join('')}<title>${title}</title></head>` +
    `<body><p>${title}</p><p>${description}</p>` +
    `<p><a href="${transferHttpEscapeAttr(rawUrl)}">Open file</a></p></body></html>\n`;
  const headers = {
    ...TRANSFER_HEADERS_COMMON,
    'Content-Security-Policy': `${TRANSFER_CSP}; sandbox`,
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': String(new TextEncoder().encode(body).byteLength),
  };
  return new Response(headOnly ? null : body, { status: 200, headers });
}

/**
 * Returns the card's image tags: a large preview image when there is one.
 *
 * @param thumbnailUrl Absolute thumbnail URL, or null.
 * @returns Meta tags.
 */
function transferHttpDiscordImageTags(thumbnailUrl: string | null): string[] {
  if (thumbnailUrl === null) return ['<meta name="twitter:card" content="summary">'];
  const image = transferHttpEscapeAttr(thumbnailUrl);
  return [
    `<meta property="og:image" content="${image}">`,
    '<meta property="og:image:type" content="image/png">',
    '<meta name="twitter:card" content="summary_large_image">',
  ];
}

/**
 * Formats a byte size for Open Graph descriptions.
 *
 * @param bytes Size.
 * @returns Short size text.
 */
function transferHttpHumanSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  let value = bytes / 1000;
  const units = ['KB', 'MB', 'GB'];
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(2)} ${units[unit]}`;
}

/**
 * Returns the human-readable message of a refused download.
 *
 * @param status HTTP status.
 * @param sizeMaximum Size cap in bytes, for 413.
 * @returns Message.
 */
export function transferHttpStatusText(status: number, sizeMaximum: number): string {
  const limit = `${Math.round((sizeMaximum / 1048576) * 100) / 100} MiB`;
  return (TRANSFER_STATUS_TEXT[status] ?? 'The download failed.').replace('{limit}', limit);
}

/**
 * Builds a small HTML error page.
 *
 * @param status HTTP status.
 * @param sizeMaximum Size cap in bytes, for 413.
 * @param extra Extra headers.
 * @returns Response.
 */
function transferHttpStatus(status: number, sizeMaximum = 0, extra: Record<string, string> = {}): Response {
  const csp = `${TRANSFER_CSP}; sandbox`;
  const headers = {
    ...TRANSFER_HEADERS_COMMON,
    'Content-Security-Policy': csp,
    'Content-Type': 'text/html; charset=utf-8',
    ...extra,
  };
  if (status === 405) Object.assign(headers, { Allow: 'GET, HEAD, OPTIONS' });
  if (status === 503) Object.assign(headers, { 'Retry-After': '5' });
  const text = transferHttpStatusText(status, sizeMaximum);
  const body = `<!doctype html><meta charset="utf-8"><title>${status}</title><p>${text}</p>\n`;
  return new Response(body, { status, headers });
}
