import { Buffer } from 'node:buffer';
import type { ArtifactRef } from '../../context/contracts.js';
import { truncationNotice, utf8Prefix } from '../../text.js';

/**
 * Bounded, deterministically-decoded tool text shared by the terminal and web
 * tools. The cut rule is the neutral `src/text.ts` one; the notice reports the
 * model-text cap separately from the raw artifact's captured bytes and
 * completeness.
 */

export { decodeToolText } from '../../text.js';

/**
 * Bounds the model-visible tool text to `maxBytes` UTF-8 bytes, measured after
 * deterministic decoding. The notice names the cap and the captured raw
 * artifact's own facts — its captured byte count and whether capture completed,
 * never a claim about the retained prefix's size.
 */
export function boundToolText(text: string, maxBytes: number, raw: ArtifactRef): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  return utf8Prefix(text, maxBytes).text + truncationNotice('output', maxBytes, raw);
}
