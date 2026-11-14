/**
 * Browser MCP tokens with the editor connection listening on each (one token
 * per connection, one connection per token) and the inbound byte windows of the
 * client addresses currently sending requests.
 */
import type { ConnectionSession } from '../connection/connection_session.ts';
import { CustomWindow } from '../forks/custom_window.ts';
import { McpListener } from './mcp_listener.ts';

/** Byte window of one client address and how many requests use it. */
interface McpAddressWindow {
  readonly window: CustomWindow;
  users: number;
}

/** Every listening token of the relay. */
export class McpListenerRegistry {
  private readonly listenersByToken = new Map<string, McpListener>();
  private readonly listenersByUser = new Map<number, McpListener>();
  private readonly addressWindows = new Map<string, McpAddressWindow>();

  /**
   * Creates the registry.
   *
   * @param queuedMaximum Requests that may wait per token behind the one in
   *   flight.
   */
  constructor(private readonly queuedMaximum: number) {}

  /**
   * Makes a connection the listener of a token, ending a listener it had on
   * another token.
   *
   * @param session Editor connection.
   * @param token Validated token.
   * @returns False when another connection already listens on the token.
   */
  listen(session: ConnectionSession, token: string): boolean {
    const holder = this.listenersByToken.get(token);
    if (holder !== undefined) return holder.session === session;
    this.unlisten(session);
    const listener = new McpListener(token, session, this.queuedMaximum);
    this.listenersByToken.set(token, listener);
    this.listenersByUser.set(session.user, listener);
    return true;
  }

  /**
   * Stops a connection listening; its running and queued requests get 503.
   *
   * @param session Editor connection.
   */
  unlisten(session: ConnectionSession): void {
    const listener = this.listenersByUser.get(session.user);
    if (listener === undefined || listener.session !== session) return;
    this.listenersByUser.delete(session.user);
    this.listenersByToken.delete(listener.token);
    listener.close();
  }

  /**
   * Finds the listener of a token.
   *
   * @param token Validated token.
   * @returns Listener, or null when nobody listens on it.
   */
  find(token: string): McpListener | null {
    return this.listenersByToken.get(token) ?? null;
  }

  /**
   * Finds the listener a connection runs.
   *
   * @param session Editor connection.
   * @returns Listener, or null when the connection does not listen.
   */
  ofSession(session: ConnectionSession): McpListener | null {
    const listener = this.listenersByUser.get(session.user);
    return listener?.session === session ? listener : null;
  }

  /**
   * Returns the byte window of a client address for one more request.
   *
   * @param ipKey Address limit key.
   * @returns Shared window of the address.
   */
  addressWindowAcquire(ipKey: string): CustomWindow {
    let entry = this.addressWindows.get(ipKey);
    if (entry === undefined) {
      entry = { window: new CustomWindow(), users: 0 };
      this.addressWindows.set(ipKey, entry);
    }
    entry.users += 1;
    return entry.window;
  }

  /**
   * Gives back an address window after a request; an unused window that holds
   * no recent bytes is dropped.
   *
   * @param ipKey Address limit key.
   */
  addressWindowRelease(ipKey: string): void {
    const entry = this.addressWindows.get(ipKey);
    if (entry === undefined) return;
    entry.users -= 1;
    if (entry.users <= 0 && entry.window.isEmpty()) this.addressWindows.delete(ipKey);
  }

  /** Drops address windows no request uses and that hold no recent bytes. */
  prune(): void {
    for (const [ipKey, entry] of this.addressWindows) {
      if (entry.users <= 0 && entry.window.isEmpty()) this.addressWindows.delete(ipKey);
    }
  }
}
