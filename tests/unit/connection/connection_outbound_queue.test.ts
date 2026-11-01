import { expect, test } from 'bun:test';
import { LimiterSharedBudget } from '../../../src/network/limiter_shared_budget.ts';
import { ConnectionOutboundQueue } from '../../../src/connection/connection_outbound_queue.ts';

/** Fake socket whose buffered amount the test controls. */
function socketFake() {
  const sent: (string | Uint8Array)[] = [];
  const socket = {
    buffered: 0,
    send: (data: string | Uint8Array) => (sent.push(data), 1),
    getBufferedAmount: () => socket.buffered,
  };
  return { socket, sent };
}

test('sends immediately while the socket is not backed up', () => {
  const { socket, sent } = socketFake();
  const queue = new ConnectionOutboundQueue(socket, 1000, 100, () => {});
  queue.pushText('{"t":"pong"}');
  expect(sent).toEqual(['{"t":"pong"}']);
  expect(queue.length()).toBe(0);
});

test('backpressure holds items, then coalesces queued edits into one frame and forgets them', () => {
  const { socket, sent } = socketFake();
  const queue = new ConnectionOutboundQueue(socket, 10_000, 100, () => {});
  socket.buffered = 500;
  for (let index = 1; index <= 5; index++) queue.pushEdit(JSON.stringify({ from: 1, seq: index, ops: [] }));
  queue.pushText('{"t":"locks"}');
  queue.pushEdit(JSON.stringify({ from: 2, seq: 1, ops: [] }));
  expect(sent.length).toBe(0);
  expect(queue.length()).toBe(7);
  socket.buffered = 0;
  queue.flush();
  expect(sent.length).toBe(3);
  const first = JSON.parse(sent[0] as string);
  expect(first.t).toBe('edits');
  expect(first.list.map((entry: { seq: number }) => entry.seq)).toEqual([1, 2, 3, 4, 5]);
  expect(sent[1]).toBe('{"t":"locks"}');
  expect(JSON.parse(sent[2] as string).list.length).toBe(1);
  expect(queue.length()).toBe(0);
  expect(queue.bytesQueued()).toBe(0);
});

test('binary delivery callbacks fire when handed to the socket', () => {
  const { socket } = socketFake();
  const queue = new ConnectionOutboundQueue(socket, 10_000, 100, () => {});
  socket.buffered = 500;
  let delivered = 0;
  queue.pushBinary(new Uint8Array(10), () => delivered++);
  expect(delivered).toBe(0);
  socket.buffered = 0;
  queue.flush();
  expect(delivered).toBe(1);
});

test('overflow clears the queue and reports the slow consumer once', () => {
  const { socket } = socketFake();
  let overflows = 0;
  const queue = new ConnectionOutboundQueue(socket, 100, 10, () => overflows++);
  socket.buffered = 50;
  for (let index = 0; index < 20; index++) queue.pushText('x'.repeat(20));
  expect(overflows).toBe(1);
  expect(queue.length()).toBe(0);
});

test('sendIfIdle only sends while nothing is queued and the socket is below the threshold; idle listener fires after draining', () => {
  const { socket, sent } = socketFake();
  const queue = new ConnectionOutboundQueue(socket, 10_000, 100, () => {});
  let idleCalls = 0;
  queue.idleListener = () => idleCalls++;
  const presence = new Uint8Array([0xa7, 2]);
  expect(queue.sendIfIdle(presence, 10)).toBe(true);
  socket.buffered = 50;
  expect(queue.sendIfIdle(presence, 10)).toBe(false);
  queue.pushText('{"t":"locks"}');
  expect(queue.length()).toBe(0);
  socket.buffered = 500;
  queue.pushEdit('{"from":1,"seq":1,"ops":[]}');
  expect(queue.sendIfIdle(presence, 1000)).toBe(false);
  idleCalls = 0;
  socket.buffered = 0;
  queue.flush();
  expect(idleCalls).toBe(1);
  expect(sent.length).toBe(3);
  expect(queue.bytesQueued()).toBe(0);
});

test('backed-up queues share a server budget and the one receiving more data past it is closed', () => {
  const budget = new LimiterSharedBudget(100);
  const first = socketFake();
  const second = socketFake();
  const overflows: string[] = [];
  const firstQueue = new ConnectionOutboundQueue(first.socket, 1000, 10, () => overflows.push('first'), budget);
  const secondQueue = new ConnectionOutboundQueue(second.socket, 1000, 10, () => overflows.push('second'), budget);
  first.socket.buffered = 20;
  second.socket.buffered = 20;
  firstQueue.pushText('x'.repeat(50));
  expect(budget.inUse()).toBe(70);
  secondQueue.pushText('y'.repeat(20));
  expect(overflows).toEqual(['second']);
  expect(budget.inUse()).toBe(70);
  first.socket.buffered = 0;
  firstQueue.flush();
  expect(budget.inUse()).toBe(0);
  expect(overflows).toEqual(['second']);
});
