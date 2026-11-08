/** Minimal editor that serves transfer links from memory, for relay tests. */
import { transferFrameEncode } from '../../src/shared/binary_frame.ts';
import { PROTOCOL_ID, PROTOCOL_VERSION } from '../../src/shared/protocol_definitions.ts';
import { TEST_ORIGIN } from './test_configuration.ts';

/** A file the test editor serves. */
export interface TestTransferFile {
  bytes: Uint8Array;
  name: string;
  mime: string;
  /** Announced size when it should differ from the bytes. */
  size?: number;
}

/** Test editor with the `transfer` capability. */
export class TestTransferEditor {
  /** Connected socket. */
  readonly socket: WebSocket;
  readonly files: Map<string, TestTransferFile> = new Map();
  /** PNG previews served for `transfer.get` with `thumbnail`, by link. */
  readonly thumbnails: Map<string, TestTransferFile> = new Map();
  /** Every `transfer.get` in arrival order. */
  readonly getLog: { link: string; thumbnail: boolean }[] = [];
  /** When true, `thumbnail` is ignored like an editor that predates it. */
  thumbnailIgnored = false;
  /** Query ids of the chunk requests in arrival order. */
  readonly chunkLog: number[] = [];
  /** Most chunk requests seen unanswered at once. */
  maxOutstanding = 0;
  /** Delay before answering a chunk request. */
  chunkDelayMs = 2;
  /** When false, chunk requests are not answered. */
  answering = true;
  /** Chunk requests from this offset on are answered with `transfer.missing`. */
  missingFromOffset: number = Number.POSITIVE_INFINITY;
  /** User id from the welcome. */
  user = 0;
  private outstanding = 0;
  private readonly queries = new Map<number, TestTransferFile>();
  private readonly replies = new Map<number, (message: any) => void>();
  private nextR = 1;

  /**
   * Wraps a connected socket.
   *
   * @param socket Socket that said hello.
   */
  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', (event) => this.receive(JSON.parse(String(event.data))));
  }

  /**
   * Connects and says hello with `select` and `transfer`.
   *
   * @param port Relay port.
   * @returns Ready editor.
   */
  static async connect(port: number): Promise<TestTransferEditor> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: TEST_ORIGIN } } as any);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    const editor = new TestTransferEditor(socket);
    const welcome = editor.reply(0);
    const hello = {
      t: 'hello',
      protocol: PROTOCOL_ID,
      version: PROTOCOL_VERSION,
      client: 'tests/1',
      caps: ['select', 'transfer'],
    };
    socket.send(JSON.stringify(hello));
    editor.user = (await welcome).user;
    return editor;
  }

  /**
   * Sends a request and waits for its reply or error.
   *
   * @param message Request without r.
   * @returns Reply.
   */
  request(message: Record<string, unknown>): Promise<any> {
    const r = this.nextR++;
    const reply = this.reply(r);
    this.socket.send(JSON.stringify({ ...message, r }));
    return reply;
  }

  /**
   * Registers a file and returns its link id.
   *
   * @param file File to serve.
   * @returns Link id.
   */
  async share(file: TestTransferFile): Promise<string> {
    const created = await this.request({ t: 'transfer.create' });
    if (created.t !== 'transfer.created') throw new Error(JSON.stringify(created));
    this.files.set(created.link, file);
    return created.link;
  }

  /** Closes the socket. */
  close(): void {
    this.socket.close();
  }

  /**
   * Waits for the message with a request id (0 = welcome).
   *
   * @param r Request id.
   * @returns Message.
   */
  private reply(r: number): Promise<any> {
    return new Promise((resolve) => this.replies.set(r, resolve));
  }

  /**
   * Handles a relay message.
   *
   * @param message Decoded message.
   */
  private receive(message: any): void {
    if (message.t === 'welcome') this.replies.get(0)?.(message);
    else if (message.r !== undefined) this.replies.get(message.r)?.(message);
    if (message.t === 'transfer.get') this.answerGet(message.q, message.link, message.thumbnail === true);
    if (message.t === 'transfer.chunk') this.answerChunk(message.q, message.offset, message.length);
  }

  /**
   * Answers `transfer.get`.
   *
   * @param q Query id.
   * @param link Link id.
   * @param thumbnail True when the relay asks for the PNG preview.
   */
  private answerGet(q: number, link: string, thumbnail: boolean): void {
    this.getLog.push({ link, thumbnail });
    const file = (thumbnail && !this.thumbnailIgnored ? this.thumbnails : this.files).get(link);
    if (file === undefined) return this.socket.send(JSON.stringify({ t: 'transfer.missing', q }));
    this.queries.set(q, file);
    const info = { t: 'transfer.info', q, size: file.size ?? file.bytes.length, name: file.name, mime: file.mime };
    this.socket.send(JSON.stringify(info));
  }

  /**
   * Answers `transfer.chunk` after a short delay.
   *
   * @param q Query id.
   * @param offset Byte offset.
   * @param length Byte count.
   */
  private answerChunk(q: number, offset: number, length: number): void {
    this.chunkLog.push(q);
    this.outstanding += 1;
    this.maxOutstanding = Math.max(this.maxOutstanding, this.outstanding);
    if (!this.answering) return;
    if (offset >= this.missingFromOffset) {
      this.outstanding -= 1;
      return this.socket.send(JSON.stringify({ t: 'transfer.missing', q }));
    }
    setTimeout(() => {
      this.outstanding -= 1;
      const bytes = this.queries.get(q)?.bytes.subarray(offset, offset + length) ?? new Uint8Array();
      if (this.socket.readyState === WebSocket.OPEN)
        this.socket.send(transferFrameEncode(q, offset, bytes) as Uint8Array<ArrayBuffer>);
    }, this.chunkDelayMs);
  }
}
