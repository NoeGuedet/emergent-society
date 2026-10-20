import { Buffer } from 'node:buffer';
import { truncationNotice, utf8Prefix } from '../../text.js';
import type { TruncationCapture } from '../../text.js';

/**
 * Bounded, deterministically-decoded tool text shared by the terminal and web
 * tools. The cut rule is the neutral `src/text.ts` one; the notice reports the
 * model-text cap separately from the capture's own bytes and completeness.
 */

export { decodeToolText } from '../../text.js';

/**
 * Bounds the model-visible tool text to `maxBytes` UTF-8 bytes, measured after
 * deterministic decoding. The notice names the cap and the capture's own facts
 * — its captured byte count and whether capture completed, never a claim about
 * the retained prefix's size.
 */
export function boundToolText(
  text: string, maxBytes: number, capture: TruncationCapture,
): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  return utf8Prefix(text, maxBytes).text + truncationNotice('output', maxBytes, capture);
}
