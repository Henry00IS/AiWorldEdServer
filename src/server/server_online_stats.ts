/**
 * Live count of open relay connections for members with the `stats` capability.
 * Changes are coalesced so a burst of connects and disconnects sends at most
 * one `stats` message per interval.
 */
import { sessionSend, type ConnectionSession } from '../connection/connection_session.ts';

/** Shortest time between two `stats` broadcasts. */
export const SERVER_ONLINE_STATS_INTERVAL_MS = 5_000;

/** Capability that opts a member into the connection count. */
export const SERVER_ONLINE_STATS_CAPABILITY = 'stats';

/** Coalesces connection count changes into rare broadcasts. */
export class ServerOnlineStats {
  private readonly sessions: ReadonlyMap<number, ConnectionSession>;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sent = -1;

  /**
   * Creates the broadcaster over the live session map.
   *
   * @param sessions Open sessions by user id.
   * @param intervalMs Shortest time between broadcasts.
   */
  constructor(sessions: ReadonlyMap<number, ConnectionSession>, intervalMs = SERVER_ONLINE_STATS_INTERVAL_MS) {
    this.sessions = sessions;
    this.intervalMs = intervalMs;
  }

  /**
   * Returns the current number of open connections.
   *
   * @returns Connection count.
   */
  count(): number {
    return this.sessions.size;
  }

  /** Schedules a broadcast after the count changed. */
  changed(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => this.flush(), this.intervalMs);
  }

  /**
   * Sends the count to every opted-in member when it differs from the last one
   * sent.
   */
  flush(): void {
    this.timer = null;
    const online = this.count();
    if (online === this.sent) return;
    this.sent = online;
    for (const session of this.sessions.values()) {
      if (session.helloDone && !session.closed && session.protocol.caps.has(SERVER_ONLINE_STATS_CAPABILITY))
        sessionSend(session, { t: 'stats', online });
    }
  }

  /** Stops a pending broadcast. */
  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
