/** Bounded, fail-closed owner approval before membership exists. */
import { compatibilityHomeUrl } from '../shared/compatibility_identity.ts';
import type {
  CompatibilityIdentity,
  CompatibilityDecision,
  CompatibilityReason,
} from '../shared/compatibility_identity.ts';
import { sessionSend, type ConnectionSession } from '../connection/connection_session.ts';
import type { Room } from '../rooms/room.ts';

/** One pending owner approval. */
interface CompatibilityPending {
  room: Room;
  joiner: ConnectionSession;
  finish: (decision: CompatibilityDecision) => void;
}

/** Unique per-process queries with one pending request per connection. */
export class CompatibilityChecks {
  private sequence = 0;
  private readonly pending = new Map<number, CompatibilityPending>();

  /**
   * Asks only the owner to compare a joiner's identity.
   *
   * @param room Target room.
   * @param joiner Pending non-member.
   * @param identity Joiner's bounded strings.
   * @param timeoutMs Fail-closed deadline.
   * @param maximum Maximum pending queries per room.
   * @returns Whether the owner explicitly approved.
   */
  request(
    room: Room,
    joiner: ConnectionSession,
    identity: CompatibilityIdentity | undefined,
    timeoutMs: number,
    maximum: number,
  ): Promise<CompatibilityDecision> {
    if (!identity || room.owner.closed) return Promise.resolve({ allow: false, reason: 'incompatible_client' });
    if (!this.available(room, joiner, maximum)) return Promise.resolve({ allow: false, reason: 'incompatible_client' });
    const q = this.idNext();
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish({ allow: false, reason: 'owner_timeout' }), timeoutMs);
      /**
       * Completes and removes this query. @param decision Explicit approval and
       * bounded reason.
       */
      const finish = (decision: CompatibilityDecision): void => {
        clearTimeout(timer);
        this.pending.delete(q);
        resolve(decision);
      };
      this.pending.set(q, { room, joiner, finish });
      sessionSend(room.owner, { t: 'compatibility.check', q, compatibility: identity });
    });
  }

  /**
   * Checks pending-room and per-joiner resource limits.
   *
   * @param room Target room.
   * @param joiner Pending session.
   * @param maximum Room query cap.
   * @returns Whether another query fits.
   */
  private available(room: Room, joiner: ConnectionSession, maximum: number): boolean {
    const pending = [...this.pending.values()];
    if (pending.some((entry) => entry.joiner === joiner)) return false;
    const roomPending = pending.filter((entry) => entry.room === room);
    if (roomPending.length >= maximum) roomPending[0]?.finish({ allow: false, reason: 'owner_timeout' });
    return true;
  }

  /**
   * Accepts a verdict only from the owner to whom this query was sent.
   *
   * @param sender Answering session.
   * @param q Query id.
   * @param allow Explicit owner decision.
   * @param reason Bounded public refusal reason.
   * @param homeUrl Untrusted owner editor URL, sanitized on refusal.
   */
  result(sender: ConnectionSession, q: number, allow: boolean, reason?: CompatibilityReason, homeUrl?: string): void {
    const entry = this.pending.get(q);
    const safeUrl = compatibilityHomeUrl(homeUrl);
    if (entry?.room.owner === sender && !entry.room.closed)
      entry.finish({
        allow,
        ...(reason ? { reason } : {}),
        ...(!allow && safeUrl ? { homeUrl: safeUrl } : {}),
      });
  }

  /**
   * Denies pending joins when their joiner or owner leaves.
   *
   * @param session Departing session.
   */
  cancel(session: ConnectionSession): void {
    for (const entry of this.pending.values()) {
      if (entry.joiner === session || entry.room.owner === session)
        entry.finish({ allow: false, reason: entry.room.owner === session ? 'owner_left' : 'incompatible_client' });
    }
  }

  /** Allocates a fresh query id. @returns Unused u32 query id. */
  private idNext(): number {
    do {
      this.sequence = this.sequence >= 0xffffffff ? 1 : this.sequence + 1;
    } while (this.pending.has(this.sequence));
    return this.sequence;
  }
}
