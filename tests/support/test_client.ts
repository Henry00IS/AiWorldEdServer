/** Real WebSocket test client with an inbox and awaitable message matching. */
import { PROTOCOL_ID, PROTOCOL_VERSION } from '../../src/shared/protocol_definitions.ts';
import { TEST_ORIGIN } from './test_configuration.ts';

/**
 * Decoded server message. Tests read arbitrary protocol fields, so the shape is
 * deliberately untyped.
 */
export type TestMessage = any;

/** Inbound message as decoded JSON, or a binary frame. */
export type TestInbound = { kind: 'json'; message: TestMessage } | { kind: 'binary'; data: Uint8Array };

/** Options for connecting. */
export interface TestClientOptions {
  headers?: Record<string, string>;
  hello?: boolean;
  name?: string;
  path?: string;
  caps?: string[];
}

/** Test WebSocket client. */
export class TestClient {
  readonly inbox: TestInbound[] = [];
  closeCode: number | null = null;
  closeReason = '';
  user = 0;
  welcome: TestMessage = {};
  /** Lease number lock requests without one use (the running operation). */
  lease = 1;
  /** Whether the fixture owner approves the common test identity. */
  compatibilityAutomatic = true;
  private waiters: (() => void)[] = [];

  /**
   * Wraps a connected socket and starts collecting its messages.
   *
   * @param socket Connected socket.
   */
  private constructor(readonly socket: WebSocket) {
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', (event) => this.inboxPush(event.data));
    socket.addEventListener('close', (event) => {
      this.closeCode = event.code;
      this.closeReason = event.reason;
      this.wake();
    });
  }

