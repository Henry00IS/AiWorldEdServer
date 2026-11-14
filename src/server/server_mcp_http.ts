/**
 * Plain HTTP side of browser MCP: `<WEBSOCKET_PATH>/mcp/<token>` forwards each
 * JSON-RPC `POST` to the editor listening on the token and returns its answer,
 * like the desktop editor's local MCP server does. Malformed, unknown and
 * not-listening tokens all get the relay's plain 404. Bodies are read as a
 * throttled stream (see src/mcp/mcp_body_reader.ts) with a size cap, one
 * request in flight per token, a short queue and a time limit.
 */
import { MCP_PATH_SEGMENT, MCP_TOKEN_PATTERN } from '../shared/protocol_definitions.ts';
import type { McpListener, McpTicket } from '../mcp/mcp_listener.ts';
import { mcpBodyRead } from '../mcp/mcp_body_reader.ts';
import { mcpAbortableWait, mcpAbortReason } from '../mcp/mcp_request_abort.ts';
import { ipLimitKey, ipNormalize, requestTrustResolve } from '../network/trust_forwarded_request.ts';
import type { ServerCore } from './server_core.ts';

/**
 * Bytes kept free below the WebSocket payload limit for the `mcp.request`
 * envelope around a body.
 */
export const MCP_ENVELOPE_BYTES = 1024;

/**
 * CORS headers of every answer of a listening token, as the desktop server
 * sends.
 */
const MCP_HEADERS_CORS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, mcp-protocol-version, mcp-session-id, last-event-id',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Cache-Control': 'no-store',
};

/** Messages of refused requests. */
const MCP_STATUS_TEXT: Readonly<Record<number, string>> = {
  400: 'The request body is not valid UTF-8.',
  405: 'Method not allowed.',
  413: 'The request body is too large.',
  429: 'Too many requests for this editor, try again shortly.',
  503: 'The editor stopped listening.',
  504: 'The editor did not answer in time.',
};

/**
 * Returns the URL path prefix of browser MCP, e.g. `/ws/mcp/`.
 *
 * @param websocketPath Configured WebSocket path.
 * @returns Prefix ending in a slash.
 */
export function mcpHttpPrefix(websocketPath: string): string {
  return `${websocketPath.replace(/\/+$/, '')}/${MCP_PATH_SEGMENT}/`;
}

/**
 * Returns the largest accepted request body.
 *
 * @param maxPayloadBytes Configured WebSocket payload limit.
 * @returns Body size cap in bytes.
 */
export function mcpHttpBodyBytesMaximum(maxPayloadBytes: number): number {
  return Math.max(0, maxPayloadBytes - MCP_ENVELOPE_BYTES);
}

/**
 * Answers a request on a browser MCP path. The token is checked before anything
 * else.
 *
 * @param core Relay core.
 * @param request HTTP request.
 * @param token Path rest after the prefix.
 * @param socketAddress Remote address of the TCP peer.
 * @returns Response.
 */
export async function mcpHttpServe(
  core: ServerCore,
  request: Request,
  token: string,
  socketAddress: string,
): Promise<Response> {
  const listener = MCP_TOKEN_PATTERN.test(token) ? core.mcp.find(token) : null;
  if (listener === null) return new Response('not found\n', { status: 404 });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: MCP_HEADERS_CORS });
  if (request.method === 'GET') return mcpHttpJson(200, { ok: true, message: MCP_GET_HINT });
  if (request.method !== 'POST') return mcpHttpStatus(405);
  return mcpHttpPost(core, request, listener, mcpHttpAddressKey(core, request, socketAddress));
}

/** Hint a `GET` of a listening token returns, the same as the desktop server. */
const MCP_GET_HINT = 'AiWorldEd MCP endpoint. Use POST for JSON-RPC.';

/**
 * Returns the limit key of the client address, honouring a trusted proxy.
 *
 * @param core Relay core.
 * @param request HTTP request.
 * @param socketAddress Remote address of the TCP peer.
 * @returns Address limit key.
 */
function mcpHttpAddressKey(core: ServerCore, request: Request, socketAddress: string): string {
  const trust = requestTrustResolve(request.headers, socketAddress, core.config);
  return ipLimitKey(trust.kind === 'rejected' ? ipNormalize(socketAddress) : trust.clientIp);
}

