/**
 * Per-recipient outbound queue. Holds frames only until the socket accepts
 * them, coalesces consecutive edit items into one `edits` frame ("replicate
 * these N edits") and enforces a byte cap so slow consumers cannot grow RAM.
 */

/** Coalescing stops adding edits to one frame once it reaches this size. */
export const EDITS_FRAME_COALESCE_BYTES = 1024 * 1024;

/** Minimal socket surface the queue writes to. */
export interface OutboundSocket {
  send(data: string | Uint8Array): number;
  getBufferedAmount(): number;
}

/** One queued frame. */
type OutboundItem =
  | { kind: 'text'; data: string; bytes: number }
  | { kind: 'edit'; data: string; bytes: number }
  | { kind: 'binary'; data: Uint8Array; bytes: number; onDelivered?: () => void };

/** Bounded, coalescing outbound queue. */
export class ConnectionOutboundQueue {
  private readonly items: OutboundItem[] = [];
  private head = 0;
  private queuedBytes = 0;
  private overflowed = false;
  /** Called after a flush that left the queue empty (presence delivery hook). */
  idleListener: (() => void) | null = null;

  /**
   * @param socket Destination socket.
   * @param maximumQueuedBytes Byte cap before the consumer is declared too
   *   slow.
   * @param socketHighWaterBytes Socket buffer level above which flushing
   *   pauses.
   * @param onOverflow Called once when the cap is exceeded.
   */
  constructor(
    private readonly socket: OutboundSocket,
    private readonly maximumQueuedBytes: number,
    private readonly socketHighWaterBytes: number,
    private readonly onOverflow: () => void,
  ) {}

  /**
   * Queues a complete JSON text frame.
   *
   * @param data Serialized message.
   */
  pushText(data: string): void {
    this.push({ kind: 'text', data, bytes: data.length });
  }

  /**
   * Queues one serialized edit entry (`{"from":..,"seq":..,"ops":[..]}`).
   *
   * @param data Serialized edit entry shared between recipients.
   */
  pushEdit(data: string): void {
    this.push({ kind: 'edit', data, bytes: data.length });
  }

  /**
   * Queues a binary frame.
   *
   * @param data Frame bytes (owned by the queue from now on).
   * @param onDelivered Called once the frame was handed to the socket.
   */
  pushBinary(data: Uint8Array, onDelivered?: () => void): void {
    this.push({ kind: 'binary', data, bytes: data.byteLength, onDelivered });
  }

  /** @returns Bytes waiting in the queue. */
  bytesQueued(): number {
    return this.queuedBytes;
  }

  /** @returns Frames waiting in the queue. */
  length(): number {
    return this.items.length - this.head;
  }

  /**
   * Sends a low-priority frame right away only if nothing is queued and the
   * socket buffer is below a threshold. The frame never enters the queue.
   *
   * @param data Frame bytes.
   * @param highWaterBytes Socket buffer level at or above which the frame is
   *   refused.
   * @returns True when the frame was handed to the socket.
   */
  sendIfIdle(data: Uint8Array, highWaterBytes: number): boolean {
    if (this.overflowed || this.length() > 0 || this.socket.getBufferedAmount() >= highWaterBytes) return false;
    this.socket.send(data);
    return true;
  }

  /** Drops everything (connection closing). */
  clear(): void {
    this.items.length = 0;
    this.head = 0;
    this.queuedBytes = 0;
  }

  /**
   * Hands queued frames to the socket while its buffer is below the high water
   * mark.
   */
  flush(): void {
    while (this.head < this.items.length && this.socket.getBufferedAmount() < this.socketHighWaterBytes) {
      const item = this.items[this.head] as OutboundItem;
      if (item.kind === 'edit') this.flushEditRun();
      else this.flushSingle(item);
    }
    this.compact();
    if (this.length() === 0) this.idleListener?.();
  }

  /** @param item Item to enqueue. */
  private push(item: OutboundItem): void {
    if (this.overflowed) return;
    if (this.queuedBytes + item.bytes > this.maximumQueuedBytes) {
      this.overflowed = true;
      this.clear();
      this.onOverflow();
      return;
    }
    this.items.push(item);
    this.queuedBytes += item.bytes;
    this.flush();
  }

  /**
   * Sends one non-edit item.
   *
   * @param item Item at the head of the queue.
   */
  private flushSingle(item: Exclude<OutboundItem, { kind: 'edit' }>): void {
    this.head++;
    this.queuedBytes -= item.bytes;
    this.socket.send(item.data);
    if (item.kind === 'binary') item.onDelivered?.();
  }

  /** Sends every consecutive edit item at the head as a single `edits` frame. */
  private flushEditRun(): void {
    const entries: string[] = [];
    let frameBytes = 0;
    while (
      this.head < this.items.length &&
      (this.items[this.head] as OutboundItem).kind === 'edit' &&
      frameBytes < EDITS_FRAME_COALESCE_BYTES
    ) {
      const item = this.items[this.head++] as OutboundItem;
      this.queuedBytes -= item.bytes;
      frameBytes += item.bytes;
      entries.push(item.data as string);
    }
    this.socket.send(`{"t":"edits","list":[${entries.join(',')}]}`);
  }

  /** Reclaims consumed slots so the backing array does not grow without bound. */
  private compact(): void {
    if (this.head === 0) return;
    if (this.head >= this.items.length) {
      this.items.length = 0;
      this.head = 0;
    } else if (this.head > 1024) {
      this.items.splice(0, this.head);
      this.head = 0;
    }
  }
}
