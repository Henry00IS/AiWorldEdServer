/** Bun.serve wiring: HTTP upgrade gatekeeping and WebSocket event forwarding. */
import { transferHttpPrefix, transferHttpServe } from './server_transfer_http.ts';
import type { Server, ServerWebSocket, TLSOptions, WebSocketHandler } from 'bun';
import type { ServerConfiguration } from '../config/server_configuration.ts';
import type { ConnectionSession, ConnectionUpgradeData } from '../connection/connection_session.ts';
import { ServerCore } from './server_core.ts';
import { ServerRefusedSockets } from './server_refused_sockets.ts';
import { upgradeAdmissionDecide, type UpgradeRefusal } from './server_upgrade_admission.ts';

/** Data attached to each Bun WebSocket. */
interface SocketData extends ConnectionUpgradeData {
  session: ConnectionSession | null;
  /** Set for a refused upgrade that only stays open to send its close reason. */
  refusal: UpgradeRefusal | null;
}

/** Running relay handle. */
export interface CollabServer {
  readonly port: number;
  readonly core: ServerCore;
  stop(): Promise<void>;
}

/** Relay core plus the bounded count of refused sockets. */
interface CollabServerState {
  readonly core: ServerCore;
  readonly refusedSockets: ServerRefusedSockets;
}

/**
 * Starts the relay, serving wss:// itself when a TLS certificate is configured.
 *
 * @param config Effective configuration.
 * @returns Handle with the bound port and a stop function.
 */
export function collabServerStart(config: ServerConfiguration): CollabServer {
  const state: CollabServerState = {
    core: new ServerCore(config),
    refusedSockets: new ServerRefusedSockets(config.refusedSocketsMaximum),
  };
  const server = Bun.serve<SocketData, never>({
    hostname: config.hostname,
    port: config.port,
    ...collabServerTls(config),
    fetch: (request, bunServer) => collabServerFetch(state, request, bunServer),
    websocket: collabWebSocketHandler(state, config),
  });
  return collabServerHandle(state.core, server, config);
}

/**
 * Builds the TLS options from the configured PEM files.
 *
 * @param config Effective configuration.
 * @returns Serve options holding the TLS settings, or no options for plain
 *   ws://.
 */
function collabServerTls(config: ServerConfiguration): { tls?: TLSOptions } {
  if (config.tlsCertificateFile === null || config.tlsKeyFile === null) return {};
  return { tls: { cert: Bun.file(config.tlsCertificateFile), key: Bun.file(config.tlsKeyFile) } };
}

/**
 * Wraps the Bun server into the relay handle.
 *
 * @param core Relay core.
 * @param server Bun server.
 * @param config Effective configuration.
 * @returns Relay handle.
 */
function collabServerHandle(core: ServerCore, server: Server<SocketData>, config: ServerConfiguration): CollabServer {
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
 * @param state Relay state.
 * @param config Effective configuration.
 * @returns WebSocket handler options.
 */
function collabWebSocketHandler(state: CollabServerState, config: ServerConfiguration): WebSocketHandler<SocketData> {
  return {
    maxPayloadLength: config.maxPayloadBytes,
    idleTimeout: config.idleTimeoutSeconds,
    sendPings: true,
    perMessageDeflate: false,
    backpressureLimit: config.socketBufferHighWaterBytes * 4,
    closeOnBackpressureLimit: false,
    open: (socket) => collabSocketOpen(state.core, socket),
    message: (socket, message) => {
      if (socket.data.session) state.core.sessionMessage(socket.data.session, message);
    },
    drain: (socket) => {
      if (socket.data.session) state.core.sessionDrain(socket.data.session);
    },
    close: (socket) => collabSocketClose(state, socket),
  };
}

/**
 * Handles plain HTTP requests: health check, and gatekeeping of upgrades.
 *
 * @param state Relay state.
 * @param request HTTP request.
 * @param server Bun server.
 * @returns Response, or undefined after an upgrade.
 */
function collabServerFetch(
  state: CollabServerState,
  request: Request,
  server: Server<SocketData>,
): Response | Promise<Response> | undefined {
  const url = new URL(request.url);
  if (url.pathname === '/healthz' && request.method === 'GET') return new Response('ok\n');
  const transferPrefix = transferHttpPrefix(state.core.config.websocketPath);
  if (url.pathname.startsWith(transferPrefix))
    return transferHttpServe(state.core, request, url.pathname.slice(transferPrefix.length));
  if (url.pathname !== state.core.config.websocketPath) return new Response('not found\n', { status: 404 });
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
    return new Response('websocket upgrade required\n', { status: 426 });
  const socketAddress = server.requestIP(request)?.address ?? '0.0.0.0';
  const admission = upgradeAdmissionDecide(state.core, request.headers, socketAddress);
  if (admission.kind === 'refused') return collabUpgradeRefuse(state, request, server, admission.refusal);
  if (server.upgrade(request, { data: { ...admission.data, session: null, refusal: null } })) return undefined;
  state.core.connectionsPerIpKey.release(admission.data.ipKey);
  return new Response('upgrade failed\n', { status: 400 });
}

/**
 * Upgrades a refused request only to close it at once with a code and reason
 * the client can read (browsers hide HTTP errors of failed upgrades). When too
 * many refused sockets are open, answers with plain HTTP instead.
 *
 * @param state Relay state.
 * @param request Upgrade request.
 * @param server Bun server.
 * @param refusal Why the upgrade was refused.
 * @returns HTTP response, or undefined after the upgrade.
 */
function collabUpgradeRefuse(
  state: CollabServerState,
  request: Request,
  server: Server<SocketData>,
  refusal: UpgradeRefusal,
): Response | undefined {
  const plainResponse = new Response(`${refusal.reason}\n`, { status: refusal.httpStatus });
  if (!state.refusedSockets.tryAcquire()) return plainResponse;
  const data: SocketData = { clientIp: '', ipKey: '', via: 'direct', session: null, refusal };
  if (server.upgrade(request, { data })) return undefined;
  state.refusedSockets.release();
  return plainResponse;
}

/**
 * Creates the session for a new socket, or closes a refused socket with its
 * reason.
 *
 * @param core Relay core.
 * @param socket Bun socket.
 */
function collabSocketOpen(core: ServerCore, socket: ServerWebSocket<SocketData>): void {
  if (socket.data.refusal) return socket.close(socket.data.refusal.code, socket.data.refusal.reason);
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
 * @param state Relay state.
 * @param socket Bun socket.
 */
function collabSocketClose(state: CollabServerState, socket: ServerWebSocket<SocketData>): void {
  if (socket.data.refusal) state.refusedSockets.release();
  else if (socket.data.session) state.core.sessionClosed(socket.data.session);
  else state.core.connectionsPerIpKey.release(socket.data.ipKey);
}