/**
 * Queues a `POST`, then runs it within the time limit.
 *
 * @param core Relay core.
 * @param request HTTP request.
 * @param listener Listener of the token.
 * @param ipKey Client address limit key.
 * @returns Editor answer or refusal.
 */
async function mcpHttpPost(
  core: ServerCore,
  request: Request,
  listener: McpListener,
  ipKey: string,
): Promise<Response> {
  const bytesMaximum = mcpHttpBodyBytesMaximum(core.config.maxPayloadBytes);
  if (mcpHttpDeclaredLength(request) > bytesMaximum) return mcpHttpStatus(413);
  const controller = new AbortController();
  const ticket = listener.ticketEnter(controller);
  if (ticket === null) return mcpHttpStatus(429, { 'Retry-After': '1' });
  const timer = setTimeout(() => controller.abort('timeout'), core.config.mcpRequestTimeoutMs);
  request.signal.addEventListener('abort', () => controller.abort('client'), { once: true });
  const addressWindow = core.mcp.addressWindowAcquire(ipKey);
  try {
    return await mcpHttpExchange(core, request, listener, ticket, [listener.window, addressWindow]);
  } finally {
    clearTimeout(timer);
    listener.ticketLeave(ticket);
    core.mcp.addressWindowRelease(ipKey);
  }
}

/**
 * Waits for the request's turn, reads its body at the limited rate, forwards it
 * and returns the editor's answer.
 *
 * @param core Relay core.
 * @param request HTTP request.
 * @param listener Listener of the token.
 * @param ticket Queue ticket of the request.
 * @param windows Byte windows of the token and the client address.
 * @returns 200 with the answer, 202 for a notification, or a refusal.
 */
async function mcpHttpExchange(
  core: ServerCore,
  request: Request,
  listener: McpListener,
  ticket: McpTicket,
  windows: McpBodyWindows,
): Promise<Response> {
  const signal = ticket.controller.signal;
  if ((await mcpAbortableWait(ticket.turn, signal)) === null) return mcpHttpAborted(signal);
  const bytesMaximum = mcpHttpBodyBytesMaximum(core.config.maxPayloadBytes);
  const bytesPerSecond = core.config.mcpBytesPerSecond;
  const body = await mcpBodyRead(request.body, { bytesMaximum, bytesPerSecond, windows, signal });
  if (!body.ok) return body.status === 'aborted' ? mcpHttpAborted(signal) : mcpHttpStatus(body.status);
  const answer = await listener.forward(body.text, signal);
  if (answer === null) return mcpHttpAborted(signal);
  if (answer === '') return new Response(null, { status: 202, headers: MCP_HEADERS_CORS });
  return new Response(answer, { headers: { ...MCP_HEADERS_CORS, 'Content-Type': 'application/json' } });
}

/** Byte windows charged for a request body: the token's, then the address's. */
type McpBodyWindows = Parameters<typeof mcpBodyRead>[1]['windows'];

/**
 * Returns the body size the client declared.
 *
 * @param request HTTP request.
 * @returns Declared `Content-Length`, or 0 when absent or unreadable.
 */
function mcpHttpDeclaredLength(request: Request): number {
  const declared = Number(request.headers.get('content-length') ?? '0');
  return Number.isFinite(declared) ? declared : 0;
}

/**
 * Answers an aborted request: 504 after the time limit, else 503.
 *
 * @param signal Aborted request signal.
 * @returns Refusal.
 */
function mcpHttpAborted(signal: AbortSignal): Response {
  return mcpHttpStatus(mcpAbortReason(signal) === 'timeout' ? 504 : 503);
}

/**
 * Builds a JSON refusal with the CORS headers.
 *
 * @param status HTTP status.
 * @param extra Extra headers.
 * @returns Response.
 */
function mcpHttpStatus(status: number, extra: Record<string, string> = {}): Response {
  return mcpHttpJson(status, { error: MCP_STATUS_TEXT[status] ?? 'The request failed.' }, extra);
}

/**
 * Builds a JSON response with the CORS headers.
 *
 * @param status HTTP status.
 * @param body Response object.
 * @param extra Extra headers.
 * @returns Response.
 */
function mcpHttpJson(status: number, body: object, extra: Record<string, string> = {}): Response {
  const headers = { ...MCP_HEADERS_CORS, 'Content-Type': 'application/json', ...extra };
  return new Response(JSON.stringify(body), { status, headers });
}
