import { expect, test } from 'bun:test';
import { ConnectionOutboundQueue } from '../../../src/connection/connection_outbound_queue.ts';
import type { ConnectionSession } from '../../../src/connection/connection_session.ts';
import { chatFlush, chatOffer, chatPurge } from '../../../src/handlers/handler_chat.ts';

/**
 * Creates a session with a fake socket whose buffer level the test controls.
 *
 * @returns Session, its socket and the frames it sent.
 */
function sessionFake() {
  const sent: (string | Uint8Array)[] = [];
  const socket = {
    buffered: 0,
    send: (data: string | Uint8Array) => (sent.push(data), 1),
    getBufferedAmount: () => socket.buffered,
  };
  const outbound = new ConnectionOutboundQueue(socket, 1 << 20, 1000, () => {});
  const session = {
    user: 1,
    outbound,
    closed: false,
    chatPending: [],
    presenceHighWaterBytes: 100,
  } as unknown as ConnectionSession;
  outbound.idleListener = () => chatFlush(session);
  return { session, socket, sent };
}

test('an idle recipient gets chat at once', () => {
  const recipient = sessionFake();
  chatOffer(recipient.session, 'a', 4);
  expect(recipient.sent).toEqual(['a']);
  expect(recipient.session.chatPending.length).toBe(0);
});

test('chat waits behind queued edits and keeps its order', () => {
  const recipient = sessionFake();
  recipient.socket.buffered = 5000;
  recipient.session.outbound.pushText('edit');
  chatOffer(recipient.session, 'one', 4);
  chatOffer(recipient.session, 'two', 4);
  expect(recipient.sent).toEqual([]);
  recipient.socket.buffered = 0;
  recipient.session.outbound.flush();
  expect(recipient.sent).toEqual(['edit', 'one', 'two']);
});

test('a full FIFO drops the oldest message', () => {
  const recipient = sessionFake();
  recipient.socket.buffered = 5000;
  for (const frame of ['1', '2', '3', '4', '5']) chatOffer(recipient.session, frame, 3);
  expect(recipient.session.chatPending).toEqual(['3', '4', '5']);
  recipient.socket.buffered = 0;
  recipient.session.outbound.flush();
  expect(recipient.sent).toEqual(['3', '4', '5']);
});

test('purge drops waiting messages and closed recipients get nothing', () => {
  const recipient = sessionFake();
  recipient.socket.buffered = 5000;
  chatOffer(recipient.session, 'old room', 4);
  chatPurge(recipient.session);
  recipient.socket.buffered = 0;
  recipient.session.outbound.flush();
  expect(recipient.sent).toEqual([]);
  recipient.session.closed = true;
  chatOffer(recipient.session, 'late', 4);
  expect(recipient.sent).toEqual([]);
});
