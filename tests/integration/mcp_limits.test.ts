/**
 * Browser MCP limits end to end: the request body is read at the configured
 * rate (a large body takes as long as the rate demands), oversized bodies get
 * 413 whether declared or streamed, one request flies per token with a short
 * queue (429 beyond it), slow editors get 504 and editors that leave
 * mid-request 503.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { collabServerStart, type CollabServer } from '../../src/server/server_collab.ts';
import { MCP_ENVELOPE_BYTES } from '../../src/server/server_mcp_http.ts';
import type { TestClient } from '../support/test_client.ts';
import { testConfiguration } from '../support/test_configuration.ts';
import {
  testMcpAnswerNext,
  testMcpEditorListen,
  testMcpPost,
  testMcpToken,
  testMcpUrl,
} from '../support/test_mcp_editor.ts';

const RATE = 16 * 1024;
const BODY_MAXIMUM = 48 * 1024;
const TIMEOUT_MS = 4000;
const QUEUED = 2;
let server: CollabServer;

beforeAll(() => {
  server = collabServerStart(
    testConfiguration({
      connectionsPerIp: 200,
      mcpBytesPerSecond: RATE,
      maxPayloadBytes: BODY_MAXIMUM + MCP_ENVELOPE_BYTES,
      mcpRequestTimeoutMs: TIMEOUT_MS,
      mcpQueuedRequestsPerToken: QUEUED,
    }),
  );
});

afterAll(async () => {
  await server.stop();
});

/**
 * Connects an editor listening on a fresh token.
 *
 * @returns Editor and the token's URL.
 */
async function listening(): Promise<{ editor: TestClient; url: string }> {
  const token = testMcpToken();
  return { editor: await testMcpEditorListen(server.port, token), url: testMcpUrl(server.port, token) };
}

/**
 * Builds a JSON-RPC text padded to a byte size.
 *
 * @param bytes Total size.
 * @returns ASCII JSON text of exactly that size.
 */
function paddedRequest(bytes: number): string {
  const head = '{"jsonrpc":"2.0","id":1,"method":"ping","params":{"pad":"';
  const tail = '"}}';
  return head + 'x'.repeat(bytes - head.length - tail.length) + tail;
}

/**
 * POSTs a body as a chunked stream without a declared length.
 *
 * @param url Browser MCP URL.
 * @param bytes Body size.
 * @returns Response.
 */
function streamedPost(url: string, bytes: number): Promise<Response> {
  const chunk = new TextEncoder().encode('x'.repeat(4096));
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    /**
     * Enqueues the next chunk, or ends the body once enough was sent.
     *
     * @param controller Stream controller.
     */
    pull(controller) {
      if (sent >= bytes) return controller.close();
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  return fetch(url, { method: 'POST', body, duplex: 'half' } as RequestInit);
}

describe('throttle', () => {
  test('a body larger than one second of budget takes at least as long as the rate allows', async () => {
    const { editor, url } = await listening();
    const text = paddedRequest(BODY_MAXIMUM);
    const startedAt = performance.now();
    const pending = testMcpPost(url, text);
    const forwarded = await testMcpAnswerNext(editor, () => '{}', TIMEOUT_MS);
    const elapsedMs = performance.now() - startedAt;
    expect((await pending).status).toBe(200);
    expect(forwarded.body).toBe(text);
    expect(elapsedMs).toBeGreaterThanOrEqual(((BODY_MAXIMUM - RATE) / RATE) * 1000 * 0.95);
    editor.close();
  });

  test('requests to different tokens from one address share that address budget', async () => {
    const first = await listening();
    const second = await listening();
    const bytes = BODY_MAXIMUM / 2;
    const startedAt = performance.now();
    const pending = [testMcpPost(first.url, paddedRequest(bytes)), testMcpPost(second.url, paddedRequest(bytes))];
    await Promise.all([
      testMcpAnswerNext(first.editor, () => '{}', TIMEOUT_MS),
      testMcpAnswerNext(second.editor, () => '{}', TIMEOUT_MS),
    ]);
    const elapsedMs = performance.now() - startedAt;
    for (const response of await Promise.all(pending)) expect(response.status).toBe(200);
    expect(elapsedMs).toBeGreaterThanOrEqual(((2 * bytes - RATE) / RATE) * 1000 * 0.95);
    first.editor.close();
    second.editor.close();
  });
});

describe('caps', () => {
  test('bodies over the cap get 413, declared or streamed, and never reach the editor', async () => {
    const { editor, url } = await listening();
    expect((await testMcpPost(url, paddedRequest(BODY_MAXIMUM + 1))).status).toBe(413);
    expect((await streamedPost(url, BODY_MAXIMUM + 8192)).status).toBe(413);
    expect(editor.has('mcp.request')).toBe(false);
    editor.close();
  });

  test('one request flies per token, a short queue waits and more get 429', async () => {
    const { editor, url } = await listening();
    const pending = Array.from({ length: 1 + QUEUED }, () => testMcpPost(url, '{}'));
    const first = await editor.next('mcp.request');
    expect(editor.has('mcp.request')).toBe(false);
    const refused = await testMcpPost(url, '{}');
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('1');
    editor.send({ t: 'mcp.response', q: first.q, body: '{}' });
    for (let index = 0; index < QUEUED; index++) await testMcpAnswerNext(editor, () => '{}');
    for (const response of await Promise.all(pending)) expect(response.status).toBe(200);
    editor.close();
  });

  test('an editor that does not answer in time gives 504; its late answer is ignored', async () => {
    const { editor, url } = await listening();
    const response = testMcpPost(url, '{}');
    const request = await editor.next('mcp.request');
    expect((await response).status).toBe(504);
    editor.send({ t: 'mcp.response', q: request.q, body: '{}' });
    const followUp = testMcpPost(url, '{}');
    await testMcpAnswerNext(editor, () => '{"ok":1}');
    expect(await (await followUp).json()).toEqual({ ok: 1 });
    editor.close();
  });

  test('an editor that leaves mid-request gives 503 to the running and the queued request', async () => {
    const { editor, url } = await listening();
    const running = testMcpPost(url, '{}');
    await editor.next('mcp.request');
    const queued = testMcpPost(url, '{}');
    await Bun.sleep(50);
    editor.close();
    expect((await running).status).toBe(503);
    expect((await queued).status).toBe(503);
  });
});
