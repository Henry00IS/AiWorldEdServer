/**
 * Streams transfer link downloads from the owner's editor to HTTP responses.
 * Across all downloads of one owner exactly one chunk is in flight: requested
 * from the owner, or delivered but not yet read by its HTTP response. The next
 * chunk is requested only once that response pulls again, so concurrent
 * downloads interleave and relay memory stays at one chunk per owner.
 */
import type { TransferOwner } from './transfer_owner.ts';

/** Largest thumbnail the relay accepts from an owner. */
export const TRANSFER_THUMBNAIL_SIZE_MAXIMUM: number = 1024 * 1024;

/** What the owner announced for a download, or the HTTP status to answer. */
export type TransferInfoResult = { ok: true; size: number; name: string; mime: string } | { ok: false; status: number };

/** One HTTP download of a link. */
export interface TransferDownload {
  readonly q: number;
  readonly owner: TransferOwner;
  /** True when the owner was asked for a PNG preview instead of the file. */
  readonly thumbnail: boolean;
  size: number;
  /** Next byte to request. */
  offset: number;
  /** End of the served range (exclusive). */
  end: number;
  /** Bytes of the chunk requested from the owner, 0 when none. */
  requested: number;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  infoResolve: ((result: TransferInfoResult) => void) | null;
  pullResolve: (() => void) | null;
  timer: ReturnType<typeof setTimeout> | null;
  ended: boolean;
}

/**
 * Starts a download: asks the owner what the link holds.
 *
 * @param owner Link owner.
 * @param link Link token.
 * @param thumbnail True to ask for the PNG preview of the file instead.
 * @returns Download, or null when the owner has too many downloads.
 */
export function transferDownloadStart(owner: TransferOwner, link: string, thumbnail = false): TransferDownload | null {
  if (owner.downloads.size >= owner.limits.downloads) return null;
  const download: TransferDownload = {
    q: owner.queryNext(),
    owner,
    thumbnail,
    size: 0,
    offset: 0,
    end: 0,
    requested: 0,
    controller: null,
    infoResolve: null,
    pullResolve: null,
    timer: null,
    ended: false,
  };
  owner.downloads.set(download.q, download);
  owner.send({ t: 'transfer.get', q: download.q, link, ...(thumbnail ? { thumbnail: true } : {}) });
  return download;
}

/**
 * Waits for the owner's `transfer.info` or `transfer.missing`.
 *
 * @param download Started download.
 * @returns Info or HTTP status.
 */
export function transferDownloadInfo(download: TransferDownload): Promise<TransferInfoResult> {
  if (download.ended) return Promise.resolve({ ok: false, status: 404 });
  return new Promise((resolve) => {
    download.infoResolve = resolve;
    transferTimerArm(download);
  });
}

/**
 * Takes the owner's answer to `transfer.get`.
 *
 * @param owner Link owner.
 * @param q Query id.
 * @param info File info, or null for `transfer.missing`, which also fails a
 *   running download.
 */
export function transferInfoReceived(
  owner: TransferOwner,
  q: number,
  info: { size: number; name: string; mime: string } | null,
): void {
  const download = owner.downloads.get(q);
  if (download === undefined) return;
  const resolve = download.infoResolve;
  if (!resolve) return info === null ? transferStreamMissing(owner, download) : undefined;
  if (info === null || (download.thumbnail && !transferThumbnailValid(info))) return transferDownloadEnd(download, 404);
  if (info.size > owner.limits.sizeMaximum) return transferDownloadEnd(download, 413);
  transferTimerClear(download);
  download.infoResolve = null;
  download.size = info.size;
  download.end = info.size;
  resolve({ ok: true, ...info });
}

/**
 * Returns whether an owner's answer to a thumbnail request is a small PNG, so
 * an editor that ignores the flag and announces the file itself is refused.
 *
 * @param info Announced size and type.
 * @returns True for a PNG within the thumbnail cap.
 */
function transferThumbnailValid(info: { size: number; mime: string }): boolean {
  return info.mime === 'image/png' && info.size <= TRANSFER_THUMBNAIL_SIZE_MAXIMUM;
}

/**
 * Fails a running download at once when its owner can no longer serve it (a
 * `transfer.missing` mid-stream), without waiting for the reply timeout.
 *
 * @param owner Link owner.
 * @param download Running download.
 */
function transferStreamMissing(owner: TransferOwner, download: TransferDownload): void {
  if (owner.inFlight === download) download.requested = 0;
  transferDownloadEnd(download, 502);
}

/**
 * Narrows a download whose info arrived to one byte range.
 *
 * @param download Download.
 * @param start First byte.
 * @param end Last byte plus one.
 */
export function transferDownloadRange(download: TransferDownload, start: number, end: number): void {
  download.offset = start;
  download.end = end;
}

/**
 * Creates the response body of a download whose info arrived.
 *
 * @param download Download.
 * @returns Byte stream pulled chunk by chunk from the owner.
 */
export function transferStreamCreate(download: TransferDownload): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      start: (controller) => {
        download.controller = controller;
        if (download.offset >= download.end) transferDownloadEnd(download, null);
      },
      pull: () => transferPull(download),
      cancel: () => transferDownloadEnd(download, null),
    },
    { highWaterMark: 0 },
  );
}

