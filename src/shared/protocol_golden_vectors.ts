/**
 * Golden test vectors: recorded frames per protocol version. Relay and editor
 * both replay them in their shared protocol check, so a change that breaks a
 * released version fails CI on both sides. Dependency-free, shared by relay and
 * client.
 *
 * Vectors of a released version are frozen: never edit or remove one, only add.
 * A new version gets its own entry; the old entries stay as long as the relay
 * or the editor still accepts that version.
 */

/** What the relay does with a client frame. */
export type GoldenVerdict = 'accept' | 'reject' | 'refuse';

/** One recorded client frame and the verdict it must get. */
export interface GoldenClientVector {
  readonly name: string;
  readonly frame: string;
  readonly verdict: GoldenVerdict;
}

/**
 * One recorded server frame; clients must parse it, the relay must emit its
 * shape.
 */
export interface GoldenServerVector {
  readonly name: string;
  readonly frame: string;
}

/** One recorded binary frame in hexadecimal. */
export interface GoldenBinaryVector {
  readonly name: string;
  readonly hex: string;
}

/** All vectors of one protocol version. */
export interface GoldenVersionVectors {
  readonly client: readonly GoldenClientVector[];
  readonly server: readonly GoldenServerVector[];
  readonly binary: readonly GoldenBinaryVector[];
}

/** Room id used in the vectors. */
const ROOM = 'AbCdEfGhIjKlMnOp';
/** A transfer link id of the right shape. */
const LINK = 'Tr4nsferL1nkTr4nsferL1nkTr4nsferL1nk_-AbCdE';

/**
 * Client frames of protocol version 2 ('refuse' = valid frame, version refused
 * at hello).
 */
const GOLDEN_CLIENT_V2: readonly GoldenClientVector[] = [
  {
    name: 'hello minimal',
    verdict: 'accept',
    frame: '{"t":"hello","protocol":"aiworlded-collab","version":2,"client":"AiWorldEd/1.0"}',
  },
  {
    name: 'hello full',
    verdict: 'accept',
    frame:
      '{"t":"hello","protocol":"aiworlded-collab","version":3,"minVersion":2,"client":"AiWorldEd/1.1","name":"Ana","caps":["select","future.thing"],"x":{"studio.build":"nb-42"}}',
  },
  {
    name: 'hello version 1',
    verdict: 'refuse',
    frame: '{"t":"hello","protocol":"aiworlded-collab","version":1,"client":"AiWorldEd/0.9"}',
  },
  {
    name: 'hello unknown top-level field',
    verdict: 'reject',
    frame: '{"t":"hello","protocol":"aiworlded-collab","version":2,"client":"A","future":1}',
  },
  {
    name: 'hello extension bad key',
    verdict: 'reject',
    frame: '{"t":"hello","protocol":"aiworlded-collab","version":2,"client":"A","x":{"Bad Key":1}}',
  },
  {
    name: 'hello float version',
    verdict: 'reject',
    frame: '{"t":"hello","protocol":"aiworlded-collab","version":2.5,"client":"A"}',
  },
  {
    name: 'hello version above 16 bits',
    verdict: 'reject',
    frame: '{"t":"hello","protocol":"aiworlded-collab","version":65536,"client":"A"}',
  },
  {
    name: 'room.create',
    verdict: 'accept',
    frame: '{"t":"room.create","r":1,"name":"Level 1","private":false,"x":{"tag":"e1m1"}}',
  },
  { name: 'room.join', verdict: 'accept', frame: `{"t":"room.join","r":2,"room":"${ROOM}","discardLocalWork":true}` },
  { name: 'select', verdict: 'accept', frame: '{"t":"select","ids":["brush_1","light_2"]}' },
  { name: 'select clear', verdict: 'accept', frame: '{"t":"select","ids":[]}' },
  {
    name: 'lock.acquire',
    verdict: 'accept',
    frame: '{"t":"lock.acquire","r":3,"lease":1,"ids":["brush_1"],"shared":["group_1"]}',
  },
  {
    name: 'lock.acquire replace',
    verdict: 'accept',
    frame: '{"t":"lock.acquire","lease":2,"ids":["brush_2"],"replace":true}',
  },
  { name: 'lock.renew', verdict: 'accept', frame: '{"t":"lock.renew","lease":2}' },
  { name: 'lock.renew with request id', verdict: 'reject', frame: '{"t":"lock.renew","r":1,"lease":2}' },
  { name: 'lock.release', verdict: 'accept', frame: '{"t":"lock.release"}' },
  {
    name: 'edit leased transform',
    verdict: 'accept',
    frame: '{"t":"edit","seq":4,"lease":2,"ops":[{"k":"transform","ids":["brush_2"],"d":{"p":[0,64,0]}}]}',
  },
  {
    name: 'edit one-shot property',
    verdict: 'accept',
    frame: '{"t":"edit","seq":5,"ops":[{"k":"property","ids":["light_2"],"d":{"f":{"intensity":2}}}]}',
  },
  {
    name: 'edit lease zero',
    verdict: 'reject',
    frame: '{"t":"edit","seq":6,"lease":0,"ops":[{"k":"delete","ids":["a"]}]}',
  },
  { name: 'edit unknown kind', verdict: 'reject', frame: '{"t":"edit","seq":7,"ops":[{"k":"teleport","ids":["a"]}]}' },
  { name: 'object id with space', verdict: 'reject', frame: '{"t":"select","ids":["a b"]}' },
  { name: 'unknown type', verdict: 'reject', frame: '{"t":"proxy.connect","host":"example.com"}' },
  { name: 'chat', verdict: 'accept', frame: '{"t":"chat","text":"hi"}' },
  { name: 'ping', verdict: 'accept', frame: '{"t":"ping","r":9}' },
  { name: 'transfer.create', verdict: 'accept', frame: '{"t":"transfer.create","r":3}' },
  {
    name: 'transfer.info',
    verdict: 'accept',
    frame: '{"t":"transfer.info","q":5,"size":1048576,"name":"shot.png","mime":"image/png"}',
  },
  { name: 'transfer.missing', verdict: 'accept', frame: '{"t":"transfer.missing","q":5}' },
  {
    name: 'transfer.info with r',
    verdict: 'reject',
    frame: '{"t":"transfer.info","r":1,"q":5,"size":1,"name":"a","mime":"a/b"}',
  },
  {
    name: 'chat with file',
    verdict: 'accept',
    frame: `{"t":"chat","text":"shot.png","file":{"link":"${LINK}","name":"shot.png","size":1048576,"mime":"image/png"}}`,
  },
];

