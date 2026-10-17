import { Buffer } from 'node:buffer';

/**
 * The one bounded streamed body read, shared by every outbound HTTP path.
 *
 * It captures at most `maxBytes` of a web-stream body, preserving the captured
 * prefix when the stream overruns the cap or fails mid-read: a cap or a read
 * error never discards what was already received. The outcome is neutral — the
 * caller owns its failure vocabulary — so a drift here cannot silently drift two
 * capture caps apart.
 *
 * `isCancelled` is evaluated at the moment a read fails, never after, matching
 * each caller's own check at the same point: a caller-cancelled read is
 * `cancelled-by-caller`, anything else is `read-error`. A zero cap therefore
 * still yields an empty, incomplete body rather than reading one chunk.
 */
export type BoundedBodyOutcome = 'complete' | 'body-limit' | 'read-error' | 'cancelled-by-caller';

export type BoundedBody = {
  readonly body: Buffer;
  readonly complete: boolean;
  readonly outcome: BoundedBodyOutcome;
};

export async function readBoundedBody(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  isCancelled: () => boolean,
): Promise<BoundedBody> {
  const collected: Buffer[] = [];
  let total = 0;
  // No body is an empty complete body, not a failure.
  if (stream === null) return { body: Buffer.concat(collected), complete: true, outcome: 'complete' };
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      const chunk = Buffer.from(value);
      if (total + chunk.length > maxBytes) {
        const remaining = maxBytes - total;
        if (remaining > 0) collected.push(chunk.subarray(0, remaining));
        total = maxBytes;
        // Cancelling the reader is best-effort: the captured prefix is already
        // the result, and a cancel that throws must not turn a cap into an error.
        try { await reader.cancel(); } catch { /* the prefix is still returned */ }
        return { body: Buffer.concat(collected), complete: false, outcome: 'body-limit' };
      }
      collected.push(chunk);
      total += chunk.length;
    }
  } catch {
    return {
      body: Buffer.concat(collected), complete: false,
      outcome: isCancelled() ? 'cancelled-by-caller' : 'read-error',
    };
  }
  return { body: Buffer.concat(collected), complete: true, outcome: 'complete' };
}
