/**
 * Transfer link state of one owner connection: the creation times of its live
 * links and its downloads. A link costs 8 bytes (its creation time); the number
 * of live links is bounded by time, link lifetime divided by the create
 * interval, so no count is configured.
 */
import type { TransferDownload } from './transfer_stream.ts';

/** Limits an owner works with. */
export interface TransferOwnerLimits {
  /** Minimum time between two links. */
  intervalMs: number;
  /** Link lifetime. */
  lifetimeMs: number;
  /** Bytes asked for per chunk. */
  chunkBytes: number;
  /** Largest file served. */
  sizeMaximum: number;
  /** Concurrent downloads. */
  downloads: number;
  /** Wait for the owner's info or chunk, and for the downloader to read. */
  timeoutMs: number;
}

/** Links and downloads of one connection. */
export class TransferOwner {
  /** Random per connection; part of every token MAC. */
  readonly nonce: Uint8Array;
  /** Downloads by query id. */
  readonly downloads = new Map<number, TransferDownload>();
  /** Downloads whose reader wants the next chunk, in arrival order. */
  readonly wanting: TransferDownload[] = [];
  /** Download whose chunk is requested or not yet read; one at a time. */
  inFlight: TransferDownload | null = null;
  private readonly times: number[] = [];
  private firstCounter = 0;
  private lastCreatedAt = Number.NEGATIVE_INFINITY;
  private lastQuery = 0;

  /**
   * Creates the state of a connection's first link.
   *
   * @param limits Limits.
   * @param send Sends a JSON message to the owner.
   */
  constructor(
    readonly limits: TransferOwnerLimits,
    readonly send: (message: object) => void,
  ) {
    this.nonce = crypto.getRandomValues(new Uint8Array(16));
  }

  /**
   * Returns how long until the next link may be created.
   *
   * @param now Current time (epoch ms).
   * @returns Milliseconds, 0 when allowed now.
   */
  retryAfterMs(now: number): number {
    return Math.max(0, Math.ceil(this.lastCreatedAt + this.limits.intervalMs - now));
  }

  /**
   * Records a new link; the caller checked {@link retryAfterMs}.
   *
   * @param now Current time (epoch ms).
   * @returns Counter of the link.
   */
  linkCreate(now: number): number {
    this.prune(now);
    this.times.push(now);
    this.lastCreatedAt = now;
    return this.firstCounter + this.times.length - 1;
  }

  /**
   * Returns whether a link counter is still within its lifetime.
   *
   * @param counter Link counter.
   * @param now Current time (epoch ms).
   * @returns True while alive.
   */
  linkAlive(counter: number, now: number): boolean {
    const createdAt = this.times[counter - this.firstCounter];
    return createdAt !== undefined && now - createdAt < this.limits.lifetimeMs;
  }

  /**
   * Returns the number of links kept, expired ones included until pruned.
   *
   * @returns Link count.
   */
  linkCount(): number {
    return this.times.length;
  }

  /**
   * Forgets expired links.
   *
   * @param now Current time (epoch ms).
   */
  prune(now: number): void {
    let expired = 0;
    while (expired < this.times.length && now - (this.times[expired] ?? now) >= this.limits.lifetimeMs) expired += 1;
    this.times.splice(0, expired);
    this.firstCounter += expired;
  }

  /**
   * Returns the next download query id.
   *
   * @returns Query id in 1..2^32-1.
   */
  queryNext(): number {
    this.lastQuery = this.lastQuery >= 0xffffffff ? 1 : this.lastQuery + 1;
    return this.lastQuery;
  }
}
