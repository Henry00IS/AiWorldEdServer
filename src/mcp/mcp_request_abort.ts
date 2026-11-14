/**
 * Abort helpers of one browser MCP request: every wait of the request (its
 * queue turn, a throttle pause, the editor's answer) ends early when the
 * request times out, its editor stops listening or the HTTP client goes away.
 */

/** Why a browser MCP request was aborted. */
export type McpAbortReason = 'closed' | 'timeout' | 'client';

/**
 * Reads why a request signal was aborted.
 *
 * @param signal Aborted request signal.
 * @returns Abort reason; anything unknown counts as the client going away.
 */
export function mcpAbortReason(signal: AbortSignal): McpAbortReason {
  const reason: unknown = signal.reason;
  return reason === 'closed' || reason === 'timeout' ? reason : 'client';
}

/**
 * Waits for a promise unless the signal aborts first.
 *
 * @param promise Promise to wait for.
 * @param signal Request signal.
 * @returns The promise's value, or null once the signal aborted.
 */
export function mcpAbortableWait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    /** Ends the wait with null when the signal aborts. */
    const abortListener = (): void => resolve(null);
    signal.addEventListener('abort', abortListener, { once: true });
    void promise.then((value) => {
      signal.removeEventListener('abort', abortListener);
      resolve(value);
    });
  });
}

/**
 * Sleeps unless the signal aborts first.
 *
 * @param milliseconds Sleep time.
 * @param signal Request signal.
 * @returns True after the full sleep, false once the signal aborted.
 */
export async function mcpAbortableSleep(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slept = new Promise<true>((resolve) => {
    timer = setTimeout(() => resolve(true), milliseconds);
  });
  const result = await mcpAbortableWait(slept, signal);
  clearTimeout(timer);
  return result === true;
}
