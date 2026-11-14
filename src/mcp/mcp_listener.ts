/**
 * One editor connection listening for browser MCP requests on its token: the
 * request queue (one in flight, a few waiting), the token's inbound byte window
 * and the requests forwarded to the editor that wait for its answer.
 */
import { sessionSend, type ConnectionSession } from '../connection/connection_session.ts';
import { CustomWindow } from '../forks/custom_window.ts';
import type { McpRequestMessage } from '../shared/protocol_definitions.ts';
import { mcpAbortableWait } from './mcp_request_abort.ts';

/** Place of one HTTP request in a listener's queue. */
export interface McpTicket {
  /** Aborts every wait of the request. */
  readonly controller: AbortController;
  /** Resolves when the request is the one in flight. */
  readonly turn: Promise<true>;
  /** Makes the request the one in flight. */
  readonly turnStart: () => void;
}

/** Listening editor of one browser MCP token. */
export class McpListener {
  /** Request body bytes accepted for this token in the last second. */
  readonly window = new CustomWindow();
  private readonly tickets: McpTicket[] = [];
  private readonly answersPending = new Map<number, (body: string) => void>();
  private queryLast = 0;

  /**
   * Creates the listener of a token.
   *
   * @param token Browser MCP token.
   * @param session Listening editor connection.
   * @param queuedMaximum Requests that may wait behind the one in flight.
   */
  constructor(
    readonly token: string,
    readonly session: ConnectionSession,
    private readonly queuedMaximum: number,
  ) {}

  /**
   * Queues an HTTP request; the first one is in flight at once.
   *
   * @param controller Abort controller of the request.
   * @returns Ticket, or null when the queue is full (429).
   */
  ticketEnter(controller: AbortController): McpTicket | null {
    if (this.tickets.length > this.queuedMaximum) return null;
    const { promise, resolve } = Promise.withResolvers<true>();
    const ticket: McpTicket = { controller, turn: promise, turnStart: () => resolve(true) };
    this.tickets.push(ticket);
    if (this.tickets.length === 1) ticket.turnStart();
    return ticket;
  }

  /**
   * Removes a finished request and lets the next one fly.
   *
   * @param ticket Ticket of the finished request.
   */
  ticketLeave(ticket: McpTicket): void {
    const index = this.tickets.indexOf(ticket);
    if (index < 0) return;
    this.tickets.splice(index, 1);
    if (index === 0) this.tickets[0]?.turnStart();
  }

  /**
   * Sends the raw JSON-RPC request text to the editor and waits for its answer.
   *
   * @param body Raw request text.
   * @param signal Request signal.
   * @returns Raw response text (empty for a notification), or null once
   *   aborted.
   */
  async forward(body: string, signal: AbortSignal): Promise<string | null> {
    const q = this.queryNext();
    const { promise, resolve } = Promise.withResolvers<string>();
    this.answersPending.set(q, resolve);
    const request: McpRequestMessage = { t: 'mcp.request', q, body };
    sessionSend(this.session, request);
    const answer = await mcpAbortableWait(promise, signal);
    this.answersPending.delete(q);
    return answer;
  }

  /**
   * Delivers the editor's answer to the request waiting for it.
   *
   * @param q Relay request id.
   * @param body Raw response text.
   * @returns False when no request waits for this id.
   */
  answer(q: number, body: string): boolean {
    const resolve = this.answersPending.get(q);
    if (resolve === undefined) return false;
    this.answersPending.delete(q);
    resolve(body);
    return true;
  }

  /** Ends every queued and running request of the token (503). */
  close(): void {
    for (const ticket of this.tickets.splice(0)) ticket.controller.abort('closed');
    this.answersPending.clear();
  }

  /**
   * Allocates the next relay request id.
   *
   * @returns Request id in 1..0xffffffff.
   */
  private queryNext(): number {
    this.queryLast = this.queryLast >= 0xffffffff ? 1 : this.queryLast + 1;
    return this.queryLast;
  }
}