/**
 * Takes a chunk frame of the owner.
 *
 * @param owner Link owner.
 * @param q Query id from the frame.
 * @param offset Offset from the frame.
 * @param payload Chunk bytes.
 * @returns 'ok', 'stale' for a chunk nobody waits for (late after a timeout),
 *   or 'invalid' for a wrong offset or length, which fails only this download
 *   with a 502.
 */
export function transferChunkReceived(
  owner: TransferOwner,
  q: number,
  offset: number,
  payload: Uint8Array,
): 'ok' | 'stale' | 'invalid' {
  const download = owner.inFlight;
  if (download === null || download.q !== q || download.requested === 0) return 'stale';
  if (offset !== download.offset || payload.byteLength !== download.requested) {
    download.requested = 0;
    transferDownloadEnd(download, 502);
    return 'invalid';
  }
  transferTimerClear(download);
  download.requested = 0;
  download.offset += payload.byteLength;
  if (download.ended) {
    transferSlotFree(owner);
    return 'ok';
  }
  download.controller?.enqueue(payload.slice());
  transferPullResolve(download);
  if (download.offset >= download.end) transferDownloadEnd(download, null);
  else transferTimerArm(download);
  return 'ok';
}

/**
 * Ends a download: closes or fails its response and frees its slot.
 *
 * @param download Download.
 * @param status HTTP status for a failure (an error mid-stream aborts the
 *   response), or null for a normal end.
 */
export function transferDownloadEnd(download: TransferDownload, status: number | null): void {
  if (download.ended) return;
  download.ended = true;
  const owner = download.owner;
  transferTimerClear(download);
  owner.downloads.delete(download.q);
  transferWantingRemove(owner, download);
  download.infoResolve?.({ ok: false, status: status ?? 404 });
  download.infoResolve = null;
  transferControllerEnd(download, status);
  transferPullResolve(download);
  if (owner.inFlight !== download) return;
  if (download.requested === 0) transferSlotFree(owner);
  else transferTimerArm(download);
}

/**
 * Ends every download of an owner whose connection closed.
 *
 * @param owner Link owner.
 */
export function transferOwnerClosed(owner: TransferOwner): void {
  for (const download of [...owner.downloads.values()]) transferDownloadEnd(download, 404);
  owner.inFlight = null;
  owner.wanting.length = 0;
}

/**
 * Handles a pull of the response: the previous chunk was read, so the slot is
 * free and this download queues for its next chunk.
 *
 * @param download Download.
 * @returns Resolves once the next chunk was enqueued or the download ended.
 */
function transferPull(download: TransferDownload): Promise<void> {
  if (download.ended) return Promise.resolve();
  transferTimerClear(download);
  return new Promise((resolve) => {
    download.pullResolve = resolve;
    download.owner.wanting.push(download);
    if (download.owner.inFlight === download) download.owner.inFlight = null;
    transferPump(download.owner);
  });
}

/**
 * Requests the next chunk when no chunk is in flight.
 *
 * @param owner Link owner.
 */
function transferPump(owner: TransferOwner): void {
  if (owner.inFlight !== null) return;
  const download = owner.wanting.shift();
  if (download === undefined) return;
  owner.inFlight = download;
  download.requested = Math.min(owner.limits.chunkBytes, download.end - download.offset);
  owner.send({ t: 'transfer.chunk', q: download.q, offset: download.offset, length: download.requested });
  transferTimerArm(download);
}

/**
 * Frees the in-flight slot and requests the next chunk.
 *
 * @param owner Link owner.
 */
function transferSlotFree(owner: TransferOwner): void {
  owner.inFlight = null;
  transferPump(owner);
}

/**
 * Arms the timeout of the current wait (owner reply or downloader read).
 *
 * @param download Download.
 */
function transferTimerArm(download: TransferDownload): void {
  transferTimerClear(download);
  download.timer = setTimeout(() => transferTimedOut(download), download.owner.limits.timeoutMs);
}

/**
 * Gives up on a download whose owner or reader stalled.
 *
 * @param download Download.
 */
function transferTimedOut(download: TransferDownload): void {
  download.timer = null;
  const owner = download.owner;
  const holdsSlot = owner.inFlight === download;
  download.requested = 0;
  transferDownloadEnd(download, 504);
  if (holdsSlot && owner.inFlight === download) transferSlotFree(owner);
}

/**
 * Clears the timeout of a download.
 *
 * @param download Download.
 */
function transferTimerClear(download: TransferDownload): void {
  if (download.timer !== null) clearTimeout(download.timer);
  download.timer = null;
}

/**
 * Resolves a waiting pull.
 *
 * @param download Download.
 */
function transferPullResolve(download: TransferDownload): void {
  const resolve = download.pullResolve;
  download.pullResolve = null;
  resolve?.();
}

/**
 * Closes or errors the response stream; a stream the reader already cancelled
 * ignores it.
 *
 * @param download Download.
 * @param status Failure status or null.
 */
function transferControllerEnd(download: TransferDownload, status: number | null): void {
  try {
    if (status === null) download.controller?.close();
    else download.controller?.error(new Error(`transfer failed (${status})`));
  } catch {
    return;
  }
}

/**
 * Removes a download from the wanting queue.
 *
 * @param owner Link owner.
 * @param download Download.
 */
function transferWantingRemove(owner: TransferOwner, download: TransferDownload): void {
  const index = owner.wanting.indexOf(download);
  if (index >= 0) owner.wanting.splice(index, 1);
}
