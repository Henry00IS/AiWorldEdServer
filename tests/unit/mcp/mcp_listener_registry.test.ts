/**
 * Listener registry and queue: one connection per token, switching tokens,
 * strict request order with a bounded queue, answers by relay request id and
 * closing that aborts every waiting request.
 */
import { expect, test } from 'bun:test';
import type { ConnectionSession } from '../../../src/connection/connection_session.ts';
import { McpListenerRegistry } from '../../../src/mcp/mcp_listener_registry.ts';

/**
 * Builds the session fields the registry and listener use.
 *
 * @param user User id.
 * @returns Session that records sent messages.
 */
function sessionFake(user: number): ConnectionSession & { sent: string[] } {
  const sent: string[] = [];
  const outbound = { pushText: (text: string) => sent.push(text) };
  return { user, closed: false, outbound, sent } as unknown as ConnectionSession & { sent: string[] };
}

test('one connection per token, and listening on another token frees the first', () => {
  const registry = new McpListenerRegistry(4);
  const first = sessionFake(1);
  const second = sessionFake(2);
  expect(registry.listen(first, 'a'.repeat(64))).toBe(true);
  expect(registry.listen(second, 'a'.repeat(64))).toBe(false);
  expect(registry.listen(first, 'a'.repeat(64))).toBe(true);
  expect(registry.listen(first, 'b'.repeat(64))).toBe(true);
  expect(registry.find('a'.repeat(64))).toBeNull();
  expect(registry.listen(second, 'a'.repeat(64))).toBe(true);
  registry.unlisten(first);
  expect(registry.find('b'.repeat(64))).toBeNull();
  expect(registry.ofSession(second)?.token).toBe('a'.repeat(64));
});

test('requests fly one at a time in order and the queue is bounded', async () => {
  const listener = new McpListenerRegistry(1);
  listener.listen(sessionFake(1), 'c'.repeat(64));
  const queue = listener.find('c'.repeat(64));
  const first = queue?.ticketEnter(new AbortController());
  const second = queue?.ticketEnter(new AbortController());
  expect(queue?.ticketEnter(new AbortController())).toBeNull();
  let secondStarted = false;
  void second?.turn.then(() => (secondStarted = true));
  expect(await first?.turn).toBe(true);
  await Bun.sleep(0);
  expect(secondStarted).toBe(false);
  if (first) queue?.ticketLeave(first);
  expect(await second?.turn).toBe(true);
});

test('answers resolve by request id and closing aborts every queued request', async () => {
  const registry = new McpListenerRegistry(4);
  const session = sessionFake(1);
  registry.listen(session, 'd'.repeat(64));
  const listener = registry.ofSession(session);
  const controller = new AbortController();
  listener?.ticketEnter(controller);
  const answer = listener?.forward('{"id":1}', controller.signal);
  expect(JSON.parse(session.sent[0] ?? '{}')).toEqual({ t: 'mcp.request', q: 1, body: '{"id":1}' });
  expect(listener?.answer(2, '{}')).toBe(false);
  expect(listener?.answer(1, '{"ok":true}')).toBe(true);
  expect(await answer).toBe('{"ok":true}');
  registry.unlisten(session);
  expect(controller.signal.reason).toBe('closed');
});
