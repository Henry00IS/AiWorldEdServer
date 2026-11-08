/**
 * Query isolation, bounded pending approvals and cleanup without real
 * networking.
 */
import { expect, test } from 'bun:test';
import { CompatibilityChecks } from '../../../src/forks/compatibility_checks.ts';
import type { ConnectionSession } from '../../../src/connection/connection_session.ts';
import type { Room } from '../../../src/rooms/room.ts';

const identity = { version: '1', homeUrl: 'https://editor.invalid/' };

/**
 * Creates a recording owner with no identity field to accidentally disclose.
 *
 * @returns Owner and sent messages.
 */
function ownerFixture() {
  const sent: string[] = [];
  const owner = {
    closed: false,
    outbound: { pushText: (text: string) => sent.push(text) },
  } as unknown as ConnectionSession;
  const room = { owner, closed: false } as Room;
  return { owner, room, sent };
}

test('only the queried owner may approve a unique request and stale answers do nothing', async () => {
  const checks = new CompatibilityChecks();
  const first = ownerFixture();
  const second = ownerFixture();
  const joiner = {} as ConnectionSession;
  const a = checks.request(first.room, joiner, identity, 10000, 2);
  const b = checks.request(second.room, {} as ConnectionSession, identity, 10000, 2);
  const q1 = JSON.parse(first.sent[0] ?? '{}').q;
  const q2 = JSON.parse(second.sent[0] ?? '{}').q;
  expect(q1).not.toBe(q2);
  checks.result(second.owner, q1, true);
  checks.result(first.owner, q1, false);
  checks.result(first.owner, q1, true);
  checks.result(second.owner, q2, true);
  expect(await a).toMatchObject({ allow: false });
  expect(await b).toMatchObject({ allow: true });
});

test('full waiting room evicts oldest, admits replacement and reports owner departure', async () => {
  const checks = new CompatibilityChecks();
  const { owner, room, sent } = ownerFixture();
  const first = checks.request(room, {} as ConnectionSession, identity, 10000, 1);
  const next = checks.request(room, {} as ConnectionSession, identity, 10000, 1);
  expect(await first).toMatchObject({ allow: false, reason: 'owner_timeout' });
  expect(sent).toHaveLength(2);
  checks.cancel(owner);
  expect(await next).toMatchObject({ allow: false, reason: 'owner_left' });
});
