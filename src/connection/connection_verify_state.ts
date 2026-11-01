/**
 * Per-member state of owner verification: the one open query, the lock and edit
 * messages held behind it, its rate limit and how often the owner refuted the
 * member.
 */
import { LimiterTokenBucket } from '../network/limiter_token_bucket.ts';
import type { Room } from '../rooms/room.ts';
import type { ClientMessage, VerifyDenial } from '../shared/protocol_definitions.ts';

/** Outcome of a query: confirmed, or the reason it was refused. */
export type ConnectionVerifyOutcome = 'ok' | VerifyDenial;

/** Lock and edit messages that wait while a query is open. */
export type ConnectionVerifyHeldMessage = Extract<ClientMessage, { t: 'lock.acquire' | 'lock.release' | 'edit' }>;

/** One held message and its frame size. */
interface ConnectionVerifyHeld {
  readonly message: ConnectionVerifyHeldMessage;
  readonly bytes: number;
}

/** The open query of a member. */
export interface ConnectionVerifyPending {
  readonly room: Room;
  readonly query: number;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly resume: (outcome: ConnectionVerifyOutcome) => void;
}

/** Limits of one member's verification state. */
export interface ConnectionVerifyLimits {
  perSecond: number;
  burst: number;
  heldMessagesMaximum: number;
  heldBytesMaximum: number;
}

/** Verification state of one connection. */
export class ConnectionVerifyState {
  pending: ConnectionVerifyPending | null = null;
  /**
   * Owner answers that refuted this member's claims, kept for a future kick
   * rule.
   */
  refuted = 0;
  readonly bucket: LimiterTokenBucket;
  private readonly held: ConnectionVerifyHeld[] = [];
  private heldBytes = 0;

  /**
   * Creates an idle state.
   *
   * @param limits Rate and held message limits.
   */
  constructor(private readonly limits: ConnectionVerifyLimits) {
    this.bucket = new LimiterTokenBucket(limits.perSecond, limits.burst);
  }

  /**
   * Holds a message until the open query is answered.
   *
   * @param message Lock or edit message.
   * @param bytes Frame size.
   * @returns False when the held messages would exceed their limits.
   */
  hold(message: ConnectionVerifyHeldMessage, bytes: number): boolean {
    if (this.held.length >= this.limits.heldMessagesMaximum) return false;
    if (this.heldBytes + bytes > this.limits.heldBytesMaximum) return false;
    this.held.push({ message, bytes });
    this.heldBytes += bytes;
    return true;
  }

  /**
   * Takes the oldest held message.
   *
   * @returns The message, or undefined when none is held.
   */
  next(): ConnectionVerifyHeldMessage | undefined {
    const first = this.held.shift();
    if (first === undefined) return undefined;
    this.heldBytes -= first.bytes;
    return first.message;
  }

  /**
   * Counts the held messages.
   *
   * @returns Number of held messages.
   */
  heldCount(): number {
    return this.held.length;
  }

  /** Drops every held message. */
  heldClear(): void {
    this.held.length = 0;
    this.heldBytes = 0;
  }
}
