/**
 * Browser MCP messages of a listening editor (capability `mcp`): listening on a
 * token, stopping, and answering forwarded JSON-RPC requests. See src/mcp/ for
 * the queue and src/server/server_mcp_http.ts for the HTTP side.
 */
import { sessionSend, sessionSendError, type ConnectionSession } from '../connection/connection_session.ts';
import type { ServerCore } from '../server/server_core.ts';
import type { ClientMessage } from '../shared/protocol_definitions.ts';
import { abuseRecord } from './handler_abuse.ts';

/** Capability a connection must agree on before sending `mcp.*`. */
export const MCP_CAPABILITY = 'mcp';

/** Client browser MCP messages. */
type McpClientMessage = Extract<ClientMessage, { t: 'mcp.listen' | 'mcp.unlisten' | 'mcp.response' }>;

/** Abuse points for an answer no request waits for. */
const MCP_ABUSE_POINTS_STALE = 1;

/**
 * Handles browser MCP messages, leaving unrelated messages to other handlers.
 *
 * @param core Relay core.
 * @param session Sender.
 * @param message Validated client message.
 * @returns Whether the message was a browser MCP message.
 */
export function handlerMcpControl(core: ServerCore, session: ConnectionSession, message: ClientMessage): boolean {
  if (message.t !== 'mcp.listen' && message.t !== 'mcp.unlisten' && message.t !== 'mcp.response') return false;
  handlerMcp(core, session, message);
  return true;
}

/**
 * Routes a browser MCP message; only sessions that agreed on `mcp` may send
 * them.
 *
 * @param core Relay core.
 * @param session Sender.
 * @param message Validated message.
 */
function handlerMcp(core: ServerCore, session: ConnectionSession, message: McpClientMessage): void {
  if (!session.protocol.caps.has(MCP_CAPABILITY)) return core.violation(session, 'mcp capability not agreed');
  if (message.t === 'mcp.listen') return mcpListen(core, session, message.token, message.r);
  if (message.t === 'mcp.unlisten') return core.mcp.unlisten(session);
  if (core.mcp.ofSession(session)?.answer(message.q, message.body) !== true) {
    abuseRecord(core, session, MCP_ABUSE_POINTS_STALE, 'unexpected mcp response');
  }
}

/**
 * Handles `mcp.listen`: replies `mcp.listening`, or `mcp_token_in_use` while
 * another connection listens on the token.
 *
 * @param core Relay core.
 * @param session Sender.
 * @param token Validated token.
 * @param r Request id.
 */
function mcpListen(core: ServerCore, session: ConnectionSession, token: string, r: number | undefined): void {
  if (!core.mcp.listen(session, token)) return sessionSendError(session, 'mcp_token_in_use', r);
  sessionSend(session, { t: 'mcp.listening', ...(r === undefined ? {} : { r }) });
}
