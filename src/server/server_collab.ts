/** Bun.serve wiring: HTTP upgrade gatekeeping and WebSocket event forwarding. */
import type { Server, ServerWebSocket, WebSocketHandler } from 'bun';
import type { ServerConfiguration } from '../config/server_configuration.ts';
import type { ConnectionSession, ConnectionUpgradeData } from '../connection/connection_session.ts';
import { originIsAllowed } from '../network/origin_policy.ts';
import { ipLimitKey, requestTrustResolve } from '../network/trust_forwarded_request.ts';
import { ServerCore } from './server_core.ts';

/** Data attached to each Bun WebSocket. */
interface SocketData extends ConnectionUpgradeData {
  session: ConnectionSession | null;
}

/** Running relay handle. */
export interface CollabServer {
  readonly port: number;
  readonly core: ServerCore;
  stop(): Promise<void>;
}

/**
 * Starts the relay.
 *
 * @param config Effective configuration.
 * @returns Handle with the bound port and a stop function.
 */
export function collabServerStart(config: ServerConfiguration): CollabServer {
  const core = new ServerCore(config);
  const server = Bun.serve<SocketData, never>({
    hostname: config.hostname,
    port: config.port,
    fetch: (request, bunServer) => collabServerFetch(core, request, bunServer),
    websocket: collabWebSocketHandler(core, config),
  });
  return {
    port: server.port ?? config.port,
    core,
    stop: async () => {
      core.shutdown();
      await server.stop(true);
    },
  };
}

/**
 * Builds the Bun WebSocket options that forward socket events to the core.
 *
 * @param core Relay core.
 * @param config Effective configuration.
 * @returns WebSocket handler options.
 */
function collabWebSocketHandler(core: ServerCore, config: ServerConfiguration): WebSocketHandler<SocketData> {
  return {
    maxPayloadLength: config.maxPayloadBytes,
    idleTimeout: config.idleTimeoutSeconds,
    sendPings: true,
    perMessageDeflate: false,
    backpressureLimit: config.socketBufferHighWaterBytes * 4,
    closeOnBackpressureLimit: false,
    open: (socket) => collabSocketOpen(core, socket),
    message: (socket, message) => {
      if (socket.data.session) core.sessionMessage(socket.data.session, message);
    },
    drain: (socket) => {
      if (socket.data.session) core.sessionDrain(socket.data.session);
    },
    close: (socket) => collabSocketClose(core, socket),
  };
}

/**
 * Handles plain HTTP requests: health check, and gatekeeping of upgrades.
 *
 * @param core Relay core.
 * @param request HTTP request.
 * @param server Bun server.
 * @returns Response, or undefined after a successful upgrade.
 */
function collabServerFetch(core: ServerCore, request: Request, server: Server<SocketData>): Response | undefined {
  const url = new URL(request.url);
  if (url.pathname === '/healthz' && request.method === 'GET') return new Response('ok\n');
  if (url.pathname !== core.config.websocketPath) return new Response('not found\n', { status: 404 });
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
    return new Response('websocket upgrade required\n', { status: 426 });
  const upgradeData = collabUpgradeAdmit(core, request, server);
  if (upgradeData instanceof Response) return upgradeData;
  if (server.upgrade(request, { data: upgradeData })) return undefined;
  core.connectionsPerIpKey.release(upgradeData.ipKey);
  return new Response('upgrade failed\n', { status: 400 });
}

/**
 * Applies trust, Origin and connection limits to an upgrade request.
 *
 * @param core Relay core.
 * @param request Upgrade request.
 * @param server Bun server.
 * @returns Socket data on success, or the rejection response.
 */
function collabUpgradeAdmit(core: ServerCore, request: Request, server: Server<SocketData>): SocketData | Response {
  const socketAddress = server.requestIP(request)?.address ?? '0.0.0.0';
  const trust = requestTrustResolve(request.headers, socketAddress, core.config.forwardedSecret);
  if (trust.kind === 'rejected') return new Response('forbidden\n', { status: 403 });
  if (!originIsAllowed(request.headers.get('origin'), core.config.allowedOrigins))
    return new Response('origin not allowed\n', { status: 403 });
  const ipKey = ipLimitKey(trust.clientIp);
  if (!core.connectionReserve(ipKey)) return new Response('too many connections\n', { status: 429 });
  return { clientIp: trust.clientIp, ipKey, via: trust.kind === 'proxied' ? 'proxy' : 'direct', session: null };
}

/**
 * Creates the session for a new socket.
 *
 * @param core Relay core.
 * @param socket Bun socket.
 */
function collabSocketOpen(core: ServerCore, socket: ServerWebSocket<SocketData>): void {
  socket.data.session = core.sessionOpen(
    {
      send: (data) => socket.send(data),
      getBufferedAmount: () => socket.getBufferedAmount(),
      close: (code, reason) => socket.close(code, reason),
    },
    socket.data,
  );
}

/**
 * Cleans up after a socket closed.
 *
 * @param core Relay core.
 * @param socket Bun socket.
 */
function collabSocketClose(core: ServerCore, socket: ServerWebSocket<SocketData>): void {
  if (socket.data.session) core.sessionClosed(socket.data.session);
  else core.connectionsPerIpKey.release(socket.data.ipKey);
}
