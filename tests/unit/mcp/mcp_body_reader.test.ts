/**
 * Throttled body reading: the reader pulls no more than one chunk beyond the
 * byte budget while the window is full, refuses oversized bodies and invalid
 * UTF-8, and stops at once when the request aborts.
 */
import { expect, test } from 'bun:test';
import { CustomWindow } from '../../../src/forks/custom_window.ts';
import { mcpBodyRead } from '../../../src/mcp/mcp_body_reader.ts';

const CHUNK = 4096;
const RATE = 2 * CHUNK;

/** Source stream that only produces a chunk when asked and counts it. */
interface CountingSource {
  readonly stream: ReadableStream<Uint8Array>;
  pulledBytes(): number;
}

/**
 * Builds a source of ASCII chunks that never buffers ahead of the reader.
 *
 * @param totalBytes Body size.
 * @param chunk Chunk produced per pull.
 * @returns Source and its pulled byte counter.
 */
function countingSource(totalBytes: number, chunk = new TextEncoder().encode('x'.repeat(CHUNK))): CountingSource {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      /**
       * Enqueues the next chunk only when the reader asks, or ends the body.
       *
       * @param controller Stream controller.
       */
      pull(controller) {
        if (pulled >= totalBytes) return controller.close();
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulledBytes: () => pulled };
}

/**
 * Builds read options with fresh windows.
 *
 * @param signal Request signal.
 * @param bytesMaximum Body cap.
 * @returns Options.
 */
function options(signal: AbortSignal, bytesMaximum = 1024 * 1024): Parameters<typeof mcpBodyRead>[1] {
  return { bytesMaximum, bytesPerSecond: RATE, windows: [new CustomWindow(), new CustomWindow()], signal };
}

test('while the window is full the reader stops pulling: at most one chunk beyond the budget', async () => {
  const source = countingSource(64 * CHUNK);
  const controller = new AbortController();
  const reading = mcpBodyRead(source.stream, options(controller.signal));
  await Bun.sleep(300);
  expect(source.pulledBytes()).toBeLessThanOrEqual(RATE + CHUNK);
  controller.abort('closed');
  expect(await reading).toEqual({ ok: false, status: 'aborted' });
});

test('a small body is read whole and decoded', async () => {
  const source = countingSource(CHUNK);
  const result = await mcpBodyRead(source.stream, options(new AbortController().signal));
  expect(result).toEqual({ ok: true, text: 'x'.repeat(CHUNK) });
});

test('a body above the cap is refused with 413 and invalid UTF-8 with 400', async () => {
  const large = await mcpBodyRead(countingSource(2 * CHUNK).stream, options(new AbortController().signal, CHUNK));
  expect(large).toEqual({ ok: false, status: 413 });
  const invalid = countingSource(1, new Uint8Array([0xc3, 0x28]));
  expect(await mcpBodyRead(invalid.stream, options(new AbortController().signal))).toEqual({ ok: false, status: 400 });
});

test('a missing body reads as empty text', async () => {
  expect(await mcpBodyRead(null, options(new AbortController().signal))).toEqual({ ok: true, text: '' });
});
