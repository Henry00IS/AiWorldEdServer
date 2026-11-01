import { expect, test } from 'bun:test';
import { protocolMessageDecode } from '../../../src/protocol/protocol_message_decoder.ts';

const valid = [
  { t: 'ping' },
  { t: 'room.list', r: 1 },
  { t: 'room.create', name: 'Level', private: true, password: 'Tq7#mRw2!xLp', internalTest: true, maxUsers: 4, r: 2 },
  { t: 'room.join', room: 'AbCdEfGhIjKlMn_-', discardLocalWork: true },
  { t: 'lock.acquire', lease: 1, ids: ['brush:1', 'brush.2'], replace: true },
  { t: 'lock.acquire', lease: 2, ids: ['brush:1'], shared: ['group:1', 'model:1'] },
  { t: 'lock.renew', lease: 2 },
  { t: 'select', ids: ['brush:1', 'group:1'] },
  { t: 'select', ids: [] },
  { t: 'edit', seq: 8, ops: [{ k: 'reparent', ids: ['brush:1'], d: {}, p: ['group:1'] }] },
  { t: 'lock.release' },
  { t: 'verify.result', q: 4294967295, v: 'deleted' },
  {
    t: 'edit',
    seq: 7,
    ops: [{ k: 'transform', ids: ['brush:1'], d: { p: [1, 2, 3], nested: { a: [true, null, 'x'] } } }],
  },
  { t: 'stream.begin', to: 2, stream: 1, kind: 'asset', size: 10, name: 'textures/wall.png', mime: 'image/png' },
];

test('accepts every well-formed message', () => {
  for (const message of valid) expect(protocolMessageDecode(JSON.stringify(message))).toMatchObject({ ok: true });
});

test.each([
  ['not json', 'not json'],
  ['array', '[1,2]'],
  ['unknown type', JSON.stringify({ t: 'exec', cmd: 'ls' })],
  ['prototype key type', JSON.stringify({ t: 'constructor' })],
  ['unknown field', JSON.stringify({ t: 'ping', extra: 1 })],
  ['__proto__ field', '{"t":"ping","__proto__":{"x":1}}'],
  ['wrong field type', JSON.stringify({ t: 'room.create', name: 5, private: false })],
  ['join without discard', JSON.stringify({ t: 'room.join', room: 'AbCdEfGhIjKlMn_-' })],
  ['discard false', JSON.stringify({ t: 'room.join', room: 'AbCdEfGhIjKlMn_-', discardLocalWork: false })],
  ['bad object id', JSON.stringify({ t: 'lock.acquire', lease: 1, ids: ['bad id with spaces'] })],
  ['bad shared id', JSON.stringify({ t: 'lock.acquire', lease: 1, ids: ['a'], shared: ['bad id'] })],
  ['acquire without lease', JSON.stringify({ t: 'lock.acquire', ids: ['a'] })],
  ['lease zero', JSON.stringify({ t: 'lock.acquire', lease: 0, ids: ['a'] })],
  ['renew without lease', JSON.stringify({ t: 'lock.renew' })],
  ['select too many', JSON.stringify({ t: 'select', ids: Array.from({ length: 257 }, (_, i) => `o${i}`) })],
  ['edit lease negative', JSON.stringify({ t: 'edit', seq: 1, lease: -1, ops: [{ k: 'delete', ids: ['a'] }] })],
  ['empty parent chain', JSON.stringify({ t: 'edit', seq: 1, ops: [{ k: 'create', ids: ['a'], p: [] }] })],
  ['unknown verdict', JSON.stringify({ t: 'verify.result', q: 1, v: 'maybe' })],
  ['verify answer without query', JSON.stringify({ t: 'verify.result', v: 'ok' })],
  ['verify answer with request id', JSON.stringify({ t: 'verify.result', q: 1, v: 'ok', r: 1 })],
  ['zero verify query', JSON.stringify({ t: 'verify.result', q: 0, v: 'ok' })],
  ['unknown edit kind', JSON.stringify({ t: 'edit', seq: 1, ops: [{ k: 'chat', ids: ['a'] }] })],
  ['float seq', JSON.stringify({ t: 'edit', seq: 1.5, ops: [{ k: 'transform', ids: ['a'] }] })],
  [
    'too deep payload',
    JSON.stringify({
      t: 'edit',
      seq: 1,
      ops: [{ k: 'property', ids: ['a'], d: JSON.parse('['.repeat(40) + ']'.repeat(40)) }],
    }),
  ],
  ['stream size too big', JSON.stringify({ t: 'stream.begin', to: 2, stream: 1, kind: 'asset', size: 2 ** 40 })],
])('rejects %s', (_label, text) => {
  expect(protocolMessageDecode(text).ok).toBe(false);
});