  /**
   * Opens a socket (with the test Origin unless overridden) and optionally says
   * hello.
   *
   * @param port Server port.
   * @param options Headers, hello toggle, display name, WebSocket path (default
   *   `/ws`) and capabilities.
   * @returns Connected client.
   */
  static async connect(port: number, options: TestClientOptions = {}): Promise<TestClient> {
    const headers = { Origin: TEST_ORIGIN, ...(options.headers ?? {}) };
    const socket = new WebSocket(`ws://127.0.0.1:${port}${options.path ?? '/ws'}`, { headers } as any);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('connect failed')), { once: true });
    });
    const client = new TestClient(socket);
    if (options.hello !== false) await client.hello(options.name, options.caps);
    return client;
  }

  /**
   * Sends hello and waits for welcome.
   *
   * @param name Optional display name.
   * @param caps Capabilities (default `select`).
   */
  async hello(name?: string, caps: string[] = ['select']): Promise<void> {
    this.send({
      t: 'hello',
      protocol: PROTOCOL_ID,
      version: PROTOCOL_VERSION,
      client: 'aiworlded-tests/1',
      caps,
      ...(name ? { name } : {}),
    });
    this.welcome = await this.next('welcome');
    this.user = this.welcome.user;
  }

  /**
   * Sends an object as a JSON text frame.
   *
   * @param message Object to send as JSON.
   */
  send(message: object): void {
    this.socket.send(JSON.stringify(this.leaseFill(message)));
    const typed = message as { t?: string; ids?: unknown };
    if (typed.t === 'lock.release' && typed.ids === undefined) this.leaseNext();
  }

  /**
   * Gives lock requests without a lease number the client's current lease, so
   * consecutive requests extend one operation like an editor drag does; a full
   * release ends it and the next request starts a new one.
   *
   * @param message Outgoing message.
   * @returns Message with a lease number where one is needed.
   */
  private leaseFill(message: object): object {
    const typed = message as { t?: string; lease?: number };
    if ((typed.t === 'lock.acquire' || typed.t === 'lock.renew') && typed.lease === undefined)
      return { ...message, lease: this.lease };
    return message;
  }

  /**
   * Starts a new operation: later lock requests use a fresh lease number.
   *
   * @returns The new lease number.
   */
  leaseNext(): number {
    this.lease += 1;
    return this.lease;
  }

  /**
   * Sends a raw text or binary frame.
   *
   * @param data Raw frame.
   */
  sendRaw(data: string | Uint8Array): void {
    this.socket.send(data as string | Uint8Array<ArrayBuffer>);
  }

  /**
   * Waits for and removes the first JSON message of the given type ('*' = any)
   * matching the predicate.
   *
   * @param type Message type.
   * @param predicate Extra filter.
   * @param timeoutMs Timeout.
   * @returns The message.
   */
  async next(
    type: string,
    predicate: (message: TestMessage) => boolean = () => true,
    timeoutMs = 3000,
  ): Promise<TestMessage> {
    const found = await this.waitFor(
      (item) => item.kind === 'json' && (type === '*' || item.message.t === type) && predicate(item.message),
      timeoutMs,
      type,
    );
    return (found as { message: TestMessage }).message;
  }

  /**
   * Waits for and removes the first binary frame.
   *
   * @param timeoutMs Timeout.
   * @returns Frame bytes.
   */
  async nextBinary(timeoutMs = 3000): Promise<Uint8Array> {
    const found = await this.waitFor((item) => item.kind === 'binary', timeoutMs, 'binary');
    return (found as { data: Uint8Array }).data;
  }

  /**
   * Sends a request with a request id and waits for the reply of the given type
   * or an error.
   *
   * @param message Request without r.
   * @param replyType Expected reply type.
   * @returns Reply or error message.
   */
  async request(message: Record<string, unknown>, replyType: string): Promise<TestMessage> {
    const requestId = Math.floor(Math.random() * 0x7fffffff);
    this.send({ ...message, r: requestId });
    return this.next('*', (reply) => reply.r === requestId && (reply.t === replyType || reply.t === 'error'));
  }

  /**
   * Waits until the socket closes.
   *
   * @param timeoutMs Timeout.
   * @returns Close code once the socket closed.
   */
  async closed(timeoutMs = 3000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (this.closeCode === null) {
      if (Date.now() > deadline) throw new Error('socket did not close');
      await this.sleepUntilWake(deadline - Date.now());
    }
    return this.closeCode;
  }

  /**
   * Checks whether a message of a type is already in the inbox.
   *
   * @param type Message type to look for.
   * @returns True when such a message is already in the inbox.
   */
  has(type: string): boolean {
    return this.inbox.some((item) => item.kind === 'json' && item.message.t === type);
  }

  /** Closes the socket. */
  close(): void {
    this.socket.close();
  }

  /**
   * Waits for the first inbox item that matches and removes it.
   *
   * @param matcher Inbox matcher (type '*' in next() matches any type).
   * @param timeoutMs Timeout.
   * @param label Label for the timeout error.
   * @returns Matched inbox item (removed from the inbox).
   */
  private async waitFor(
    matcher: (item: TestInbound) => boolean,
    timeoutMs: number,
    label: string,
  ): Promise<TestInbound> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.inbox.findIndex(matcher);
      if (index >= 0) return this.inbox.splice(index, 1)[0] as TestInbound;
      if (Date.now() > deadline)
        throw new Error(
          `timed out waiting for ${label}; inbox: ${JSON.stringify(this.inbox.map((i) => (i.kind === 'json' ? i.message : 'binary')))}`,
        );
      await this.sleepUntilWake(deadline - Date.now());
    }
  }

  /**
   * Stores one received frame in the inbox and wakes waiters.
   *
   * @param data Raw message data.
   */
  private inboxPush(data: unknown): void {
    if (typeof data === 'string') {
      const message = JSON.parse(data);
      if (message.t === 'compatibility.check' && this.compatibilityAutomatic) {
        this.send({
          t: 'compatibility.result',
          q: message.q,
          homeUrl: TEST_COMPATIBILITY_IDENTITY.homeUrl,
          allow:
            message.compatibility.version === TEST_COMPATIBILITY_IDENTITY.version &&
            message.compatibility.homeUrl === TEST_COMPATIBILITY_IDENTITY.homeUrl,
        });
        return;
      }
      this.inbox.push({ kind: 'json', message });
    } else this.inbox.push({ kind: 'binary', data: new Uint8Array(data as ArrayBuffer) });
    this.wake();
  }

  /** Resolves all pending waiters. */
  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  /**
   * Sleeps until a new frame arrives or the time runs out.
   *
   * @param maximumMs Longest sleep.
   */
  private sleepUntilWake(maximumMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, Math.max(1, maximumMs));
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

/** Explicit identity used by test fixtures; never injected by the transport. */
export const TEST_COMPATIBILITY_IDENTITY = { homeUrl: 'https://editor.invalid/AiWorldEd', version: '1' };
