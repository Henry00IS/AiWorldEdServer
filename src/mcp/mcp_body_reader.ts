/**
 * Reads a browser MCP request body as a stream at a limited rate. Each chunk is
 * charged to the token's and the client address's sliding byte windows; while
 * they are full the reader does not ask for more, so the socket stops being
 * read and TCP backpressure stalls the sender. At most one chunk beyond the
 * budget is ever held, and the whole body never exceeds its size cap.
 */
import type { CustomWindow } from '../forks/custom_window.ts';
import { mcpAbortableSleep } from './mcp_request_abort.ts';

/** Limits and windows of one body read. */
export interface McpBodyReadOptions {
  /** Largest accepted body in bytes; more gives 413. */
  readonly bytesMaximum: number;
  /** Bytes accepted per sliding second in every window. */
  readonly bytesPerSecond: number;
  /** Windows charged for every byte (token and client address). */
  readonly windows: readonly CustomWindow[];
  /** Request signal; aborting it cancels the read. */
  readonly signal: AbortSignal;
}

/** Outcome of a body read. */
export type McpBodyResult =
  { ok: true; text: string } | { ok: false; status: 400 | 413 } | { ok: false; status: 'aborted' };

/**
 * Reads the whole body as UTF-8 text at the configured rate.
 *
 * @param body Request body stream, or null for an empty body.
 * @param options Size cap, rate, windows and signal.
 * @returns Body text, 400 for invalid UTF-8, 413 when too large, or aborted.
 */
export async function mcpBodyRead(
  body: ReadableStream<Uint8Array> | null,
  options: McpBodyReadOptions,
): Promise<McpBodyResult> {
  if (body === null) return { ok: true, text: '' };
  const reader = body.getReader();
  /** Cancels the body stream, ignoring a stream that already ended. */
  const cancel = (): void => void reader.cancel().catch(() => undefined);
  options.signal.addEventListener('abort', cancel, { once: true });
  try {
    return await mcpBodyChunksRead(reader, options);
  } finally {
    options.signal.removeEventListener('abort', cancel);
    cancel();
  }
}

/**
 * Reads, charges and decodes chunks until the body ends.
 *
 * @param reader Body reader.
 * @param options Size cap, rate, windows and signal.
 * @returns Body text or why it was refused.
 */
async function mcpBodyChunksRead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: McpBodyReadOptions,
): Promise<McpBodyResult> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parts: string[] = [];
  let bytesRead = 0;
  for (;;) {
    const chunk = await mcpBodyChunkNext(reader);
    if (options.signal.aborted || chunk === null) return { ok: false, status: 'aborted' };
    if (chunk === 'end') break;
    bytesRead += chunk.byteLength;
    if (bytesRead > options.bytesMaximum) return { ok: false, status: 413 };
    if (!(await mcpBodyPace(chunk.byteLength, options))) return { ok: false, status: 'aborted' };
    const text = mcpBodyDecode(decoder, chunk);
    if (text === null) return { ok: false, status: 400 };
    parts.push(text);
  }
  const rest = mcpBodyDecode(decoder, undefined);
  return rest === null ? { ok: false, status: 400 } : { ok: true, text: parts.join('') + rest };
}

/**
 * Reads the next chunk.
 *
 * @param reader Body reader.
 * @returns Chunk, `end` after the last one, or null when the stream failed.
 */
async function mcpBodyChunkNext(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Uint8Array | 'end' | null> {
  try {
    const result = await reader.read();
    return result.done ? 'end' : result.value;
  } catch {
    return null;
  }
}

/**
 * Charges bytes to every window in budget-sized pieces, pausing until each
 * piece fits all windows.
 *
 * @param bytes Bytes of the chunk just read.
 * @param options Rate, windows and signal.
 * @returns False once the request was aborted while pausing.
 */
async function mcpBodyPace(bytes: number, options: McpBodyReadOptions): Promise<boolean> {
  let remaining = bytes;
  while (remaining > 0) {
    const piece = Math.min(remaining, options.bytesPerSecond);
    const delay = Math.max(0, ...options.windows.map((window) => window.delayMs(piece, options.bytesPerSecond)));
    if (delay > 0) {
      if (!(await mcpAbortableSleep(delay, options.signal))) return false;
      continue;
    }
    for (const window of options.windows) window.take(piece, options.bytesPerSecond, Number.MAX_SAFE_INTEGER);
    remaining -= piece;
  }
  return true;
}

/**
 * Decodes a chunk as part of a UTF-8 stream; without a chunk it flushes the
 * end.
 *
 * @param decoder Fatal streaming decoder.
 * @param chunk Next chunk, or undefined to finish.
 * @returns Decoded text, or null for invalid UTF-8.
 */
function mcpBodyDecode(decoder: TextDecoder, chunk: Uint8Array | undefined): string | null {
  try {
    return chunk === undefined ? decoder.decode() : decoder.decode(chunk, { stream: true });
  } catch {
    return null;
  }
}