/** Server frames of protocol version 2. */
const GOLDEN_SERVER_V2: readonly GoldenServerVector[] = [
  { name: 'welcome', frame: '{"t":"welcome","user":1,"version":2,"versions":{"min":2,"max":2},"caps":["select"]}' },
  {
    name: 'protocol_unsupported',
    frame:
      '{"t":"error","code":"protocol_unsupported","versions":{"min":2,"max":2},"message":"This server speaks collaboration protocol v2; your editor speaks v1. Update your editor."}',
  },
  {
    name: 'protocol_mismatch',
    frame:
      '{"t":"error","r":2,"code":"protocol_mismatch","roomProtocol":1,"yourProtocol":2,"message":"This room uses protocol v1; your editor speaks v2. Update or join a compatible room."}',
  },
  {
    name: 'room list entry',
    frame: `{"t":"room.list","rooms":[{"id":"${ROOM}","name":"Level 1","private":false,"users":1,"maxUsers":8,"owner":"Ana","protocol":2,"editor":"AiWorldEd/1.0"}]}`,
  },
  { name: 'selected', frame: '{"t":"selected","by":2,"ids":["brush_1"]}' },
  { name: 'lease expired', frame: '{"t":"locks","by":2,"remove":["brush_2"],"expired":true}' },
  { name: 'transfer.created', frame: `{"t":"transfer.created","r":3,"link":"${LINK}","expiresInMs":3600000}` },
  { name: 'transfer.get', frame: `{"t":"transfer.get","q":5,"link":"${LINK}"}` },
  { name: 'transfer.get thumbnail', frame: `{"t":"transfer.get","q":6,"link":"${LINK}","thumbnail":true}` },
  { name: 'transfer.chunk', frame: '{"t":"transfer.chunk","q":5,"offset":262144,"length":262144}' },
  { name: 'transfer_rate_limited', frame: '{"t":"error","r":4,"code":"transfer_rate_limited","retryAfterMs":4200}' },
];

/** Binary frames of protocol version 2. */
const GOLDEN_BINARY_V2: readonly GoldenBinaryVector[] = [
  { name: 'stream chunk stream 1 peer 7 payload 010203', hex: 'a70100000000000100000007010203' },
  { name: 'presence client camera 0 at 1,2,3 fov 90', hex: 'a7020101003f8000004000000040400000e00802005a' },
  { name: 'presence relayed from user 7', hex: 'a702010100000007003f8000004000000040400000e00802005a' },
  { name: 'transfer chunk q 5 offset 262144 payload 010203', hex: 'a70300000000000500040000010203' },
];

/** All vectors of protocol version 2. */
export const PROTOCOL_GOLDEN_VECTORS_V2: GoldenVersionVectors = {
  client: GOLDEN_CLIENT_V2,
  server: GOLDEN_SERVER_V2,
  binary: GOLDEN_BINARY_V2,
};

/** Vectors per protocol version. */
export const PROTOCOL_GOLDEN_VECTORS: Readonly<Record<number, GoldenVersionVectors>> = {
  2: PROTOCOL_GOLDEN_VECTORS_V2,
};
