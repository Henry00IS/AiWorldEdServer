/** Tests for the coalesced connection count broadcast. */
import { describe, expect, test } from 'bun:test';
import type { ConnectionSession } from '../../../src/connection/connection_session.ts';
import { ServerOnlineStats } from '../../../src/server/server_online_stats.ts';

/**
 * Creates a fake session that records sent frames.
 *
 * @param user User id.
 * @param caps Agreed capabilities.
 * @returns Fake session and its sent frames.
 */
function fakeSession(user: number, caps: string[]): { session: ConnectionSession; sent: string[] } {
  const sent: string[] = [];
  const session = {
    user,
    closed: false,
    helloDone: true,
    protocol: { version: 2, caps: new Set(caps) },
    outbound: { pushText: (text: string) => sent.push(text) },
  } as unknown as ConnectionSession;
  return { session, sent };
}

describe('ServerOnlineStats', () => {
  test('sends one coalesced count to members with the stats capability only', async () => {
    const sessions = new Map<number, ConnectionSession>();
    const stats = new ServerOnlineStats(sessions, 20);
    const watcher = fakeSession(1, ['stats']);
    const old = fakeSession(2, ['select']);
    sessions.set(1, watcher.session).set(2, old.session);
    stats.changed();
    stats.changed();
    await Bun.sleep(40);
    expect(watcher.sent).toEqual(['{"t":"stats","online":2}']);
    expect(old.sent).toEqual([]);
    stats.changed();
    await Bun.sleep(40);
    expect(watcher.sent).toHaveLength(1);
    stats.stop();
  });
});
