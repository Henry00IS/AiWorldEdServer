/** Opens a raw WebSocket and reports how the relay answered it. */

/** What happened to a raw WebSocket. */
export interface TestSocketOutcome {
  /** Whether the WebSocket handshake succeeded. */
  readonly opened: boolean;
  /** Close code the client saw. */
  readonly code: number;
  /** Close reason the client saw. */
  readonly reason: string;
}

/** Options for a raw WebSocket. */
export interface TestSocketOptions {
  readonly headers?: Record<string, string>;
  /** PEM certificate to trust for wss://. */
  readonly certificateAuthority?: string;
  /** Close from the client side right after the handshake succeeded. */
  readonly closeWhenOpen?: boolean;
}

/**
 * Connects and waits for the socket to close, either by the relay or (with
 * closeWhenOpen) by the client after a successful handshake.
 *
 * @param url WebSocket URL.
 * @param options Headers, trusted certificate and close behaviour.
 * @returns Outcome with the close code and reason.
 */
export function testSocketOutcome(url: string, options: TestSocketOptions = {}): Promise<TestSocketOutcome> {
  const tls = options.certificateAuthority === undefined ? undefined : { ca: options.certificateAuthority };
  const socket = new WebSocket(url, { headers: options.headers ?? {}, tls } as unknown as string[]);
  let opened = false;
  return new Promise((resolve) => {
    socket.addEventListener('open', () => {
      opened = true;
      if (options.closeWhenOpen) socket.close(1000, 'test done');
    });
    socket.addEventListener('close', (event) => resolve({ opened, code: event.code, reason: event.reason }));
  });
}
